import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAfterCursor, maxEvidence, type EvidenceCursor } from '@breeze/shared';
import type { EvaluateOptions } from './alertConditions';

const {
  dbMock, rows, insertedAlerts, captureExceptionMock, resolveMonitorsForDeviceMock,
  evaluateConditionsMock, recordMonitorEvaluationMock, detachMonitorFromDeviceMock,
  linkEpisodeAlertMock, fireEscalationLatchMock, isCooldownActiveMock, isFlappingMock,
  readClosedCursorsMock, advanceOpenRuleCursorsMock,
} = vi.hoisted(() => {
  const rows = new Map<unknown, unknown[]>();
  const insertedAlerts: Record<string, unknown>[] = [];
  return {
    rows, insertedAlerts,
    dbMock: {
      select: vi.fn(), execute: vi.fn(),
      update: vi.fn(), delete: vi.fn(),
    },
    captureExceptionMock: vi.fn(), resolveMonitorsForDeviceMock: vi.fn(), evaluateConditionsMock: vi.fn(),
    recordMonitorEvaluationMock: vi.fn(), detachMonitorFromDeviceMock: vi.fn(), linkEpisodeAlertMock: vi.fn(),
    fireEscalationLatchMock: vi.fn(), isCooldownActiveMock: vi.fn(), isFlappingMock: vi.fn(),
    readClosedCursorsMock: vi.fn(), advanceOpenRuleCursorsMock: vi.fn(),
  };
});

vi.mock('./alertLifecycle/cursor', () => ({
  readClosedCursors: readClosedCursorsMock,
  advanceOpenRuleCursors: advanceOpenRuleCursorsMock,
}));

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

vi.mock('../db', () => ({ db: dbMock, withDbTransaction: async (fn: () => Promise<unknown>) => fn() }));
vi.mock('./alertSubjects', () => ({ evaluateSubjectAlerts: vi.fn(async () => 'ok') }));

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
  evidenceLeafPaths: (condition: { type?: string }) => condition?.type === 'event_log' ? ['root'] : [],
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

import { alerts, alertRules, alertTemplates, devices, organizations, monitorDefinitions, monitorDeviceState } from '../db/schema';
import { createAlert, evaluateDeviceAlerts } from './alertService';
import { resolveMaintenanceConfigForDevice, isInMaintenanceWindow } from './featureConfigResolver';

const DEVICE_ID = 'device-1';
const EVENT_CONDITION = { type: 'event_log', category: 'system', level: 'error', countThreshold: 1, windowMinutes: 60 };
const STATE_CONDITION = { type: 'threshold', metric: 'cpuPercent', operator: 'gt', value: 80 };
const closedAt = new Date('2026-10-29T10:05:00Z');
type Event = EvidenceCursor & { matchesTrigger: boolean; matchesRecovery: boolean };
const event = (minute: number, trigger = true, ingestedMinute = minute): Event => ({
  ts: `2026-10-29T10:${String(minute).padStart(2, '0')}:00.000Z`,
  createdAt: `2026-10-29T10:${String(ingestedMinute).padStart(2, '0')}:00.000Z`,
  id: `event-${minute}`, matchesTrigger: trigger, matchesRecovery: !trigger,
});
const cursor = ({ ts, createdAt, id }: Event): EvidenceCursor => ({ ts, createdAt, id });
let events: Event[];

function closed(anchor: Event | null) {
  readClosedCursorsMock.mockResolvedValue(new Map([
    ['rule-1', { cursors: anchor ? { root: cursor(anchor) } : null, closedAt, legacy: !anchor }],
  ]));
}

function configureRules(conditions: unknown[] = [EVENT_CONDITION]) {
  rows.set(alertRules, conditions.map((_, i) => ({
    id: `rule-${i + 1}`, templateId: `template-${i + 1}`, orgId: 'org-1',
    targetType: 'monitor', targetId: `monitor-${i + 1}`, isActive: true,
    managedByMonitorId: `monitor-${i + 1}`, overrideSettings: null, name: 'Event monitor',
  })));
  rows.set(alertTemplates, conditions.map((condition, i) => ({
    id: `template-${i + 1}`, conditions: condition, severity: 'high', cooldownMinutes: 5,
    titleTemplate: 'Monitor breach', messageTemplate: 'Monitor breached',
  })));
  rows.set(monitorDefinitions, conditions.map((condition, i) => ({
    id: `monitor-${i + 1}`, kind: condition === STATE_CONDITION ? 'cpu' : 'event_log',
  })));
  resolveMonitorsForDeviceMock.mockResolvedValue({ kind: 'resolved', monitors: conditions.map((_, i) => ({
    monitorId: `monitor-${i + 1}`, enabled: true, overrides: null,
  })) });
}

beforeEach(() => {
  vi.resetAllMocks();
  rows.clear();
  insertedAlerts.length = 0;
  dbMock.select.mockImplementation(() => ({ from: (table: unknown) => ({ where: () => {
    const result = rows.get(table) ?? [];
    return { limit: () => Promise.resolve(result), then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(result).then(resolve) };
  } }) }));
  dbMock.execute.mockImplementation(async (statement: { values: unknown[] }) => {
    const [ruleId, deviceId, orgId, severity, title, message, context] = statement.values;
    insertedAlerts.push({ ruleId, deviceId, orgId, severity, title, message, context: JSON.parse(context as string) });
    return [{ id: 'alert-1' }];
  });
  rows.set(devices, [{ id: DEVICE_ID, orgId: 'org-1', siteId: 'site-1', hostname: 'device' }]);
  rows.set(organizations, [{ partnerId: null }]);
  configureRules();
  events = [event(0)];
  vi.mocked(resolveMaintenanceConfigForDevice).mockResolvedValue(null);
  readClosedCursorsMock.mockResolvedValue(new Map());
  advanceOpenRuleCursorsMock.mockResolvedValue(false);
  isCooldownActiveMock.mockResolvedValue(false);
  isFlappingMock.mockResolvedValue(false);
  recordMonitorEvaluationMock.mockResolvedValue({ episodeId: null, latched: false });
  linkEpisodeAlertMock.mockResolvedValue({ owner: true });
  evaluateConditionsMock.mockImplementation(async (condition: { type: string }, deviceId: string, opts?: EvaluateOptions) => {
    const matching = events.filter(row => row.matchesTrigger);
    const watermark = matching.map(cursor).reduce<EvidenceCursor | undefined>((newest, row) => maxEvidence(newest, row), undefined);
    const triggered = condition.type !== 'event_log' || matching.some(row =>
      isAfterCursor(cursor(row), opts?.cursors?.root, opts?.side ?? 'trigger')
      && (!opts?.legacyIngestedBefore || Date.parse(row.createdAt) > opts.legacyIngestedBefore.getTime()));
    return { triggered, dataState: 'ok', conditionsMet: [], conditionsNotMet: [], context: { deviceId },
      evidenceWatermarks: condition.type === 'event_log' && watermark ? { root: watermark } : {} };
  });
});

describe('alert evidence re-arm sweep', () => {
  it('does not re-open after condition_cleared when every trigger event precedes the recovery event', async () => {
    events = [event(0), event(2), event(4, false)];
    closed(events[2]!);
    expect(await evaluateDeviceAlerts(DEVICE_ID)).toEqual([]);
    expect(insertedAlerts).toHaveLength(0);
    expect(isCooldownActiveMock).not.toHaveBeenCalled();
  });

  it('does not re-open on a delayed trigger event that predates the recovery event but was ingested after the close', async () => {
    events = [event(2, true, 8), event(4, false)];
    closed(events[1]!);
    expect(await evaluateDeviceAlerts(DEVICE_ID)).toEqual([]);
    expect(insertedAlerts).toHaveLength(0);
  });

  it('re-opens on a trigger event logged after the recovery event even if ingested before the resolve sweep', async () => {
    events = [event(2, false), event(3, true, 4)];
    closed(events[0]!);
    expect(await evaluateDeviceAlerts(DEVICE_ID)).toEqual(['alert-1']);
    expect(insertedAlerts[0]).toMatchObject({ context: { lifecycle: { cursor: { root: cursor(events[1]!) } } } });
  });

  it('re-opens after a manual resolve on a trigger event the sweep never observed', async () => {
    events = [event(0), event(4)];
    closed(events[0]!);
    expect(await evaluateDeviceAlerts(DEVICE_ID)).toEqual(['alert-1']);
    expect(insertedAlerts[0]).toMatchObject({ context: { lifecycle: { cursor: { root: cursor(events[1]!) } } } });
  });

  it('does not re-open after a manual resolve on events the sweep observed while open', async () => {
    events = [event(0), event(4)];
    closed(events[1]!);
    expect(await evaluateDeviceAlerts(DEVICE_ID)).toEqual([]);
    expect(insertedAlerts).toHaveLength(0);
  });

  it('a cooldown- or flap-blocked evaluation consumes nothing', async () => {
    closed(event(0));
    events = [event(4)];
    isCooldownActiveMock.mockResolvedValueOnce(true);
    expect(await evaluateDeviceAlerts(DEVICE_ID)).toEqual([]);
    expect(advanceOpenRuleCursorsMock).toHaveReturnedWith(expect.any(Promise));
    expect(await advanceOpenRuleCursorsMock.mock.results[0]!.value).toBe(false);
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(insertedAlerts).toHaveLength(0);
    isFlappingMock.mockResolvedValueOnce(true);
    expect(await evaluateDeviceAlerts(DEVICE_ID)).toEqual([]);
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(insertedAlerts).toHaveLength(0);
    expect(await evaluateDeviceAlerts(DEVICE_ID)).toEqual(['alert-1']);
    expect(insertedAlerts[0]).toMatchObject({ context: { lifecycle: { cursor: { root: cursor(events[0]!) } } } });
  });

  it('skips the cursor lookup for rules with no evidence leaf', async () => {
    configureRules([STATE_CONDITION]);
    await evaluateDeviceAlerts(DEVICE_ID);
    expect(readClosedCursorsMock).not.toHaveBeenCalled();
  });

  it('state condition re-opens after cooldown when still breaching after a manual resolve', async () => {
    configureRules([STATE_CONDITION]);
    closed(event(4));
    expect(await evaluateDeviceAlerts(DEVICE_ID)).toEqual(['alert-1']);
    expect(evaluateConditionsMock).toHaveBeenCalledWith(STATE_CONDITION, DEVICE_ID);
    expect(insertedAlerts).toHaveLength(1);
  });

  it('breach episode records ok once the anchored trigger is false', async () => {
    closed(events[0]!);
    await evaluateDeviceAlerts(DEVICE_ID);
    expect(recordMonitorEvaluationMock).toHaveBeenCalledWith(expect.objectContaining({ observation: 'ok' }));
  });

  it('legacy closed alert without cursor passes legacyIngestedBefore = closedAt', async () => {
    closed(null);
    await evaluateDeviceAlerts(DEVICE_ID);
    expect(evaluateConditionsMock).toHaveBeenCalledWith(EVENT_CONDITION, DEVICE_ID, {
      side: 'trigger', cursors: undefined, legacyIngestedBefore: closedAt,
    });
    expect(insertedAlerts).toHaveLength(0);
  });

  it("advances the open alert's cursor when the trigger is still true", async () => {
    rows.set(alerts, [{ id: 'open-alert', status: 'active' }]);
    isCooldownActiveMock.mockResolvedValue(true);
    advanceOpenRuleCursorsMock.mockResolvedValue(true);
    await evaluateDeviceAlerts(DEVICE_ID);
    expect(advanceOpenRuleCursorsMock).toHaveBeenCalledWith('rule-1', DEVICE_ID, { root: cursor(events[0]!) });
    expect(advanceOpenRuleCursorsMock.mock.invocationCallOrder[0]).toBeLessThan(isCooldownActiveMock.mock.invocationCallOrder[0]!);
    expect(insertedAlerts).toHaveLength(0);
  });

  it('createAlert persists lifecycle.cursor into the inserted context', async () => {
    const lifecycle = { cursor: { root: cursor(events[0]!) } };
    await createAlert({ ruleId: 'rule-1', deviceId: DEVICE_ID, orgId: 'org-1', severity: 'high',
      title: 'Breach', message: 'Event', context: { custom: 'kept', lifecycle: { retained: true } }, lifecycle });
    expect(insertedAlerts[0]).toMatchObject({ context: { custom: 'kept', lifecycle: { retained: true, ...lifecycle } } });
  });

  it('cursor read failure skips evidence rules but still evaluates state rules', async () => {
    configureRules([EVENT_CONDITION, STATE_CONDITION]);
    const error = new Error('cursor unavailable');
    readClosedCursorsMock.mockRejectedValue(error);
    rows.set(monitorDeviceState, [{ monitorId: 'monitor-1' }]);
    expect(await evaluateDeviceAlerts(DEVICE_ID)).toEqual(['alert-1']);
    expect(evaluateConditionsMock).toHaveBeenCalledTimes(1);
    expect(evaluateConditionsMock).toHaveBeenCalledWith(STATE_CONDITION, DEVICE_ID);
    expect(detachMonitorFromDeviceMock).not.toHaveBeenCalled();
    expect(readClosedCursorsMock).toHaveBeenCalledTimes(1);
    expect(readClosedCursorsMock).toHaveBeenCalledWith(DEVICE_ID, ['rule-1']);
    expect(captureExceptionMock).toHaveBeenCalledWith(error, undefined, { errorId: 'alert-rearm-cursor-read-failed', deviceId: DEVICE_ID });
  });

  it('cursor advance failure does not prevent alert creation', async () => {
    const error = new Error('advance unavailable');
    advanceOpenRuleCursorsMock.mockRejectedValue(error);
    expect(await evaluateDeviceAlerts(DEVICE_ID)).toEqual(['alert-1']);
    expect(captureExceptionMock).toHaveBeenCalledWith(error, undefined, expect.objectContaining({ deviceId: DEVICE_ID }));
  });

  it('batches the closed cursor lookup for all evidence rules', async () => {
    configureRules([EVENT_CONDITION, EVENT_CONDITION]);
    await evaluateDeviceAlerts(DEVICE_ID);
    expect(readClosedCursorsMock).toHaveBeenCalledTimes(1);
    expect(readClosedCursorsMock).toHaveBeenCalledWith(DEVICE_ID, ['rule-1', 'rule-2']);
  });

  it('maintenance suppression does not evaluate or consume evidence', async () => {
    vi.mocked(resolveMaintenanceConfigForDevice).mockResolvedValue({ suppressAlerts: true } as never);
    vi.mocked(isInMaintenanceWindow).mockReturnValue({ active: true, suppressAlerts: true } as never);
    expect(await evaluateDeviceAlerts(DEVICE_ID)).toEqual([]);
    expect(readClosedCursorsMock).not.toHaveBeenCalled();
    expect(evaluateConditionsMock).not.toHaveBeenCalled();
    expect(advanceOpenRuleCursorsMock).not.toHaveBeenCalled();
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it.each(['network_check', 'hardware_health'])('does not read closed evidence cursors for %s monitors', async kind => {
    rows.set(monitorDefinitions, [{ id: 'monitor-1', kind }]);
    await evaluateDeviceAlerts(DEVICE_ID);
    expect(readClosedCursorsMock).not.toHaveBeenCalled();
    expect(advanceOpenRuleCursorsMock).not.toHaveBeenCalled();
  });

});
