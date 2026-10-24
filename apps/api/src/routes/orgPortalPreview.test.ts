import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  authRef: { current: null as any },
  permsRef: { current: { allowedSiteIds: null as string[] | null, permissions: [{ resource: '*', action: '*' }] } },
  selectQueue: vi.fn(),
  wheres: [] as unknown[],
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  withSystemDbAccessContext: vi.fn(),
  runOutsideDbContext: vi.fn(),
  audit: vi.fn(),
  // read models
  dashboardForOrg: vi.fn(),
  serviceOverview: vi.fn(),
  documentsForOrg: vi.fn(),
  securityOverview: vi.fn(),
  backupOverview: vi.fn(),
  listPortalRuns: vi.fn(),
  resolveOrgTimezone: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!h.authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', h.authRef.current);
    c.set('permissions', h.permsRef.current);
    await next();
  }),
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn((p: unknown) => { h.wheres.push(p); return { limit: vi.fn(() => h.selectQueue()) }; }) })),
    })),
    insert: h.insert,
    update: h.update,
    delete: h.delete,
  },
  withSystemDbAccessContext: h.withSystemDbAccessContext,
  runOutsideDbContext: h.runOutsideDbContext,
}));
vi.mock('../db/schema', async (importOriginal) => await importOriginal());
vi.mock('../services/auditEvents', async (importOriginal) => ({ ...(await importOriginal<object>()), writeRouteAudit: (...a: unknown[]) => h.audit(...a) }));
vi.mock('../services/portal/dashboard', () => ({ dashboardForOrg: h.dashboardForOrg }));
vi.mock('../services/portal/serviceReadModel', () => ({ serviceOverview: h.serviceOverview }));
vi.mock('../services/portal/documentsReadModel', () => ({ documentsForOrg: h.documentsForOrg }));
vi.mock('../services/portal/securityReadModel', () => ({ securityOverview: h.securityOverview }));
vi.mock('../services/portal/backupReadModel', () => ({ backupOverview: h.backupOverview }));
vi.mock('../services/portal/reportsSelfService', () => ({ listPortalRuns: h.listPortalRuns }));
vi.mock('../services/portal/timezone', () => ({ resolveOrgTimezone: h.resolveOrgTimezone }));
vi.mock('../services/orgDocumentService', () => ({ streamDocument: vi.fn() }));
vi.mock('../services/serviceDeliverableService', () => ({ DeliverableServiceError: class extends Error {} }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('./portal/ticketOwnership', () => ({
  portalTicketOwnership: vi.fn((u: { id: string }) => ({ ownership: u.id })),
}));
// #8972: the dashboard's ticket set (own + survivors of merged tickets) — same sentinel shape.
vi.mock('./portal/ticketReadAccess', () => ({
  portalDashboardTicketScope: vi.fn((u: { id: string }) => ({ ownership: u.id })),
}));

import { authMiddleware } from '../middleware/auth';
import { PORTAL_SECTION_GATES } from './portal/featureFlags';
import { registerOrgPortalPreviewRoutes } from './orgPortalPreview';
import { portalDashboardRoutes } from './portal/dashboard';
import { portalServiceRoutes } from './portal/service';
import { portalDocumentRoutes } from './portal/documents';

const ORG = '7c0a1f7e-1111-4222-8333-444455556666';
const PU = 'aaaaaaaa-1111-4222-8333-444455556666';

const flagNames = [...new Set(PORTAL_SECTION_GATES.flatMap((g) => g.flags))] as string[];
const flagsRow = (on: string[]) => ({
  ...Object.fromEntries(flagNames.map((f) => [f, on.includes(f)])),
  logoUrl: 'logo', primaryColor: null, welcomeMessage: null, supportEmail: null, supportPhone: null,
});

function makeApp() {
  const app = new Hono();
  app.use('*', authMiddleware as any);
  registerOrgPortalPreviewRoutes(app);
  return app;
}
const get = (qs = '', id = ORG) => makeApp().request(`/organizations/${id}/portal-preview${qs}`);

function auth(over: Record<string, unknown> = {}) {
  h.authRef.current = {
    scope: 'partner', partnerId: 'p-1', orgId: null, accessibleOrgIds: null,
    user: { id: 'staff-1', email: 'tess@msp.example', name: 'Tess' },
    canAccessOrg: () => true,
    ...over,
  };
}

/** org existence → (portal user) → branding row, the order the handler reads them. */
function queue(...rows: unknown[][]) {
  for (const r of rows) h.selectQueue.mockResolvedValueOnce(r);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.wheres.length = 0;
  auth();
  h.permsRef.current = { allowedSiteIds: null, permissions: [{ resource: '*', action: '*' }] };
  h.resolveOrgTimezone.mockResolvedValue('UTC');
  h.dashboardForOrg.mockResolvedValue({ securityScore: { status: 'ok' }, support: { openTickets: 2 } });
  h.serviceOverview.mockResolvedValue({ groups: [] });
  h.documentsForOrg.mockResolvedValue({ groups: [{ category: 'runbook', documents: [{ id: 'd' }] }] });
  h.securityOverview.mockResolvedValue({ dataStatus: 'ok' });
  h.backupOverview.mockResolvedValue({ dataStatus: 'ok' });
  h.listPortalRuns.mockResolvedValue({ data: [{ id: 'r' }], pagination: { page: 1, limit: 20, total: 1 } });
});

describe('GET /organizations/:id/portal-preview — access (#9350)', () => {
  it('site-restricted caller → 403 and nothing is read', async () => {
    h.permsRef.current = { allowedSiteIds: ['site-1'], permissions: [{ resource: '*', action: '*' }] };
    const res = await get();
    expect(res.status).toBe(403);
    expect(h.selectQueue).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('partner without access to the org → 404', async () => {
    auth({ canAccessOrg: () => false });
    const res = await get();
    expect(res.status).toBe(404);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('portalUserId belonging to another org → 404 (lookup is org-scoped)', async () => {
    queue([{ id: ORG, partnerId: 'p-1' }], []); // org ok; portal user not found in THIS org
    const res = await get(`?portalUserId=${PU}`);
    expect(res.status).toBe(404);
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.dashboardForOrg).not.toHaveBeenCalled();
  });

  it('the portal-user lookup predicate is scoped to THIS org as well as the user id', async () => {
    queue([{ id: ORG, partnerId: 'p-1' }], [{ id: PU, contactId: null, name: 'Pat', email: 'p@x.example' }], [flagsRow([])]);
    await get(`?portalUserId=${PU}`);
    const compiled = h.wheres.map((w) => new PgDialect().sqlToQuery(w as never));
    const lookup = compiled.find((q) => q.params.includes(PU));
    expect(lookup, 'portal user lookup not found').toBeTruthy();
    expect(lookup!.params).toContain(ORG);
    expect(lookup!.sql).toMatch(/"portal_users"\."org_id"/);
    expect(lookup!.sql).toMatch(/"portal_users"\."id"/);
  });

  it('no resolved permissions fails closed (403)', async () => {
    h.permsRef.current = undefined as never;
    expect((await get()).status).toBe(403);
  });

  it('malformed portalUserId → 400', async () => {
    const res = await get('?portalUserId=not-a-uuid');
    expect(res.status).toBe(400);
  });
});

describe('GET /organizations/:id/portal-preview — gating (#9350)', () => {
  it('all flags off: every section enabled:false data:null and no read model runs', async () => {
    queue([{ id: ORG, partnerId: 'p-1' }], [flagsRow([])]);
    const res = await get();
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.sections.map((s: any) => s.key)).toEqual(PORTAL_SECTION_GATES.map((g) => g.key));
    for (const s of data.sections) {
      expect(s.enabled).toBe(false);
      expect(s.data).toBeNull();
    }
    for (const fn of [h.dashboardForOrg, h.serviceOverview, h.documentsForOrg, h.securityOverview, h.backupOverview, h.listPortalRuns]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  // One case per flag in the shared gate table: turning every OTHER flag on but
  // this one off must leave its section disabled with its read model untouched.
  it.each(PORTAL_SECTION_GATES.flatMap((g) => g.flags.map((f) => [g.key, f] as const)))(
    'section %s is disabled when flag %s is off',
    async (key, flag) => {
      queue([{ id: ORG, partnerId: 'p-1' }], [flagsRow(flagNames.filter((f) => f !== flag))]);
      const res = await get();
      const { data } = await res.json();
      const s = data.sections.find((x: any) => x.key === key);
      expect(s).toMatchObject({ enabled: false, data: null });
      const runnerFor: Record<string, ReturnType<typeof vi.fn>> = {
        dashboard: h.dashboardForOrg, security: h.securityOverview, backups: h.backupOverview,
        reports: h.listPortalRuns, service: h.serviceOverview, documents: h.documentsForOrg,
      };
      if (runnerFor[key]) expect(runnerFor[key]).not.toHaveBeenCalled();
    },
  );

  it('enabled sections carry their read-model payload', async () => {
    queue([{ id: ORG, partnerId: 'p-1' }], [flagsRow(flagNames)]);
    const { data } = await (await get()).json();
    expect(data.sections.find((s: any) => s.key === 'service')).toMatchObject({ enabled: true, data: { groups: [] } });
    expect(data.portalUser).toBeNull();
  });
});

describe('GET /organizations/:id/portal-preview — portal user scoping (#9350)', () => {
  it('without portalUserId the dashboard has no ticket-scoped support tile', async () => {
    queue([{ id: ORG, partnerId: 'p-1' }], [flagsRow(['enableDashboard'])]);
    const { data } = await (await get()).json();
    const dash = data.sections.find((s: any) => s.key === 'dashboard');
    expect(dash.data).not.toHaveProperty('support');
    expect(dash.note).toBeTruthy();
  });

  it('with portalUserId the dashboard is built with that user\'s ownership and keeps the support count', async () => {
    queue(
      [{ id: ORG, partnerId: 'p-1' }],
      [{ id: PU, contactId: 'c-1', name: 'Pat', email: 'pat@cust.example' }],
      [flagsRow(['enableDashboard'])],
    );
    const { data } = await (await get(`?portalUserId=${PU}`)).json();
    expect(h.dashboardForOrg.mock.calls[0]![2]).toEqual({ ownership: PU });
    expect(data.sections.find((s: any) => s.key === 'dashboard').data.support).toEqual({ openTickets: 2 });
    expect(data.portalUser).toEqual({ id: PU, name: 'Pat', email: 'pat@cust.example' });
  });
});

describe('GET /organizations/:id/portal-preview — read-only guarantees (#9350)', () => {
  it('writes nothing but one audit event; no insert/update/delete, no context switch', async () => {
    queue([{ id: ORG, partnerId: 'p-1' }], [flagsRow(flagNames)]);
    const res = await get();
    expect(res.status).toBe(200);
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.delete).not.toHaveBeenCalled();
    expect(h.withSystemDbAccessContext).not.toHaveBeenCalled();
    expect(h.runOutsideDbContext).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0]![1]).toMatchObject({
      orgId: ORG,
      action: 'organization.portal_preview.view',
      resourceType: 'organization',
      resourceId: ORG,
    });
  });

  it('never mints a portal session, token or JWT (source assertion)', () => {
    for (const rel of ['./orgPortalPreview.ts', '../services/portal/portalPreview.ts']) {
      const src = readFileSync(join(__dirname, rel), 'utf8');
      expect(src, rel).not.toMatch(/jsonwebtoken|\bsignJwt|createPortalSession|createPortalToken|sign\(|\.setex?\(/i);
      expect(src, rel).not.toMatch(/withSystemDbAccessContext|runOutsideDbContext/);
      expect(src, rel).not.toMatch(/\.(insert|update|delete)\(/);
    }
  });

  it('is not cacheable (per-viewer, org-wide data)', async () => {
    queue([{ id: ORG, partnerId: 'p-1' }], [flagsRow([])]);
    const res = await get();
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
  });
});

describe('preview ↔ portal parity (#9350): same read model, same payload', () => {
  const PORTAL_USER = { id: PU, contactId: 'c-1', name: 'Pat', email: 'pat@cust.example' };

  /** The portal routes as index.ts mounts them, minus the session lookup. */
  function portalApp() {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('portalAuth' as never, { user: { ...PORTAL_USER, orgId: ORG }, timezone: 'UTC' } as never);
      await next();
    });
    app.route('/', portalDashboardRoutes);
    app.route('/', portalServiceRoutes);
    app.route('/', portalDocumentRoutes);
    return app;
  }

  it.each([
    ['dashboard', '/dashboard'],
    ['service', '/service'],
    ['documents', '/documents'],
  ])('%s section deep-equals GET %s from the portal', async (key, path) => {
    queue(
      [{ id: ORG, partnerId: 'p-1' }],
      [PORTAL_USER],
      [flagsRow(['enableDashboard', 'enableService', 'enableDocuments'])],
    );
    const preview = (await (await get(`?portalUserId=${PU}`)).json()).data;
    const portal = await (await portalApp().request(path)).json();
    expect(preview.sections.find((s: any) => s.key === key).data).toEqual(portal);
    // Same read model called with the same org, timezone and (dashboard) ownership.
    const fn = ({ dashboard: h.dashboardForOrg, service: h.serviceOverview, documents: h.documentsForOrg } as Record<string, ReturnType<typeof vi.fn>>)[key]!;
    expect(fn).toHaveBeenCalledTimes(2);
    const [a, b] = fn.mock.calls as [any[], any[]];
    expect(a[0]).toBe(b[0]);
    expect(a[1].timezone).toBe(b[1].timezone);
    expect(a[2]).toEqual(b[2]);
  });

  it("dashboard support count equals the portal dashboard's for that user (same ownership predicate)", async () => {
    queue([{ id: ORG, partnerId: 'p-1' }], [PORTAL_USER], [flagsRow(['enableDashboard'])]);
    await get(`?portalUserId=${PU}`);
    await portalApp().request('/dashboard');
    const [previewCall, portalCall] = h.dashboardForOrg.mock.calls as [any[], any[]];
    expect(previewCall[2]).toEqual(portalCall[2]);
    expect(previewCall[0]).toBe(portalCall[0]);
    expect(previewCall[1].timezone).toBe(portalCall[1].timezone);
  });
});
