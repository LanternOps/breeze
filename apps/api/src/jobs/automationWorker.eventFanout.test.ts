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

const { queueAddMock, workerCapture } = vi.hoisted(() => ({
  queueAddMock: vi.fn(),
  workerCapture: { processor: null as null | ((job: unknown) => Promise<unknown>) },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = queueAddMock;
    getJob = async () => null;
    getRepeatableJobs = async () => [];
    removeRepeatableByKey = async () => undefined;
    close = async () => undefined;
  },
  Worker: class {
    constructor(_queue: string, processor: (job: unknown) => Promise<unknown>) {
      workerCapture.processor = processor;
    }
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

import * as dbModule from '../db';
import { db } from '../db';
import { executeAutomationRun, executeConfigPolicyAutomationRun } from '../services/automationRuntime';
import { createAutomationWorker, queueEventTriggers } from './automationWorker';
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

// #3828 wave-6-3 task 3 — the dossier correction: the ticket-outbox
// publisher (Task 2) is the first thing that ever calls publishEvent for a
// ticket lifecycle event, so this is the FIRST time automation-worker's
// wildcard '*' subscription can see one at all. There is no special-case
// exclusion for ticket.* anywhere in queueEventTriggers — an automation
// reaches it exactly like any other event type, by explicitly configuring
// trigger.eventType to match. These two tests pin that: silent by default,
// reachable only by opt-in.
function ticketCreatedEvent(orgId: string): BreezeEvent<Record<string, unknown>> {
  return {
    id: 'evt-ticket-1',
    type: 'ticket.created',
    orgId,
    source: 'ticket-outbox-publisher',
    priority: 'normal',
    payload: { ticketId: 'ticket-1' },
    metadata: { timestamp: '2026-08-28T00:00:00.000Z' },
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

describe('queueEventTriggers — ticket events reach automations ONLY when explicitly subscribed (#3828 wave-6-3 task 3)', () => {
  it('does not enqueue an automation configured for a different event type', async () => {
    mockOrgLookupOnce([{ partnerId: 'partner-1' }]);
    // Configured for device.offline, same fixture the rest of this file uses.
    mockCandidatesOnce([PARTNER_WIDE_AUTOMATION]);

    await queueEventTriggers(ticketCreatedEvent('org-member-1'));

    expect(queueAddMock).not.toHaveBeenCalled();
  });

  it('enqueues an automation that explicitly configured trigger.eventType = ticket.created', async () => {
    mockOrgLookupOnce([{ partnerId: 'partner-1' }]);
    mockCandidatesOnce([
      { ...PARTNER_WIDE_AUTOMATION, id: 'auto-ticket', trigger: { type: 'event', eventType: 'ticket.created' } },
    ]);

    await queueEventTriggers(ticketCreatedEvent('org-member-1'));

    expect(queueAddMock).toHaveBeenCalledWith(
      'trigger-event',
      expect.objectContaining({
        type: 'trigger-event',
        automationId: 'auto-ticket',
        eventType: 'ticket.created',
      }),
      expect.anything(),
    );
  });
});

describe('automation execution DB context ownership', () => {
  beforeEach(() => {
    workerCapture.processor = null;
    vi.mocked(dbModule.runOutsideDbContext).mockClear();
    vi.mocked(dbModule.withSystemDbAccessContext).mockClear();
    vi.mocked(executeAutomationRun).mockReset().mockResolvedValue({
      status: 'running', devicesSucceeded: 0, devicesFailed: 0,
    });
    vi.mocked(executeConfigPolicyAutomationRun).mockReset().mockResolvedValue({
      runId: 'run-2', status: 'running', devicesSucceeded: 0, devicesFailed: 0,
    });
  });

  it.each([
    [{
      name: 'execute-run',
      data: {
        type: 'execute-run',
        runId: '11111111-1111-4111-8111-111111111111',
        targetDeviceIds: ['22222222-2222-4222-8222-222222222222'],
      },
    }, 0],
    [{
      name: 'execute-config-policy-run',
      data: {
        type: 'execute-config-policy-run',
        configPolicyAutomationId: '33333333-3333-4333-8333-333333333333',
        targetDeviceIds: ['22222222-2222-4222-8222-222222222222'],
        triggeredBy: 'scheduler',
      },
    }, 1],
  ])('runs %s outside the worker-wide system transaction', async (job, expectedShortSystemContexts) => {
    if ('configPolicyAutomationId' in job.data) {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: job.data.configPolicyAutomationId }]),
          }),
        }),
      } as never);
    }
    createAutomationWorker();
    expect(workerCapture.processor).not.toBeNull();
    await workerCapture.processor!(job);

    expect(dbModule.runOutsideDbContext).toHaveBeenCalledTimes(1);
    expect(dbModule.withSystemDbAccessContext).toHaveBeenCalledTimes(expectedShortSystemContexts);
  });
});
