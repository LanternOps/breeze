import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  authRef,
  grantedRef,
  emitAlertStateFeedbackMock,
  emitCorrelationFeedbackMock,
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
    devices: { id: 'devices.id', hostname: 'devices.hostname' },
  };

  type Predicate = { op: string; col?: unknown; val?: unknown; vals?: unknown[]; args?: Predicate[] } | undefined;
  const columnKey = (col: unknown) => String(col).split('.').pop()!;
  const evalPredicate = (row: Record<string, unknown>, predicate: Predicate): boolean => {
    if (!predicate) return true;
    if (predicate.op === 'eq') return row[columnKey(predicate.col)] === predicate.val;
    if (predicate.op === 'inArray') return (predicate.vals ?? []).includes(row[columnKey(predicate.col)]);
    if (predicate.op === 'and') return (predicate.args ?? []).every((arg) => evalPredicate(row, arg));
    if (predicate.op === 'or') return (predicate.args ?? []).some((arg) => evalPredicate(row, arg));
    return true;
  };

  const state = {
    alerts: [] as Array<Record<string, any>>,
    correlations: [] as Array<Record<string, any>>,
    devices: [] as Array<Record<string, any>>,
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
        where: async (predicate: Predicate) => {
          const source = table === tables.alerts ? state.alerts : [];
          let updated = 0;
          for (const row of source) {
            if (evalPredicate(row, predicate)) {
              Object.assign(row, values);
              updated += 1;
            }
          }
          return Array.from({ length: updated }, () => ({}));
        },
      }),
    })),
  };

  return {
    authRef: { current: null as any },
    grantedRef: { current: new Set<string>() },
    emitAlertStateFeedbackMock: vi.fn(),
    emitCorrelationFeedbackMock: vi.fn(),
    state,
    tables,
    dbMock,
  };
});

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
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
  alertCorrelations: tables.alertCorrelations,
  devices: tables.devices,
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/eventBus', () => ({ publishEvent: vi.fn(() => Promise.resolve()) }));
vi.mock('../../services/mlFeedbackEmitters', () => ({
  emitAlertStateFeedback: emitAlertStateFeedbackMock,
  emitCorrelationFeedback: emitCorrelationFeedbackMock,
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
  state.devices = [{ id: DEVICE_1, hostname: 'server-1' }];
}

describe('/alerts correlation routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seed();
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

  it('acknowledges all accessible alerts in a correlation group', async () => {
    const groupsRes = await makeApp().request('/alerts/correlations');
    const groupsBody = await groupsRes.json();
    const res = await makeApp().request(`/alerts/correlations/${groupsBody.groups[0].id}/acknowledge`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ updated: 2, skipped: 0 });
    expect(state.alerts.find((alert) => alert.id === ALERT_1)?.status).toBe('acknowledged');
    expect(state.alerts.find((alert) => alert.id === ALERT_2)?.status).toBe('acknowledged');
    expect(state.alerts.find((alert) => alert.id === ALERT_3)?.status).toBe('active');
    expect(emitAlertStateFeedbackMock).toHaveBeenCalledTimes(2);
    expect(emitCorrelationFeedbackMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_1,
      correlationId: groupsBody.groups[0].id,
      eventType: 'correlation.accepted',
      outcome: 'accepted',
      actorUserId: '99999999-9999-4999-8999-999999999999',
    }));
  });
});
