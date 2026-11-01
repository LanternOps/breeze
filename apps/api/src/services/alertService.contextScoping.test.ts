import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #10859 — `evaluateDeviceAlerts` scopes its own DB contexts.
 *
 * The alert worker used to wrap the whole evaluation in ONE system context, so
 * a device's ~13 managed rules ran back to back on one pooled connection held
 * in an open transaction for 2–6 s. The evaluator now opens one short system
 * context per unit of work — the rule lookup (prelude), each rule, and the
 * detach scan — and joins the caller's context when one is already open (the
 * network_check sweep, the integration tests).
 *
 * The `withSystemDbAccessContext` double below models the real join semantics
 * (a nested call runs inside the ambient context, it does not open a second
 * one) and gives every top-level context an id, so each DB read and each
 * mocked service call can be attributed to the context it ran in.
 *
 * Harness (FIFO `resultsQueue` chainable `db`) follows
 * `alertService.episodes.test.ts`.
 */
const h = vi.hoisted(() => {
  const ctx = {
    depth: 0,
    maxDepth: 0,
    nextId: 1,
    currentId: 0,
    labels: [] as Array<string | undefined>,
  };
  /** Every DB read and every mocked service call, tagged with its context id (0 = none). */
  const trace: Array<{ op: string; ctxId: number }> = [];
  const record = (op: string) => trace.push({ op, ctxId: ctx.depth > 0 ? ctx.currentId : 0 });

  const resultsQueue: Array<{ op: string; rows: unknown[] }> = [];
  const nextResult = () => {
    const next = resultsQueue.shift();
    if (!next) return [];
    record(next.op);
    return next.rows;
  };
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
    ctx,
    trace,
    record,
    resultsQueue,
    dbMock: {
      select: vi.fn(() => ({ from: () => ({ where: () => chain() }) })),
      execute: vi.fn(async () => {
        record('db.execute');
        return [];
      }),
      insert: vi.fn(),
      update: vi.fn(() => ({ set: () => ({ where: () => Promise.resolve(undefined) }) })),
      delete: vi.fn(() => ({ where: () => Promise.resolve([]) })),
    },
    withSystemDbAccessContext: vi.fn(async <T>(fn: () => Promise<T>, label?: string): Promise<T> => {
      if (ctx.depth > 0) return fn(); // join the ambient context, like the real helper
      const id = ctx.nextId++;
      ctx.labels.push(label);
      ctx.depth++;
      ctx.maxDepth = Math.max(ctx.maxDepth, ctx.depth);
      ctx.currentId = id;
      try {
        return await fn();
      } finally {
        ctx.depth--;
        ctx.currentId = 0;
      }
    }),
    withDbTransaction: vi.fn(async <T>(fn: () => Promise<T>): Promise<T> => {
      if (ctx.depth === 0) throw new Error('withDbTransaction must run inside withDbAccessContext');
      record('withDbTransaction');
      return fn();
    }),
    captureExceptionMock: vi.fn(),
    resolveMonitorsForDeviceMock: vi.fn(),
    evaluateConditionsMock: vi.fn(),
    recordMonitorEvaluationMock: vi.fn(),
    detachMonitorFromDeviceMock: vi.fn(),
    evaluateSubjectAlertsMock: vi.fn(),
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

vi.mock('../db', () => ({
  db: h.dbMock,
  withDbTransaction: h.withDbTransaction,
  withSystemDbAccessContext: h.withSystemDbAccessContext,
}));

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
  resolveMonitorsForDevice: (...args: unknown[]) => {
    h.record('resolveMonitorsForDevice');
    return h.resolveMonitorsForDeviceMock(...args);
  },
}));

vi.mock('./monitors/episodeService', () => ({
  recordMonitorEvaluation: (input: { monitor: { id: string } }) => {
    h.record(`recordMonitorEvaluation:${input.monitor.id}`);
    return h.recordMonitorEvaluationMock(input);
  },
  detachMonitorFromDevice: (monitorId: string, deviceId: string) => {
    h.record(`detachMonitorFromDevice:${monitorId}`);
    return h.detachMonitorFromDeviceMock(monitorId, deviceId);
  },
  linkEpisodeAlert: vi.fn(async () => ({ owner: true })),
}));

vi.mock('./monitors/escalationLatch', () => ({ fireEscalationLatch: vi.fn() }));

vi.mock('./alertSubjects', () => ({
  evaluateSubjectAlerts: (...args: unknown[]) => {
    h.record('evaluateSubjectAlerts');
    return h.evaluateSubjectAlertsMock(...args);
  },
}));

vi.mock('./alertConditions', () => ({
  evaluateConditions: (conditions: { rule: string }, deviceId: string) => {
    h.record(`evaluateConditions:${conditions.rule}`);
    return h.evaluateConditionsMock(conditions, deviceId);
  },
  evaluateAutoResolveConditions: vi.fn(),
  interpolateTemplate: vi.fn((template: string) => template),
}));

vi.mock('./alertCooldown', () => ({
  isCooldownActive: vi.fn(async () => false),
  setCooldown: vi.fn(async () => undefined),
  recordStateTransition: vi.fn(async () => undefined),
  isFlapping: vi.fn(async () => false),
}));

vi.mock('./featureConfigResolver', () => ({
  resolveMaintenanceConfigForDevice: vi.fn(async () => {
    h.record('resolveMaintenanceConfigForDevice');
    return null;
  }),
  isInMaintenanceWindow: vi.fn(),
}));

vi.mock('./eventBus', () => ({ publishEvent: vi.fn(async () => 'evt') }));
vi.mock('./sentry', () => ({ captureException: h.captureExceptionMock }));
vi.mock('./deviceSiteResolver', () => ({ resolveDeviceSiteId: vi.fn(async () => 'site-1') }));
vi.mock('../jobs/alertCorrelation', () => ({ enqueueAlertCorrelation: vi.fn(async () => 'job-1') }));

import { evaluateDeviceAlerts } from './alertService';
import { withSystemDbAccessContext } from '../db';

const DEVICE_ID = 'device-1';
const DEVICE_ORG = 'org-device';

type RuleSpec = { ruleId: string; monitorId: string; kind?: string };

/** FIFO results for one sweep over `rules` (all monitor-managed, none triggering). */
function pushSweep(rules: RuleSpec[], openStateRows: Array<{ monitorId: string }> = []) {
  const q = h.resultsQueue;
  q.push({ op: 'select:device', rows: [{ id: DEVICE_ID, orgId: DEVICE_ORG, siteId: 'site-1' }] });
  q.push({ op: 'select:groupMemberships', rows: [] });
  q.push({ op: 'select:owningOrg', rows: [{ partnerId: null }] });
  q.push({
    op: 'select:rules',
    rows: rules.map((r) => ({
      id: r.ruleId,
      templateId: `template-${r.ruleId}`,
      orgId: DEVICE_ORG,
      partnerId: null,
      targetType: 'monitor',
      targetId: r.monitorId,
      isActive: true,
      managedByMonitorId: r.monitorId,
      overrideSettings: null,
      name: r.ruleId,
    })),
  });
  q.push({
    op: 'select:templates',
    rows: rules.map((r) => ({
      id: `template-${r.ruleId}`,
      conditions: { rule: r.ruleId },
      severity: 'high',
      cooldownMinutes: 5,
      titleTemplate: 't',
      messageTemplate: 'm',
    })),
  });
  q.push({
    op: 'select:monitorDefinitions',
    rows: rules.map((r) => ({ id: r.monitorId, kind: r.kind ?? 'cpu', name: r.monitorId })),
  });
  q.push({ op: 'select:sweepDevice', rows: [{ id: DEVICE_ID, orgId: DEVICE_ORG, hostname: 'ws-1' }] });
  q.push({ op: 'select:detachScan', rows: openStateRows });
}

const opsIn = (ctxId: number) => h.trace.filter((t) => t.ctxId === ctxId).map((t) => t.op);
const ctxOf = (op: string) => h.trace.find((t) => t.op === op)?.ctxId;

beforeEach(() => {
  h.resultsQueue.length = 0;
  h.trace.length = 0;
  h.ctx.depth = 0;
  h.ctx.maxDepth = 0;
  h.ctx.nextId = 1;
  h.ctx.currentId = 0;
  h.ctx.labels.length = 0;
  vi.clearAllMocks();
  h.resolveMonitorsForDeviceMock.mockResolvedValue({
    kind: 'resolved',
    monitors: ['monitor-1', 'monitor-2', 'monitor-3'].map((monitorId) => ({
      monitorId, enabled: true, overrides: null, sourcePolicyId: 'p1', sourceLevel: 'organization',
    })),
  });
  h.evaluateConditionsMock.mockResolvedValue({
    triggered: false,
    conditionsMet: [],
    conditionsNotMet: ['cpu <= 80'],
    dataState: 'ok',
    context: {},
  });
  h.recordMonitorEvaluationMock.mockResolvedValue({
    episodeId: null,
    episodeOpened: false,
    episodeClosed: false,
    episodesInWindow: 0,
    latched: false,
    needsEscalationAlert: false,
    responsesPaused: false,
  });
  h.detachMonitorFromDeviceMock.mockResolvedValue(undefined);
  h.evaluateSubjectAlertsMock.mockResolvedValue('ok');
});

describe('evaluateDeviceAlerts — DB context scoping (#10859)', () => {
  const THREE_RULES: RuleSpec[] = [
    { ruleId: 'rule-1', monitorId: 'monitor-1' },
    { ruleId: 'rule-2', monitorId: 'monitor-2' },
    { ruleId: 'rule-3', monitorId: 'monitor-3' },
  ];

  it('opens one short context per unit of work — never one spanning all of a device\'s rules', async () => {
    pushSweep(THREE_RULES);

    await evaluateDeviceAlerts(DEVICE_ID);

    // Nothing touched the DB (or a DB-backed service) outside a context.
    expect(h.trace.filter((t) => t.ctxId === 0)).toEqual([]);
    // Contexts are sequential, never nested.
    expect(h.ctx.maxDepth).toBe(1);

    // prelude, one per rule, detach.
    expect(h.ctx.labels).toEqual([
      'alertEvaluation.prelude',
      'alertEvaluation.rule',
      'alertEvaluation.rule',
      'alertEvaluation.rule',
      'alertEvaluation.detach',
    ]);
    expect(opsIn(1)).toEqual([
      'resolveMaintenanceConfigForDevice',
      'select:device',
      'select:groupMemberships',
      'resolveMonitorsForDevice',
      'select:owningOrg',
      'select:rules',
      'select:templates',
      'select:monitorDefinitions',
      'select:sweepDevice',
    ]);
    expect(opsIn(2)).toEqual(['evaluateConditions:rule-1', 'recordMonitorEvaluation:monitor-1']);
    expect(opsIn(3)).toEqual(['evaluateConditions:rule-2', 'recordMonitorEvaluation:monitor-2']);
    expect(opsIn(4)).toEqual(['evaluateConditions:rule-3', 'recordMonitorEvaluation:monitor-3']);
    expect(opsIn(5)).toEqual(['select:detachScan']);

    // The acceptance criterion, stated directly: no context saw two rules.
    const rulesPerContext = new Map<number, Set<string>>();
    for (const t of h.trace) {
      const match = /^evaluateConditions:(.+)$/.exec(t.op);
      if (!match) continue;
      const set = rulesPerContext.get(t.ctxId) ?? new Set<string>();
      set.add(match[1]!);
      rulesPerContext.set(t.ctxId, set);
    }
    expect([...rulesPerContext.values()].every((set) => set.size === 1)).toBe(true);
  });

  it('a rule that fails in its own context does not stop the next rule, and its monitor is not detached', async () => {
    // The failing rule's monitor has an open episode: if the failure dropped
    // it from the evaluated set, the detach scan would wrongly close it as
    // `monitor_detached` on every failed tick.
    pushSweep(THREE_RULES, [{ monitorId: 'monitor-2' }]);
    h.recordMonitorEvaluationMock.mockImplementation(async (input: { monitor: { id: string } }) => {
      if (input.monitor.id === 'monitor-2') throw new Error('episode write failed');
      return { episodeId: null, latched: false, needsEscalationAlert: false, episodesInWindow: 0 };
    });
    h.evaluateConditionsMock.mockImplementation(async (conditions: { rule: string }) => {
      if (conditions.rule === 'rule-2') throw new Error('metrics read failed');
      return { triggered: false, conditionsMet: [], conditionsNotMet: [], dataState: 'ok', context: {} };
    });

    await evaluateDeviceAlerts(DEVICE_ID);

    expect(ctxOf('evaluateConditions:rule-3')).toBe(4);
    expect(opsIn(4)).toEqual(['evaluateConditions:rule-3', 'recordMonitorEvaluation:monitor-3']);
    expect(h.captureExceptionMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'metrics read failed' }),
      undefined,
      expect.objectContaining({ errorId: 'alert-rule-evaluation-failed', ruleId: 'rule-2' }),
    );
    expect(h.detachMonitorFromDeviceMock).not.toHaveBeenCalled();
  });

  it('keeps the subject branch\'s savepoint + advisory lock inside that rule\'s own context', async () => {
    pushSweep([
      { ruleId: 'rule-1', monitorId: 'monitor-1', kind: 'hardware_health' },
      { ruleId: 'rule-2', monitorId: 'monitor-2' },
    ]);
    h.evaluateConditionsMock.mockImplementation(async (conditions: { rule: string }) => (
      conditions.rule === 'rule-1'
        ? { triggered: false, conditionsMet: [], conditionsNotMet: [], dataState: 'ok', context: {}, subjects: [] }
        : { triggered: false, conditionsMet: [], conditionsNotMet: [], dataState: 'ok', context: {} }
    ));

    await evaluateDeviceAlerts(DEVICE_ID);

    // The whole subject reconciliation — first read, savepoint, advisory
    // lock, re-read, reconcile, observation — runs in rule-1's context, which
    // commits (and releases the xact lock) before rule-2's context opens.
    expect(opsIn(2)).toEqual([
      'evaluateConditions:rule-1',
      'withDbTransaction',
      'db.execute',
      'evaluateConditions:rule-1',
      'evaluateSubjectAlerts',
      'recordMonitorEvaluation:monitor-1',
    ]);
    expect(opsIn(3)).toEqual(['evaluateConditions:rule-2', 'recordMonitorEvaluation:monitor-2']);
    expect(h.ctx.maxDepth).toBe(1);
  });

  it('joins the caller\'s context when one is already open (network_check sweep, integration tests)', async () => {
    pushSweep(THREE_RULES);

    await withSystemDbAccessContext(() => evaluateDeviceAlerts(DEVICE_ID), 'caller');

    expect(h.ctx.labels).toEqual(['caller']);
    expect(new Set(h.trace.map((t) => t.ctxId))).toEqual(new Set([1]));
  });

  it('opens no rule context at all when no rule applies', async () => {
    h.resultsQueue.push({ op: 'select:device', rows: [{ id: DEVICE_ID, orgId: DEVICE_ORG, siteId: 'site-1' }] });
    h.resultsQueue.push({ op: 'select:groupMemberships', rows: [] });
    h.resultsQueue.push({ op: 'select:owningOrg', rows: [{ partnerId: null }] });
    h.resultsQueue.push({ op: 'select:rules', rows: [] });

    await expect(evaluateDeviceAlerts(DEVICE_ID)).resolves.toEqual([]);

    expect(h.ctx.labels).toEqual(['alertEvaluation.prelude']);
  });
});
