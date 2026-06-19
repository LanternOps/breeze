import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  authRef,
  buildAlertCorrelationRcaMock,
  grantedRef,
  emitAlertStateFeedbackMock,
  emitCorrelationFeedbackMock,
  emitRcaFeedbackMock,
  shouldProduceMlOutputMock,
  captureExceptionMock,
  state,
  tables,
  dbMock,
} = vi.hoisted(() => {
  const tables = {
    alerts: {
      id: 'alerts.id', orgId: 'alerts.orgId', deviceId: 'alerts.deviceId', status: 'alerts.status',
      severity: 'alerts.severity', title: 'alerts.title', triggeredAt: 'alerts.triggeredAt', createdAt: 'alerts.createdAt',
    },
    alertCorrelations: {
      id: 'alert_correlations.id', parentAlertId: 'alert_correlations.parentAlertId', childAlertId: 'alert_correlations.childAlertId',
      correlationType: 'alert_correlations.correlationType', confidence: 'alert_correlations.confidence', createdAt: 'alert_correlations.createdAt',
    },
    alertCorrelationGroups: {
      id: 'alert_correlation_groups.id', orgId: 'alert_correlation_groups.orgId', groupKey: 'alert_correlation_groups.groupKey',
      rootAlertId: 'alert_correlation_groups.rootAlertId', status: 'alert_correlation_groups.status', score: 'alert_correlation_groups.score',
      noiseReductionPercent: 'alert_correlation_groups.noiseReductionPercent', memberCount: 'alert_correlation_groups.memberCount',
      firstSeenAt: 'alert_correlation_groups.firstSeenAt', lastSeenAt: 'alert_correlation_groups.lastSeenAt',
      metadata: 'alert_correlation_groups.metadata', createdAt: 'alert_correlation_groups.createdAt',
    },
    alertCorrelationMembers: {
      id: 'alert_correlation_members.id', orgId: 'alert_correlation_members.orgId', groupId: 'alert_correlation_members.groupId',
      alertId: 'alert_correlation_members.alertId', role: 'alert_correlation_members.role',
      confidence: 'alert_correlation_members.confidence', createdAt: 'alert_correlation_members.createdAt',
    },
    mlFeedbackEvents: {
      id: 'ml_feedback_events.id', orgId: 'ml_feedback_events.orgId', sourceType: 'ml_feedback_events.sourceType',
      sourceId: 'ml_feedback_events.sourceId', eventType: 'ml_feedback_events.eventType',
      outcome: 'ml_feedback_events.outcome', occurredAt: 'ml_feedback_events.occurredAt',
    },
    devices: { id: 'devices.id', hostname: 'devices.hostname' },
  };

  type Predicate = { op: string; col?: unknown; val?: unknown; vals?: unknown[]; args?: Predicate[] } | undefined;
  const columnKey = (col: unknown) => String(col).split('.').pop()!;
  const evalPredicate = (row: Record<string, unknown>, predicate: Predicate): boolean => {
    if (!predicate) return true;
    if (predicate.op === 'eq') return row[columnKey(predicate.col)] === predicate.val;
    if (predicate.op === 'gte') return Number(row[columnKey(predicate.col)]) >= Number(predicate.val);
    if (predicate.op === 'inArray') return (predicate.vals ?? []).includes(row[columnKey(predicate.col)]);
    if (predicate.op === 'and') return (predicate.args ?? []).every((arg) => evalPredicate(row, arg));
    if (predicate.op === 'or') return (predicate.args ?? []).some((arg) => evalPredicate(row, arg));
    return true;
  };

  const state = {
    alerts: [] as Array<Record<string, any>>,
    correlations: [] as Array<Record<string, any>>,
    groups: [] as Array<Record<string, any>>,
    members: [] as Array<Record<string, any>>,
    feedback: [] as Array<Record<string, any>>,
    devices: [] as Array<Record<string, any>>,
    // Alert ids whose UPDATE should match 0 rows (simulating an RLS-scoped write that the
    // breeze_app connection silently drops). They still appear in SELECTs so they are read as
    // "eligible" pre-write, exposing the eligible-vs-written mismatch path.
    unwritableAlertIds: new Set<string>(),
  };

  class SelectQuery {
    private predicate: Predicate;
    constructor(private table: unknown, private projection?: Record<string, unknown>) {}
    where(predicate: Predicate) { this.predicate = predicate; return this; }
    orderBy() { return this; }
    limit(limit: number) { return Promise.resolve(this.rows().slice(0, limit)); }
    then(resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) {
      return Promise.resolve(this.rows()).then(resolve, reject);
    }
    private rows() {
      const source = this.table === tables.alerts
        ? state.alerts
        : this.table === tables.alertCorrelations
          ? state.correlations
          : this.table === tables.alertCorrelationGroups
            ? state.groups
            : this.table === tables.alertCorrelationMembers
              ? state.members
              : this.table === tables.mlFeedbackEvents
                ? state.feedback
                : state.devices;
      const filtered = source.filter((row) => evalPredicate(row, this.predicate));
      if (!this.projection) return filtered;
      return filtered.map((row) => {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(this.projection!)) {
          out[key] = row[columnKey(this.projection![key])];
        }
        return out;
      });
    }
  }

  const dbMock = {
    select: vi.fn((projection?: Record<string, unknown>) => ({
      from: (table: unknown) => new SelectQuery(table, projection),
    })),
    update: vi.fn((table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (predicate: Predicate) => {
          const source = table === tables.alerts
            ? state.alerts
            : table === tables.alertCorrelationGroups
              ? state.groups
              : [];
          const written: Array<Record<string, unknown>> = [];
          for (const row of source) {
            if (!evalPredicate(row, predicate)) continue;
            // Simulate an RLS-scoped write silently matching 0 rows for flagged alert ids.
            if (table === tables.alerts && state.unwritableAlertIds.has(row.id as string)) continue;
            Object.assign(row, values);
            written.push(row);
          }
          const result = written.map(() => ({}));
          // Support both `await db.update(...).set(...).where(...)` (returns row stubs) and
          // `.where(...).returning({ id })` (returns the written ids), matching Drizzle.
          return {
            returning: (projection?: Record<string, unknown>) =>
              Promise.resolve(written.map((row) => {
                if (!projection) return row;
                const out: Record<string, unknown> = {};
                for (const key of Object.keys(projection)) {
                  out[key] = row[columnKey(projection[key])];
                }
                return out;
              })),
            then: (resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) =>
              Promise.resolve(result).then(resolve, reject),
          };
        },
      }),
    })),
  };

  return {
    authRef: { current: null as any },
    buildAlertCorrelationRcaMock: vi.fn(),
    grantedRef: { current: new Set<string>() },
    emitAlertStateFeedbackMock: vi.fn(),
    emitCorrelationFeedbackMock: vi.fn(),
    emitRcaFeedbackMock: vi.fn(),
    shouldProduceMlOutputMock: vi.fn(),
    captureExceptionMock: vi.fn(),
    state,
    tables,
    dbMock,
  };
});

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  gte: (col: unknown, val: unknown) => ({ op: 'gte', col, val }),
  and: (...args: unknown[]) => ({ op: 'and', args }),
  or: (...args: unknown[]) => ({ op: 'or', args }),
  inArray: (col: unknown, vals: unknown[]) => ({ op: 'inArray', col, vals }),
  desc: (col: unknown) => ({ op: 'desc', col }),
}));

vi.mock('../../middleware/auth', () => ({
  requireScope: () => async (c: any, next: any) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', authRef.current);
    await next();
  },
  requirePermission: (resource: string, action: string) => async (_c: any, next: any) => {
    if (!grantedRef.current.has(`${resource}:${action}`)) return _c.json({ error: 'Forbidden' }, 403);
    await next();
  },
}));

vi.mock('../../db', () => ({ db: dbMock }));
vi.mock('../../db/schema', () => ({
  alerts: tables.alerts,
  alertCorrelationGroups: tables.alertCorrelationGroups,
  alertCorrelationMembers: tables.alertCorrelationMembers,
  alertCorrelations: tables.alertCorrelations,
  devices: tables.devices,
  mlFeedbackEvents: tables.mlFeedbackEvents,
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/alertCorrelationRca', () => ({
  buildAlertCorrelationRca: buildAlertCorrelationRcaMock,
}));
vi.mock('../../services/eventBus', () => ({ publishEvent: vi.fn(() => Promise.resolve()) }));
vi.mock('../../services/sentry', () => ({ captureException: captureExceptionMock }));
vi.mock('../../services/mlFeedbackEmitters', () => ({
  emitAlertStateFeedback: emitAlertStateFeedbackMock,
  emitCorrelationFeedback: emitCorrelationFeedbackMock,
  emitRcaFeedback: emitRcaFeedbackMock,
}));
vi.mock('../../services/mlFeatureFlags', () => ({
  shouldProduceMlOutput: shouldProduceMlOutputMock,
}));
vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    ALERTS_READ: { resource: 'alerts', action: 'read' },
    ALERTS_WRITE: { resource: 'alerts', action: 'write' },
    ALERTS_ACKNOWLEDGE: { resource: 'alerts', action: 'acknowledge' },
  },
}));

import { alertCorrelationRoutes } from './correlations';

const ORG_1 = '11111111-1111-4111-8111-111111111111';
const ORG_2 = '22222222-2222-4222-8222-222222222222';
const ALERT_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ALERT_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ALERT_3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEVICE_1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const GROUP_1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function makeApp() {
  const app = new Hono();
  app.route('/alerts', alertCorrelationRoutes);
  return app;
}

function seed() {
  state.alerts = [
    { id: ALERT_1, orgId: ORG_1, deviceId: DEVICE_1, status: 'active', severity: 'critical', title: 'CPU high', ruleId: 'rule-1', triggeredAt: new Date('2026-06-18T12:00:00Z'), createdAt: new Date('2026-06-18T12:00:00Z') },
    { id: ALERT_2, orgId: ORG_1, deviceId: DEVICE_1, status: 'active', severity: 'high', title: 'Memory high', ruleId: 'rule-2', triggeredAt: new Date('2026-06-18T12:02:00Z'), createdAt: new Date('2026-06-18T12:02:00Z') },
    { id: ALERT_3, orgId: ORG_2, deviceId: DEVICE_1, status: 'active', severity: 'low', title: 'Other org', ruleId: 'rule-3', triggeredAt: new Date('2026-06-18T12:03:00Z'), createdAt: new Date('2026-06-18T12:03:00Z') },
  ];
  state.correlations = [
    { id: '11111111-aaaa-4aaa-8aaa-111111111111', parentAlertId: ALERT_1, childAlertId: ALERT_2, correlationType: 'same_device_temporal', confidence: '0.91', createdAt: new Date('2026-06-18T12:03:00Z') },
    { id: '22222222-aaaa-4aaa-8aaa-222222222222', parentAlertId: ALERT_1, childAlertId: ALERT_3, correlationType: 'same_device_temporal', confidence: '0.88', createdAt: new Date('2026-06-18T12:04:00Z') },
  ];
  state.groups = [];
  state.members = [];
  state.feedback = [];
  state.devices = [{ id: DEVICE_1, hostname: 'server-1' }];
  state.unwritableAlertIds = new Set();
}

function seedPersistedGroup() {
  state.groups = [{
    id: GROUP_1,
    orgId: ORG_1,
    groupKey: `root:${ALERT_1}`,
    rootAlertId: ALERT_1,
    status: 'open',
    score: '0.91',
    noiseReductionPercent: 50,
    memberCount: 2,
    firstSeenAt: new Date('2026-06-18T12:00:00Z'),
    lastSeenAt: new Date('2026-06-18T12:02:00Z'),
    metadata: { version: 'test' },
    createdAt: new Date('2026-06-18T12:03:00Z'),
  }];
  state.members = [
    { id: 'eeeeeeee-0001-4eee-8eee-eeeeeeeeeeee', orgId: ORG_1, groupId: GROUP_1, alertId: ALERT_1, role: 'root', confidence: '1.00', createdAt: new Date('2026-06-18T12:03:00Z') },
    { id: 'eeeeeeee-0002-4eee-8eee-eeeeeeeeeeee', orgId: ORG_1, groupId: GROUP_1, alertId: ALERT_2, role: 'related', confidence: '0.91', createdAt: new Date('2026-06-18T12:03:00Z') },
  ];
}

describe('/alerts correlation routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seed();
    shouldProduceMlOutputMock.mockResolvedValue(true);
    buildAlertCorrelationRcaMock.mockResolvedValue({
      groupId: GROUP_1,
      scope: {
        orgId: ORG_1,
        deviceIds: [DEVICE_1],
        alertIds: [ALERT_1, ALERT_2],
        windowStart: '2026-06-18T06:00:00.000Z',
        windowEnd: '2026-06-18T13:02:00.000Z',
      },
      timeline: [
        { id: `alert:${ALERT_1}`, source: 'alert', type: 'critical', timestamp: '2026-06-18T12:00:00.000Z', title: 'CPU high', summary: 'CPU high' },
      ],
      rootCauseCandidates: [
        { summary: 'CPU high was earliest', confidence: 0.91, supportingEvidenceIds: [`alert:${ALERT_1}`] },
      ],
      gaps: [],
    });
    grantedRef.current = new Set(['alerts:read', 'alerts:acknowledge', 'alerts:write']);
    authRef.current = {
      scope: 'organization',
      orgId: ORG_1,
      accessibleOrgIds: null,
      user: { id: '99999999-9999-4999-8999-999999999999' },
      canAccessOrg: (orgId: string) => orgId === ORG_1,
    };
  });

  it('returns detail correlations at GET /alerts/:alertId/correlations without leaking cross-org links', async () => {
    const res = await makeApp().request(`/alerts/${ALERT_1}/correlations`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.correlations).toEqual([
      expect.objectContaining({ id: '11111111-aaaa-4aaa-8aaa-111111111111', title: 'Memory high', confidence: 0.91 }),
    ]);
    expect(body.correlationLinks).toHaveLength(1);
    expect(body.summary.relatedCount).toBe(1);
  });

  it('returns 404 when the alert exists but belongs to another org', async () => {
    const res = await makeApp().request(`/alerts/${ALERT_3}/correlations`);

    expect(res.status).toBe(404);
  });

  it('returns grouped correlations at GET /alerts/correlations', async () => {
    const res = await makeApp().request('/alerts/correlations');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]).toEqual(expect.objectContaining({ relatedCount: 1, correlationScore: 0.91 }));
    expect(body.groups[0].rootCause.device).toBe('server-1');
  });

  it('returns persisted correlation groups before falling back to derived groups', async () => {
    seedPersistedGroup();

    const res = await makeApp().request('/alerts/correlations');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]).toEqual(expect.objectContaining({
      id: GROUP_1,
      relatedCount: 1,
      correlationScore: 0.91,
      noiseReductionPercent: 50,
      status: 'open',
    }));
    expect(body.groups[0].rootCause.id).toBe(ALERT_1);
  });

  it('returns scoped alert correlation evaluation metrics and recent feedback labels', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T13:00:00Z'));
    seedPersistedGroup();
    state.feedback = [
      {
        id: '11111111-ffff-4fff-8fff-111111111111',
        orgId: ORG_1,
        sourceType: 'correlation',
        sourceId: GROUP_1,
        eventType: 'correlation.accepted',
        outcome: 'accepted',
        occurredAt: new Date('2026-06-18T12:10:00Z'),
      },
      {
        id: '22222222-ffff-4fff-8fff-222222222222',
        orgId: ORG_1,
        sourceType: 'correlation',
        sourceId: GROUP_1,
        eventType: 'correlation.split',
        outcome: 'split',
        occurredAt: new Date('2026-06-18T12:11:00Z'),
      },
      {
        id: '33333333-ffff-4fff-8fff-333333333333',
        orgId: ORG_1,
        sourceType: 'correlation',
        sourceId: GROUP_1,
        eventType: 'correlation.merged',
        outcome: 'merged',
        occurredAt: new Date('2026-06-18T12:12:00Z'),
      },
      {
        id: '44444444-ffff-4fff-8fff-444444444444',
        orgId: ORG_1,
        sourceType: 'correlation',
        sourceId: GROUP_1,
        eventType: 'correlation.dismissed',
        outcome: 'dismissed',
        occurredAt: new Date('2026-04-01T12:00:00Z'),
      },
      {
        id: '55555555-ffff-4fff-8fff-555555555555',
        orgId: ORG_2,
        sourceType: 'correlation',
        sourceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        eventType: 'correlation.dismissed',
        outcome: 'dismissed',
        occurredAt: new Date('2026-06-18T12:13:00Z'),
      },
      {
        id: '66666666-ffff-4fff-8fff-666666666666',
        orgId: ORG_1,
        sourceType: 'ticket',
        sourceId: 'ticket-1',
        eventType: 'correlation.dismissed',
        outcome: 'dismissed',
        occurredAt: new Date('2026-06-18T12:14:00Z'),
      },
      {
        id: '77777777-ffff-4fff-8fff-777777777777',
        orgId: ORG_1,
        sourceType: 'rca',
        sourceId: GROUP_1,
        eventType: 'rca.helpful',
        outcome: 'helpful',
        occurredAt: new Date('2026-06-18T12:15:00Z'),
      },
      {
        id: '88888888-ffff-4fff-8fff-888888888888',
        orgId: ORG_1,
        sourceType: 'rca',
        sourceId: GROUP_1,
        eventType: 'rca.not_helpful',
        outcome: 'not_helpful',
        occurredAt: new Date('2026-06-18T12:16:00Z'),
      },
      {
        id: '99999999-ffff-4fff-8fff-999999999999',
        orgId: ORG_1,
        sourceType: 'rca',
        sourceId: GROUP_1,
        eventType: 'rca.edited',
        outcome: 'edited',
        occurredAt: new Date('2026-06-18T12:17:00Z'),
      },
      {
        id: 'aaaaaaaa-ffff-4fff-8fff-aaaaaaaaaaaa',
        orgId: ORG_1,
        sourceType: 'rca',
        sourceId: GROUP_1,
        eventType: 'rca.used_in_ticket',
        outcome: 'used_in_ticket',
        occurredAt: new Date('2026-06-18T12:18:00Z'),
      },
      {
        id: 'bbbbbbbb-ffff-4fff-8fff-bbbbbbbbbbbb',
        orgId: ORG_1,
        sourceType: 'rca',
        sourceId: GROUP_1,
        eventType: 'rca.helpful',
        outcome: 'helpful',
        occurredAt: new Date('2026-04-01T12:00:00Z'),
      },
      {
        id: 'cccccccc-ffff-4fff-8fff-cccccccccccc',
        orgId: ORG_2,
        sourceType: 'rca',
        sourceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        eventType: 'rca.helpful',
        outcome: 'helpful',
        occurredAt: new Date('2026-06-18T12:19:00Z'),
      },
      {
        id: 'dddddddd-ffff-4fff-8fff-dddddddddddd',
        orgId: ORG_1,
        sourceType: 'correlation',
        sourceId: GROUP_1,
        eventType: 'rca.helpful',
        outcome: 'helpful',
        occurredAt: new Date('2026-06-18T12:20:00Z'),
      },
    ];

    try {
      const res = await makeApp().request('/alerts/correlations/evaluation?labelWindowDays=30');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.evaluation).toEqual({
        labelWindowDays: 30,
        labelWindowStart: '2026-05-19T13:00:00.000Z',
        groupsCreated: 1,
        totalGroupedAlerts: 2,
        estimatedSuppressedAlerts: 1,
        compressionRatio: 0.5,
        averageCorrelationScore: 0.91,
        averageNoiseReductionPercent: 50,
        feedback: {
          accepted: 1,
          split: 1,
          merged: 1,
          dismissed: 0,
          totalCorrections: 2,
        },
        rcaFeedback: {
          helpful: 1,
          notHelpful: 1,
          edited: 1,
          usedInTicket: 1,
          total: 4,
        },
      });
      expect(body.data).toEqual(body.evaluation);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns persisted correlation group detail without leaking cross-org groups', async () => {
    seedPersistedGroup();
    state.groups.push({
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      orgId: ORG_2,
      groupKey: `root:${ALERT_3}`,
      rootAlertId: ALERT_3,
      status: 'open',
      score: '0.88',
      noiseReductionPercent: 0,
      memberCount: 1,
      firstSeenAt: new Date('2026-06-18T12:03:00Z'),
      lastSeenAt: new Date('2026-06-18T12:03:00Z'),
      metadata: {},
      createdAt: new Date('2026-06-18T12:04:00Z'),
    });

    const allowed = await makeApp().request(`/alerts/correlations/${GROUP_1}`);
    expect(allowed.status).toBe(200);
    const allowedBody = await allowed.json();
    expect(allowedBody.group.id).toBe(GROUP_1);

    const denied = await makeApp().request('/alerts/correlations/ffffffff-ffff-4fff-8fff-ffffffffffff');
    expect(denied.status).toBe(404);
  });

  it('returns a deterministic RCA bundle for a persisted correlation group', async () => {
    seedPersistedGroup();

    const res = await makeApp().request(`/alerts/correlations/${GROUP_1}/explain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ windowHours: 4, maxEvidenceItems: 12 }),
    });

    expect(res.status).toBe(200);
    expect(shouldProduceMlOutputMock).toHaveBeenCalledWith(ORG_1, 'ml.rca.enabled');
    expect(buildAlertCorrelationRcaMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_1,
      groupId: GROUP_1,
      alerts: expect.arrayContaining([
        expect.objectContaining({ id: ALERT_1 }),
        expect.objectContaining({ id: ALERT_2 }),
      ]),
      windowHours: 4,
      maxEvidenceItems: 12,
    }));
    const body = await res.json();
    expect(body.rca.rootCauseCandidates[0]).toEqual(expect.objectContaining({ confidence: 0.91 }));
  });

  it('uses default RCA options when explain is called without a JSON body', async () => {
    seedPersistedGroup();

    const res = await makeApp().request(`/alerts/correlations/${GROUP_1}/explain`, {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    expect(buildAlertCorrelationRcaMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_1,
      groupId: GROUP_1,
      windowHours: undefined,
      maxEvidenceItems: undefined,
    }));
  });

  it('rejects invalid RCA explain options', async () => {
    seedPersistedGroup();

    const res = await makeApp().request(`/alerts/correlations/${GROUP_1}/explain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ windowHours: 99 }),
    });

    expect(res.status).toBe(400);
    expect(buildAlertCorrelationRcaMock).not.toHaveBeenCalled();
  });

  it('does not build RCA output when the RCA flag is disabled', async () => {
    seedPersistedGroup();
    shouldProduceMlOutputMock.mockResolvedValue(false);

    const res = await makeApp().request(`/alerts/correlations/${GROUP_1}/explain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(403);
    expect(buildAlertCorrelationRcaMock).not.toHaveBeenCalled();
  });

  it('records RCA feedback for a visible persisted correlation group', async () => {
    seedPersistedGroup();

    const res = await makeApp().request(`/alerts/correlations/${GROUP_1}/rca-feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType: 'rca.helpful',
        outcome: 'helpful',
        metadata: { surface: 'test' },
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(emitRcaFeedbackMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_1,
      rcaId: GROUP_1,
      eventType: 'rca.helpful',
      dedupeKey: 'rca.helpful',
      outcome: 'helpful',
      actorUserId: '99999999-9999-4999-8999-999999999999',
      metadata: expect.objectContaining({ groupId: GROUP_1, rootAlertId: ALERT_1, surface: 'test' }),
    }));
  });

  it('records split correction feedback for a visible persisted correlation group', async () => {
    seedPersistedGroup();

    const res = await makeApp().request(`/alerts/correlations/${GROUP_1}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType: 'correlation.split',
        outcome: 'split',
        alertIds: [ALERT_2, ALERT_1],
        note: 'These alerts are unrelated.',
        metadata: { surface: 'test' },
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(emitCorrelationFeedbackMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_1,
      correlationId: GROUP_1,
      eventType: 'correlation.split',
      dedupeKey: `split:${[ALERT_1, ALERT_2].sort().join(',')}`,
      outcome: 'split',
      actorUserId: '99999999-9999-4999-8999-999999999999',
      metadata: expect.objectContaining({
        groupId: GROUP_1,
        rootAlertId: ALERT_1,
        alertIds: [ALERT_2, ALERT_1],
        note: 'These alerts are unrelated.',
        surface: 'test',
      }),
    }));
  });

  it('records dismissed and merged correction feedback with stable replay keys', async () => {
    seedPersistedGroup();
    const targetGroupId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

    const dismissed = await makeApp().request(`/alerts/correlations/${GROUP_1}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType: 'correlation.dismissed',
        outcome: 'dismissed',
      }),
    });
    expect(dismissed.status).toBe(200);

    const merged = await makeApp().request(`/alerts/correlations/${GROUP_1}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType: 'correlation.merged',
        outcome: 'merged',
        targetGroupId,
      }),
    });
    expect(merged.status).toBe(200);

    expect(emitCorrelationFeedbackMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'correlation.dismissed',
      dedupeKey: 'correction:dismissed',
      outcome: 'dismissed',
    }));
    expect(emitCorrelationFeedbackMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'correlation.merged',
      dedupeKey: `merge:${targetGroupId}`,
      outcome: 'merged',
      metadata: expect.objectContaining({ targetGroupId }),
    }));
  });

  it('rejects invalid correlation correction feedback', async () => {
    seedPersistedGroup();

    const badOutcome = await makeApp().request(`/alerts/correlations/${GROUP_1}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType: 'correlation.split',
        outcome: 'dismissed',
      }),
    });
    expect(badOutcome.status).toBe(400);

    const missingMergeTarget = await makeApp().request(`/alerts/correlations/${GROUP_1}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType: 'correlation.merged',
        outcome: 'merged',
      }),
    });
    expect(missingMergeTarget.status).toBe(400);

    expect(emitCorrelationFeedbackMock).not.toHaveBeenCalled();
  });

  it('does not record correction feedback for an inaccessible correlation group', async () => {
    seedPersistedGroup();
    authRef.current = {
      ...authRef.current,
      orgId: ORG_2,
      canAccessOrg: (orgId: string) => orgId === ORG_2,
    };

    const res = await makeApp().request(`/alerts/correlations/${GROUP_1}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType: 'correlation.dismissed',
        outcome: 'dismissed',
      }),
    });

    expect(res.status).toBe(404);
    expect(emitCorrelationFeedbackMock).not.toHaveBeenCalled();
  });

  it('rejects inconsistent RCA feedback event/outcome pairs', async () => {
    seedPersistedGroup();

    const res = await makeApp().request(`/alerts/correlations/${GROUP_1}/rca-feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType: 'rca.helpful',
        outcome: 'not_helpful',
      }),
    });

    expect(res.status).toBe(400);
    expect(emitRcaFeedbackMock).not.toHaveBeenCalled();
  });

  it('acknowledges all accessible alerts in a correlation group', async () => {
    seedPersistedGroup();
    const res = await makeApp().request(`/alerts/correlations/${GROUP_1}/acknowledge`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ updated: 2, skipped: 0 });
    expect(state.alerts.find((alert) => alert.id === ALERT_1)?.status).toBe('acknowledged');
    expect(state.alerts.find((alert) => alert.id === ALERT_2)?.status).toBe('acknowledged');
    expect(state.alerts.find((alert) => alert.id === ALERT_3)?.status).toBe('active');
    expect(state.groups.find((group) => group.id === GROUP_1)?.status).toBe('acknowledged');
    expect(emitAlertStateFeedbackMock).toHaveBeenCalledTimes(2);
    expect(emitCorrelationFeedbackMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_1,
      correlationId: GROUP_1,
      eventType: 'correlation.accepted',
      dedupeKey: 'group:acknowledge',
      outcome: 'accepted',
      actorUserId: '99999999-9999-4999-8999-999999999999',
    }));
  });

  it('does not emit alert-state feedback for alerts the UPDATE did not return (RLS 0-row write)', async () => {
    seedPersistedGroup();
    // ALERT_2 is read as eligible (still in state) but its UPDATE matches 0 rows, simulating
    // an RLS-scoped write the breeze_app connection silently drops.
    state.unwritableAlertIds = new Set([ALERT_2]);

    const res = await makeApp().request(`/alerts/correlations/${GROUP_1}/acknowledge`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();

    // Only the written alert is counted and gets feedback; the phantom one is suppressed.
    expect(body.updated).toBe(1);
    expect(emitAlertStateFeedbackMock).toHaveBeenCalledTimes(1);
    expect(emitAlertStateFeedbackMock).toHaveBeenCalledWith(expect.objectContaining({ alertId: ALERT_1 }));
    expect(emitAlertStateFeedbackMock).not.toHaveBeenCalledWith(expect.objectContaining({ alertId: ALERT_2 }));
    // The eligible-vs-written mismatch is surfaced to Sentry, not silently swallowed.
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  it('emits feedback for every alert and reports no mismatch when all writes land', async () => {
    seedPersistedGroup();

    const res = await makeApp().request(`/alerts/correlations/${GROUP_1}/acknowledge`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.updated).toBe(2);
    expect(emitAlertStateFeedbackMock).toHaveBeenCalledTimes(2);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('scopes persisted group status updates to the resolving org', async () => {
    seedPersistedGroup();

    await makeApp().request(`/alerts/correlations/${GROUP_1}/resolve`, { method: 'POST' });

    const updateCalls = dbMock.update.mock.calls;
    expect(updateCalls).toContainEqual([tables.alertCorrelationGroups]);
    expect(state.groups.find((group) => group.id === GROUP_1)?.status).toBe('resolved');
  });
});
