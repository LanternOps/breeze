import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

const { addBulkMock, addMock, getJobMock, queueCtorMock, warnSpy, devicesSchema, organizationsSchema, fleetState } = vi.hoisted(() => ({
  addBulkMock: vi.fn(async () => undefined),
  addMock: vi.fn(async () => ({ id: 'queued-job-1' })),
  getJobMock: vi.fn(async () => null),
  queueCtorMock: vi.fn(),
  warnSpy: vi.fn(),
  devicesSchema: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    status: 'devices.status',
    lastSeenAt: 'devices.lastSeenAt',
    isEphemeral: 'devices.isEphemeral'
  } as const,
  organizationsSchema: { id: 'organizations.id', status: 'organizations.status', type: 'organizations.type' } as const,
  fleetState: { fleet: [] as { id: string; orgId: string }[], chunkCalls: 0 }
}));

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
            where: () => Promise.resolve([{ id: 'org-1' }])
          };
        }
        return {
          where: () => ({
            orderBy: () => ({
              limit: (limit: number) => {
                const startIdx = fleetState.chunkCalls * limit;
                const slice = fleetState.fleet.slice(startIdx, startIdx + limit);
                fleetState.chunkCalls++;
                return Promise.resolve(slice);
              }
            })
          })
        };
      }
    })),
    withSystemDbAccessContext: undefined
  },
  withSystemDbAccessContext: undefined
}));

vi.mock('bullmq', () => ({
  Queue: class {
    constructor(...args: unknown[]) {
      queueCtorMock(...args);
    }
    addBulk = addBulkMock;
    add = addMock;
    getJob = getJobMock;
  },
  Worker: class {
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

import { getAlertQueue, processEvaluateAll, triggerDeviceEvaluation, triggerFullEvaluation } from './alertWorker';

describe('alertWorker.processEvaluateAll cursor fan-out', () => {
  beforeEach(() => {
    fleetState.fleet = [];
    fleetState.chunkCalls = 0;
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

// Unbounded Redis growth: BullMQ retains completed jobs forever by default, and
// this fan-out enqueues one evaluate-device job per online device every 60s
// (~56k/day on US prod). The bounds live in the queue's defaultJobOptions so
// every producer inherits them.
describe('alertWorker queue retention bounds', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('constructs the alert queue with bounded completed/failed retention', () => {
    getAlertQueue();

    expect(queueCtorMock).toHaveBeenCalled();
    const [name, opts] = queueCtorMock.mock.calls[0] as unknown as [
      string,
      { defaultJobOptions?: { removeOnComplete?: { count?: number }; removeOnFail?: { count?: number } } }
    ];
    expect(name).toBe('alert-evaluation');
    const removeOnComplete = opts.defaultJobOptions?.removeOnComplete;
    const removeOnFail = opts.defaultJobOptions?.removeOnFail;
    expect(removeOnComplete?.count).toBeGreaterThan(0);
    expect(removeOnComplete?.count).toBeLessThanOrEqual(5000);
    // Failures are what people debug — keep them meaningfully longer.
    expect(removeOnFail?.count).toBeGreaterThan(removeOnComplete!.count!);
  });

  it('enqueues the evaluate-device fan-out with no per-job opts, onto a queue that declares bounds', async () => {
    fleetState.fleet = buildFleet(10);
    fleetState.chunkCalls = 0;
    addBulkMock.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await processEvaluateAll({ type: 'evaluate-all' });

    expect(addBulkMock).toHaveBeenCalledTimes(1);
    const jobs = (addBulkMock.mock.calls[0] as unknown[])[0] as { opts?: Record<string, unknown> }[];
    expect(jobs).toHaveLength(10);

    // Half one: the fan-out carries NO per-job opts at all. BullMQ lets per-call
    // options win over the queue defaults, so any opts here would be a second
    // place retention has to be kept correct — and an unbounded one would
    // silently un-bound the highest-volume producer on this queue.
    for (const job of jobs) {
      expect(job.opts).toBeUndefined();
    }

    // Half two: inheriting nothing is only safe because the queue these jobs
    // were enqueued onto actually declares bounds. The sibling test above pins
    // the numeric window; this one pins the LINKAGE — deleting defaultJobOptions
    // from getAlertQueue() must fail the fan-out test too, not just that one.
    const ctorCall = queueCtorMock.mock.calls.find((call) => (call as unknown[])[0] === 'alert-evaluation');
    expect(ctorCall, 'the evaluate-all fan-out never constructed the alert-evaluation queue').toBeDefined();
    const defaultJobOptions = ((ctorCall as unknown[])[1] as {
      defaultJobOptions?: { removeOnComplete?: unknown; removeOnFail?: unknown };
    }).defaultJobOptions;
    expect(defaultJobOptions?.removeOnComplete).toEqual(expect.objectContaining({ count: expect.any(Number) }));
    expect(defaultJobOptions?.removeOnFail).toEqual(expect.objectContaining({ count: expect.any(Number) }));
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

describe('alertWorker.triggerDeviceEvaluation jobId', () => {
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

  // Same regression as triggerFullEvaluation. `alert-evaluate-device:<id>:<slot>`
  // only survives because a UUID deviceId contains no colon — split length is
  // exactly 3. A deviceId that ever carried a colon would push the split past 3
  // and BullMQ would throw "Custom Id cannot contain :".
  it('does not use a colon in the enqueued BullMQ job id', async () => {
    await triggerDeviceEvaluation('device-1', 'org-1');

    expect(addMock).toHaveBeenCalled();
    const [, , opts] = addMock.mock.calls[0] as unknown as [string, unknown, { jobId: string }];
    expect(String(opts.jobId)).not.toContain(':');
    expect(String(opts.jobId)).toMatch(/^alert-evaluate-device-device-1-[a-z0-9]+$/);
  });
});
