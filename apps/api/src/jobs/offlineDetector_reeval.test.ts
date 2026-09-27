import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// Jobs left in Redis by the retired evaluator must drain without side effects.

const { addBulkMock, addMock, getRepeatableJobsMock, selectMock } = vi.hoisted(() => ({
  addBulkMock: vi.fn(async () => undefined),
  addMock: vi.fn(async () => undefined),
  getRepeatableJobsMock: vi.fn(async () => [] as { key: string }[]),
  selectMock: vi.fn(() => { throw new Error('Retired reevaluation must not read the database'); }),
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...args: unknown[]) => ({ op: 'and', args }),
  or: (...args: unknown[]) => ({ op: 'or', args }),
  lt: (col: unknown, val: unknown) => ({ op: 'lt', col, val }),
  gt: (col: unknown, val: unknown) => ({ op: 'gt', col, val }),
  asc: (col: unknown) => ({ op: 'asc', col }),
  inArray: (col: unknown, vals: unknown[]) => ({ op: 'inArray', col, vals }),
}));

vi.mock('../db/schema', () => ({
  devices: { id: 'devices.id', orgId: 'devices.orgId', status: 'devices.status', lastSeenAt: 'devices.lastSeenAt' },
  alertRules: {},
  alertTemplates: {},
  alerts: {},
}));

vi.mock('../db', () => ({
  db: { select: selectMock },
  withSystemDbAccessContext: undefined,
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_c: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../services/offlineEffectsStore', () => ({
  persistOfflineTransition: vi.fn(async () => ['effect-id']),
  findDueOfflineEffects: vi.fn(async () => []),
  pruneOfflineEffects: vi.fn(async () => 0),
}));
vi.mock('../services/offlineTransitionEffects', () => ({ processOfflineEffect: vi.fn() }));

vi.mock('bullmq', () => ({
  Queue: class {
    addBulk = addBulkMock;
    add = addMock;
    getJob = vi.fn();
    getRepeatableJobs = getRepeatableJobsMock;
    removeRepeatableByKey = vi.fn();
    close = vi.fn();
  },
  Worker: class {
    on = vi.fn();
    close = vi.fn();
  },
  Job: class {},
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/eventBus', () => ({ publishEvent: vi.fn() }));

vi.mock('../services/bullmqUtils', () => ({ isReusableState: vi.fn(() => false) }));

import { processReevaluateOffline, processReevaluateOfflineSweep, scheduleOfflineJobs } from './offlineDetector';

beforeEach(() => {
  addBulkMock.mockClear();
  addMock.mockClear();
  getRepeatableJobsMock.mockClear();
  selectMock.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('processReevaluateOffline — retired queued jobs', () => {
  it('drains an already queued device without evaluating rules', async () => {
    const result = await processReevaluateOffline({ type: 'reevaluate-offline', deviceId: 'd1', orgId: 'o1' });
    expect(result).toMatchObject({ deviceId: 'd1', alertCreated: false });
    expect(selectMock).not.toHaveBeenCalled();
    expect(readFileSync(new URL('./offlineDetector.ts', import.meta.url), 'utf8'))
      .not.toMatch(/evaluateDeviceAlertsFromPolicy|triggerConfigPolicyOfflineAlerts/);
  });
});

describe('retired offline reevaluation jobs', () => {
  it('does not fan out pending sweep jobs', async () => {
    const result = await processReevaluateOfflineSweep();
    expect(result.queued).toBe(0);
    expect(selectMock).not.toHaveBeenCalled();
    expect(addBulkMock).not.toHaveBeenCalled();
  });

  it('does not schedule retired sweeps and keeps detection and recovery scheduled', async () => {
    await scheduleOfflineJobs();
    const names = addMock.mock.calls.map(call => (call as unknown[])[0]);
    expect(names).not.toContain('reevaluate-offline-sweep');
    expect(names).toContain('detect-offline');
    expect(names).toContain('recover-offline-effects');
  });
});
