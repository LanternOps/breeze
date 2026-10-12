/**
 * #7277 — loop guard for script.completed / script.failed in the automation
 * event fan-out.
 *
 * Without it, an automation "on script.completed → run script" queues a script
 * whose own completion fires script.completed, which fires the automation
 * again, forever. The rule: a script terminal event whose execution was queued
 * by an automation run that was ITSELF started by a script terminal event is
 * not fanned out (depth limit of one hop), and an automation never receives the
 * terminal event of a script its own run queued.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queueAddMock } = vi.hoisted(() => ({ queueAddMock: vi.fn() }));

vi.mock('bullmq', () => ({
  Queue: class {
    add = queueAddMock;
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
  isRedisAvailable: vi.fn(() => true),
  getRedis: vi.fn(() => null),
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn() },
}));

vi.mock('../db/schema', () => ({
  automations: { id: 'id', orgId: 'orgId', partnerId: 'partnerId', enabled: 'enabled', retiredAt: 'retiredAt' },
  automationRuns: { id: 'runs.id', automationId: 'runs.automationId', triggeredBy: 'runs.triggeredBy' },
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
  resolveAutomationsForDeviceWithPolicy: vi.fn(async () => null),
  resolveMaintenanceConfigForDevice: vi.fn(async () => null),
  isInMaintenanceWindow: vi.fn(() => ({ active: false, suppressAutomations: false })),
}));

vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

import { db } from '../db';
import { queueEventTriggers } from './automationWorker';
import type { BreezeEvent } from '../services/eventBus';

const ON_COMPLETED = {
  id: 'auto-on-completed',
  orgId: 'org-1',
  partnerId: null,
  enabled: true,
  trigger: { type: 'event', eventType: 'script.completed' },
};
const OTHER_ON_COMPLETED = { ...ON_COMPLETED, id: 'auto-other' };

function scriptEvent(payload: Record<string, unknown>, type = 'script.completed'): BreezeEvent<Record<string, unknown>> {
  return {
    id: 'evt-script-1',
    type,
    orgId: 'org-1',
    source: 'script-execution',
    priority: 'normal',
    payload,
    metadata: { timestamp: '2026-10-12T00:00:00.000Z' },
  } as BreezeEvent<Record<string, unknown>>;
}

/** select().from().where().limit() → rows (the run lookup and the org lookup). */
function mockLimitedOnce(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
    }),
  } as never);
}
/** select().from().where() → rows (the candidates query). */
function mockCandidatesOnce(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }),
  } as never);
}

beforeEach(() => {
  vi.mocked(db.select).mockReset();
  queueAddMock.mockReset().mockResolvedValue({ id: 'job-1' });
});

describe('queueEventTriggers — script event loop guard (#7277)', () => {
  it('delivers a script.completed that no automation caused (manual / scheduled script)', async () => {
    mockLimitedOnce([{ partnerId: null }]); // org lookup
    mockCandidatesOnce([ON_COMPLETED]);

    await queueEventTriggers(scriptEvent({ executionId: 'e1', deviceId: 'd1', automationRunId: null }));

    expect(queueAddMock).toHaveBeenCalledWith(
      'trigger-event',
      expect.objectContaining({ automationId: 'auto-on-completed', eventType: 'script.completed' }),
      expect.anything(),
    );
  });

  it('drops the event when the script was queued by a run that a script event itself started (the self-trigger loop)', async () => {
    mockLimitedOnce([{ automationId: 'auto-on-completed', triggeredBy: 'event:script.completed' }]); // run lookup
    mockLimitedOnce([{ partnerId: null }]);
    mockCandidatesOnce([ON_COMPLETED, OTHER_ON_COMPLETED]);

    await queueEventTriggers(scriptEvent({ executionId: 'e1', deviceId: 'd1', automationRunId: 'run-1' }));

    // Neither the originating automation (direct loop) nor another one (A→B→A) fires.
    expect(queueAddMock).not.toHaveBeenCalled();
  });

  it('also drops a script.failed whose script was queued by a run started by a script.failed event', async () => {
    mockLimitedOnce([{ automationId: 'auto-x', triggeredBy: 'event:script.failed' }]);

    await queueEventTriggers(scriptEvent({ executionId: 'e1', deviceId: 'd1', automationRunId: 'run-1' }, 'script.failed'));

    expect(queueAddMock).not.toHaveBeenCalled();
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1); // dropped before the org/candidate queries
  });

  it('also drops when the originating run was a config-policy event run (automationId null)', async () => {
    mockLimitedOnce([{ automationId: null, triggeredBy: 'config-policy-event:script.completed' }]);

    await queueEventTriggers(scriptEvent({ executionId: 'e1', deviceId: 'd1', automationRunId: 'run-1' }));

    expect(queueAddMock).not.toHaveBeenCalled();
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
  });

  it('delivers when the originating run was started by something other than a script event (one hop is allowed)', async () => {
    mockLimitedOnce([{ automationId: 'auto-alert', triggeredBy: 'event:alert.triggered' }]); // run lookup
    mockLimitedOnce([{ partnerId: null }]);
    mockCandidatesOnce([ON_COMPLETED]);

    await queueEventTriggers(scriptEvent({ executionId: 'e1', deviceId: 'd1', automationRunId: 'run-1' }));

    expect(queueAddMock).toHaveBeenCalledTimes(1);
  });

  it('never delivers a script event to the automation whose own run queued the script', async () => {
    mockLimitedOnce([{ automationId: 'auto-on-completed', triggeredBy: 'schedule:202610120000' }]); // run lookup
    mockLimitedOnce([{ partnerId: null }]);
    mockCandidatesOnce([ON_COMPLETED, OTHER_ON_COMPLETED]);

    await queueEventTriggers(scriptEvent({ executionId: 'e1', deviceId: 'd1', automationRunId: 'run-1' }));

    expect(queueAddMock).toHaveBeenCalledTimes(1);
    expect(queueAddMock).toHaveBeenCalledWith(
      'trigger-event',
      expect.objectContaining({ automationId: 'auto-other' }),
      expect.anything(),
    );
  });

  it('delivers when the originating run no longer exists (deleted automation / purged run cannot be a live loop)', async () => {
    mockLimitedOnce([]); // run lookup: gone
    mockLimitedOnce([{ partnerId: null }]);
    mockCandidatesOnce([ON_COMPLETED]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await queueEventTriggers(scriptEvent({ executionId: 'e1', deviceId: 'd1', automationRunId: 'run-gone' }));

    expect(queueAddMock).toHaveBeenCalledTimes(1);
  });

  it('does not touch other event types (no run lookup)', async () => {
    mockLimitedOnce([{ partnerId: null }]);
    mockCandidatesOnce([{ ...ON_COMPLETED, trigger: { type: 'event', eventType: 'device.offline' } }]);

    await queueEventTriggers(scriptEvent({ automationRunId: 'run-1' }, 'device.offline'));

    expect(queueAddMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2); // org + candidates only, no run lookup
  });
});
