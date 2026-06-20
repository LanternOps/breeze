import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Regression for Finding #6 (MEDIUM): alert state-change endpoints
// (acknowledge/resolve/suppress/bulk) must gate on an alert RBAC permission in
// addition to scope tier. acknowledge -> ALERTS_ACKNOWLEDGE; resolve/suppress/
// bulk -> ALERTS_WRITE (mirrors the mobile alert routes).

const { authRef, grantedRef, state, tables, dbMock } = vi.hoisted(() => {
  const tables = {
    alerts: { id: 'alerts.id', orgId: 'alerts.orgId', deviceId: 'alerts.deviceId', status: 'alerts.status' },
    devices: { id: 'devices.id', siteId: 'devices.siteId', orgId: 'devices.orgId' },
    tickets: { id: 'tickets.id', deviceId: 'tickets.deviceId' },
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
      const source = this.table === tables.alerts ? state.alerts : state.devices;
      const filtered = source.filter((row) => evalPredicate(row, this.predicate));
      if (!this.projection) return filtered;
      return filtered.map((row) => {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(this.projection!)) out[key] = row[columnKey(this.projection![key])];
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
          const source = table === tables.alerts ? state.alerts : [];
          const written: Array<Record<string, unknown>> = [];
          for (const row of source) {
            if (!evalPredicate(row, predicate)) continue;
            Object.assign(row, values);
            written.push(row);
          }
          return {
            returning: () => Promise.resolve(written),
            then: (resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) =>
              Promise.resolve(written.map(() => ({}))).then(resolve, reject),
          };
        },
      }),
    })),
  };

  return {
    authRef: {
      current: {
        scope: 'organization' as string,
        user: { id: 'u-1', name: 'Reed Only', email: 'reed@org.example' },
        partnerId: null as string | null,
        orgId: 'org-1' as string | null,
        accessibleOrgIds: null as string[] | null,
        allowedSiteIds: undefined as string[] | undefined,
        canAccessOrg: (_id: string) => true as boolean,
      },
    },
    grantedRef: { current: new Set<string>() },
    state,
    tables,
    dbMock,
  };
});

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  gte: (col: unknown, val: unknown) => ({ op: 'gte', col, val }),
  lte: (col: unknown, val: unknown) => ({ op: 'lte', col, val }),
  and: (...args: unknown[]) => ({ op: 'and', args }),
  or: (...args: unknown[]) => ({ op: 'or', args }),
  inArray: (col: unknown, vals: unknown[]) => ({ op: 'inArray', col, vals }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  desc: (col: unknown) => ({ op: 'desc', col }),
  sql: Object.assign(() => ({ op: 'sql' }), { raw: () => ({ op: 'sql' }) }),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (_c: any, next: any) => next()),
  requireScope: () => async (c: any, next: any) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', authRef.current);
    await next();
  },
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    if (!grantedRef.current.has(`${resource}:${action}`)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    c.set('permissions', { allowedSiteIds: authRef.current?.allowedSiteIds });
    await next();
  },
  requireMfa: () => async (_c: any, next: any) => next(),
  // Used by filterAlertsBySiteScope / deviceInSiteScope (real ../tickets/siteScope).
  siteAccessCheck: (allowedSiteIds?: string[]) => (siteId: string | null | undefined) => {
    if (!allowedSiteIds) return true;
    if (!siteId) return false;
    return allowedSiteIds.includes(siteId);
  },
}));

vi.mock('../../db', () => ({ db: dbMock }));
vi.mock('../../db/schema', () => ({
  alertCorrelationGroups: {}, alertCorrelationMembers: {},
  alertRules: {}, alertTemplates: {}, alerts: tables.alerts, notificationChannels: {},
  alertNotifications: {}, devices: tables.devices, tickets: tables.tickets, ticketAlertLinks: {},
}));
vi.mock('../../services/alertCooldown', () => ({
  setCooldown: vi.fn(), markConfigPolicyRuleCooldown: vi.fn(),
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('../../services/mlFeedbackEmitters', () => ({
  emitAlertStateFeedback: vi.fn(),
  emitCorrelationFeedback: vi.fn(),
}));
vi.mock('../../services/ticketService', () => ({
  createTicketFromAlert: vi.fn(),
  TicketServiceError: class TicketServiceError extends Error { status = 400; },
}));
vi.mock('./helpers', () => ({
  getPagination: vi.fn(() => ({ page: 1, limit: 50, offset: 0 })),
  ensureOrgAccess: vi.fn(() => true),
  getAlertWithOrgCheck: vi.fn(),
}));

import { alertsRoutes, attachAlertCorrelationSummaries } from './alerts';

function makeApp() {
  const app = new Hono();
  app.route('/alerts', alertsRoutes);
  return app;
}

const ALERT_ID = '5d4c3b2a-1111-4222-8333-444455556666';
const ALERTS_WRITE = 'alerts:write';
const ALERTS_ACKNOWLEDGE = 'alerts:acknowledge';

describe('alert state-change authz (Finding #6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantedRef.current = new Set<string>();
    authRef.current = {
      scope: 'organization',
      user: { id: 'u-1', name: 'Reed Only', email: 'reed@org.example' },
      partnerId: null, orgId: 'org-1', accessibleOrgIds: null, allowedSiteIds: undefined, canAccessOrg: () => true,
    } as typeof authRef.current;
  });

  it('403 on POST /alerts/:id/acknowledge without ALERTS_ACKNOWLEDGE', async () => {
    const res = await makeApp().request(`/alerts/${ALERT_ID}/acknowledge`, { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('403 on POST /alerts/:id/resolve without ALERTS_WRITE', async () => {
    const res = await makeApp().request(`/alerts/${ALERT_ID}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it('403 on POST /alerts/:id/suppress without ALERTS_WRITE', async () => {
    const res = await makeApp().request(`/alerts/${ALERT_ID}/suppress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ until: '2030-01-01T00:00:00.000Z' }),
    });
    expect(res.status).toBe(403);
  });

  it('403 on POST /alerts/bulk without ALERTS_WRITE', async () => {
    const res = await makeApp().request('/alerts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertIds: [ALERT_ID], action: 'acknowledge' }),
    });
    expect(res.status).toBe(403);
  });

  it('passes the acknowledge gate when ALERTS_ACKNOWLEDGE is granted', async () => {
    grantedRef.current.add(ALERTS_ACKNOWLEDGE);
    const res = await makeApp().request(`/alerts/${ALERT_ID}/acknowledge`, { method: 'POST' });
    expect(res.status).not.toBe(403);
  });

  it('passes the bulk gate when ALERTS_WRITE is granted', async () => {
    grantedRef.current.add(ALERTS_WRITE);
    const res = await makeApp().request('/alerts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).not.toBe(403);
  });
});

// Site-axis enforcement on POST /alerts/bulk (T3, #1051 class). RLS does NOT
// enforce site scope; a site-restricted org user must not bulk ack/resolve
// alerts on devices outside their allowed sites.
describe('POST /alerts/bulk site-axis scope (T3)', () => {
  const ORG = 'org-1';
  const SITE_A = '5a5a5a5a-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const SITE_B = '5b5b5b5b-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const DEVICE_A = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd';
  const DEVICE_B = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd';
  const ALERT_A = 'a1a1a1a1-1111-4111-8111-111111111111';
  const ALERT_B = 'a2a2a2a2-2222-4222-8222-222222222222';
  const ALERT_ORGWIDE = 'a3a3a3a3-3333-4333-8333-333333333333';

  beforeEach(() => {
    vi.clearAllMocks();
    grantedRef.current = new Set<string>(['alerts:write']);
    authRef.current = {
      scope: 'organization',
      user: { id: 'u-1', name: 'Reed Only', email: 'reed@org.example' },
      partnerId: null, orgId: ORG, accessibleOrgIds: null,
      allowedSiteIds: undefined, canAccessOrg: () => true,
    } as typeof authRef.current;
    state.devices = [
      { id: DEVICE_A, siteId: SITE_A, orgId: ORG },
      { id: DEVICE_B, siteId: SITE_B, orgId: ORG },
    ];
    state.alerts = [
      { id: ALERT_A, orgId: ORG, deviceId: DEVICE_A, status: 'active', ruleId: 'r-a' },
      { id: ALERT_B, orgId: ORG, deviceId: DEVICE_B, status: 'active', ruleId: 'r-b' },
      { id: ALERT_ORGWIDE, orgId: ORG, deviceId: null, status: 'active', ruleId: 'r-org' },
    ];
  });

  it('does not acknowledge a SITE_B alert for a SITE_A-restricted user', async () => {
    authRef.current = { ...authRef.current, allowedSiteIds: [SITE_A] } as typeof authRef.current;

    const res = await makeApp().request('/alerts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertIds: [ALERT_A, ALERT_B], action: 'acknowledge' }),
    });

    expect(res.status).toBe(200);
    expect(state.alerts.find((a) => a.id === ALERT_A)?.status).toBe('acknowledged');
    expect(state.alerts.find((a) => a.id === ALERT_B)?.status).toBe('active');
  });

  it('returns 404 (no writes) when every alertId is out-of-site for a SITE_A-restricted user', async () => {
    authRef.current = { ...authRef.current, allowedSiteIds: [SITE_A] } as typeof authRef.current;

    const res = await makeApp().request('/alerts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertIds: [ALERT_B], action: 'acknowledge' }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'No accessible alerts found' });
    // No alert was mutated.
    expect(state.alerts.find((a) => a.id === ALERT_B)?.status).toBe('active');
  });

  it('still acknowledges org-wide (deviceless) alerts for a SITE_A-restricted user', async () => {
    authRef.current = { ...authRef.current, allowedSiteIds: [SITE_A] } as typeof authRef.current;

    const res = await makeApp().request('/alerts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertIds: [ALERT_ORGWIDE, ALERT_B], action: 'acknowledge' }),
    });

    expect(res.status).toBe(200);
    expect(state.alerts.find((a) => a.id === ALERT_ORGWIDE)?.status).toBe('acknowledged');
    expect(state.alerts.find((a) => a.id === ALERT_B)?.status).toBe('active');
  });

  it('acknowledges alerts across all sites for an unrestricted user (no regression)', async () => {
    const res = await makeApp().request('/alerts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertIds: [ALERT_A, ALERT_B], action: 'acknowledge' }),
    });

    expect(res.status).toBe(200);
    expect(state.alerts.find((a) => a.id === ALERT_A)?.status).toBe('acknowledged');
    expect(state.alerts.find((a) => a.id === ALERT_B)?.status).toBe('acknowledged');
  });
});

describe('attachAlertCorrelationSummaries', () => {
  it('adds group child count and noise reduction fields to visible alert rows', () => {
    const [alert] = attachAlertCorrelationSummaries(
      [{ id: ALERT_ID, title: 'High CPU' }],
      [{
        alertId: ALERT_ID,
        groupId: '6f5e4d3c-2222-4333-8444-555566667777',
        role: 'root',
        groupStatus: 'open',
        memberCount: 4,
        noiseReductionPercent: 75,
      }]
    );

    expect(alert).toEqual(expect.objectContaining({
      correlationGroupId: '6f5e4d3c-2222-4333-8444-555566667777',
      correlationRole: 'root',
      correlationGroupStatus: 'open',
      correlationMemberCount: 4,
      correlationChildCount: 3,
      noiseReductionPercent: 75,
    }));
  });

  it('returns explicit empty correlation fields when an alert is not grouped', () => {
    const [alert] = attachAlertCorrelationSummaries([{ id: ALERT_ID, title: 'High CPU' }], []);

    expect(alert).toEqual(expect.objectContaining({
      correlationGroupId: null,
      correlationRole: null,
      correlationGroupStatus: null,
      correlationMemberCount: 0,
      correlationChildCount: 0,
      noiseReductionPercent: null,
    }));
  });
});
