import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

const {
  addBulkMock,
  addMock,
  getJobMock,
  warnSpy,
  devicesSchema,
  organizationsSchema,
  fleetState,
  ctx,
  workerState
} = vi.hoisted(() => {
  // Models the #1105 surface under test: `depth > 0` means a
  // withDbAccessContext transaction is open and a pooled Postgres connection is
  // pinned. Every mocked DB read and every enqueue records the depth it saw, so
  // the tests can assert WHERE the context boundary actually falls.
  const ctx = {
    depth: 0,
    orgReadDepths: [] as number[],
    deviceReadDepths: [] as number[],
    addBulkDepths: [] as number[],
    tripwireViolations: [] as string[]
  };
  return {
    addBulkMock: vi.fn(async () => {
      ctx.addBulkDepths.push(ctx.depth);
      return undefined;
    }),
    addMock: vi.fn(async () => ({ id: 'queued-job-1' })),
    getJobMock: vi.fn(async () => null),
    warnSpy: vi.fn(),
    devicesSchema: {
      id: 'devices.id',
      orgId: 'devices.orgId',
      status: 'devices.status',
      lastSeenAt: 'devices.lastSeenAt',
      isEphemeral: 'devices.isEphemeral'
    } as const,
    organizationsSchema: { id: 'organizations.id', status: 'organizations.status', type: 'organizations.type' } as const,
    fleetState: { fleet: [] as { id: string; orgId: string }[], chunkCalls: 0 },
    ctx,
    workerState: { processor: null as null | ((job: { data: unknown }) => Promise<unknown>) }
  };
});

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  ne: (col: unknown, val: unknown) => ({ op: 'ne', col, val }),
  and: (...args: unknown[]) => ({ op: 'and', args }),
  gte: (col: unknown, val: unknown) => ({ op: 'gte', col, val }),
  gt: (col: unknown, val: unknown) => ({ op: 'gt', col, val }),
  desc: (col: unknown) => ({ op: 'desc', col }),
  asc: (col: unknown) => ({ op: 'asc', col }),
  inArray: (col: unknown, vals: unknown[]) => ({ op: 'inArray', col, vals }),
  isNotNull: (col: unknown) => ({ op: 'isNotNull', col })
}));

vi.mock('../db/schema', () => ({
  devices: devicesSchema,
  deviceMetrics: {},
  organizations: organizationsSchema,
  alerts: {}
}));

const buildFleet = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `device-${String(i).padStart(6, '0')}`,
    orgId: 'org-1'
  }));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: (table: unknown) => {
        if (table === organizationsSchema) {
          return {
            where: () => {
              ctx.orgReadDepths.push(ctx.depth);
              return Promise.resolve([{ id: 'org-1' }]);
            }
          };
        }
        return {
          where: () => ({
            orderBy: () => ({
              limit: (limit: number) => {
                ctx.deviceReadDepths.push(ctx.depth);
                const startIdx = fleetState.chunkCalls * limit;
                const slice = fleetState.fleet.slice(startIdx, startIdx + limit);
                fleetState.chunkCalls++;
                return Promise.resolve(slice);
              }
            })
          })
        };
      }
    }))
  },
  // Real nesting semantics are irrelevant here; what matters is that a context
  // is OPEN for the duration of `fn` and closed after it settles.
  withSystemDbAccessContext: async <T>(fn: () => Promise<T>): Promise<T> => {
    ctx.depth++;
    try {
      return await fn();
    } finally {
      ctx.depth--;
    }
  },
  // Mirrors the production guard wired into createInstrumentedQueue: record the
  // enqueue call sites that ran while a transaction was still held.
  assertOutsideHeldDbContext: (operation: string) => {
    if (ctx.depth > 0) ctx.tripwireViolations.push(operation);
  }
}));

vi.mock('bullmq', () => ({
  Queue: class {
    addBulk = addBulkMock;
    add = addMock;
    getJob = getJobMock;
  },
  Worker: class {
    constructor(_name: string, processor: (job: { data: unknown }) => Promise<unknown>) {
      workerState.processor = processor;
    }
    on = vi.fn();
    close = vi.fn();
  }
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({}))
}));

vi.mock('../services/alertService', () => ({
  evaluateDeviceAlerts: vi.fn(),
  checkAllAutoResolve: vi.fn(),
  evaluateDeviceAlertsFromPolicy: vi.fn(),
  checkAutoResolveFromConfigPolicy: vi.fn()
}));

vi.mock('../services/bullmqUtils', () => ({
  isReusableState: vi.fn(() => false)
}));

import { createAlertWorker, processEvaluateAll, triggerFullEvaluation } from './alertWorker';

const resetCtx = () => {
  ctx.depth = 0;
  ctx.orgReadDepths.length = 0;
  ctx.deviceReadDepths.length = 0;
  ctx.addBulkDepths.length = 0;
  ctx.tripwireViolations.length = 0;
};

describe('alertWorker.processEvaluateAll cursor fan-out', () => {
  beforeEach(() => {
    fleetState.fleet = [];
    fleetState.chunkCalls = 0;
    resetCtx();
    addBulkMock.mockClear();
    warnSpy.mockClear();
    vi.spyOn(console, 'warn').mockImplementation(warnSpy);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    delete process.env.ALERT_WORKER_MAX_DEVICES_PER_RUN;
    delete process.env.ALERT_WORKER_CHUNK_SIZE;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('queues all devices in a single chunk when fleet < chunkSize', async () => {
    fleetState.fleet = buildFleet(50);

    const result = await processEvaluateAll({ type: 'evaluate-all' });

    expect(result.queued).toBe(50);
    expect(addBulkMock).toHaveBeenCalledTimes(1);
    const firstCall = addBulkMock.mock.calls[0] as unknown as [{ data: { deviceId: string } }[]];
    const jobs = firstCall[0];
    expect(jobs).toHaveLength(50);
    expect(jobs[0]!.data.deviceId).toBe('device-000000');
  });

  it('paginates through multiple chunks when fleet > chunkSize', async () => {
    process.env.ALERT_WORKER_CHUNK_SIZE = '500';
    fleetState.fleet = buildFleet(1500);

    const result = await processEvaluateAll({ type: 'evaluate-all' });

    expect(result.queued).toBe(1500);
    // 1500 fleet / 500 chunkSize = 3 chunks
    expect(addBulkMock).toHaveBeenCalledTimes(3);
  });

  it('respects ALERT_WORKER_MAX_DEVICES_PER_RUN cap and warns', async () => {
    process.env.ALERT_WORKER_CHUNK_SIZE = '500';
    process.env.ALERT_WORKER_MAX_DEVICES_PER_RUN = '5000';
    fleetState.fleet = buildFleet(6000);

    const result = await processEvaluateAll({ type: 'evaluate-all' });

    expect(result.queued).toBe(5000);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Hit ALERT_WORKER_MAX_DEVICES_PER_RUN=5000'));
  });

  it('treats cap=0 as unlimited', async () => {
    process.env.ALERT_WORKER_CHUNK_SIZE = '500';
    process.env.ALERT_WORKER_MAX_DEVICES_PER_RUN = '0';
    fleetState.fleet = buildFleet(6000);

    const result = await processEvaluateAll({ type: 'evaluate-all' });

    expect(result.queued).toBe(6000);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('caller-supplied batchSize overrides env cap (back-compat)', async () => {
    process.env.ALERT_WORKER_MAX_DEVICES_PER_RUN = '5000';
    process.env.ALERT_WORKER_CHUNK_SIZE = '500';
    fleetState.fleet = buildFleet(1000);

    const result = await processEvaluateAll({ type: 'evaluate-all', batchSize: 200 });

    expect(result.queued).toBe(200);
  });

  it('returns 0 queued when no devices match', async () => {
    fleetState.fleet = [];

    const result = await processEvaluateAll({ type: 'evaluate-all' });

    expect(result.queued).toBe(0);
    expect(addBulkMock).not.toHaveBeenCalled();
  });
});

// Regression for #3216 (Sentry BREEZE-9, #1105 class): the evaluate-all sweep
// used to run its entire per-device iteration and Redis fan-out inside the DB
// context opened by the worker wrapper, pinning a pooled Postgres connection
// idle-in-transaction for ~5s on every 60s cycle. The context must now be scoped
// to the reads only, with every enqueue landing after it closes.
describe('alertWorker evaluate-all #1105 DB-context scoping', () => {
  beforeEach(() => {
    fleetState.fleet = [];
    fleetState.chunkCalls = 0;
    resetCtx();
    workerState.processor = null;
    addBulkMock.mockClear();
    vi.spyOn(console, 'warn').mockImplementation(warnSpy);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    delete process.env.ALERT_WORKER_MAX_DEVICES_PER_RUN;
    delete process.env.ALERT_WORKER_CHUNK_SIZE;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not hold a DB context across the enqueue loop', async () => {
    process.env.ALERT_WORKER_CHUNK_SIZE = '500';
    fleetState.fleet = buildFleet(1500);

    const result = await processEvaluateAll({ type: 'evaluate-all' });

    expect(result.queued).toBe(1500);

    // The whole point: every addBulk in the multi-page loop ran with NO context
    // open. A single non-zero entry here is the bug returning.
    expect(ctx.addBulkDepths).toHaveLength(3);
    expect(ctx.addBulkDepths).toEqual([0, 0, 0]);

    // ...and the instrumented queue's #1105 tripwire agrees.
    expect(ctx.tripwireViolations).toEqual([]);

    // The context must be scoped, not removed: reads still run inside one, or
    // the fan-out would be reading past RLS on a bare pool.
    expect(ctx.orgReadDepths.every((d) => d > 0)).toBe(true);
    // 4 reads, not 3: 1500 devices at chunkSize 500 fills every page exactly, so
    // the `chunk.length < limit` early-out never fires and the loop terminates on
    // a final empty page. That page opens its own context too.
    expect(ctx.deviceReadDepths).toHaveLength(4);
    expect(ctx.deviceReadDepths.every((d) => d > 0)).toBe(true);

    // Nothing leaked: the sweep leaves no context open behind it.
    expect(ctx.depth).toBe(0);
  });

  it('runs the evaluate-all job through the worker handler with no wrapping context', async () => {
    process.env.ALERT_WORKER_CHUNK_SIZE = '500';
    fleetState.fleet = buildFleet(600);

    createAlertWorker();
    expect(workerState.processor).toBeTypeOf('function');

    // Exercised through the real worker processor, because the wrapper is what
    // opened the offending context — asserting on processEvaluateAll alone would
    // not catch a blanket runWithSystemDbAccess being reinstated here.
    const result = (await workerState.processor!({ data: { type: 'evaluate-all' } })) as { queued: number };

    expect(result.queued).toBe(600);
    expect(ctx.addBulkDepths).toEqual([0, 0]);
    expect(ctx.tripwireViolations).toEqual([]);
  });

  it('still wraps per-device evaluation in a system DB context', async () => {
    createAlertWorker();
    expect(workerState.processor).toBeTypeOf('function');

    const seenDepths: number[] = [];
    const { evaluateDeviceAlerts, evaluateDeviceAlertsFromPolicy } = await import('../services/alertService');
    vi.mocked(evaluateDeviceAlerts).mockImplementation(async () => {
      seenDepths.push(ctx.depth);
      return [];
    });
    vi.mocked(evaluateDeviceAlertsFromPolicy).mockImplementation(async () => []);

    await workerState.processor!({ data: { type: 'evaluate-device', deviceId: 'device-1', orgId: 'org-1' } });

    // evaluate-device does its own reads AND writes; it keeps the wrapper.
    expect(seenDepths).toEqual([1]);
  });
});

describe('alertWorker.triggerFullEvaluation jobId', () => {
  beforeEach(() => {
    addMock.mockClear();
    getJobMock.mockClear();
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queued-job-1' });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Regression for "Custom Id cannot contain :" — BullMQ rejects a custom
  // jobId whose colon-split length !== 3. `alert-evaluate-all:<slot>` is 2
  // parts and would throw, silently dropping the full-evaluation enqueue.
  it('does not use a colon in the enqueued BullMQ job id', async () => {
    await triggerFullEvaluation();

    expect(addMock).toHaveBeenCalled();
    const [, , opts] = addMock.mock.calls[0] as unknown as [string, unknown, { jobId: string }];
    expect(String(opts.jobId)).not.toContain(':');
    expect(String(opts.jobId)).toMatch(/^alert-evaluate-all-[a-z0-9]+$/);
  });
});
