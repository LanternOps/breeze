/**
 * #5866 — a `network_check` monitor definition saved with owner scope "All
 * orgs" compiles to a `network_monitors` row with `org_id NULL, partner_id =
 * P`. The legacy CRUD surface in `monitors.ts` is org-axis only, which is
 * correct for WRITES (managed-row guard + partner-wide capability gate) but
 * left those rows invisible on every read surface: they run, produce results,
 * and nobody can see them.
 *
 * This suite pins the SELECT-only partner-wide read branch (CLAUDE.md
 * "Partner-Wide First" step 3) and, just as importantly, pins that the write
 * paths did NOT widen with it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  networkMonitors: {
    id: 'networkMonitors.id',
    orgId: 'networkMonitors.orgId',
    partnerId: 'networkMonitors.partnerId',
    assetId: 'networkMonitors.assetId',
    name: 'networkMonitors.name',
    monitorType: 'networkMonitors.monitorType',
    target: 'networkMonitors.target',
    config: 'networkMonitors.config',
    pollingInterval: 'networkMonitors.pollingInterval',
    timeout: 'networkMonitors.timeout',
    isActive: 'networkMonitors.isActive',
    lastChecked: 'networkMonitors.lastChecked',
    lastStatus: 'networkMonitors.lastStatus',
    lastResponseMs: 'networkMonitors.lastResponseMs',
    lastError: 'networkMonitors.lastError',
    consecutiveFailures: 'networkMonitors.consecutiveFailures',
    createdAt: 'networkMonitors.createdAt',
    updatedAt: 'networkMonitors.updatedAt',
  },
  networkMonitorResults: {
    id: 'networkMonitorResults.id',
    monitorId: 'networkMonitorResults.monitorId',
    timestamp: 'networkMonitorResults.timestamp',
    status: 'networkMonitorResults.status',
    responseMs: 'networkMonitorResults.responseMs',
    error: 'networkMonitorResults.error',
  },
  networkMonitorAlertRules: {
    id: 'networkMonitorAlertRules.id',
    monitorId: 'networkMonitorAlertRules.monitorId',
    condition: 'networkMonitorAlertRules.condition',
    threshold: 'networkMonitorAlertRules.threshold',
    severity: 'networkMonitorAlertRules.severity',
    message: 'networkMonitorAlertRules.message',
    isActive: 'networkMonitorAlertRules.isActive',
  },
  devices: { id: 'devices.id', orgId: 'devices.orgId', agentId: 'devices.agentId', status: 'devices.status' },
  discoveredAssets: { id: 'discoveredAssets.id', orgId: 'discoveredAssets.orgId', siteId: 'discoveredAssets.siteId' },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../services/redis', () => ({ isRedisAvailable: vi.fn().mockReturnValue(true) }));
vi.mock('../routes/agentWs', () => ({
  sendCommandToAgent: vi.fn().mockReturnValue(true),
  isAgentConnected: vi.fn().mockReturnValue(true),
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../jobs/monitorWorker', () => ({ enqueueMonitorCheck: vi.fn() }));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { monitorRoutes } from './monitors';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const PARTNER_ID = '99999999-9999-9999-9999-999999999999';
const OTHER_PARTNER_ID = '88888888-8888-8888-8888-888888888888';
const MONITOR_ID = '33333333-3333-3333-3333-333333333333';
const NOW = new Date('2026-09-15T12:00:00Z');

/**
 * Drizzle's `eq`/`and`/`or`/`isNull` build a real SQL AST even with our mocked
 * schema columns (plain strings): neither operand satisfies
 * isDriverValueEncoder, so both land verbatim in `queryChunks`. Walking the
 * tree recovers the ACTUAL filter identifiers/values a `.where(...)` was built
 * with, instead of trusting a stub that returns a fixed row no matter what was
 * asked for.
 */
function collectSqlLeafStrings(node: unknown, seen = new Set<unknown>(), acc: string[] = []): string[] {
  if (typeof node === 'string') {
    acc.push(node);
    return acc;
  }
  if (node === null || typeof node !== 'object' || seen.has(node)) return acc;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) collectSqlLeafStrings(item, seen, acc);
    return acc;
  }
  const queryChunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(queryChunks)) {
    for (const item of queryChunks) collectSqlLeafStrings(item, seen, acc);
  }
  return acc;
}

function setAuth(overrides: Record<string, unknown> = {}) {
  vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (id: string) => id === ORG_ID,
      orgCondition: () => undefined,
      ...overrides,
    });
    return next();
  });
}

function partnerAuth(overrides: Record<string, unknown> = {}) {
  setAuth({
    scope: 'partner',
    orgId: null,
    partnerId: PARTNER_ID,
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (id: string) => id === ORG_ID,
    ...overrides,
  });
}

const partnerWideRow = {
  id: MONITOR_ID,
  orgId: null,
  partnerId: PARTNER_ID,
  managedByMonitorId: 'def-1',
  assetId: null,
  name: 'All-orgs DNS check',
  monitorType: 'dns_check',
  target: 'example.com',
  config: {},
  pollingInterval: 60,
  timeout: 5,
  isActive: true,
  lastChecked: NOW,
  lastStatus: 'online',
  lastResponseMs: 11,
  lastError: null,
  consecutiveFailures: 0,
  createdAt: NOW,
  updatedAt: NOW,
};

/** `select().from().where().orderBy()` — the list shape. */
function mockListSelect(rows: unknown[], capture: { where?: unknown }) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation((w: unknown) => {
        capture.where = w;
        return { orderBy: vi.fn().mockResolvedValue(rows) };
      }),
    }),
  } as any;
}

/** `select().from().where()` — the count shape. */
function mockCountSelect(count: number) {
  return {
    from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ count }]) }),
  } as any;
}

/** `select().from().where().limit()` — the single-row shape. */
function mockRowSelect(rows: unknown[], capture?: { wheres: unknown[] }) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation((w: unknown) => {
        capture?.wheres.push(w);
        return { limit: vi.fn().mockResolvedValue(rows) };
      }),
    }),
  } as any;
}

function makeApp() {
  const app = new Hono();
  app.route('/monitors', monitorRoutes);
  return app;
}

describe('partner-wide network_monitors read visibility (#5866)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    setAuth();
    app = makeApp();
  });

  describe('GET / (list)', () => {
    it('adds the partner-wide branch to the filter for a partner token', async () => {
      partnerAuth();
      const capture: { where?: unknown } = {};
      vi.mocked(db.select)
        .mockReturnValueOnce(mockListSelect([partnerWideRow], capture))
        .mockReturnValueOnce(mockCountSelect(1));

      const res = await app.request(`/monitors?orgId=${ORG_ID}`);
      expect(res.status).toBe(200);

      const leaves = collectSqlLeafStrings(capture.where);
      expect(leaves).toContain('networkMonitors.orgId');
      expect(leaves).toContain('networkMonitors.partnerId');
      expect(leaves).toContain(PARTNER_ID);
    });

    it('projects partnerId so the UI can badge the row "All orgs"', async () => {
      partnerAuth();
      vi.mocked(db.select)
        .mockReturnValueOnce(mockListSelect([partnerWideRow], {}))
        .mockReturnValueOnce(mockCountSelect(1));

      const res = await app.request(`/monitors?orgId=${ORG_ID}`);
      const body = await res.json();
      expect(body.data[0].orgId).toBeNull();
      expect(body.data[0].partnerId).toBe(PARTNER_ID);
    });

    it('does NOT add a partner branch for an org-scoped token', async () => {
      const capture: { where?: unknown } = {};
      vi.mocked(db.select)
        .mockReturnValueOnce(mockListSelect([], capture))
        .mockReturnValueOnce(mockCountSelect(0));

      const res = await app.request('/monitors');
      expect(res.status).toBe(200);

      const leaves = collectSqlLeafStrings(capture.where);
      expect(leaves).toContain('networkMonitors.orgId');
      expect(leaves).not.toContain('networkMonitors.partnerId');
      expect(leaves).not.toContain(PARTNER_ID);
    });

    it('does NOT add a partner branch for an org token that CARRIES a partnerId', async () => {
      // The load-bearing half of the guard. A real org-scoped session can carry
      // a non-null partnerId, and the table's RLS SELECT-only branch keys on
      // `partner_id = breeze_current_partner_id()` alone — so `scope ===
      // 'partner'` is the ONLY thing standing between an org user and every
      // partner-wide check. Pin it separately from the `!auth.partnerId` half,
      // or a "simplification" to `if (!auth.partnerId) return undefined` leaks
      // the lot with the suite still green.
      setAuth({ partnerId: PARTNER_ID });
      const capture: { where?: unknown } = {};
      vi.mocked(db.select)
        .mockReturnValueOnce(mockListSelect([], capture))
        .mockReturnValueOnce(mockCountSelect(0));

      const res = await app.request('/monitors');
      expect(res.status).toBe(200);

      const leaves = collectSqlLeafStrings(capture.where);
      expect(leaves).toContain('networkMonitors.orgId');
      expect(leaves).not.toContain('networkMonitors.partnerId');
      expect(leaves).not.toContain(PARTNER_ID);
    });

    it('filters partner-wide rows out for a site-restricted user', async () => {
      // A partner-wide row owns no org and therefore no site, so the site gate
      // answers "no site" and denies. Pinning the vacuous-false: flipping it to
      // true would hand every site-scoped tech every partner-wide check.
      partnerAuth();
      vi.mocked(db.select)
        .mockReturnValueOnce(mockListSelect([partnerWideRow], {}))
        .mockReturnValueOnce(mockCountSelect(1));

      const app2 = new Hono();
      app2.use('*', async (c, next) => {
        c.set('permissions', { allowedSiteIds: ['site-a'] } as any);
        await next();
      });
      app2.route('/monitors', monitorRoutes);

      const res = await app2.request(`/monitors?orgId=${ORG_ID}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(0);
      expect(body.total).toBe(0);
    });
  });

  describe('GET /dashboard (status rollup)', () => {
    it('counts partner-wide rows for a partner token', async () => {
      partnerAuth();
      const capture: { where?: unknown } = {};
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation((w: unknown) => {
            capture.where = w;
            return Object.assign(Promise.resolve([{ count: 1 }]), {
              groupBy: vi.fn().mockResolvedValue([]),
            });
          }),
        }),
      } as any);

      const res = await app.request('/monitors/dashboard');
      expect(res.status).toBe(200);
      const leaves = collectSqlLeafStrings(capture.where);
      expect(leaves).toContain('networkMonitors.partnerId');
      expect(leaves).toContain(PARTNER_ID);
    });
  });

  describe('GET /:id (detail)', () => {
    it('returns the partner-wide row to its owning partner', async () => {
      partnerAuth();
      vi.mocked(db.select)
        // requireMonitorAccess: org-axis lookup, row is partner-wide -> refused
        .mockReturnValueOnce(mockRowSelect([partnerWideRow]))
        // partner-wide read fallback
        .mockReturnValueOnce(mockRowSelect([partnerWideRow]))
        // recentResults
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
            }),
          }),
        } as any)
        // alertRules
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
        } as any);

      const res = await app.request(`/monitors/${MONITOR_ID}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe(MONITOR_ID);
      expect(body.data.orgId).toBeNull();
      expect(body.data.partnerId).toBe(PARTNER_ID);
    });

    it('404s the partner-wide row for an org-scoped token', async () => {
      // Org scope narrows by org_id in SQL, so the row never comes back.
      vi.mocked(db.select).mockReturnValue(mockRowSelect([]));

      const res = await app.request(`/monitors/${MONITOR_ID}`);
      expect(res.status).toBe(404);
    });

    it('404s a partner-wide row owned by a DIFFERENT partner', async () => {
      partnerAuth();
      const capture = { wheres: [] as unknown[] };
      vi.mocked(db.select)
        .mockReturnValueOnce(mockRowSelect([{ ...partnerWideRow, partnerId: OTHER_PARTNER_ID }], capture))
        // fallback is scoped to the caller's partner — no row
        .mockReturnValueOnce(mockRowSelect([], capture));

      const res = await app.request(`/monitors/${MONITOR_ID}`);
      expect(res.status).toBe(404);
      // The fallback must filter on the CALLER's partner id, not the row's.
      const leaves = collectSqlLeafStrings(capture.wheres.at(-1));
      expect(leaves).toContain(PARTNER_ID);
      expect(leaves).not.toContain(OTHER_PARTNER_ID);
    });
  });

  describe('GET /:id/results', () => {
    it('returns results for a partner-wide monitor to its owning partner', async () => {
      partnerAuth();
      vi.mocked(db.select)
        .mockReturnValueOnce(mockRowSelect([partnerWideRow]))
        .mockReturnValueOnce(mockRowSelect([partnerWideRow]))
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  { id: 'r1', monitorId: MONITOR_ID, timestamp: NOW, status: 'online', responseMs: 9, error: null },
                ]),
              }),
            }),
          }),
        } as any);

      const res = await app.request(`/monitors/${MONITOR_ID}/results`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });
  });

  describe('GET /:monitorId/alerts', () => {
    it('returns the alert rules of a partner-wide monitor to its owning partner', async () => {
      partnerAuth();
      vi.mocked(db.select)
        .mockReturnValueOnce(mockRowSelect([partnerWideRow]))
        .mockReturnValueOnce(mockRowSelect([partnerWideRow]))
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ id: 'rule-1', monitorId: MONITOR_ID }]),
          }),
        } as any);

      const res = await app.request(`/monitors/${MONITOR_ID}/alerts`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });

    it('404s the alert rules of a partner-wide monitor for an org token', async () => {
      setAuth({ partnerId: PARTNER_ID });
      vi.mocked(db.select).mockReturnValue(mockRowSelect([]));

      const res = await app.request(`/monitors/${MONITOR_ID}/alerts`);
      expect(res.status).toBe(404);
    });
  });

  describe('writes stay org-axis only', () => {
    // Deliberately UNMANAGED: a managed row is refused a second time by
    // managedRowGuard with a 409, which would let an accidental widening of the
    // write path still look like a refusal. With managedByMonitorId null, the
    // 404 can only come from the org-axis guard itself.
    const unmanagedPartnerWideRow = { ...partnerWideRow, managedByMonitorId: null };

    it('PATCH /:id still refuses a partner-wide row for its own partner', async () => {
      partnerAuth();
      vi.mocked(db.select).mockReturnValue(mockRowSelect([unmanagedPartnerWideRow]));

      const res = await app.request(`/monitors/${MONITOR_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'renamed' }),
      });
      expect(res.status).toBe(404);
      expect(db.update).not.toHaveBeenCalled();
      // The write path must not even attempt the partner-wide fallback lookup.
      expect(vi.mocked(db.select).mock.calls).toHaveLength(1);
    });

    it('DELETE /:id still refuses a partner-wide row for its own partner', async () => {
      partnerAuth();
      vi.mocked(db.select).mockReturnValue(mockRowSelect([unmanagedPartnerWideRow]));

      const res = await app.request(`/monitors/${MONITOR_ID}`, { method: 'DELETE' });
      expect(res.status).toBe(404);
      expect(db.delete).not.toHaveBeenCalled();
      expect(vi.mocked(db.select).mock.calls).toHaveLength(1);
    });

    it('POST /:id/check still refuses a partner-wide row for its own partner', async () => {
      partnerAuth();
      vi.mocked(db.select).mockReturnValue(mockRowSelect([unmanagedPartnerWideRow]));

      const res = await app.request(`/monitors/${MONITOR_ID}/check`, { method: 'POST' });
      expect(res.status).toBe(404);
      expect(vi.mocked(db.select).mock.calls).toHaveLength(1);
    });
  });
});
