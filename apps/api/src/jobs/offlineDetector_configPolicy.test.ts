import { describe, it, expect, vi, beforeEach } from 'vitest';

const { evaluateFromPolicyMock, selectMock } = vi.hoisted(() => ({
  evaluateFromPolicyMock: vi.fn(),
  // db.select().from().where() resolves to the legacy alertRules rows.
  selectMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = vi.fn();
    add = vi.fn();
    close = vi.fn();
  },
  Worker: class {
    close = vi.fn();
    on = vi.fn();
  },
  Job: class {},
}));

vi.mock('../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (..._args: unknown[]) => selectMock(),
      }),
    }),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: {},
  alertRules: { orgId: {}, isActive: {}, targetType: {}, targetId: {} },
  alertTemplates: {},
  alerts: {},
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/eventBus', () => ({ publishEvent: vi.fn() }));

vi.mock('../services/alertService', () => ({
  createAlert: vi.fn(),
  evaluateDeviceAlertsFromPolicy: evaluateFromPolicyMock,
}));

vi.mock('../services/alertConditions', () => ({ interpolateTemplate: vi.fn() }));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(), and: vi.fn(), lt: vi.fn(), gt: vi.fn(), asc: vi.fn(),
  inArray: vi.fn(), or: vi.fn(),
}));

import { triggerOfflineAlerts } from './offlineDetector';

const device = {
  id: 'device-1',
  orgId: 'org-1',
  siteId: 'site-1',
  hostname: 'host-1',
  displayName: 'Host 1',
  status: 'offline',
  lastSeenAt: new Date('2026-06-24T11:30:00.000Z'),
  osType: 'windows',
  osVersion: '11',
} as never;

describe('triggerOfflineAlerts — config policy wiring (issue #1857)', () => {
  beforeEach(() => {
    evaluateFromPolicyMock.mockReset();
    selectMock.mockReset();
    // No legacy standalone alert rules for this org by default.
    selectMock.mockResolvedValue([]);
  });

  it('evaluates config-policy offline rules for an offline device', async () => {
    evaluateFromPolicyMock.mockResolvedValue([]);

    await triggerOfflineAlerts(device);

    expect(evaluateFromPolicyMock).toHaveBeenCalledWith('device-1');
  });

  it('returns true when a config-policy alert is created (even with no legacy rules)', async () => {
    evaluateFromPolicyMock.mockResolvedValue(['alert-1']);

    const created = await triggerOfflineAlerts(device);

    expect(created).toBe(true);
  });

  it('returns false when neither config-policy nor legacy rules fire', async () => {
    evaluateFromPolicyMock.mockResolvedValue([]);

    const created = await triggerOfflineAlerts(device);

    expect(created).toBe(false);
  });

  it('runs the legacy path then re-throws an unexpected config-policy error (job fails + retries)', async () => {
    const boom = new Error('boom');
    evaluateFromPolicyMock.mockRejectedValue(boom);

    // The legacy query must still run, but the unexpected error must surface so
    // BullMQ marks the job failed and retries it — not silently swallowed (#1857).
    await expect(triggerOfflineAlerts(device)).rejects.toThrow('boom');
    expect(selectMock).toHaveBeenCalled(); // legacy query still ran first
  });

  it('skips config-policy evaluation gracefully when tables are missing (42P01)', async () => {
    const relErr = Object.assign(new Error('relation does not exist'), {
      cause: { code: '42P01' },
    });
    evaluateFromPolicyMock.mockRejectedValue(relErr);

    const created = await triggerOfflineAlerts(device);

    expect(created).toBe(false);
  });
});
