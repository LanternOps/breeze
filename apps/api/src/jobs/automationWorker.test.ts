import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { devices, organizations } from '../db/schema';

const { selectMock, createRunMock, addMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  createRunMock: vi.fn(),
  addMock: vi.fn(async () => ({ id: 'queued-job' })),
}));

vi.mock('../db', () => ({
  db: { select: selectMock },
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock('../services/automationRuntime', async () => ({
  isCronDue: (await import('../services/cronDue')).isCronDue,
  normalizeAutomationTrigger: vi.fn((trigger: unknown) => trigger),
  createAutomationRunRecord: createRunMock,
  executeAutomationRun: vi.fn(),
  executeConfigPolicyAutomationRun: vi.fn(),
  formatScheduleTriggerKey: vi.fn(),
}));
vi.mock('../services/featureConfigResolver', () => ({
  resolveAutomationsForDeviceWithPolicy: vi.fn(),
  resolveMaintenanceConfigForDevice: vi.fn(),
  isInMaintenanceWindow: vi.fn(),
}));
vi.mock('../services/monitors/conversion/workflows', () => ({ policyWorkflowApplies: vi.fn() }));
import { policyWorkflowApplies } from '../services/monitors/conversion/workflows';
import { resolveAutomationsForDeviceWithPolicy, resolveMaintenanceConfigForDevice, isInMaintenanceWindow } from '../services/featureConfigResolver';
vi.mock('../services/monitors/episodeService', () => ({ recordEpisodeResponse: vi.fn() }));
vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({})),
  isRedisAvailable: vi.fn(() => true),
}));
vi.mock('bullmq', () => ({
  Queue: class {
    getJob = vi.fn(async () => undefined);
    add = addMock;
  },
  Worker: class {},
}));
import {
  __testOnly,
  queueEventTriggers,
  collectDueConfigPolicyScheduleDispatches,
  shouldTriggerEventAutomation,
  shouldTriggerScheduleAutomation,
} from './automationWorker';

describe('automationWorker trigger helpers', () => {
  it('matches due schedule slots using cron + timezone', () => {
    const trigger = {
      type: 'schedule' as const,
      cronExpression: '0 * * * *',
      timezone: 'UTC',
    };

    expect(shouldTriggerScheduleAutomation(trigger, new Date('2026-01-01T10:00:00Z'))).toBe(true);
    expect(shouldTriggerScheduleAutomation(trigger, new Date('2026-01-01T10:01:00Z'))).toBe(false);
  });

  it('matches event triggers with nested filter values', () => {
    const trigger = {
      type: 'event' as const,
      eventType: 'device.offline',
      filter: {
        'device.siteId': 'site-1',
        'device.tags': ['prod', 'linux'],
      },
    };

    const payload = {
      device: {
        siteId: 'site-1',
        tags: ['prod', 'linux', 'critical'],
      },
    };

    expect(shouldTriggerEventAutomation(trigger, 'device.offline', payload)).toBe(true);
  });

  it('rejects event triggers when type or filter mismatch', () => {
    const trigger = {
      type: 'event' as const,
      eventType: 'device.offline',
      filter: {
        'device.siteId': 'site-1',
      },
    };

    expect(shouldTriggerEventAutomation(trigger, 'device.online', { device: { siteId: 'site-1' } })).toBe(false);
    expect(shouldTriggerEventAutomation(trigger, 'device.offline', { device: { siteId: 'site-2' } })).toBe(false);
  });

  it('deduplicates due config-policy schedule dispatches by automation per slot', () => {
    const scanDate = new Date('2026-01-01T10:00:00Z');
    const baseAutomation = {
      id: 'cp-auto-1',
      name: 'Patching',
      cronExpression: '0 * * * *',
      timezone: 'UTC',
    };

    const dispatches = collectDueConfigPolicyScheduleDispatches([
      {
        automation: baseAutomation as any,
        assignmentLevel: 'organization',
        assignmentTargetId: 'org-1',
        policyId: 'policy-1',
        policyName: 'Policy 1',
      } as any,
      {
        automation: baseAutomation as any,
        assignmentLevel: 'site',
        assignmentTargetId: 'site-1',
        policyId: 'policy-1',
        policyName: 'Policy 1',
      } as any,
      {
        automation: {
          ...baseAutomation,
          id: 'cp-auto-2',
          cronExpression: '15 * * * *',
        } as any,
        assignmentLevel: 'organization',
        assignmentTargetId: 'org-1',
        policyId: 'policy-2',
        policyName: 'Policy 2',
      } as any,
    ], scanDate);

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.configPolicyAutomationId).toBe('cp-auto-1');
    expect(dispatches[0]?.assignmentTargets).toEqual(
      expect.arrayContaining([
        { level: 'organization', targetId: 'org-1' },
        { level: 'site', targetId: 'site-1' },
      ]),
    );
  });
});


describe('processTriggerEvent device binding', () => {
  const deviceId = '11111111-1111-4111-8111-111111111111';
  const orgId = '22222222-2222-4222-8222-222222222222';
  const partnerId = '33333333-3333-4333-8333-333333333333';
  const automation = {
    id: '44444444-4444-4444-8444-444444444444',
    orgId,
    partnerId: null,
    managedByAgentId: null,
    managedByMonitorId: null,
    trigger: { type: 'event', eventType: 'alert.triggered' },
    conditions: { deviceIds: [deviceId, '55555555-5555-4555-8555-555555555555'] },
  };
  const event = (eventPayload: Record<string, unknown>) => ({
    type: 'trigger-event' as const,
    automationId: automation.id,
    eventType: 'alert.triggered',
    eventId: 'event-1',
    eventTimestamp: '2026-09-15T12:00:00Z',
    eventPayload,
  });

  function selectRows(rows: unknown[]) {
    const query = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(rows),
    };
    selectMock.mockReturnValueOnce(query);
    return query;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    createRunMock.mockResolvedValue({ run: { id: 'run-1' }, targetDeviceIds: [deviceId] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('binds an unmanaged automation to exactly the triggering device', async () => {
    selectRows([automation]);
    const lookup = selectRows([{ id: deviceId, orgId, partnerId }]);

    expect(await __testOnly.processTriggerEvent(event({ deviceId }))).toEqual({ runId: 'run-1' });
    expect(createRunMock).toHaveBeenCalledWith(expect.objectContaining({ boundDeviceIds: [deviceId] }));
    expect(lookup.from).toHaveBeenCalledWith(devices);
    expect(lookup.innerJoin).toHaveBeenCalledWith(organizations, eq(devices.orgId, organizations.id));
    expect(lookup.where).toHaveBeenCalledWith(eq(devices.id, deviceId));
    expect(selectMock).toHaveBeenLastCalledWith({ orgId: devices.orgId, partnerId: organizations.partnerId });
  });

  it.each([
    ['cross-org', { id: deviceId, orgId: '66666666-6666-4666-8666-666666666666', partnerId }],
    ['missing', undefined],
  ])('skips and logs a %s device instead of widening the run', async (_label, device) => {
    selectRows([automation]);
    selectRows(device ? [device] : []);

    expect(await __testOnly.processTriggerEvent(event({ deviceId }))).toEqual({ skipped: 'event_device_outside_automation_scope' });
    expect(createRunMock).not.toHaveBeenCalled();
    expect(addMock).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('event_device_outside_automation_scope'));
  });

  it.each([undefined, 123])('keeps static-condition fallback without a string deviceId (%s)', async (value) => {
    selectRows([automation]);

    await __testOnly.processTriggerEvent(event(value === undefined ? {} : { deviceId: value }));

    expect(createRunMock).toHaveBeenCalledWith(expect.objectContaining({ automation }));
    expect(createRunMock.mock.calls[0]![0]).not.toHaveProperty('boundDeviceIds');
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('checks partner ownership for partner-wide automations (matches: %s)', async (matches) => {
    selectRows([{ ...automation, orgId: null, partnerId }]);
    selectRows([{ id: deviceId, orgId, partnerId: matches ? partnerId : '77777777-7777-4777-8777-777777777777' }]);

    const result = await __testOnly.processTriggerEvent(event({ deviceId }));

    if (matches) {
      expect(result).toEqual({ runId: 'run-1' });
      expect(createRunMock).toHaveBeenCalledWith(expect.objectContaining({ boundDeviceIds: [deviceId] }));
    } else {
      expect(result).toEqual({ skipped: 'event_device_outside_automation_scope' });
      expect(createRunMock).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalled();
    }
  });

  it('preserves agent-managed binding and trigger context without another lookup', async () => {
    selectRows([{ ...automation, managedByAgentId: 'agent-1' }]);
    await __testOnly.processTriggerEvent(event({ deviceId, alertId: 'alert-1', severity: 'critical' }));
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(createRunMock).toHaveBeenCalledWith(expect.objectContaining({ boundDeviceIds: [deviceId] }));
    expect(addMock).toHaveBeenCalledWith('execute-run', expect.objectContaining({
      triggerContext: { alertId: 'alert-1', eventId: 'event-1', severity: 'critical', ruleId: null },
    }), expect.any(Object));
  });

  it('preserves the managed missing-device skip', async () => {
    selectRows([{ ...automation, managedByAgentId: 'agent-1' }]);
    expect(await __testOnly.processTriggerEvent(event({}))).toEqual({ skipped: 'managed_automation_event_has_no_device' });
    expect(createRunMock).not.toHaveBeenCalled();
  });
});

describe('rehomed policy workflow events', () => {
  const workflow = { id: 'workflow', orgId: 'org', partnerId: null, trigger: {
    type: 'event', eventType: 'alert.triggered', filter: {
      severity: 'critical', _policyWorkflow: { policyId: 'policy', sourceId: 'source' },
    },
  } };
  const payload = { deviceId: 'device', ruleId: 'unrelated-rule', severity: 'critical' };
  const event = { id: 'event', orgId: 'org', type: 'alert.triggered', payload, metadata: { timestamp: '2026-09-20T00:00:00Z' } };
  const job = { type: 'trigger-event' as const, automationId: workflow.id, eventType: event.type, eventId: event.id, eventPayload: payload, eventTimestamp: event.metadata.timestamp };
  function rows(result: unknown[]) {
    const q: any = { from: vi.fn().mockReturnThis(), innerJoin: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue(result), then: (yes: any, no: any) => Promise.resolve(result).then(yes, no) };
    selectMock.mockReturnValueOnce(q);
  }
  beforeEach(() => {
    vi.clearAllMocks(); selectMock.mockReset();
    vi.mocked(policyWorkflowApplies).mockResolvedValue(true);
    vi.mocked(resolveMaintenanceConfigForDevice).mockResolvedValue(null);
    vi.mocked(resolveAutomationsForDeviceWithPolicy).mockResolvedValue({ configPolicyId: 'policy', automations: [{ id: 'source', enabled: true, retiredAt: new Date(), triggerType: 'event', eventType: event.type } as never] });
    createRunMock.mockResolvedValue({ run: { id: 'run' }, targetDeviceIds: ['device'] });
  });
  it('queues unrelated-rule alerts once, excludes retired policy jobs, and rechecks reassignment', async () => {
    rows([{ partnerId: 'partner' }]); rows([workflow]);
    await queueEventTriggers(event as never);
    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledWith('trigger-event', expect.objectContaining({ automationId: 'workflow', eventPayload: payload }), expect.objectContaining({ jobId: 'automation-event-workflow-event' }));
    addMock.mockClear();
    vi.mocked(policyWorkflowApplies).mockResolvedValue(false);
    rows([{ partnerId: 'partner' }]); rows([workflow]);
    await queueEventTriggers(event as never);
    expect(addMock).not.toHaveBeenCalled();
    rows([workflow]);
    expect(await __testOnly.processTriggerEvent(job)).toEqual({ skipped: 'policy_workflow_not_assigned' });
    expect(createRunMock).not.toHaveBeenCalled();
  });
  it('executes on the triggering device after removing only assignment metadata', async () => {
    rows([workflow]); rows([{ orgId: 'org', partnerId: 'partner' }]);
    expect(await __testOnly.processTriggerEvent(job)).toEqual({ runId: 'run' });
    expect(createRunMock).toHaveBeenCalledWith(expect.objectContaining({ boundDeviceIds: ['device'] }));
    rows([workflow]);
    expect(await __testOnly.processTriggerEvent({ ...job, eventPayload: { ...payload, severity: 'low' } })).toEqual({ skipped: 'filter_mismatch' });
  });
  it.each(['maintenance', 'lookup failure', 'missing device'])('suppresses queue and execution for %s', async (reason) => {
    if (reason === 'maintenance') {
      vi.mocked(resolveMaintenanceConfigForDevice).mockResolvedValue({} as never);
      vi.mocked(isInMaintenanceWindow).mockReturnValue({ active: true, suppressAutomations: true } as never);
    } else if (reason === 'lookup failure') {
      vi.mocked(resolveMaintenanceConfigForDevice).mockRejectedValue(new Error('unavailable'));
    }
    const p = reason === 'missing device' ? { severity: 'critical' } : payload;
    rows([{ partnerId: 'partner' }]); rows([workflow]);
    await queueEventTriggers({ ...event, payload: p } as never);
    expect(addMock).not.toHaveBeenCalled();
    rows([workflow]);
    expect(await __testOnly.processTriggerEvent({ ...job, eventPayload: p })).toHaveProperty('skipped');
    expect(createRunMock).not.toHaveBeenCalled();
  });
});
