import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

const { addBulkMock, warnSpy, devicesSchema, fleetState } = vi.hoisted(() => ({
  addBulkMock: vi.fn(async () => undefined),
  warnSpy: vi.fn(),
  devicesSchema: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    hostname: 'devices.hostname',
    displayName: 'devices.displayName',
    status: 'devices.status',
    lastSeenAt: 'devices.lastSeenAt'
  } as const,
  fleetState: {
    fleet: [] as { id: string; orgId: string; hostname: string; displayName: string | null; lastSeenAt: Date | null }[],
    chunkCalls: 0
  }
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...args: unknown[]) => ({ op: 'and', args }),
  or: (...args: unknown[]) => ({ op: 'or', args }),
  lt: (col: unknown, val: unknown) => ({ op: 'lt', col, val }),
  gt: (col: unknown, val: unknown) => ({ op: 'gt', col, val }),
  asc: (col: unknown) => ({ op: 'asc', col }),
  inArray: (col: unknown, vals: unknown[]) => ({ op: 'inArray', col, vals })
}));

vi.mock('../db/schema', () => ({
  devices: devicesSchema,
  alertRules: {},
  alertTemplates: {},
  alerts: {}
}));

const buildFleet = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `device-${String(i).padStart(6, '0')}`,
    orgId: 'org-1',
    hostname: `host-${i}`,
    displayName: null,
    lastSeenAt: new Date('2026-05-17T00:00:00Z')
  }));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
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
      })
    })),
    withSystemDbAccessContext: undefined
  },
  withSystemDbAccessContext: undefined
}));

vi.mock('bullmq', () => ({
  Queue: class {
    addBulk = addBulkMock;
    add = vi.fn();
    getJob = vi.fn();
    close = vi.fn();
  },
  Worker: class {
    on = vi.fn();
    close = vi.fn();
  },
  Job: class {}
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({})),
  isBullMQAvailable: vi.fn(() => true)
}));

vi.mock('../services/eventBus', () => ({
  publishEvent: vi.fn()
}));

vi.mock('../services/alertService', () => ({
  createAlert: vi.fn()
}));

vi.mock('../services/alertConditions', () => ({
  interpolateTemplate: vi.fn()
}));

vi.mock('../services/bullmqUtils', () => ({
  isReusableState: vi.fn(() => false)
}));

import { processDetectOffline } from './offlineDetector';

describe('offlineDetector.processDetectOffline cursor fan-out', () => {
  beforeEach(() => {
    fleetState.fleet = [];
    fleetState.chunkCalls = 0;
    addBulkMock.mockClear();
    warnSpy.mockClear();
    vi.spyOn(console, 'warn').mockImplementation(warnSpy);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    delete process.env.OFFLINE_DETECTOR_MAX_DEVICES_PER_RUN;
    delete process.env.OFFLINE_DETECTOR_CHUNK_SIZE;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('detects all stale devices in single chunk when fleet < chunkSize', async () => {
    fleetState.fleet = buildFleet(50);

    const result = await processDetectOffline({ type: 'detect-offline' });

    expect(result.detected).toBe(50);
    expect(addBulkMock).toHaveBeenCalledTimes(1);
  });

  it('paginates through multiple chunks when fleet > chunkSize', async () => {
    process.env.OFFLINE_DETECTOR_CHUNK_SIZE = '500';
    fleetState.fleet = buildFleet(1500);

    const result = await processDetectOffline({ type: 'detect-offline' });

    expect(result.detected).toBe(1500);
    expect(addBulkMock).toHaveBeenCalledTimes(3);
  });

  it('respects OFFLINE_DETECTOR_MAX_DEVICES_PER_RUN cap and warns', async () => {
    process.env.OFFLINE_DETECTOR_CHUNK_SIZE = '500';
    process.env.OFFLINE_DETECTOR_MAX_DEVICES_PER_RUN = '5000';
    fleetState.fleet = buildFleet(6000);

    const result = await processDetectOffline({ type: 'detect-offline' });

    expect(result.detected).toBe(5000);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Hit OFFLINE_DETECTOR_MAX_DEVICES_PER_RUN=5000'));
  });

  it('treats cap=0 as unlimited', async () => {
    process.env.OFFLINE_DETECTOR_CHUNK_SIZE = '500';
    process.env.OFFLINE_DETECTOR_MAX_DEVICES_PER_RUN = '0';
    fleetState.fleet = buildFleet(6000);

    const result = await processDetectOffline({ type: 'detect-offline' });

    expect(result.detected).toBe(6000);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns 0 when no stale devices', async () => {
    fleetState.fleet = [];

    const result = await processDetectOffline({ type: 'detect-offline' });

    expect(result.detected).toBe(0);
    expect(addBulkMock).not.toHaveBeenCalled();
  });
});
