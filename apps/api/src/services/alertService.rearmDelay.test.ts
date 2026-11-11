/**
 * Alert re-arm lifecycle W2 Task 13: the lifecycle snapshot on an alert and the
 * `after_delay` re-arm mode. Harness matches alertService.rearm.test.ts; the
 * lifecycle loader here is the REAL one, reading rows from the mocked `db`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAfterCursor, maxEvidence, type EvidenceCursor } from '@breeze/shared';
import type { EvaluateOptions } from './alertConditions';

const {
  dbMock, rows, insertedAlerts, updateSets, updateReturning, setCooldownMock, resolveMonitorsForDeviceMock,
  evaluateConditionsMock, recordMonitorEvaluationMock, linkEpisodeAlertMock,
  isCooldownActiveMock, isFlappingMock, readClosedCursorsMock, advanceOpenRuleCursorsMock,
} = vi.hoisted(() => ({
  rows: new Map<unknown, unknown[]>(),
  insertedAlerts: [] as Array<Record<string, unknown>>,
  updateSets: [] as Array<Record<string, unknown>>,
  updateReturning: { rows: [] as unknown[] },
  dbMock: { select: vi.fn(), execute: vi.fn(), update: vi.fn(), delete: vi.fn() },
  setCooldownMock: vi.fn(() => Promise.resolve()),
  resolveMonitorsForDeviceMock: vi.fn(),
  evaluateConditionsMock: vi.fn(),
  recordMonitorEvaluationMock: vi.fn(),
  linkEpisodeAlertMock: vi.fn(),
  isCooldownActiveMock: vi.fn(),
  isFlappingMock: vi.fn(),
  readClosedCursorsMock: vi.fn(),
  advanceOpenRuleCursorsMock: vi.fn(),
}));

vi.mock('./alertLifecycle/cursor', () => ({
  readClosedCursors: readClosedCursorsMock,
  advanceOpenRuleCursors: advanceOpenRuleCursorsMock,
}));

vi.mock('drizzle-orm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('drizzle-orm')>()),
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
}));

vi.mock('../db', () => ({
  db: dbMock,
  withDbTransaction: async (fn: () => Promise<unknown>) => fn(),
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => fn(),
}));
// A partner read under the sweep's system scope takes no escape; the escape
// itself is pinned by alertLifecycle/resolve.test.ts.
vi.mock('../db/partnerAxisRead', () => ({
  readWithPartnerAxisVisibility: <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock('./alertSubjects', () => ({ evaluateSubjectAlerts: vi.fn(async () => 'ok') }));
vi.mock('./monitors/monitorResolver', () => ({ resolveMonitorsForDevice: resolveMonitorsForDeviceMock }));
vi.mock('./monitors/episodeService', () => ({
  recordMonitorEvaluation: recordMonitorEvaluationMock,
  recordRecoveryObservation: vi.fn(),
  detachMonitorFromDevice: vi.fn(),
  linkEpisodeAlert: linkEpisodeAlertMock,
}));
vi.mock('./monitors/escalationLatch', () => ({ fireEscalationLatch: vi.fn() }));
vi.mock('./alertConditions', () => ({
  evaluateConditions: evaluateConditionsMock,
  evidenceLeafPaths: (condition: { type?: string }) => condition?.type === 'event_log' ? ['root'] : [],
  evaluateAutoResolveConditions: vi.fn(),
  interpolateTemplate: vi.fn((template: string) => template),
  withMetConditionDescriptions: vi.fn((context: Record<string, unknown>) => context),
}));
vi.mock('./alertCooldown', () => ({
  isCooldownActive: isCooldownActiveMock,
  setCooldown: setCooldownMock,
  recordStateTransition: vi.fn(() => Promise.resolve()),
  isFlapping: isFlappingMock,
}));
vi.mock('./featureConfigResolver', () => ({
  resolveMaintenanceConfigForDevice: vi.fn(async () => null),
  isInMaintenanceWindow: vi.fn(),
}));
vi.mock('./eventBus', () => ({ publishEvent: vi.fn(() => Promise.resolve()) }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./deviceSiteResolver', () => ({ resolveDeviceSiteId: vi.fn(() => Promise.resolve('site-1')) }));
vi.mock('../jobs/alertCorrelation', () => ({ enqueueAlertCorrelation: vi.fn(() => Promise.resolve('job-1')) }));
vi.mock('./subjectAlertOutbox', () => ({ scheduleStagedAlertDispatch: vi.fn() }));

import {
  alerts, alertRules, alertTemplates, devices, organizations, partners, monitorDefinitions,
} from '../db/schema';
import { checkAutoResolve, createAlert, evaluateDeviceAlerts, resolveAlert } from './alertService';

const DEVICE_ID = 'device-1';
const EVENT_CONDITION = { type: 'event_log', category: 'system', level: 'error', countThreshold: 1, windowMinutes: 60 };
const closedAt = new Date('2026-10-29T10:05:00Z');
const minutesAfterClose = (minutes: number) => new Date(closedAt.getTime() + minutes * 60_000);

type Event = EvidenceCursor;
const event = (minute: number): Event => ({
  ts: `2026-10-29T10:${String(minute).padStart(2, '0')}:00.000Z`,
  createdAt: `2026-10-29T10:${String(minute).padStart(2, '0')}:00.000Z`,
  id: `event-${minute}`,
});
let events: Event[];

function closed(anchor: Event) {
  readClosedCursorsMock.mockResolvedValue(new Map([
    ['rule-1', { cursors: { root: anchor }, closedAt, legacy: false }],
  ]));
}

function monitorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'monitor-1', kind: 'event_log', compiledHash: 'hash-1', autoResolve: null, cooldownMinutes: null,
    rearmMode: null, rearmDelayMinutes: null, ...overrides,
  };
}

function setMonitor(overrides: Record<string, unknown> = {}) {
  rows.set(monitorDefinitions, [monitorRow(overrides)]);
}

beforeEach(() => {
  vi.resetAllMocks();
  rows.clear();
  insertedAlerts.length = 0;
  updateSets.length = 0;
  updateReturning.rows = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(minutesAfterClose(1));

  dbMock.select.mockImplementation(() => ({ from: (table: unknown) => ({ where: () => {
    const result = rows.get(table) ?? [];
    return { limit: () => Promise.resolve(result), then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(result).then(resolve) };
  } }) }));
  dbMock.execute.mockImplementation(async (statement: { values: unknown[] }) => {
    const [ruleId, deviceId, orgId, severity, title, message, context] = statement.values;
    insertedAlerts.push({ ruleId, deviceId, orgId, severity, title, message, context: JSON.parse(context as string) });
    return [{ id: 'alert-1' }];
  });
  dbMock.update.mockImplementation(() => ({ set: (values: Record<string, unknown>) => {
    updateSets.push(values);
    return { where: () => ({ returning: async () => updateReturning.rows }) };
  } }));

  rows.set(devices, [{ id: DEVICE_ID, orgId: 'org-1', siteId: 'site-1', hostname: 'device' }]);
  rows.set(organizations, [{
    partnerId: 'partner-1', alertAutoResolve: null, alertRearmMode: null, alertRearmDelayMinutes: null, alertCooldownMinutes: null,
  }]);
  rows.set(partners, [{
    alertAutoResolve: false, alertRearmMode: 'new_evidence', alertRearmDelayMinutes: null, alertCooldownMinutes: 5,
  }]);
  rows.set(alertRules, [{
    id: 'rule-1', templateId: 'template-1', orgId: 'org-1', targetType: 'monitor', targetId: 'monitor-1', isActive: true,
    managedByMonitorId: 'monitor-1', overrideSettings: null, name: 'Event monitor',
  }]);
  rows.set(alertTemplates, [{
    id: 'template-1', conditions: EVENT_CONDITION, severity: 'high', cooldownMinutes: 5, autoResolve: false,
    autoResolveConditions: null, titleTemplate: 'Monitor breach', messageTemplate: 'Monitor breached',
  }]);
  setMonitor();
  resolveMonitorsForDeviceMock.mockResolvedValue({
    kind: 'resolved', monitors: [{ monitorId: 'monitor-1', enabled: true, overrides: null }],
  });

  events = [event(0)];
  readClosedCursorsMock.mockResolvedValue(new Map());
  advanceOpenRuleCursorsMock.mockResolvedValue(false);
  isCooldownActiveMock.mockResolvedValue(false);
  isFlappingMock.mockResolvedValue(false);
  recordMonitorEvaluationMock.mockResolvedValue({ episodeId: null, latched: false });
  linkEpisodeAlertMock.mockResolvedValue({ owner: true });
  // The real event_log semantics that matter here: a stored cursor requires one
  // row after it; no cursor means the rolling window alone decides.
  evaluateConditionsMock.mockImplementation(async (_condition: unknown, deviceId: string, opts?: EvaluateOptions) => {
    const watermark = events.reduce<EvidenceCursor | undefined>((newest, row) => maxEvidence(newest, row), undefined);
    const triggered = events.some((row) => isAfterCursor(row, opts?.cursors?.root, opts?.side ?? 'trigger'));
    return {
      triggered, dataState: 'ok', conditionsMet: [], conditionsNotMet: [], context: { deviceId },
      evidenceWatermarks: watermark ? { root: watermark } : {},
    };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('lifecycle snapshot', () => {
  it('createAlert snapshots the effective lifecycle and its sources on context.lifecycle', async () => {
    setMonitor({ cooldownMinutes: 3 });
    rows.set(organizations, [{
      partnerId: 'partner-1', alertAutoResolve: true, alertRearmMode: null, alertRearmDelayMinutes: null, alertCooldownMinutes: 20,
    }]);
    rows.set(partners, [{
      alertAutoResolve: false, alertRearmMode: 'after_delay', alertRearmDelayMinutes: 90, alertCooldownMinutes: 5,
    }]);

    expect(await evaluateDeviceAlerts(DEVICE_ID)).toEqual(['alert-1']);

    expect(insertedAlerts[0]!.context).toMatchObject({
      lifecycle: {
        cursor: { root: event(0) },
        autoResolve: true,
        rearmMode: 'after_delay',
        rearmDelayMinutes: 90,
        cooldownMinutes: 3,
        sources: { autoResolve: 'org', rearmMode: 'partner', rearmDelayMinutes: 'partner', cooldownMinutes: 'monitor' },
        monitorCompiledHash: 'hash-1',
      },
    });
  });

  it('a legacy rule snapshots its rule/template values, a null hash and the built-in re-arm', async () => {
    rows.set(alertRules, [{
      id: 'rule-1', templateId: 'template-1', orgId: 'org-1', isActive: true,
      managedByMonitorId: null, overrideSettings: { cooldownMinutes: 15 }, name: 'Legacy',
    }]);
    expect(await createAlert({
      ruleId: 'rule-1', deviceId: DEVICE_ID, orgId: 'org-1', severity: 'high', title: 't', message: 'm',
    })).toBe('alert-1');
    expect(insertedAlerts[0]!.context).toMatchObject({
      lifecycle: {
        autoResolve: false, rearmMode: 'new_evidence', rearmDelayMinutes: null, cooldownMinutes: 15,
        sources: { autoResolve: 'legacy', rearmMode: 'builtin', rearmDelayMinutes: 'builtin', cooldownMinutes: 'legacy' },
        monitorCompiledHash: null,
      },
    });
  });

  it('a subject alert keeps the snapshot through its outbox stamp, with no evidence cursor', async () => {
    setMonitor({ cooldownMinutes: 3 });
    expect(await createAlert({
      ruleId: 'rule-1', deviceId: DEVICE_ID, orgId: 'org-1', severity: 'high', title: 't', message: 'm',
      subjectKey: 'disk:3', lifecycle: { cursor: { root: event(0) } }, monitorCompiledHash: 'hash-1',
    })).toBe('alert-1');
    const stamped = updateSets[0]!.context as Record<string, Record<string, unknown>>;
    expect(stamped._subjectDispatch).toMatchObject({ cooldownMinutes: 3 });
    expect(stamped.lifecycle).toMatchObject({ cooldownMinutes: 3, monitorCompiledHash: 'hash-1' });
    expect(stamped.lifecycle).not.toHaveProperty('cursor');
  });

  it('open alert keeps its snapshotted cooldown after the partner default changes', async () => {
    // Opened with a 7-minute cooldown; the partner default is now 99.
    rows.set(partners, [{
      alertAutoResolve: false, alertRearmMode: 'new_evidence', alertRearmDelayMinutes: null, alertCooldownMinutes: 99,
    }]);
    updateReturning.rows = [{
      id: 'alert-1', ruleId: 'rule-1', deviceId: DEVICE_ID, orgId: 'org-1', ownerKind: 'device', subjectKey: null,
      triggeredAt: closedAt, resolvedAt: minutesAfterClose(1), resolvedBy: null, resolutionReason: 'manual',
      context: {
        lifecycle: {
          autoResolve: false, rearmMode: 'new_evidence', rearmDelayMinutes: null, cooldownMinutes: 7,
          sources: { autoResolve: 'partner', rearmMode: 'partner', rearmDelayMinutes: 'partner', cooldownMinutes: 'partner' },
          monitorCompiledHash: 'hash-1',
        },
      },
    }];

    expect(await resolveAlert('alert-1', 'done', 'user-1')).toBe(true);
    expect(setCooldownMock).toHaveBeenCalledWith('rule-1', DEVICE_ID, 7, undefined);
  });

  it('an alert with no snapshot (opened before W2) closes with the current resolution', async () => {
    rows.set(partners, [{
      alertAutoResolve: false, alertRearmMode: 'new_evidence', alertRearmDelayMinutes: null, alertCooldownMinutes: 99,
    }]);
    updateReturning.rows = [{
      id: 'alert-1', ruleId: 'rule-1', deviceId: DEVICE_ID, orgId: 'org-1', ownerKind: 'device', subjectKey: null,
      triggeredAt: closedAt, resolvedAt: minutesAfterClose(1), resolvedBy: null, resolutionReason: 'manual',
      // A W1 alert: a cursor but no lifecycle values.
      context: { lifecycle: { cursor: { root: event(0) } } },
    }];

    expect(await resolveAlert('alert-1', 'done', 'user-1')).toBe(true);
    expect(setCooldownMock).toHaveBeenCalledWith('rule-1', DEVICE_ID, 99, undefined);
  });

  it('a monitor edit does not change the auto-resolve an open alert opened with', async () => {
    setMonitor({ autoResolve: true });
    rows.set(alerts, [{
      id: 'alert-1', ruleId: 'rule-1', deviceId: DEVICE_ID, orgId: 'org-1', ownerKind: 'device', status: 'active', subjectKey: null,
      requiresHuman: false, triggeredAt: closedAt,
      context: {
        lifecycle: {
          autoResolve: false, rearmMode: 'new_evidence', rearmDelayMinutes: null, cooldownMinutes: 5,
          sources: { autoResolve: 'partner', rearmMode: 'partner', rearmDelayMinutes: 'partner', cooldownMinutes: 'partner' },
          monitorCompiledHash: 'hash-0',
        },
      },
    }]);
    expect(await checkAutoResolve('alert-1')).toBe(false);
    expect(evaluateConditionsMock).not.toHaveBeenCalled();
  });
});

describe('re-arm modes', () => {
  it('after_delay re-opens on old evidence once N minutes have passed since close', async () => {
    setMonitor({ rearmMode: 'after_delay', rearmDelayMinutes: 30 });
    closed(event(0)); // every matching row is already consumed

    vi.setSystemTime(minutesAfterClose(29));
    expect(await evaluateDeviceAlerts(DEVICE_ID)).toEqual([]);
    expect(insertedAlerts).toHaveLength(0);

    vi.setSystemTime(minutesAfterClose(30));
    expect(await evaluateDeviceAlerts(DEVICE_ID)).toEqual(['alert-1']);
    expect(insertedAlerts).toHaveLength(1);
    expect(evaluateConditionsMock).toHaveBeenLastCalledWith(EVENT_CONDITION, DEVICE_ID, { side: 'trigger' });
  });

  it('an after_delay re-open past the delay still respects an active cooldown', async () => {
    setMonitor({ rearmMode: 'after_delay', rearmDelayMinutes: 30, cooldownMinutes: 60 });
    closed(event(0));
    isCooldownActiveMock.mockResolvedValue(true);
    vi.setSystemTime(minutesAfterClose(31));
    expect(await evaluateDeviceAlerts(DEVICE_ID)).toEqual([]);
    expect(insertedAlerts).toHaveLength(0);
    expect(isCooldownActiveMock).toHaveBeenCalled();
  });

  it('after_delay still fires immediately on new evidence', async () => {
    setMonitor({ rearmMode: 'after_delay', rearmDelayMinutes: 30 });
    closed(event(0));
    events = [event(0), event(4)];

    vi.setSystemTime(minutesAfterClose(1));
    expect(await evaluateDeviceAlerts(DEVICE_ID)).toEqual(['alert-1']);
    expect(insertedAlerts[0]).toMatchObject({ context: { lifecycle: { cursor: { root: event(4) } } } });
  });

  it('new_evidence never re-opens on consumed evidence however long ago the close was', async () => {
    closed(event(0));
    vi.setSystemTime(minutesAfterClose(60 * 24 * 30));
    expect(await evaluateDeviceAlerts(DEVICE_ID)).toEqual([]);
    expect(insertedAlerts).toHaveLength(0);
  });

  it('the re-arm gate reads the current lifecycle: a mode change applies to the next episode at once', async () => {
    // The closed alert opened under new_evidence; the org has since chosen after_delay.
    rows.set(organizations, [{
      partnerId: 'partner-1', alertAutoResolve: null, alertRearmMode: 'after_delay', alertRearmDelayMinutes: 10, alertCooldownMinutes: null,
    }]);
    closed(event(0));
    vi.setSystemTime(minutesAfterClose(10));
    expect(await evaluateDeviceAlerts(DEVICE_ID)).toEqual(['alert-1']);
  });

  it('after_delay drops the legacy ingestion fence too once the delay has passed', async () => {
    setMonitor({ rearmMode: 'after_delay', rearmDelayMinutes: 30 });
    readClosedCursorsMock.mockResolvedValue(new Map([
      ['rule-1', { cursors: null, closedAt, legacy: true }],
    ]));

    vi.setSystemTime(minutesAfterClose(29));
    await evaluateDeviceAlerts(DEVICE_ID);
    expect(evaluateConditionsMock).toHaveBeenLastCalledWith(EVENT_CONDITION, DEVICE_ID, {
      side: 'trigger', cursors: undefined, legacyIngestedBefore: closedAt,
    });

    vi.setSystemTime(minutesAfterClose(30));
    await evaluateDeviceAlerts(DEVICE_ID);
    expect(evaluateConditionsMock).toHaveBeenLastCalledWith(EVENT_CONDITION, DEVICE_ID, { side: 'trigger' });
  });

  it('an after_delay re-open on old evidence is not cleared at once by the inverse auto-resolve check', async () => {
    // Without the same gate, the inverse check would evaluate the trigger against
    // the closed cursor, find nothing new and resolve the alert it just re-opened.
    readClosedCursorsMock.mockResolvedValue(new Map([
      ['rule-1', { cursors: { root: event(0) }, closedAt, legacy: false }],
    ]));
    rows.set(alerts, [{
      id: 'alert-1', ruleId: 'rule-1', deviceId: DEVICE_ID, orgId: 'org-1', ownerKind: 'device', status: 'active', subjectKey: null,
      requiresHuman: false, triggeredAt: minutesAfterClose(30),
      context: {
        lifecycle: {
          autoResolve: true, rearmMode: 'after_delay', rearmDelayMinutes: 30, cooldownMinutes: 5,
          sources: { autoResolve: 'monitor', rearmMode: 'monitor', rearmDelayMinutes: 'monitor', cooldownMinutes: 'partner' },
          monitorCompiledHash: 'hash-1',
        },
      },
    }]);
    vi.setSystemTime(minutesAfterClose(31));

    expect(await checkAutoResolve('alert-1')).toBe(false);
    expect(evaluateConditionsMock).toHaveBeenCalledWith(EVENT_CONDITION, DEVICE_ID, { side: 'trigger' });
    expect(updateSets).toHaveLength(0);
  });
});
