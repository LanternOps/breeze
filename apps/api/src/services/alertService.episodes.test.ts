import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #5290 — the episode seam inside `evaluateDeviceAlerts`.
 *
 * Harness copied from `alertService.monitorOverrides.test.ts` (same chainable
 * `db` stand-in driven by a FIFO `resultsQueue`), extended with `insert` so
 * `createAlert` can run to completion.
 *
 * The seam's PLACEMENT is the property under test: it must run after the
 * condition evaluation and before `createAlert`, so cooldown and flapping gate
 * the alert but never the episode.
 */
const {
  dbMock,
  resultsQueue,
  insertedAlerts,
  captureExceptionMock,
  resolveMonitorsForDeviceMock,
  evaluateConditionsMock,
  recordMonitorEvaluationMock,
  detachMonitorFromDeviceMock,
  linkEpisodeAlertMock,
  fireEscalationLatchMock,
  isCooldownActiveMock,
  isFlappingMock,
  callOrder,
} = vi.hoisted(() => {
  const resultsQueue: unknown[][] = [];
  const callOrder: string[] = [];
  const insertedAlerts: Record<string, unknown>[] = [];
  const nextResult = () => resultsQueue.shift() ?? [];
  const chain = () => {
    let resolved: unknown[] | undefined;
    const resolveOnce = () => {
      if (resolved === undefined) resolved = nextResult();
      return resolved;
    };
    return {
      limit: () => Promise.resolve(resolveOnce()),
      then: (onFulfilled: (v: unknown[]) => unknown, onRejected?: (e: unknown) => unknown) =>
        Promise.resolve(resolveOnce()).then(onFulfilled, onRejected),
    };
  };
  return {
    resultsQueue,
    callOrder,
    insertedAlerts,
    dbMock: {
      select: vi.fn(() => ({ from: () => ({ where: () => chain() }) })),
      insert: vi.fn(() => ({
        values: (values: Record<string, unknown>) => {
          callOrder.push('createAlert.insert');
          insertedAlerts.push(values);
          return {
            returning: () => Promise.resolve([{ id: 'alert-1', ...values }]),
          };
        },
      })),
      execute: vi.fn(async (statement: { values: unknown[] }) => {
        callOrder.push('createAlert.insert');
        const [ruleId, deviceId, orgId, severity, title, message, context, monitorId, episodeId, requiresHuman, subjectKey] = statement.values;
        insertedAlerts.push({
          ruleId, deviceId, orgId, severity, title, message,
          context: JSON.parse(context as string), monitorId, episodeId, requiresHuman, subjectKey,
        });
        return [{ id: 'alert-1' }];
      }),
      update: vi.fn(() => ({ set: () => ({ where: () => Promise.resolve(undefined) }) })),
      delete: vi.fn(() => ({ where: () => Promise.resolve([]) })),
    },
    captureExceptionMock: vi.fn(),
    resolveMonitorsForDeviceMock: vi.fn(),
    evaluateConditionsMock: vi.fn(),
    recordMonitorEvaluationMock: vi.fn(),
    detachMonitorFromDeviceMock: vi.fn(),
    linkEpisodeAlertMock: vi.fn(),
    fireEscalationLatchMock: vi.fn(),
    isCooldownActiveMock: vi.fn(),
    isFlappingMock: vi.fn(),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...args: unknown[]) => ({ op: 'and', args }),
  inArray: (col: unknown, vals: unknown[]) => ({ op: 'inArray', col, vals }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  isNotNull: (col: unknown) => ({ op: 'isNotNull', col }),
  or: (...args: unknown[]) => ({ op: 'or', args }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: 'sql', strings, values }),
    { join: (...args: unknown[]) => ({ op: 'sqlJoin', args }), raw: (s: string) => ({ op: 'raw', s }) },
  ),
  asc: (col: unknown) => ({ op: 'asc', col }),
  desc: (col: unknown) => ({ op: 'desc', col }),
}));

vi.mock('../db', () => ({ db: dbMock }));

vi.mock('../db/schema', () => ({
  alerts: { id: 'alerts.id', ruleId: 'alerts.ruleId', deviceId: 'alerts.deviceId', status: 'alerts.status' },
  alertRules: {
    id: 'alert_rules.id',
    templateId: 'alert_rules.templateId',
    orgId: 'alert_rules.orgId',
    partnerId: 'alert_rules.partnerId',
    targetType: 'alert_rules.targetType',
    targetId: 'alert_rules.targetId',
    isActive: 'alert_rules.isActive',
    managedByMonitorId: 'alert_rules.managedByMonitorId',
  },
  alertTemplates: { id: 'alert_templates.id' },
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId' },
  deviceGroups: {},
  deviceGroupMemberships: {
    deviceId: 'device_group_memberships.deviceId',
    groupId: 'device_group_memberships.groupId',
  },
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId' },
  sites: {},
  configPolicyAlertRules: {},
  monitorDefinitions: { id: 'monitor_definitions.id' },
  monitorDeviceState: {
    monitorId: 'monitor_device_state.monitorId',
    deviceId: 'monitor_device_state.deviceId',
    currentEpisodeId: 'monitor_device_state.currentEpisodeId',
  },
}));

vi.mock('./monitors/monitorResolver', () => ({
  resolveMonitorsForDevice: resolveMonitorsForDeviceMock,
}));

vi.mock('./monitors/episodeService', () => ({
  recordMonitorEvaluation: recordMonitorEvaluationMock,
  detachMonitorFromDevice: detachMonitorFromDeviceMock,
  linkEpisodeAlert: linkEpisodeAlertMock,
}));

vi.mock('./monitors/escalationLatch', () => ({
  fireEscalationLatch: fireEscalationLatchMock,
}));

vi.mock('./alertConditions', () => ({
  evaluateConditions: evaluateConditionsMock,
  evaluateAutoResolveConditions: vi.fn(),
  interpolateTemplate: vi.fn((template: string) => template),
}));

vi.mock('./alertCooldown', () => ({
  isCooldownActive: isCooldownActiveMock,
  setCooldown: vi.fn(() => Promise.resolve()),
  recordStateTransition: vi.fn(() => Promise.resolve()),
  isFlapping: isFlappingMock,
}));

vi.mock('./featureConfigResolver', () => ({
  resolveMaintenanceConfigForDevice: vi.fn(),
  isInMaintenanceWindow: vi.fn(),
}));

vi.mock('./eventBus', () => ({ publishEvent: vi.fn(() => Promise.resolve()) }));
vi.mock('./sentry', () => ({ captureException: captureExceptionMock }));
vi.mock('./deviceSiteResolver', () => ({ resolveDeviceSiteId: vi.fn(() => Promise.resolve('site-1')) }));
vi.mock('../jobs/alertCorrelation', () => ({ enqueueAlertCorrelation: vi.fn(() => Promise.resolve('job-1')) }));

import { evaluateDeviceAlerts } from './alertService';

const DEVICE_ID = 'device-1';
const DEVICE_ORG = 'org-device';
const MONITOR_ID = 'monitor-1';

const CONDITIONS = { type: 'threshold', metric: 'cpuPercent', operator: 'gt', value: 80 };

/**
 * Pushes the FIFO db results for one sweep of one rule.
 *
 * Order (derived from the source): getApplicableRules → device, group
 * memberships, owning org, rules, templates, monitor definitions; then
 * evaluateDeviceAlerts' own device read; then (only when the condition
 * triggered) createAlert's rule, template and open-alert dedupe reads; then the
 * detach scan.
 */
function pushSweepQueue(opts: {
  managedByMonitorId?: string | null;
  /** Monitor definition rows returned for the managed rule. */
  monitorRow?: Record<string, unknown> | null;
  triggered: boolean;
  /** monitor_device_state rows with an open episode, for the detach scan. */
  openStateRows?: Array<{ monitorId: string }>;
  /** Partner-wide rule: rule.orgId null. */
  ruleOrgId?: string | null;
} = { triggered: true }) {
  const managedByMonitorId = opts.managedByMonitorId === undefined ? MONITOR_ID : opts.managedByMonitorId;
  resultsQueue.push([{ id: DEVICE_ID, orgId: DEVICE_ORG, siteId: 'site-1' }]); // device (getApplicableRules)
  resultsQueue.push([]); // group memberships
  resultsQueue.push([{ partnerId: null }]); // owning org
  resultsQueue.push([
    {
      id: 'rule-1',
      templateId: 'template-1',
      orgId: opts.ruleOrgId === undefined ? DEVICE_ORG : opts.ruleOrgId,
      partnerId: null,
      targetType: 'monitor',
      targetId: managedByMonitorId,
      isActive: true,
      managedByMonitorId,
      overrideSettings: null,
      name: 'CPU rule',
    },
  ]); // rules
  resultsQueue.push([
    {
      id: 'template-1',
      conditions: CONDITIONS,
      severity: 'high',
      cooldownMinutes: 5,
      titleTemplate: 'High CPU',
      messageTemplate: 'CPU high',
    },
  ]); // templates
  const monitorRow = opts.monitorRow === undefined
    ? {
      id: MONITOR_ID,
      kind: 'cpu',
      name: 'CPU high',
      severity: 'high',
      condition: { operator: 'gt', value: 80 },
      recurrenceThreshold: 3,
      recurrenceWindowHours: 72,
      recurrenceActions: [],
      pauseResponsesOnEscalation: true,
    }
    : opts.monitorRow;
  // The batched monitor-definition read only happens when at least one rule is
  // monitor-managed, so an unmanaged sweep must NOT consume a queue slot here.
  if (managedByMonitorId) resultsQueue.push(monitorRow ? [monitorRow] : []);
  resultsQueue.push([{ id: DEVICE_ID, orgId: DEVICE_ORG, siteId: 'site-1', displayName: 'WS-1', hostname: 'ws-1' }]); // device (sweep)

  if (opts.triggered) {
    resultsQueue.push([{ id: 'rule-1', templateId: 'template-1', overrideSettings: null }]); // createAlert rule
    resultsQueue.push([{ id: 'template-1', cooldownMinutes: 5 }]); // createAlert template
    resultsQueue.push([]); // createAlert open-alert dedupe
  }

  resultsQueue.push(opts.openStateRows ?? []); // detach scan
}

beforeEach(() => {
  resultsQueue.length = 0;
  callOrder.length = 0;
  insertedAlerts.length = 0;
  vi.clearAllMocks();
  resolveMonitorsForDeviceMock.mockResolvedValue({
    kind: 'resolved',
    monitors: [
      { monitorId: MONITOR_ID, enabled: true, overrides: null, sourcePolicyId: 'p1', sourceLevel: 'organization' },
    ],
  });
  isCooldownActiveMock.mockResolvedValue(false);
  isFlappingMock.mockResolvedValue(false);
  recordMonitorEvaluationMock.mockImplementation(async () => {
    callOrder.push('recordMonitorEvaluation');
    return {
      episodeId: 'episode-1',
      episodeOpened: true,
      episodeClosed: false,
      episodesInWindow: 1,
      latched: false,
      needsEscalationAlert: false,
      responsesPaused: false,
    };
  });
  fireEscalationLatchMock.mockResolvedValue({ escalationAlertId: 'alert-esc', recurrenceActionsPending: 0 });
  linkEpisodeAlertMock.mockResolvedValue({ owner: true });
  detachMonitorFromDeviceMock.mockResolvedValue(undefined);
  evaluateConditionsMock.mockResolvedValue({
    triggered: true,
    conditionsMet: ['cpu > 80'],
    conditionsNotMet: [],
    dataState: 'ok',
    context: { deviceId: DEVICE_ID, evaluatedAt: '2026-09-13T12:00:00.000Z' },
  });
});

describe('evaluateDeviceAlerts — monitor episodes (#5290)', () => {
  it('records a breach observation BEFORE the alert is inserted', async () => {
    pushSweepQueue({ triggered: true });

    await evaluateDeviceAlerts(DEVICE_ID);

    expect(recordMonitorEvaluationMock).toHaveBeenCalledWith(
      expect.objectContaining({ observation: 'breach', deviceId: DEVICE_ID }),
    );
    expect(callOrder).toEqual(['recordMonitorEvaluation', 'createAlert.insert']);
  });

  it('passes the DEVICE org, not the rule org, to recordMonitorEvaluation', async () => {
    // Partner-wide rule: rule.orgId is null, device.orgId is set.
    pushSweepQueue({ triggered: true, ruleOrgId: null });

    await evaluateDeviceAlerts(DEVICE_ID);

    expect(recordMonitorEvaluationMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: DEVICE_ORG }),
    );
  });

  it('records an ok observation when the condition does not trigger', async () => {
    evaluateConditionsMock.mockResolvedValue({
      triggered: false,
      conditionsMet: [],
      conditionsNotMet: ['cpu <= 80'],
      dataState: 'ok',
      context: { deviceId: DEVICE_ID, evaluatedAt: '2026-09-13T12:00:00.000Z' },
    });
    pushSweepQueue({ triggered: false });

    await evaluateDeviceAlerts(DEVICE_ID);

    expect(recordMonitorEvaluationMock).toHaveBeenCalledWith(
      expect.objectContaining({ observation: 'ok' }),
    );
  });

  it('records unknown when dataState is unknown, even though triggered is false', async () => {
    evaluateConditionsMock.mockResolvedValue({
      triggered: false,
      conditionsMet: [],
      conditionsNotMet: ['No metrics available for cpu'],
      dataState: 'unknown',
      context: { deviceId: DEVICE_ID, evaluatedAt: '2026-09-13T12:00:00.000Z' },
    });
    pushSweepQueue({ triggered: false });

    await evaluateDeviceAlerts(DEVICE_ID);

    expect(recordMonitorEvaluationMock).toHaveBeenCalledWith(
      expect.objectContaining({ observation: 'unknown' }),
    );
  });

  it('does NOT touch episodes for a rule with no managedByMonitorId', async () => {
    resolveMonitorsForDeviceMock.mockResolvedValue({ kind: 'resolved', monitors: [] });
    pushSweepQueue({ triggered: true, managedByMonitorId: null, monitorRow: null });

    await evaluateDeviceAlerts(DEVICE_ID);

    expect(recordMonitorEvaluationMock).not.toHaveBeenCalled();
    expect(insertedAlerts).toHaveLength(1);
  });

  it('stamps episodeId onto the created alert and links the alert back to the episode', async () => {
    pushSweepQueue({ triggered: true });

    await evaluateDeviceAlerts(DEVICE_ID);

    expect(insertedAlerts[0]).toMatchObject({ episodeId: 'episode-1', monitorId: MONITOR_ID });
    expect(linkEpisodeAlertMock).toHaveBeenCalledWith('episode-1', 'alert-1');
  });

  it('keeps a published legacy alert when episode linking fails', async () => {
    pushSweepQueue({ triggered: true });
    linkEpisodeAlertMock.mockRejectedValueOnce(new Error('episode bookkeeping unavailable'));

    expect(await evaluateDeviceAlerts(DEVICE_ID)).toContain('alert-1');
    expect(insertedAlerts).toHaveLength(1);
    expect(linkEpisodeAlertMock).toHaveBeenCalledWith('episode-1', 'alert-1');
  });

  it('opens the episode even when createAlert returns null because of cooldown', async () => {
    isCooldownActiveMock.mockResolvedValue(true);
    // Cooldown short-circuits before the template / dedupe reads, so only the
    // rule read happens inside createAlert.
    resultsQueue.push([{ id: DEVICE_ID, orgId: DEVICE_ORG, siteId: 'site-1' }]);
    resultsQueue.push([]);
    resultsQueue.push([{ partnerId: null }]);
    resultsQueue.push([
      {
        id: 'rule-1', templateId: 'template-1', orgId: DEVICE_ORG, partnerId: null,
        targetType: 'monitor', targetId: MONITOR_ID, isActive: true,
        managedByMonitorId: MONITOR_ID, overrideSettings: null, name: 'CPU rule',
      },
    ]);
    resultsQueue.push([{
      id: 'template-1', conditions: CONDITIONS, severity: 'high', cooldownMinutes: 5,
      titleTemplate: 'High CPU', messageTemplate: 'CPU high',
    }]);
    resultsQueue.push([{
      id: MONITOR_ID, kind: 'cpu', name: 'CPU high', severity: 'high',
      condition: { operator: 'gt', value: 80 },
      recurrenceThreshold: 3, recurrenceWindowHours: 72,
      recurrenceActions: [], pauseResponsesOnEscalation: true,
    }]);
    resultsQueue.push([{ id: DEVICE_ID, orgId: DEVICE_ORG, siteId: 'site-1', displayName: 'WS-1' }]);
    resultsQueue.push([{ id: 'rule-1', templateId: 'template-1', overrideSettings: null }]);
    resultsQueue.push([{ id: 'template-1', cooldownMinutes: 5 }]);
    resultsQueue.push([]); // detach scan

    const created = await evaluateDeviceAlerts(DEVICE_ID);

    expect(created).toEqual([]);
    expect(insertedAlerts).toHaveLength(0);
    // The episode was still opened — noise controls gate the alert, not the loop.
    expect(recordMonitorEvaluationMock).toHaveBeenCalledWith(
      expect.objectContaining({ observation: 'breach' }),
    );
  });

  it('fires the escalation latch exactly once when recordMonitorEvaluation reports latched', async () => {
    recordMonitorEvaluationMock.mockResolvedValue({
      episodeId: 'episode-1',
      episodeOpened: true,
      episodeClosed: false,
      episodesInWindow: 3,
      latched: true,
      needsEscalationAlert: false,
      responsesPaused: true,
    });
    pushSweepQueue({ triggered: true });

    await evaluateDeviceAlerts(DEVICE_ID);

    expect(fireEscalationLatchMock).toHaveBeenCalledTimes(1);
    expect(fireEscalationLatchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: DEVICE_ID,
        orgId: DEVICE_ORG,
        episodeId: 'episode-1',
        episodesInWindow: 3,
      }),
    );
  });

  it('retries the requires-human alert when the pair is escalated but has no alert id', async () => {
    recordMonitorEvaluationMock.mockResolvedValue({
      episodeId: 'episode-1',
      episodeOpened: true,
      episodeClosed: false,
      episodesInWindow: 4,
      latched: false,
      needsEscalationAlert: true,
      responsesPaused: true,
    });
    pushSweepQueue({ triggered: true });

    await evaluateDeviceAlerts(DEVICE_ID);

    // Not a re-latch — the earlier alert simply never landed, and the responses
    // are already paused, so the human signal has to be retried.
    expect(fireEscalationLatchMock).toHaveBeenCalledTimes(1);
  });

  it('does not fire the latch when latched is false', async () => {
    pushSweepQueue({ triggered: true });

    await evaluateDeviceAlerts(DEVICE_ID);

    expect(fireEscalationLatchMock).not.toHaveBeenCalled();
  });

  it('detaches a monitor that still has an open episode but no longer resolves to the device', async () => {
    pushSweepQueue({ triggered: true, openStateRows: [{ monitorId: 'monitor-gone' }, { monitorId: MONITOR_ID }] });

    await evaluateDeviceAlerts(DEVICE_ID);

    expect(detachMonitorFromDeviceMock).toHaveBeenCalledTimes(1);
    expect(detachMonitorFromDeviceMock).toHaveBeenCalledWith('monitor-gone', DEVICE_ID);
  });

  it('does not let an episode-service failure abort the sweep or the alert', async () => {
    recordMonitorEvaluationMock.mockRejectedValue(new Error('episode boom'));
    pushSweepQueue({ triggered: true });

    const created = await evaluateDeviceAlerts(DEVICE_ID);

    expect(created).toEqual(['alert-1']);
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      undefined,
      expect.objectContaining({ issue: 'episode_record_failed' }),
    );
  });
});
