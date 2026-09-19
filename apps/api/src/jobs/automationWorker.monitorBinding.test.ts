/**
 * #5289 — a monitor's responses must run on the device that breached.
 *
 * A compiled monitor automation is an ordinary `alert.triggered` event
 * automation with no conditions and no trigger deviceIds, so without an
 * explicit binding `resolveAutomationTargetDeviceIds` falls through to "every
 * device in the owning org" — and for a PARTNER-wide monitor, every device in
 * every org under that partner. One disk alert on one workstation would run the
 * monitor's remediation script fleet-wide.
 *
 * Mock preamble copied from automationWorker.boundTargets.test.ts (#3824), the
 * suite that pins the same property for AI-agent-managed automations.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMock,
  closeMock,
  createAutomationRunRecordMock,
  executeAutomationRunMock,
  getJobMock,
  selectMock,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  closeMock: vi.fn(),
  createAutomationRunRecordMock: vi.fn(),
  executeAutomationRunMock: vi.fn(),
  getJobMock: vi.fn(),
  selectMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = getJobMock;
    add = addMock;
    close = closeMock;
    getRepeatableJobs = vi.fn(async () => []);
    removeRepeatableByKey = vi.fn(async () => undefined);
  },
  Worker: class {
    close = closeMock;
    on = vi.fn();
  },
  Job: class {},
}));

vi.mock('../db', () => ({
  db: { select: selectMock },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  automations: { id: 'id', enabled: 'enabled' },
  configPolicyAutomations: {},
  devices: {},
  deviceGroupMemberships: {},
  organizations: {},
  // #5290 — the pause gate reads this table for a monitor-managed automation.
  monitorDeviceState: { monitorId: 'monitor_id', deviceId: 'device_id', responsesPaused: 'responses_paused' },
}));

// #5290 — episode bookkeeping is asserted in automationWorker.monitorPause.test.ts.
vi.mock('../services/monitors/episodeService', () => ({
  recordEpisodeResponse: vi.fn(async () => undefined),
}));

vi.mock('../services/eventBus', () => ({
  getEventBus: vi.fn(() => ({ subscribe: vi.fn() })),
}));

vi.mock('../services/automationRuntime', () => ({
  createAutomationRunRecord: createAutomationRunRecordMock,
  executeAutomationRun: executeAutomationRunMock,
  executeConfigPolicyAutomationRun: vi.fn(),
  formatScheduleTriggerKey: vi.fn(),
  isCronDue: vi.fn(),
  // Mirrors the real normalizer's event branch: `event` is folded into
  // `eventType` and `filter` is carried through (services/automationRuntime.ts).
  normalizeAutomationTrigger: vi.fn((trigger: Record<string, unknown>) => ({
    type: trigger.type,
    eventType: trigger.eventType ?? trigger.event,
    filter: trigger.filter,
  })),
}));

vi.mock('../services/featureConfigResolver', () => ({
  scanScheduledAutomations: vi.fn(),
  resolveAutomationsForDevice: vi.fn(),
  resolveMaintenanceConfigForDevice: vi.fn(),
  isInMaintenanceWindow: vi.fn(),
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  isRedisAvailable: vi.fn(() => true),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: vi.fn(),
}));

import { __testOnly, shutdownAutomationWorker } from './automationWorker';

const MONITOR_AUTOMATION = {
  id: 'auto-monitor-1',
  orgId: 'org-1',
  partnerId: null,
  name: '[monitor] Disk over 80%',
  enabled: true,
  managedByAgentId: null,
  managedByMonitorId: 'monitor-1',
  trigger: { type: 'event', event: 'alert.triggered', filter: { ruleId: 'rule-1' } },
};

const BASE_EVENT = {
  type: 'trigger-event' as const,
  automationId: 'auto-monitor-1',
  eventType: 'alert.triggered',
  eventId: 'evt-1',
  eventTimestamp: '2026-08-24T12:00:00.000Z',
};

function mockAutomation(row: Record<string, unknown>) {
  selectMock.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([row]),
      }),
    }),
  });
}

function mockUnmanagedAutomation(row: Record<string, unknown>) {
  for (const rows of [[row], [{ orgId: row.orgId, partnerId: row.partnerId }]]) {
    selectMock.mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(rows),
    });
  }
}

describe('monitor-managed automation event-target binding (#5289)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queue-job-1' });
    createAutomationRunRecordMock.mockResolvedValue({
      run: { id: 'run-1' },
      targetDeviceIds: ['dev-1'],
    });
    executeAutomationRunMock.mockResolvedValue({
      status: 'completed',
      devicesSucceeded: 1,
      devicesFailed: 0,
    });
    await shutdownAutomationWorker();
  });

  it('binds the run to the alerting device instead of fanning out to the org', async () => {
    mockAutomation(MONITOR_AUTOMATION);

    await __testOnly.processTriggerEvent({
      ...BASE_EVENT,
      eventPayload: { alertId: 'alert-1', ruleId: 'rule-1', deviceId: 'dev-1', severity: 'high' },
    });

    expect(createAutomationRunRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({ boundDeviceIds: ['dev-1'] }),
    );
  });

  it('skips a device-less event rather than fanning out', async () => {
    mockAutomation(MONITOR_AUTOMATION);

    const result = await __testOnly.processTriggerEvent({
      ...BASE_EVENT,
      eventPayload: { alertId: 'alert-1', ruleId: 'rule-1', severity: 'high' },
    });

    expect(result).toEqual({ skipped: 'managed_automation_event_has_no_device' });
    expect(createAutomationRunRecordMock).not.toHaveBeenCalled();
  });

  it('does NOT skip an automation-created alert — that guard is the ai_triage feedback-loop rule', async () => {
    mockAutomation(MONITOR_AUTOMATION);

    await __testOnly.processTriggerEvent({
      ...BASE_EVENT,
      eventPayload: {
        alertId: 'alert-1',
        ruleId: 'rule-1',
        deviceId: 'dev-1',
        automationId: 'auto-x',
        severity: 'high',
      },
    });

    expect(createAutomationRunRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({ boundDeviceIds: ['dev-1'] }),
    );
  });

  it('a row whose managedByMonitorId is absent is treated as UNMANAGED: bound to the event device, no triggerContext', async () => {
    const { managedByMonitorId: _omitted, ...withoutColumn } = MONITOR_AUTOMATION;
    mockUnmanagedAutomation(withoutColumn);

    await __testOnly.processTriggerEvent({
      ...BASE_EVENT,
      eventPayload: { alertId: 'alert-1', ruleId: 'rule-1', deviceId: 'dev-1', severity: 'high' },
    });

    const createOptions = createAutomationRunRecordMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(createOptions.boundDeviceIds).toEqual(['dev-1']);
    expect('triggerContext' in addMock.mock.calls[0]?.[1]).toBe(false);
  });
});
