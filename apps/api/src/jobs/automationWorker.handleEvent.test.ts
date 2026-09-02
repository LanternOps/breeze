/**
 * handleAutomationEvent — durable registry contract (#4085 Task 3).
 *
 * Registered under subscriber id `automation-worker`. Both failure paths
 * MUST throw (not swallow) so queue-mode dispatch can retry: the old
 * `subscribeToAutomationEvents` wrapped this in a try/catch and turned
 * `!isRedisAvailable()` into a silent `return` — this test pins the new
 * throwing contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { isRedisAvailableMock, selectMock } = vi.hoisted(() => ({
  isRedisAvailableMock: vi.fn(() => true),
  selectMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = vi.fn();
    getJob = async () => null;
    getRepeatableJobs = async () => [];
    removeRepeatableByKey = async () => undefined;
    close = async () => undefined;
  },
  Worker: class {
    on() { /* noop */ }
    close = async () => undefined;
  },
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({})),
  isRedisAvailable: isRedisAvailableMock,
  getRedis: vi.fn(() => null),
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: selectMock },
}));

vi.mock('../db/schema', () => ({
  automations: { id: 'id', orgId: 'orgId', partnerId: 'partnerId', enabled: 'enabled' },
  configPolicyAutomations: { id: 'id', enabled: 'enabled' },
  devices: { id: 'id', orgId: 'orgId', siteId: 'siteId' },
  deviceGroupMemberships: { deviceId: 'deviceId', groupId: 'groupId' },
  organizations: { id: 'id', partnerId: 'partnerId' },
}));

vi.mock('../services/automationRuntime', () => ({
  createAutomationRunRecord: vi.fn(),
  executeAutomationRun: vi.fn(),
  executeConfigPolicyAutomationRun: vi.fn(),
  formatScheduleTriggerKey: vi.fn(() => '202601011000'),
  isCronDue: vi.fn(() => false),
  normalizeAutomationTrigger: vi.fn((trigger) => trigger),
}));

vi.mock('../services/featureConfigResolver', () => ({
  scanScheduledAutomations: vi.fn(async () => []),
  resolveAutomationsForDevice: vi.fn(async () => []),
  resolveMaintenanceConfigForDevice: vi.fn(async () => null),
  isInMaintenanceWindow: vi.fn(() => ({ active: false, suppressAutomations: false })),
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: vi.fn(),
}));

import { handleAutomationEvent } from './automationWorker';

const EVENT = {
  id: 'event-1',
  type: 'device.online',
  orgId: 'org-1',
  source: 'test',
  priority: 'normal' as const,
  payload: {},
  metadata: { correlationId: 'c1', timestamp: new Date().toISOString() },
} as never;

/** A chainable query-builder stub: `.from().where().limit()` all resolve to `rows`. */
function chain(rows: unknown[]) {
  const builder = {
    from: () => builder,
    where: () => builder,
    limit: () => Promise.resolve(rows),
    then: (resolve: (v: unknown[]) => void) => resolve(rows), // await db.select(...).from(...) with no .limit()
  };
  return builder;
}

describe('handleAutomationEvent', () => {
  beforeEach(() => {
    isRedisAvailableMock.mockReset().mockReturnValue(true);
    selectMock.mockReset();
  });

  it('throws instead of silently returning when redis is unavailable', async () => {
    isRedisAvailableMock.mockReturnValue(false);

    await expect(handleAutomationEvent(EVENT)).rejects.toThrow(/redis unavailable/i);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('propagates a queueEventTriggers rejection out of the handler instead of swallowing it', async () => {
    // First select() is the event-org lookup inside queueEventTriggers — make
    // it reject so the failure has to come out of handleAutomationEvent itself
    // (the old subscriber's try/catch would have swallowed this into a
    // console.error and returned normally).
    selectMock.mockImplementationOnce(() => {
      throw new Error('fan-out exploded');
    });

    await expect(handleAutomationEvent(EVENT)).rejects.toThrow('fan-out exploded');
  });

  it('resolves when redis is available and the fan-out has nothing to do', async () => {
    // eventOrg lookup -> no row; automations lookup -> no rows; no deviceId in
    // payload, so the config-policy branch never runs either.
    selectMock
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]));

    await expect(handleAutomationEvent(EVENT)).resolves.toBeUndefined();
    expect(selectMock).toHaveBeenCalledTimes(2);
  });
});
