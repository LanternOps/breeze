import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #6353 — a `network_check` monitor compiles to ONE managed network_monitors
 * row, so its verdict is evaluated once per check per org on the check's ALERT
 * DEVICE (online or not), never once per device the policy reaches.
 *
 * Harness copied from `alertService.episodes.test.ts` (chainable `db`
 * stand-in driven by a FIFO `resultsQueue`).
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
  isConfigPolicyRuleCooling: vi.fn(),
  markConfigPolicyRuleCooldown: vi.fn(),
  recordStateTransition: vi.fn(() => Promise.resolve()),
  isFlapping: isFlappingMock,
}));

vi.mock('./featureConfigResolver', () => ({
  resolveAlertRulesForDevice: vi.fn(),
  resolveMaintenanceConfigForDevice: vi.fn(),
  isInMaintenanceWindow: vi.fn(),
}));

vi.mock('./eventBus', () => ({ publishEvent: vi.fn(() => Promise.resolve()) }));
vi.mock('./sentry', () => ({ captureException: captureExceptionMock }));
vi.mock('./deviceSiteResolver', () => ({ resolveDeviceSiteId: vi.fn(() => Promise.resolve('site-1')) }));
vi.mock('../jobs/alertCorrelation', () => ({ enqueueAlertCorrelation: vi.fn(() => Promise.resolve('job-1')) }));

import { evaluateDeviceAlerts, evaluateNetworkCheckAlertsForDevice } from './alertService';

const DEVICE_ORG = 'org-device';
const MONITOR_ID = 'monitor-net-1';
const OTHER_MONITOR_ID = 'monitor-net-other';

const NETWORK_CONDITIONS = { type: 'network_check', monitorId: MONITOR_ID, consecutiveFailures: 2 };

/**
 * FIFO db results for one sweep of one device that resolves ONE managed
 * `network_check` rule. Order (derived from the source): getApplicableRules →
 * device, group memberships, owning org, rules, templates, monitor
 * definitions; then evaluateDeviceAlerts' own device read; then (only when an
 * alert is created) createAlert's rule, template and open-alert dedupe reads;
 * then (per-device sweep only) the detach scan.
 */
function pushSweepQueue(opts: {
  deviceId: string;
  deviceStatus?: 'online' | 'offline';
  monitorId?: string;
  createsAlert: boolean;
  detachScan: boolean;
  openStateRows?: Array<{ monitorId: string }>;
}) {
  const monitorId = opts.monitorId ?? MONITOR_ID;
  resultsQueue.push([{ id: opts.deviceId, orgId: DEVICE_ORG, siteId: 'site-1' }]); // device (getApplicableRules)
  resultsQueue.push([]); // group memberships
  resultsQueue.push([{ partnerId: null }]); // owning org
  resultsQueue.push([
    {
      id: 'rule-net-1',
      templateId: 'template-net-1',
      orgId: DEVICE_ORG,
      partnerId: null,
      targetType: 'monitor',
      targetId: monitorId,
      isActive: true,
      managedByMonitorId: monitorId,
      overrideSettings: null,
      name: 'Gateway ping',
    },
  ]); // rules
  resultsQueue.push([
    {
      id: 'template-net-1',
      conditions: NETWORK_CONDITIONS,
      severity: 'high',
      cooldownMinutes: 5,
      titleTemplate: 'Network check {{ruleName}} failing',
      messageTemplate: 'down',
    },
  ]); // templates
  resultsQueue.push([
    {
      id: monitorId,
      kind: 'network_check',
      name: 'Gateway ping',
      severity: 'high',
      condition: { checkType: 'icmp_ping', target: '10.0.0.1', pollingIntervalSeconds: 60, timeoutSeconds: 5, consecutiveFailures: 2 },
      recurrenceThreshold: null,
      recurrenceWindowHours: null,
      recurrenceActions: [],
      pauseResponsesOnEscalation: true,
    },
  ]); // monitor definitions
  resultsQueue.push([
    { id: opts.deviceId, orgId: DEVICE_ORG, siteId: 'site-1', displayName: 'WS', hostname: 'ws', status: opts.deviceStatus ?? 'online' },
  ]); // device (sweep)

  if (opts.createsAlert) {
    resultsQueue.push([{ id: 'rule-net-1', templateId: 'template-net-1', overrideSettings: null }]); // createAlert rule
    resultsQueue.push([{ id: 'template-net-1', cooldownMinutes: 5 }]); // createAlert template
    resultsQueue.push([]); // createAlert open-alert dedupe
  }

  if (opts.detachScan) resultsQueue.push(opts.openStateRows ?? []); // detach scan
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
      { monitorId: OTHER_MONITOR_ID, enabled: true, overrides: null, sourcePolicyId: 'p1', sourceLevel: 'organization' },
    ],
  });
  isCooldownActiveMock.mockResolvedValue(false);
  isFlappingMock.mockResolvedValue(false);
  recordMonitorEvaluationMock.mockResolvedValue({
    episodeId: 'episode-1',
    episodeOpened: true,
    episodeClosed: false,
    episodesInWindow: 1,
    latched: false,
    needsEscalationAlert: false,
    responsesPaused: false,
  });
  linkEpisodeAlertMock.mockResolvedValue({ owner: true });
  detachMonitorFromDeviceMock.mockResolvedValue(undefined);
  // The handler would breach for whichever device it is asked about — that is
  // exactly the shape of the #6353 bug, so the split under test must not lean
  // on the handler saying no.
  evaluateConditionsMock.mockResolvedValue({
    triggered: true,
    conditionsMet: ['offline x2'],
    conditionsNotMet: [],
    dataState: 'ok',
    context: { evaluatedAt: '2026-09-20T12:00:00.000Z' },
  });
});

describe('#6353 — network_check rules are evaluated once per check, not once per device', () => {
  it('the per-device sweep raises NO alert for a network_check rule on any of N online devices', async () => {
    const online = ['device-a', 'device-b', 'device-c'];
    for (const id of online) pushSweepQueue({ deviceId: id, createsAlert: false, detachScan: true });

    for (const id of online) await evaluateDeviceAlerts(id);

    expect(insertedAlerts).toHaveLength(0);
    expect(evaluateConditionsMock).not.toHaveBeenCalled();
    expect(recordMonitorEvaluationMock).not.toHaveBeenCalled();
  });

  it('the per-device sweep still counts the network_check monitor as evaluated, so its open episode on the alert device is not detached', async () => {
    pushSweepQueue({ deviceId: 'device-a', createsAlert: false, detachScan: true, openStateRows: [{ monitorId: MONITOR_ID }] });

    await evaluateDeviceAlerts('device-a');

    expect(detachMonitorFromDeviceMock).not.toHaveBeenCalled();
  });

  it('the device-independent path raises exactly one alert on the resolved alert device even when it is OFFLINE', async () => {
    pushSweepQueue({ deviceId: 'device-offline', deviceStatus: 'offline', createsAlert: true, detachScan: false });

    const created = await evaluateNetworkCheckAlertsForDevice('device-offline', new Set([MONITOR_ID]));

    expect(created).toHaveLength(1);
    expect(insertedAlerts).toHaveLength(1);
    expect(insertedAlerts[0]).toMatchObject({ deviceId: 'device-offline', orgId: DEVICE_ORG, monitorId: MONITOR_ID });
    expect(evaluateConditionsMock).toHaveBeenCalledTimes(1);
    expect(evaluateConditionsMock).toHaveBeenCalledWith(NETWORK_CONDITIONS, 'device-offline');
    expect(recordMonitorEvaluationMock).toHaveBeenCalledWith(
      expect.objectContaining({ observation: 'breach', deviceId: 'device-offline', orgId: DEVICE_ORG }),
    );
    // Not a per-device sweep: it must not run the detach scan, which would
    // close every OTHER monitor's episode on this device.
    expect(detachMonitorFromDeviceMock).not.toHaveBeenCalled();
    expect(resultsQueue).toHaveLength(0);
  });

  it('the device-independent path skips a network_check rule whose monitor is not one this device is the alert device for', async () => {
    pushSweepQueue({ deviceId: 'device-a', monitorId: OTHER_MONITOR_ID, createsAlert: false, detachScan: false });

    const created = await evaluateNetworkCheckAlertsForDevice('device-a', new Set([MONITOR_ID]));

    expect(created).toEqual([]);
    expect(evaluateConditionsMock).not.toHaveBeenCalled();
    expect(insertedAlerts).toHaveLength(0);
  });
});

