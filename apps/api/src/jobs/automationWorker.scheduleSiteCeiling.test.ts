import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMock,
  closeMock,
  createAutomationRunRecordMock,
  checkAutomationTargetsWithinSiteScopeMock,
  resolveAutomationTargetDeviceIdsMock,
  getJobMock,
  selectMock,
  getUserPermissionsMock,
  writeAuditEventMock,
  isCronDueMock,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  closeMock: vi.fn(),
  createAutomationRunRecordMock: vi.fn(),
  checkAutomationTargetsWithinSiteScopeMock: vi.fn(),
  resolveAutomationTargetDeviceIdsMock: vi.fn(),
  getJobMock: vi.fn(),
  selectMock: vi.fn(),
  getUserPermissionsMock: vi.fn(),
  writeAuditEventMock: vi.fn(),
  isCronDueMock: vi.fn(() => true),
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
  executeAutomationRun: vi.fn(),
  executeConfigPolicyAutomationRun: vi.fn(),
  formatScheduleTriggerKey: vi.fn(),
  isCronDue: isCronDueMock,
  normalizeAutomationTrigger: vi.fn((trigger) => trigger),
  checkAutomationTargetsWithinSiteScope: checkAutomationTargetsWithinSiteScopeMock,
  resolveAutomationTargetDeviceIds: resolveAutomationTargetDeviceIdsMock,
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

vi.mock('../services/permissions', () => ({
  getUserPermissions: getUserPermissionsMock,
  canAccessSite: vi.fn(),
}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: writeAuditEventMock,
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
}));

import { __testOnly, shutdownAutomationWorker } from './automationWorker';

const BASE_AUTOMATION = {
  id: 'auto-sched-1',
  orgId: 'org-1',
  partnerId: null,
  name: 'Site-restricted schedule automation',
  enabled: true,
  managedByAgentId: null,
  createdBy: 'user-1',
  trigger: { type: 'schedule', cronExpression: '0 * * * *', timezone: 'UTC' },
  conditions: { type: 'groups', groupIds: ['group-1'] },
};

const BASE_JOB = {
  type: 'trigger-schedule' as const,
  automationId: 'auto-sched-1',
  slotKey: '2026-09-25T00:00',
  scanAt: '2026-09-25T00:00:00.000Z',
};

function mockAutomationRow(row: Record<string, unknown>) {
  selectMock.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([row]),
      }),
    }),
  });
}

describe('schedule-triggered automation runs recheck the creator\'s current site ceiling', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queue-job-1' });
    createAutomationRunRecordMock.mockResolvedValue({
      run: { id: 'run-1' },
      targetDeviceIds: ['dev-in-scope'],
    });
    await shutdownAutomationWorker();
  });

  it('drops devices outside the creator\'s current site ceiling and audits the drop', async () => {
    mockAutomationRow(BASE_AUTOMATION);
    getUserPermissionsMock.mockResolvedValue({ allowedSiteIds: ['site-visible'] });
    checkAutomationTargetsWithinSiteScopeMock.mockResolvedValue({
      ok: false,
      outOfScopeDeviceIds: ['dev-out-of-scope'],
      unbounded: false,
      restricted: true,
      targetDeviceIds: ['dev-in-scope', 'dev-out-of-scope'],
    });
    resolveAutomationTargetDeviceIdsMock.mockResolvedValue(['dev-in-scope', 'dev-out-of-scope']);

    await __testOnly.processTriggerSchedule(BASE_JOB);

    expect(createAutomationRunRecordMock).toHaveBeenCalledWith(expect.objectContaining({
      automation: BASE_AUTOMATION,
      boundDeviceIds: ['dev-in-scope'],
    }));
    // Field-provenance/TOCTOU: the bound set must come from the SAME resolution the
    // site-scope check made, not a second independent resolution.
    expect(resolveAutomationTargetDeviceIdsMock).not.toHaveBeenCalled();
    expect(writeAuditEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      resourceType: 'automation',
      resourceId: 'auto-sched-1',
      details: expect.objectContaining({ droppedDeviceIds: ['dev-out-of-scope'] }),
    }));
  });

  it('skips the run entirely when every resolved target sits outside the ceiling', async () => {
    mockAutomationRow(BASE_AUTOMATION);
    getUserPermissionsMock.mockResolvedValue({ allowedSiteIds: ['site-visible'] });
    checkAutomationTargetsWithinSiteScopeMock.mockResolvedValue({
      ok: false,
      outOfScopeDeviceIds: ['dev-out-of-scope'],
      unbounded: false,
      restricted: true,
      targetDeviceIds: ['dev-out-of-scope'],
    });
    resolveAutomationTargetDeviceIdsMock.mockResolvedValue(['dev-out-of-scope']);

    const result = await __testOnly.processTriggerSchedule(BASE_JOB);

    expect(result).toEqual({ skipped: 'schedule_targets_all_outside_site_ceiling' });
    expect(createAutomationRunRecordMock).not.toHaveBeenCalled();
  });

  it('does not re-check for an unrestricted creator (allowedSiteIds unset)', async () => {
    mockAutomationRow(BASE_AUTOMATION);
    getUserPermissionsMock.mockResolvedValue({ allowedSiteIds: undefined });

    await __testOnly.processTriggerSchedule(BASE_JOB);

    expect(checkAutomationTargetsWithinSiteScopeMock).not.toHaveBeenCalled();
    expect(createAutomationRunRecordMock).toHaveBeenCalledWith(expect.objectContaining({
      automation: BASE_AUTOMATION,
    }));
    const callArgs = createAutomationRunRecordMock.mock.calls[0]?.[0];
    expect('boundDeviceIds' in callArgs).toBe(false);
  });

  it('leaves an in-scope run unaffected (no dropped devices)', async () => {
    mockAutomationRow(BASE_AUTOMATION);
    getUserPermissionsMock.mockResolvedValue({ allowedSiteIds: ['site-visible'] });
    checkAutomationTargetsWithinSiteScopeMock.mockResolvedValue({
      ok: true,
      outOfScopeDeviceIds: [],
      unbounded: false,
    });

    await __testOnly.processTriggerSchedule(BASE_JOB);

    expect(writeAuditEventMock).not.toHaveBeenCalled();
    const callArgs = createAutomationRunRecordMock.mock.calls[0]?.[0];
    expect('boundDeviceIds' in callArgs).toBe(false);
  });
});
