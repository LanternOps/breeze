/**
 * queueEventTriggers — dual-ownership event fan-out wiring (#2133).
 *
 * A partner-wide automation (org_id NULL, partner_id set) must be matched
 * when a device event fires in ANY member org of the owning partner. The
 * real SQL shape is proven against Postgres in
 * automationsPartnerRls.integration.test.ts; these mocked tests pin the
 * wiring — the event-org partner lookup and the trigger-event enqueue.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  db: {
    select: vi.fn(),
  },
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
  // Pass-through: queueEventTriggers only reads trigger.type / eventType / filter.
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

import { db } from '../db';
import { queueEventTriggers } from './automationWorker';
import type { BreezeEvent } from '../services/eventBus';

const PARTNER_WIDE_AUTOMATION = {
  id: 'auto-pw',
  orgId: null,
  partnerId: 'partner-1',
  enabled: true,
  trigger: { type: 'event', eventType: 'device.offline' },
};

function offlineEvent(orgId: string): BreezeEvent<Record<string, unknown>> {
  return {
    id: 'evt-1',
    type: 'device.offline',
    orgId,
    source: 'test',
    priority: 'normal',
    payload: {},
    metadata: { timestamp: '2026-07-02T00:00:00.000Z' },
  } as BreezeEvent<Record<string, unknown>>;
}

/** db.select().from().where().limit() → rows (the event-org partner lookup). */
function mockOrgLookupOnce(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as never);
}

/** db.select().from().where() → rows (the automation candidates query). */
function mockCandidatesOnce(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  } as never);
}

beforeEach(() => {
  vi.mocked(db.select).mockReset();
  queueAddMock.mockReset().mockResolvedValue({ id: 'job-1' });
});

describe('queueEventTriggers — partner-wide fan-out wiring (#2133)', () => {
  it('resolves the event org partner and enqueues a trigger-event job for a matching partner-wide automation', async () => {
    mockOrgLookupOnce([{ partnerId: 'partner-1' }]);
    mockCandidatesOnce([PARTNER_WIDE_AUTOMATION]);

    await queueEventTriggers(offlineEvent('org-member-1'));

    expect(queueAddMock).toHaveBeenCalledWith(
      'trigger-event',
      expect.objectContaining({
        type: 'trigger-event',
        automationId: 'auto-pw',
        eventType: 'device.offline',
      }),
      expect.objectContaining({ jobId: 'automation-event-auto-pw-evt-1' }),
    );
  });

  it('does not enqueue when the candidate trigger does not match the event type', async () => {
    mockOrgLookupOnce([{ partnerId: 'partner-1' }]);
    mockCandidatesOnce([
      { ...PARTNER_WIDE_AUTOMATION, trigger: { type: 'event', eventType: 'device.online' } },
    ]);

    await queueEventTriggers(offlineEvent('org-member-1'));

    expect(queueAddMock).not.toHaveBeenCalled();
  });

  it('still works for an event org without a partner (org-owned candidates only)', async () => {
    mockOrgLookupOnce([]);
    mockCandidatesOnce([
      { id: 'auto-org', orgId: 'org-1', partnerId: null, enabled: true, trigger: { type: 'event', eventType: 'device.offline' } },
    ]);

    await queueEventTriggers(offlineEvent('org-1'));

    expect(queueAddMock).toHaveBeenCalledWith(
      'trigger-event',
      expect.objectContaining({ automationId: 'auto-org' }),
      expect.anything(),
    );
  });
});
