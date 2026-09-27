import { readFileSync } from 'node:fs';
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
    networkCheckReadDepths: [] as number[],
    // Every operation the #1105 guard was consulted for. Asserting this is
    // non-empty is what pins the queue to createInstrumentedQueue — checking
    // only `tripwireViolations` would pass just as happily against a bare
    // `new Queue`, which never calls the guard at all.
    tripwireCalls: [] as string[],
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
    ctx.tripwireCalls.push(operation);
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
}));

vi.mock('../services/bullmqUtils', () => ({
  isReusableState: vi.fn(() => false)
}));

const { networkCheckOrgIdsMock, evaluateNetworkCheckAlertsForOrgMock } = vi.hoisted(() => ({
  networkCheckOrgIdsMock: vi.fn(async () => [] as string[]),
  evaluateNetworkCheckAlertsForOrgMock: vi.fn(),
}));

vi.mock('../services/monitors/networkCheckAlertSweep', () => ({
  selectNetworkCheckOrgIds: (...args: unknown[]) => {
    ctx.networkCheckReadDepths.push(ctx.depth);
    return networkCheckOrgIdsMock(...(args as []));
  },
  evaluateNetworkCheckAlertsForOrg: evaluateNetworkCheckAlertsForOrgMock,
}));

// W03 Task 10 — records the #1105 depth it was called at, so a drain
// accidentally moved inside the evaluate-device/evaluate-all transaction is
// caught the same way every other read/enqueue in this file is.
const subjectOutbox = vi.hoisted(() => ({ depths: [] as number[] }));
vi.mock('../services/subjectAlertOutbox', () => ({
  drainSubjectAlertOutbox: vi.fn(async () => { subjectOutbox.depths.push(ctx.depth); }),
}));

import { createAlertWorker, processEvaluateAll, triggerFullEvaluation } from './alertWorker';

const resetCtx = () => {
  ctx.depth = 0;
  ctx.orgReadDepths.length = 0;
  ctx.deviceReadDepths.length = 0;
  ctx.addBulkDepths.length = 0;
  ctx.networkCheckReadDepths.length = 0;
  ctx.tripwireCalls.length = 0;
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

    // ...and the instrumented queue's #1105 tripwire agrees. Both halves are
    // load-bearing: the first pins getAlertQueue() to createInstrumentedQueue
    // (a bare `new Queue` never consults the guard, so the second assertion
    // alone would pass vacuously); the second pins the context boundary.
    expect(ctx.tripwireCalls).toEqual([
      'bullmq.addBulk(alert-evaluation)',
      'bullmq.addBulk(alert-evaluation)',
      'bullmq.addBulk(alert-evaluation)'
    ]);
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
    expect(ctx.tripwireCalls).toHaveLength(2);
    expect(ctx.tripwireViolations).toEqual([]);
  });

  it('evaluate-device runs only the monitor/standalone evaluator', async () => {
    createAlertWorker();
    const service = await import('../services/alertService');
    vi.mocked(service.evaluateDeviceAlerts).mockResolvedValue(['a1']);
    const result = await workerState.processor!({ data: {
      type: 'evaluate-device', deviceId: 'device-1', orgId: 'org-1',
    } });
    expect(result).toMatchObject({ alertsCreated: 1 });
    expect(readFileSync(new URL('./alertWorker.ts', import.meta.url), 'utf8'))
      .not.toMatch(/evaluateDeviceAlertsFromPolicy|checkAutoResolveFromConfigPolicy/);
  });

  it('still wraps per-device evaluation in a system DB context', async () => {
    createAlertWorker();
    expect(workerState.processor).toBeTypeOf('function');

    const seenDepths: number[] = [];
    const { evaluateDeviceAlerts } = await import('../services/alertService');
    vi.mocked(evaluateDeviceAlerts).mockImplementation(async () => {
      seenDepths.push(ctx.depth);
      return [];
    });

    await workerState.processor!({ data: { type: 'evaluate-device', deviceId: 'device-1', orgId: 'org-1' } });

    // evaluate-device does its own reads AND writes; it keeps the wrapper.
    expect(seenDepths).toEqual([1]);
  });

  it('drains subject events after device commit and outside the fleet context', async () => {
    subjectOutbox.depths.length = 0;
    createAlertWorker();
    const { evaluateDeviceAlerts } = await import('../services/alertService');
    vi.mocked(evaluateDeviceAlerts).mockResolvedValue([]);
    await workerState.processor!({ data: { type: 'evaluate-device', deviceId: 'device-1', orgId: 'org-1' } });
    expect(subjectOutbox.depths).toEqual([0]);
    fleetState.fleet = [];
    await workerState.processor!({ data: { type: 'evaluate-all' } });
    expect(subjectOutbox.depths).toEqual([0, 0]);
  });
});

// #6353 — a network_check has ONE verdict per org, so the sweep must enqueue
// one device-independent job per org that runs a managed check, alongside (not
// instead of) the per-device fan-out.
describe('alertWorker evaluate-all network_check fan-out (#6353)', () => {
  beforeEach(() => {
    fleetState.fleet = [];
    fleetState.chunkCalls = 0;
    resetCtx();
    workerState.processor = null;
    addBulkMock.mockClear();
    networkCheckOrgIdsMock.mockReset();
    networkCheckOrgIdsMock.mockResolvedValue([]);
    evaluateNetworkCheckAlertsForOrgMock.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(warnSpy);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    delete process.env.ALERT_WORKER_MAX_DEVICES_PER_RUN;
    delete process.env.ALERT_WORKER_CHUNK_SIZE;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enqueues one evaluate-network-checks job per org with a managed check, read inside a context and enqueued outside it', async () => {
    fleetState.fleet = buildFleet(10);
    networkCheckOrgIdsMock.mockResolvedValue(['org-1', 'org-2']);

    const result = await processEvaluateAll({ type: 'evaluate-all' });

    expect(result.queued).toBe(10);
    expect(result.networkCheckOrgsQueued).toBe(2);
    // Device page + network-check page: two addBulk calls, both outside any context.
    expect(addBulkMock).toHaveBeenCalledTimes(2);
    expect(ctx.addBulkDepths).toEqual([0, 0]);
    expect(ctx.tripwireViolations).toEqual([]);
    const [jobs] = addBulkMock.mock.calls[1] as unknown as [{ name: string; data: { type: string; orgId: string } }[]];
    expect(jobs).toEqual([
      { name: 'evaluate-network-checks', data: { type: 'evaluate-network-checks', orgId: 'org-1' } },
      { name: 'evaluate-network-checks', data: { type: 'evaluate-network-checks', orgId: 'org-2' } },
    ]);
    // The org read ran inside a short system context, like every other read here.
    expect(ctx.networkCheckReadDepths).toEqual([1]);
    expect(ctx.depth).toBe(0);
  });

  it('enqueues the network-check jobs even when NO device is online — that is the whole point', async () => {
    fleetState.fleet = [];
    networkCheckOrgIdsMock.mockResolvedValue(['org-1']);

    const result = await processEvaluateAll({ type: 'evaluate-all' });

    expect(result.queued).toBe(0);
    expect(result.networkCheckOrgsQueued).toBe(1);
    expect(addBulkMock).toHaveBeenCalledTimes(1);
  });

  it('adds no network-check job when no org runs a managed check', async () => {
    fleetState.fleet = buildFleet(3);

    const result = await processEvaluateAll({ type: 'evaluate-all' });

    expect(result.networkCheckOrgsQueued).toBe(0);
    expect(addBulkMock).toHaveBeenCalledTimes(1);
  });

  it('runs evaluate-network-checks inside a system DB context, like evaluate-device', async () => {
    createAlertWorker();
    const seenDepths: number[] = [];
    evaluateNetworkCheckAlertsForOrgMock.mockImplementation(async (orgId: string) => {
      seenDepths.push(ctx.depth);
      return { orgId, checks: 1, devicesEvaluated: 1, checksWithoutDevice: 0, staleEpisodesDetached: 0, alertIds: ['a-1'] };
    });

    const result = await workerState.processor!({ data: { type: 'evaluate-network-checks', orgId: 'org-1' } });

    expect(evaluateNetworkCheckAlertsForOrgMock).toHaveBeenCalledWith('org-1');
    expect(seenDepths).toEqual([1]);
    expect(result).toMatchObject({ orgId: 'org-1', alertsCreated: 1 });
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
