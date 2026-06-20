import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Site-axis enforcement on the single-alert by-id paths (T9, #1051 class):
// GET /:id, POST /:id/acknowledge, POST /:id/resolve, POST /:id/suppress.
// Site scope is app-layer-only (RLS does NOT enforce it). The list endpoint
// narrows by allowedSiteIds, but these by-id handlers historically did not, so
// a site-restricted org user could read/mutate alerts on devices in other
// sites of the same org. Out-of-site → 404 (no oracle); deviceless alerts stay
// visible; unrestricted callers are unaffected.
//
// This file deliberately does NOT mock ./helpers — it exercises the real
// getAlertWithOrgCheck (now site-aware) against an in-memory db.

const { authRef, grantedRef, state, tables, dbMock } = vi.hoisted(() => {
  const tables = {
    alerts: { id: 'alerts.id', orgId: 'alerts.orgId', deviceId: 'alerts.deviceId', status: 'alerts.status', ruleId: 'alerts.ruleId', title: 'alerts.title' },
    devices: { id: 'devices.id', siteId: 'devices.siteId', orgId: 'devices.orgId' },
    alertRules: { id: 'alertRules.id' },
    alertNotifications: { id: 'alertNotifications.id', alertId: 'alertNotifications.alertId', channelId: 'alertNotifications.channelId', status: 'alertNotifications.status', sentAt: 'alertNotifications.sentAt', errorMessage: 'alertNotifications.errorMessage', createdAt: 'alertNotifications.createdAt' },
    notificationChannels: { id: 'notificationChannels.id', name: 'notificationChannels.name', type: 'notificationChannels.type' },
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
    leftJoin() { return this; }
    orderBy() { return this; }
    limit(limit: number) { return Promise.resolve(this.rows().slice(0, limit)); }
    then(resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) {
      return Promise.resolve(this.rows()).then(resolve, reject);
    }
    private rows() {
      let source: Array<Record<string, unknown>> = [];
      if (this.table === tables.alerts) source = state.alerts;
      else if (this.table === tables.devices) source = state.devices;
      else source = [];
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
  siteAccessCheck: (allowedSiteIds?: string[]) => (siteId: string | null | undefined) => {
    if (!allowedSiteIds) return true;
    if (!siteId) return false;
    return allowedSiteIds.includes(siteId);
  },
}));

vi.mock('../../db', () => ({
  db: dbMock,
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../../db/schema', () => ({
  alertCorrelationGroups: {}, alertCorrelationMembers: {},
  alertRules: tables.alertRules, alertTemplates: {}, alerts: tables.alerts,
  notificationChannels: tables.notificationChannels,
  alertNotifications: tables.alertNotifications, devices: tables.devices, tickets: {}, ticketAlertLinks: {},
  organizations: {}, partners: {}, escalationPolicies: {},
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
vi.mock('../../services/notificationSenders', () => ({
  validateEmailConfig: vi.fn(() => ({ errors: [] })),
  validateWebhookConfig: vi.fn(() => ({ errors: [] })),
  validateSmsConfig: vi.fn(() => ({ errors: [] })),
  validatePagerDutyConfig: vi.fn(() => ({ errors: [] })),
  validatePushoverConfig: vi.fn(() => ({ errors: [] })),
}));

import { alertsRoutes } from './alerts';

function makeApp() {
  const app = new Hono();
  app.route('/alerts', alertsRoutes);
  return app;
}

const ORG = 'org-1';
const SITE_A = '5a5a5a5a-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_B = '5b5b5b5b-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEVICE_A = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd';
const DEVICE_B = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd';
const ALERT_A = 'a1a1a1a1-1111-4111-8111-111111111111'; // SITE_A device
const ALERT_B = 'a2a2a2a2-2222-4222-8222-222222222222'; // SITE_B device
const ALERT_ORGWIDE = 'a3a3a3a3-3333-4333-8333-333333333333'; // deviceless
const ALERTS_WRITE = 'alerts:write';
const ALERTS_ACKNOWLEDGE = 'alerts:acknowledge';

function resetState() {
  state.devices = [
    { id: DEVICE_A, siteId: SITE_A, orgId: ORG },
    { id: DEVICE_B, siteId: SITE_B, orgId: ORG },
  ];
  state.alerts = [
    { id: ALERT_A, orgId: ORG, deviceId: DEVICE_A, status: 'active', ruleId: null, title: 'A' },
    { id: ALERT_B, orgId: ORG, deviceId: DEVICE_B, status: 'active', ruleId: null, title: 'B' },
    { id: ALERT_ORGWIDE, orgId: ORG, deviceId: null, status: 'active', ruleId: null, title: 'org' },
  ];
}

describe('alert by-id site-axis scope (T9, #1051)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantedRef.current = new Set<string>([ALERTS_WRITE, ALERTS_ACKNOWLEDGE]);
    authRef.current = {
      scope: 'organization',
      user: { id: 'u-1', name: 'Reed Only', email: 'reed@org.example' },
      partnerId: null, orgId: ORG, accessibleOrgIds: null, allowedSiteIds: undefined, canAccessOrg: () => true,
    } as typeof authRef.current;
    resetState();
  });

  const restrictToSiteA = () => {
    authRef.current = { ...authRef.current, allowedSiteIds: [SITE_A] } as typeof authRef.current;
  };

  // ---- GET /:id ----
  describe('GET /alerts/:id', () => {
    it('404 on an out-of-site alert for a SITE_A-restricted user', async () => {
      restrictToSiteA();
      const res = await makeApp().request(`/alerts/${ALERT_B}`);
      expect(res.status).toBe(404);
    });

    it('200 on an in-site alert for a SITE_A-restricted user', async () => {
      restrictToSiteA();
      const res = await makeApp().request(`/alerts/${ALERT_A}`);
      expect(res.status).toBe(200);
    });

    it('200 on a deviceless (org-wide) alert for a SITE_A-restricted user', async () => {
      restrictToSiteA();
      const res = await makeApp().request(`/alerts/${ALERT_ORGWIDE}`);
      expect(res.status).toBe(200);
    });

    it('200 on an out-of-site alert for an unrestricted user (no regression)', async () => {
      const res = await makeApp().request(`/alerts/${ALERT_B}`);
      expect(res.status).toBe(200);
    });
  });

  // ---- POST /:id/acknowledge ----
  describe('POST /alerts/:id/acknowledge', () => {
    it('404 and no write on an out-of-site alert for a SITE_A-restricted user', async () => {
      restrictToSiteA();
      const res = await makeApp().request(`/alerts/${ALERT_B}/acknowledge`, { method: 'POST' });
      expect(res.status).toBe(404);
      expect(state.alerts.find((a) => a.id === ALERT_B)?.status).toBe('active');
    });

    it('acknowledges an in-site alert for a SITE_A-restricted user', async () => {
      restrictToSiteA();
      const res = await makeApp().request(`/alerts/${ALERT_A}/acknowledge`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(state.alerts.find((a) => a.id === ALERT_A)?.status).toBe('acknowledged');
    });

    it('acknowledges an out-of-site alert for an unrestricted user (no regression)', async () => {
      const res = await makeApp().request(`/alerts/${ALERT_B}/acknowledge`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(state.alerts.find((a) => a.id === ALERT_B)?.status).toBe('acknowledged');
    });
  });

  // ---- POST /:id/resolve ----
  describe('POST /alerts/:id/resolve', () => {
    it('404 and no write on an out-of-site alert for a SITE_A-restricted user', async () => {
      restrictToSiteA();
      const res = await makeApp().request(`/alerts/${ALERT_B}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
      expect(state.alerts.find((a) => a.id === ALERT_B)?.status).toBe('active');
    });

    it('resolves an in-site alert for a SITE_A-restricted user', async () => {
      restrictToSiteA();
      const res = await makeApp().request(`/alerts/${ALERT_A}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      expect(state.alerts.find((a) => a.id === ALERT_A)?.status).toBe('resolved');
    });
  });

  // ---- POST /:id/suppress ----
  describe('POST /alerts/:id/suppress', () => {
    it('404 and no write on an out-of-site alert for a SITE_A-restricted user', async () => {
      restrictToSiteA();
      const res = await makeApp().request(`/alerts/${ALERT_B}/suppress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ until: '2030-01-01T00:00:00.000Z' }),
      });
      expect(res.status).toBe(404);
      expect(state.alerts.find((a) => a.id === ALERT_B)?.status).toBe('active');
    });

    it('suppresses an in-site alert for a SITE_A-restricted user', async () => {
      restrictToSiteA();
      const res = await makeApp().request(`/alerts/${ALERT_A}/suppress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ until: '2030-01-01T00:00:00.000Z' }),
      });
      expect(res.status).toBe(200);
      expect(state.alerts.find((a) => a.id === ALERT_A)?.status).toBe('suppressed');
    });
  });
});
