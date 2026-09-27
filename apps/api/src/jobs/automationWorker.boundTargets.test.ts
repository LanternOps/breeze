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
  normalizeAutomationTrigger: vi.fn((trigger) => trigger),
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

const { getUserPermissionsMock, canAccessSiteMock } = vi.hoisted(() => ({
  getUserPermissionsMock: vi.fn(),
  canAccessSiteMock: vi.fn(),
}));

vi.mock('../services/permissions', () => ({
  getUserPermissions: getUserPermissionsMock,
  canAccessSite: canAccessSiteMock,
}));

import { automationQueueJobDataSchema } from './queueSchemas';
import { __testOnly, shutdownAutomationWorker } from './automationWorker';

const BASE_AUTOMATION = {
  id: 'auto-1',
  orgId: 'org-1',
  partnerId: null,
  name: 'Managed alert triage',
  enabled: true,
  managedByAgentId: 'agent-1',
  trigger: { type: 'event', eventType: 'alert.triggered' },
};

const BASE_EVENT = {
  type: 'trigger-event' as const,
  automationId: 'auto-1',
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

function mockUnmanagedAutomation(row: Record<string, unknown>, deviceSiteId?: string) {
  const deviceRow = { orgId: row.orgId, partnerId: row.partnerId, siteId: deviceSiteId ?? null };
  for (const rows of [[row], [deviceRow]]) {
    selectMock.mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(rows),
    });
  }
}

describe('managed automation event-target binding (#3824)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queue-job-1' });
    createAutomationRunRecordMock.mockResolvedValue({
      run: { id: 'run-1' },
      targetDeviceIds: ['configured-device-1', 'configured-device-2'],
    });
    executeAutomationRunMock.mockResolvedValue({
      status: 'completed',
      devicesSucceeded: 1,
      devicesFailed: 0,
    });
    await shutdownAutomationWorker();
  });

  it('managed automation binds the run to the event device', async () => {
    mockAutomation(BASE_AUTOMATION);

    await __testOnly.processTriggerEvent({
      ...BASE_EVENT,
      eventPayload: {
        alertId: 'alert-1',
        ruleId: 'rule-1',
        deviceId: 'dev-1',
        severity: 'high',
      },
    });

    expect(createAutomationRunRecordMock).toHaveBeenCalledWith(expect.objectContaining({
      automation: BASE_AUTOMATION,
      boundDeviceIds: ['dev-1'],
    }));
    expect(addMock).toHaveBeenCalledWith(
      'execute-run',
      expect.objectContaining({
        runId: 'run-1',
        targetDeviceIds: ['configured-device-1', 'configured-device-2'],
        triggerContext: {
          alertId: 'alert-1',
          eventId: 'evt-1',
          severity: 'high',
          ruleId: 'rule-1',
        },
      }),
      expect.anything(),
    );
  });

  it('managed automation skips a device-less event', async () => {
    mockAutomation(BASE_AUTOMATION);

    const result = await __testOnly.processTriggerEvent({
      ...BASE_EVENT,
      eventPayload: { alertId: 'alert-1', severity: 'high' },
    });

    expect(result).toEqual({ skipped: 'managed_automation_event_has_no_device' });
    expect(createAutomationRunRecordMock).not.toHaveBeenCalled();
  });

  it('managed automation skips automation-created alerts', async () => {
    mockAutomation(BASE_AUTOMATION);

    const result = await __testOnly.processTriggerEvent({
      ...BASE_EVENT,
      eventPayload: {
        alertId: 'alert-1',
        deviceId: 'dev-1',
        automationId: 'auto-x',
        severity: 'high',
      },
    });

    expect(result).toEqual({ skipped: 'managed_automation_skips_automation_created_alerts' });
    expect(createAutomationRunRecordMock).not.toHaveBeenCalled();
  });

  it('unmanaged automation binds to the event device without triggerContext', async () => {
    const automation = { ...BASE_AUTOMATION, managedByAgentId: null };
    mockUnmanagedAutomation(automation);
    createAutomationRunRecordMock.mockResolvedValue({
      run: { id: 'run-1' },
      targetDeviceIds: ['dev-1'],
    });

    await __testOnly.processTriggerEvent({
      ...BASE_EVENT,
      eventPayload: {
        alertId: 'alert-1',
        ruleId: 'rule-1',
        deviceId: 'dev-1',
        severity: 'high',
      },
    });

    const createOptions = createAutomationRunRecordMock.mock.calls[0]?.[0];
    expect(createOptions).toEqual({
      automation,
      boundDeviceIds: ['dev-1'],
      triggeredBy: 'event:alert.triggered',
      details: {
        eventId: 'evt-1',
        eventType: 'alert.triggered',
        eventTimestamp: '2026-08-24T12:00:00.000Z',
      },
      // #3189 — one run per (automation, event): a replayed trigger job gets
      // the existing run back instead of minting a second one.
      occurrenceKey: 'event:evt-1',
    });
    expect(createOptions.boundDeviceIds).toEqual(['dev-1']);
    expect(selectMock).toHaveBeenCalledTimes(2);
    const jobData = addMock.mock.calls[0]?.[1];
    expect(jobData.targetDeviceIds).toEqual(['dev-1']);
    expect('triggerContext' in jobData).toBe(false);
  });

  it('skips an event-triggered run when the device sits outside the creator\'s current site ceiling', async () => {
    const automation = { ...BASE_AUTOMATION, managedByAgentId: null, createdBy: 'user-1' };
    mockUnmanagedAutomation(automation, 'site-hidden');
    getUserPermissionsMock.mockResolvedValue({ allowedSiteIds: ['site-visible'] });
    canAccessSiteMock.mockReturnValue(false);

    const result = await __testOnly.processTriggerEvent({
      ...BASE_EVENT,
      eventPayload: { alertId: 'alert-1', deviceId: 'dev-1', severity: 'high' },
    });

    expect(result).toEqual({ skipped: 'event_device_outside_automation_site_ceiling' });
    expect(createAutomationRunRecordMock).not.toHaveBeenCalled();
  });

  it('binds an event-triggered run when the device is inside the creator\'s current site ceiling', async () => {
    const automation = { ...BASE_AUTOMATION, managedByAgentId: null, createdBy: 'user-1' };
    mockUnmanagedAutomation(automation, 'site-visible');
    getUserPermissionsMock.mockResolvedValue({ allowedSiteIds: ['site-visible'] });
    canAccessSiteMock.mockReturnValue(true);
    createAutomationRunRecordMock.mockResolvedValue({ run: { id: 'run-1' }, targetDeviceIds: ['dev-1'] });

    await __testOnly.processTriggerEvent({
      ...BASE_EVENT,
      eventPayload: { alertId: 'alert-1', deviceId: 'dev-1', severity: 'high' },
    });

    const createOptions = createAutomationRunRecordMock.mock.calls[0]?.[0];
    expect(createOptions.boundDeviceIds).toEqual(['dev-1']);
  });

  it('does not re-check site scope for an unrestricted creator (allowedSiteIds unset)', async () => {
    const automation = { ...BASE_AUTOMATION, managedByAgentId: null, createdBy: 'user-1' };
    mockUnmanagedAutomation(automation, 'site-any');
    getUserPermissionsMock.mockResolvedValue({ allowedSiteIds: undefined });
    createAutomationRunRecordMock.mockResolvedValue({ run: { id: 'run-1' }, targetDeviceIds: ['dev-1'] });

    await __testOnly.processTriggerEvent({
      ...BASE_EVENT,
      eventPayload: { alertId: 'alert-1', deviceId: 'dev-1', severity: 'high' },
    });

    expect(canAccessSiteMock).not.toHaveBeenCalled();
    const createOptions = createAutomationRunRecordMock.mock.calls[0]?.[0];
    expect(createOptions.boundDeviceIds).toEqual(['dev-1']);
  });

  it('a row whose managedByAgentId is absent is treated as UNMANAGED: bound to the event device, no triggerContext', async () => {
    // Guards the fail-toward-unmanaged branch in processTriggerEvent: a
    // partially-selected automation row still binds to the event device, but
    // must not acquire managed-only triggerContext.
    const { managedByAgentId: _managed, ...withoutColumn } = BASE_AUTOMATION;
    mockUnmanagedAutomation(withoutColumn);

    await __testOnly.processTriggerEvent({
      ...BASE_EVENT,
      eventPayload: { alertId: 'alert-1', deviceId: 'dev-1', severity: 'high' },
    });

    const createOptions = createAutomationRunRecordMock.mock.calls[0]?.[0];
    expect(createOptions.boundDeviceIds).toEqual(['dev-1']);
    expect('triggerContext' in addMock.mock.calls[0]?.[1]).toBe(false);
  });

  it('an unrecognised severity is coerced to null rather than dead-lettering the run', async () => {
    mockAutomation(BASE_AUTOMATION);

    await __testOnly.processTriggerEvent({
      ...BASE_EVENT,
      eventPayload: {
        alertId: 'alert-1',
        ruleId: 'rule-1',
        deviceId: 'dev-1',
        severity: 'bogus',
      },
    });

    const jobData = addMock.mock.calls[0]?.[1];
    expect(jobData.triggerContext.severity).toBeNull();
    expect(automationQueueJobDataSchema.parse(jobData)).toEqual(jobData);
  });

  it('processExecuteRun forwards triggerContext to executeAutomationRun', async () => {
    const triggerContext = {
      alertId: 'alert-1',
      eventId: 'evt-1',
      severity: 'medium' as const,
      ruleId: null,
    };

    await __testOnly.processExecuteRun({
      type: 'execute-run',
      runId: 'run-1',
      targetDeviceIds: ['dev-1'],
      triggerContext,
    });

    expect(executeAutomationRunMock).toHaveBeenCalledWith(
      'run-1',
      ['dev-1'],
      triggerContext,
    );
  });
});
