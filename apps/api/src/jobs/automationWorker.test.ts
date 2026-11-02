import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { devices, organizations } from '../db/schema';
import { metricsRegistry } from '../services/metricsRegistry';

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
// #5221 B2 — the ledger reads are mocked (no conversion by default, so every
// pre-existing case below runs today's path); the preference rule and the
// error class are the real ones.
vi.mock('../services/flows/conversion/claims', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/flows/conversion/claims')>()),
  currentConversionForAutomation: vi.fn(async () => null),
  claimOccurrence: vi.fn(async () => ({ ok: true })),
  loadSwitchedConvertedAutomations: vi.fn(async () => []),
  reportOccurrenceAnomaly: vi.fn(),
}));
import {
  claimOccurrence,
  currentConversionForAutomation,
  loadSwitchedConvertedAutomations,
  reportOccurrenceAnomaly,
} from '../services/flows/conversion/claims';
// #5221 B4 — the shadow writes are mocked; the trigger comparison is the real one.
vi.mock('../services/flows/conversion/shadow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/flows/conversion/shadow')>()),
  recordShadow: vi.fn(async () => true),
  observeShadowRun: vi.fn(async () => undefined),
}));
import { observeShadowRun, recordShadow } from '../services/flows/conversion/shadow';
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

  it('matches alert dimensions conjunctively, choices disjunctively, and preserves ruleId', () => {
    const trigger = {
      type: 'event' as const,
      eventType: 'alert.triggered',
      filter: { severity: ['critical', 'high'], kind: ['cpu', 'memory'], ruleId: 'r1' },
    };

    for (const severity of ['critical', 'high']) {
      expect(shouldTriggerEventAutomation(trigger, 'alert.triggered', { severity, kind: 'cpu', ruleId: 'r1' })).toBe(true);
    }

    for (const payload of [
      { severity: 'low', kind: 'cpu', ruleId: 'r1' },
      { severity: 'high', ruleId: 'r1' },
      { severity: 'high', kind: 'cpu', ruleId: 'r2' },
    ]) {
      expect(shouldTriggerEventAutomation(trigger, 'alert.triggered', payload)).toBe(false);
    }

    expect(shouldTriggerEventAutomation({ ...trigger, filter: {} }, 'alert.triggered', {})).toBe(true);
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
    eventOrgId: orgId,
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
    expect(selectMock).toHaveBeenLastCalledWith({ orgId: devices.orgId, partnerId: organizations.partnerId, siteId: devices.siteId });
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

  it.each([
    ['org alert automation', { ...automation, conditions: null }],
    ['partner-wide alert automation', { ...automation, orgId: null, partnerId, conditions: null }],
    ['automation with explicit device targets', { ...automation, conditions: { type: 'devices', deviceIds: [deviceId] } }],
  ])('skips an %s for a device-less alert', async (_label, row) => {
    selectRows([row]);
    const metric = metricsRegistry.getSingleMetric('alert_device_consumer_skipped_total');
    const before = (await metric?.get())?.values.find(v => v.labels.consumer === 'automation')?.value ?? 0;
    const result = await __testOnly.processTriggerEvent(event({
      alertId: 'alert-1', deviceId: null, owner: { kind: 'backup_workload', ref: 'workload-1' },
    }));
    expect(result).toEqual({ skipped: 'alert_has_no_device' });
    expect(createRunMock).not.toHaveBeenCalled();
    expect(addMock).not.toHaveBeenCalled();
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(automation.id), expect.objectContaining({
      reason: 'alert_has_no_device', alertId: 'alert-1', eventId: 'event-1', orgId,
      owner: { kind: 'backup_workload', ref: 'workload-1' },
    }));
    expect((await metricsRegistry.getSingleMetric('alert_device_consumer_skipped_total')?.get())?.values
      .find(v => v.labels.consumer === 'automation')?.value).toBe(before + 1);
  });

  it.each([undefined, 123])('skips an alert without a string deviceId (%s)', async (value) => {
    selectRows([automation]);
    expect(await __testOnly.processTriggerEvent(event(value === undefined ? {} : { deviceId: value })))
      .toEqual({ skipped: 'alert_has_no_device' });
    expect(createRunMock).not.toHaveBeenCalled();
  });

  it('keeps static-condition fallback for non-alert events', async () => {
    const row = { ...automation, trigger: { type: 'event', eventType: 'backup.completed' } };
    selectRows([row]);
    await __testOnly.processTriggerEvent({ ...event({}), eventType: 'backup.completed' });
    expect(createRunMock).toHaveBeenCalledWith(expect.objectContaining({ automation: row }));
    expect(createRunMock.mock.calls[0]?.[0]).not.toHaveProperty('boundDeviceIds');
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

  it('uses the alert missing-device skip for managed automations', async () => {
    selectRows([{ ...automation, managedByAgentId: 'agent-1' }]);
    expect(await __testOnly.processTriggerEvent(event({}))).toEqual({ skipped: 'alert_has_no_device' });
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

describe('occurrence claims across the cutover (#5221 B2)', () => {
  const ORG = '22222222-2222-4222-8222-222222222222';
  const AUTO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const CONV = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const EVENT_UUID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const FLOW_RUN = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const switchAt = new Date('2026-09-15T12:00:00Z');
  const switched = { id: CONV, state: 'switched' as const, switchAt };
  const standalone = {
    id: AUTO, orgId: ORG, partnerId: null, createdBy: null, managedByAgentId: null, managedByMonitorId: null,
    trigger: { type: 'event', eventType: 'device.offline' }, conditions: {},
  };
  const job = (over: Record<string, unknown> = {}) => ({
    type: 'trigger-event' as const, automationId: AUTO, eventType: 'device.offline', eventId: EVENT_UUID,
    eventTimestamp: '2026-09-15T12:00:30.000Z', eventPayload: {}, ...over,
  });
  function rows(result: unknown[]) {
    const q: any = {
      from: vi.fn().mockReturnThis(), innerJoin: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(result), then: (yes: any, no: any) => Promise.resolve(result).then(yes, no),
    };
    selectMock.mockReturnValueOnce(q);
    return q;
  }
  /** createAutomationRunRecord, with its onCreated hook run the way the real one runs it: inside its transaction, after the insert. */
  function runRecordCallingHook(runId = 'run-1') {
    createRunMock.mockImplementation(async (options: { onCreated?: (tx: unknown, run: { id: string }) => Promise<void> }) => {
      if (options.onCreated) await options.onCreated({ tx: true }, { id: runId });
      return { run: { id: runId }, targetDeviceIds: [], reused: false };
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    createRunMock.mockReset();
    vi.mocked(currentConversionForAutomation).mockReset().mockResolvedValue(null);
    vi.mocked(claimOccurrence).mockReset().mockResolvedValue({ ok: true });
    vi.mocked(loadSwitchedConvertedAutomations).mockReset().mockResolvedValue([]);
    vi.mocked(reportOccurrenceAnomaly).mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('job enqueued while unswitched is admitted after the switch when unclaimed', async () => {
    rows([standalone]);
    vi.mocked(currentConversionForAutomation).mockResolvedValue(switched);
    runRecordCallingHook();

    // No enqueuedWhileUnswitched on the job: an older job, or one the fan-out
    // enqueued while the row was unswitched. Its instant is after switch_at.
    expect(await __testOnly.processTriggerEvent(job())).toEqual({ runId: 'run-1' });
    expect(claimOccurrence).toHaveBeenCalledTimes(1);
    expect(vi.mocked(claimOccurrence).mock.calls[0]![1]).toEqual({
      automationId: AUTO,
      owner: { orgId: ORG, partnerId: null },
      keys: [`event:${EVENT_UUID}`],
      engine: 'legacy',
      conversionId: CONV,
      legacyRunId: 'run-1',
      occurrenceAt: new Date('2026-09-15T12:00:30.000Z'),
    });
    // The claim ran on createAutomationRunRecord's transaction handle.
    expect(vi.mocked(claimOccurrence).mock.calls[0]![0]).toEqual({ tx: true });
    expect(addMock).toHaveBeenCalledWith('execute-run', expect.objectContaining({ runId: 'run-1' }), expect.any(Object));
  });

  it('post-switch event fanned out after the switch is not attempted by legacy', async () => {
    const switchedRow = { ...standalone, enabled: false };
    // Fan-out: the event org, no ordinary candidates, the switched row through the widened read.
    rows([{ partnerId: 'partner', type: 'customer' }]);
    rows([]);
    vi.mocked(loadSwitchedConvertedAutomations).mockResolvedValue([{ automation: switchedRow as never, conversion: switched }]);
    const event = (timestamp: string) => ({
      id: EVENT_UUID, orgId: ORG, type: 'device.offline', payload: {}, metadata: { timestamp },
    });
    await queueEventTriggers(event('2026-09-15T12:00:00.000Z') as never);
    expect(addMock).not.toHaveBeenCalled();

    // Before switch_at legacy still owns it, and says so on the job.
    rows([{ partnerId: 'partner', type: 'customer' }]);
    rows([]);
    await queueEventTriggers(event('2026-09-15T11:59:59.000Z') as never);
    expect(addMock).toHaveBeenCalledWith('trigger-event', expect.objectContaining({ automationId: AUTO, enqueuedWhileUnswitched: false }), expect.any(Object));

    // Admission re-decides from the state it locks: a post-switch instant on a
    // job enqueued after the switch is never attempted.
    rows([switchedRow]);
    vi.mocked(currentConversionForAutomation).mockResolvedValue(switched);
    expect(await __testOnly.processTriggerEvent(job({ enqueuedWhileUnswitched: false }))).toEqual({ skipped: 'occurrence_not_preferred' });
    expect(createRunMock).not.toHaveBeenCalled();
    expect(claimOccurrence).not.toHaveBeenCalled();
  });

  it('legacy skips an occurrence the flow claimed', async () => {
    rows([standalone]);
    vi.mocked(currentConversionForAutomation).mockResolvedValue({ id: CONV, state: 'shadow', switchAt: null });
    const existing = { engine: 'flow' as const, legacyRunId: null, flowRunId: FLOW_RUN };
    vi.mocked(claimOccurrence).mockResolvedValue({ ok: false, existing });
    runRecordCallingHook();

    expect(await __testOnly.processTriggerEvent(job())).toEqual({ skipped: 'occurrence_claimed', claimedBy: existing });
    expect(addMock).not.toHaveBeenCalled();
  });

  it('a schedule occurrence claims the UTC ISO minute of its slot', async () => {
    rows([{ ...standalone, trigger: { type: 'schedule', cronExpression: '0 3 * * *', timezone: 'UTC' } }]);
    vi.mocked(currentConversionForAutomation).mockResolvedValue({ id: CONV, state: 'shadow', switchAt: null });
    runRecordCallingHook();

    const result = await __testOnly.processTriggerSchedule({
      type: 'trigger-schedule', automationId: AUTO, slotKey: '202701090300', scanAt: '2027-01-09T03:00:04.000Z',
    });
    expect(result).toEqual({ runId: 'run-1' });
    expect(createRunMock.mock.calls[0]![0]).toMatchObject({ occurrenceKey: 'schedule:202701090300' });
    expect(vi.mocked(claimOccurrence).mock.calls[0]![1]).toMatchObject({
      keys: ['schedule:2027-01-09T03:00Z'], engine: 'legacy', occurrenceAt: new Date('2027-01-09T03:00:00Z'),
    });
  });

  it('a row with no conversion keeps today\'s admission byte-for-byte', async () => {
    rows([standalone]);
    createRunMock.mockResolvedValue({ run: { id: 'run-1' }, targetDeviceIds: [] });
    expect(await __testOnly.processTriggerEvent(job())).toEqual({ runId: 'run-1' });
    expect(createRunMock.mock.calls[0]![0]).not.toHaveProperty('onCreated');
    expect(claimOccurrence).not.toHaveBeenCalled();
  });

  it('classes M, A and P never consult the conversion ledger', async () => {
    createRunMock.mockResolvedValue({ run: { id: 'run-1' }, targetDeviceIds: ['device'] });
    vi.mocked(policyWorkflowApplies).mockResolvedValue(true);
    vi.mocked(resolveMaintenanceConfigForDevice).mockResolvedValue(null);
    const payload = { deviceId: 'device', alertId: 'alert', severity: 'critical' };
    // A (agent-managed), M (monitor-compiled, no subject), P (policy workflow).
    rows([{ ...standalone, trigger: { type: 'event', eventType: 'alert.triggered' }, managedByAgentId: 'agent' }]);
    await __testOnly.processTriggerEvent(job({ eventType: 'alert.triggered', eventPayload: payload }));
    rows([{ ...standalone, trigger: { type: 'event', eventType: 'alert.triggered' }, managedByMonitorId: 'monitor' }]);
    rows([]);
    await __testOnly.processTriggerEvent(job({ eventType: 'alert.triggered', eventPayload: payload }));
    rows([{ ...standalone, trigger: { type: 'event', eventType: 'alert.triggered', filter: { _policyWorkflow: { policyId: 'p', sourceId: 's' } } } }]);
    rows([{ orgId: ORG, partnerId: 'partner', siteId: 'site' }]);
    await __testOnly.processTriggerEvent(job({ eventType: 'alert.triggered', eventPayload: payload }));

    expect(createRunMock).toHaveBeenCalledTimes(3);
    for (const [options] of createRunMock.mock.calls) expect(options).not.toHaveProperty('onCreated');
    expect(currentConversionForAutomation).not.toHaveBeenCalled();
    expect(claimOccurrence).not.toHaveBeenCalled();
  });

  it('a converted row whose event id is not a uuid is admitted without a claim and reported', async () => {
    rows([standalone]);
    vi.mocked(currentConversionForAutomation).mockResolvedValue({ id: CONV, state: 'shadow', switchAt: null });
    createRunMock.mockResolvedValue({ run: { id: 'run-1' }, targetDeviceIds: [] });
    expect(await __testOnly.processTriggerEvent(job({ eventId: 'event-1' }))).toEqual({ runId: 'run-1' });
    expect(createRunMock.mock.calls[0]![0]).not.toHaveProperty('onCreated');
    expect(reportOccurrenceAnomaly).toHaveBeenCalledWith('flow_conversion_event_key_unbuildable', 'legacy', expect.any(String));
  });

  it('a converted row with a missing event timestamp is preferred by legacy and reported', async () => {
    rows([{ ...standalone, enabled: false }]);
    vi.mocked(currentConversionForAutomation).mockResolvedValue(switched);
    runRecordCallingHook();
    expect(await __testOnly.processTriggerEvent(job({ eventTimestamp: 'not-a-time', enqueuedWhileUnswitched: false }))).toEqual({ runId: 'run-1' });
    expect(vi.mocked(claimOccurrence).mock.calls[0]![1]).toMatchObject({ occurrenceAt: null });
    expect(reportOccurrenceAnomaly).toHaveBeenCalledWith('flow_conversion_event_instant_missing', 'legacy', `event:${EVENT_UUID}`);
  });
});

describe('shadow hooks (#5221 B4)', () => {
  const ORG = '22222222-2222-4222-8222-222222222222';
  const AUTO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const CONV = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const EVENT_UUID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const DEVICE = '11111111-1111-4111-8111-111111111111';
  const DIGEST = 'd'.repeat(64);
  const shadowState = { id: CONV, state: 'shadow' as const, switchAt: null };
  const standalone = {
    id: AUTO, orgId: ORG, partnerId: null, createdBy: null, managedByAgentId: null, managedByMonitorId: null, enabled: true,
    trigger: { type: 'event', eventType: 'device.offline', filter: { 'device.siteId': 'site-legacy' } }, conditions: {},
  };
  const flowTrigger = { type: 'event', event: 'device.offline', filter: { 'device.siteId': 'site-flow' } };
  function rows(result: unknown[]) {
    const q: any = {
      from: vi.fn().mockReturnThis(), innerJoin: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(result), then: (yes: any, no: any) => Promise.resolve(result).then(yes, no),
    };
    selectMock.mockReturnValueOnce(q);
    return q;
  }
  const event = (payload: Record<string, unknown>) => ({
    id: EVENT_UUID, orgId: ORG, type: 'device.offline', payload, metadata: { timestamp: '2027-01-09T03:00:00.000Z' },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    createRunMock.mockReset();
    vi.mocked(currentConversionForAutomation).mockReset().mockResolvedValue(null);
    vi.mocked(claimOccurrence).mockReset().mockResolvedValue({ ok: true });
    vi.mocked(loadSwitchedConvertedAutomations).mockReset().mockResolvedValue([]);
    vi.mocked(recordShadow).mockReset().mockResolvedValue(true);
    vi.mocked(observeShadowRun).mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('shadow fan-out records a flow-only match', async () => {
    rows([{ partnerId: 'partner', type: 'customer' }]);
    rows([standalone]);
    vi.mocked(loadSwitchedConvertedAutomations).mockResolvedValue([
      { automation: standalone as never, conversion: shadowState, shadow: { documentDigest: DIGEST, flowTrigger } },
    ] as never);

    await queueEventTriggers(event({ device: { siteId: 'site-flow' } }) as never);

    // The fan-out's existing converted-row read is the gate: it is asked for shadow rows too.
    expect(loadSwitchedConvertedAutomations).toHaveBeenCalledTimes(1);
    expect(vi.mocked(loadSwitchedConvertedAutomations).mock.calls[0]![2]).toEqual({ withShadow: true });
    expect(recordShadow).toHaveBeenCalledTimes(1);
    expect(recordShadow).toHaveBeenCalledWith(CONV, expect.objectContaining({
      divergent: true, kind: 'trigger_mismatch', documentDigest: DIGEST,
    }));
    // Shadow never executes anything: the Job did not match, so nothing is enqueued.
    expect(addMock).not.toHaveBeenCalled();
  });

  it('a legacy match the flow does not share is recorded once, and legacy still runs it', async () => {
    rows([{ partnerId: 'partner', type: 'customer' }]);
    rows([standalone]);
    vi.mocked(loadSwitchedConvertedAutomations).mockResolvedValue([
      { automation: standalone as never, conversion: shadowState, shadow: { documentDigest: DIGEST, flowTrigger } },
    ] as never);
    await queueEventTriggers(event({ device: { siteId: 'site-legacy' } }) as never);
    expect(recordShadow).toHaveBeenCalledTimes(1);
    expect(recordShadow).toHaveBeenCalledWith(CONV, expect.objectContaining({ kind: 'trigger_mismatch' }));
    expect(addMock).toHaveBeenCalledWith('trigger-event', expect.objectContaining({ automationId: AUTO }), expect.any(Object));
    // The shadow row is an ordinary candidate: its job carries no switch marker.
    expect((addMock.mock.calls[0] as unknown[])[1]).not.toHaveProperty('enqueuedWhileUnswitched');
  });

  it('rows without a conversion do no shadow work at the fan-out', async () => {
    rows([{ partnerId: 'partner', type: 'customer' }]);
    rows([{ ...standalone, trigger: { type: 'event', eventType: 'device.offline' } }]);
    await queueEventTriggers(event({}) as never);
    expect(addMock).toHaveBeenCalledTimes(1);
    expect(recordShadow).not.toHaveBeenCalled();
  });

  it('after run creation a shadow row is observed with the legacy target set', async () => {
    rows([{ ...standalone, trigger: { type: 'event', eventType: 'device.offline' } }]);
    rows([{ orgId: ORG, partnerId: 'partner', siteId: 'site' }]);
    vi.mocked(currentConversionForAutomation).mockResolvedValue(shadowState);
    createRunMock.mockResolvedValue({ run: { id: 'run-1' }, targetDeviceIds: [DEVICE] });

    const result = await __testOnly.processTriggerEvent({
      type: 'trigger-event', automationId: AUTO, eventType: 'device.offline', eventId: EVENT_UUID,
      eventTimestamp: '2027-01-09T03:00:00.000Z', eventPayload: { deviceId: DEVICE },
    });
    expect(result).toEqual({ runId: 'run-1' });
    expect(observeShadowRun).toHaveBeenCalledTimes(1);
    expect(observeShadowRun).toHaveBeenCalledWith({
      conversionId: CONV,
      automation: { id: AUTO, orgId: ORG, partnerId: null },
      run: { kind: 'event', eventType: 'device.offline', payload: { deviceId: DEVICE } },
      legacyTargetIds: [DEVICE],
    });
  });

  it('shadow hook failure never fails the legacy run', async () => {
    rows([{ ...standalone, trigger: { type: 'schedule', cronExpression: '0 3 * * *', timezone: 'UTC' } }]);
    vi.mocked(currentConversionForAutomation).mockResolvedValue(shadowState);
    createRunMock.mockResolvedValue({ run: { id: 'run-1' }, targetDeviceIds: [DEVICE] });
    vi.mocked(observeShadowRun).mockRejectedValue(new Error('shadow exploded'));

    const result = await __testOnly.processTriggerSchedule({
      type: 'trigger-schedule', automationId: AUTO, slotKey: '202701090300', scanAt: '2027-01-09T03:00:04.000Z',
    });
    expect(result).toEqual({ runId: 'run-1' });
    expect(addMock).toHaveBeenCalledWith('execute-run', expect.objectContaining({ runId: 'run-1' }), expect.any(Object));
    expect(observeShadowRun).toHaveBeenCalledWith(expect.objectContaining({
      conversionId: CONV, run: { kind: 'schedule', at: new Date('2027-01-09T03:00:00Z') },
    }));
  });

  it('a replayed job that gets its first run back is not observed twice', async () => {
    rows([{ ...standalone, trigger: { type: 'schedule', cronExpression: '0 3 * * *', timezone: 'UTC' } }]);
    vi.mocked(currentConversionForAutomation).mockResolvedValue(shadowState);
    createRunMock.mockResolvedValue({ run: { id: 'run-1' }, targetDeviceIds: [DEVICE], reused: true });
    expect(await __testOnly.processTriggerSchedule({
      type: 'trigger-schedule', automationId: AUTO, slotKey: '202701090300', scanAt: '2027-01-09T03:00:04.000Z',
    })).toEqual({ runId: 'run-1' });
    expect(observeShadowRun).not.toHaveBeenCalled();
  });

  it('switched, reverted and unconverted rows are never observed after run creation', async () => {
    for (const conversion of [null, { id: CONV, state: 'reverted' as const, switchAt: new Date() }]) {
      rows([{ ...standalone, trigger: { type: 'event', eventType: 'device.offline' } }]);
      vi.mocked(currentConversionForAutomation).mockResolvedValue(conversion);
      createRunMock.mockResolvedValue({ run: { id: 'run-1' }, targetDeviceIds: [] });
      await __testOnly.processTriggerEvent({
        type: 'trigger-event', automationId: AUTO, eventType: 'device.offline', eventId: EVENT_UUID,
        eventTimestamp: '2027-01-09T03:00:00.000Z', eventPayload: {},
      });
    }
    expect(observeShadowRun).not.toHaveBeenCalled();
  });
});
