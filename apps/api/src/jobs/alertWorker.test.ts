import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

const { addBulkMock, addMock, getJobMock, warnSpy, devicesSchema, organizationsSchema, fleetState } = vi.hoisted(() => ({
  addBulkMock: vi.fn(async () => undefined),
  addMock: vi.fn(async () => ({ id: 'queued-job-1' })),
  getJobMock: vi.fn(async () => null),
  warnSpy: vi.fn(),
  devicesSchema: { id: 'devices.id', orgId: 'devices.orgId', status: 'devices.status', lastSeenAt: 'devices.lastSeenAt' } as const,
  organizationsSchema: { id: 'organizations.id', status: 'organizations.status' } as const,
  fleetState: { fleet: [] as { id: string; orgId: string }[], chunkCalls: 0 }
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
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

import { processEvaluateAll, triggerFullEvaluation } from './alertWorker';

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
