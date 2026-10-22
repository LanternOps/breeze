import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// #9350 review (authz): the route gate is organizations:read, which every
// technician/viewer holds. Each portal section must additionally require the
// permission that gates the same data on the staff side. Unlike
// orgPortalPreview.test.ts this suite uses an ENFORCING requirePermission
// (pattern from ai_admin_sessions_permission.test.ts) and the real
// hasPermission, so the HTTP-level gate is actually exercised.

type Perm = { resource: string; action: string };

const h = vi.hoisted(() => ({
  permsRef: { current: null as any },
  selectQueue: vi.fn(),
  audit: vi.fn(),
  dashboardForOrg: vi.fn(),
  serviceOverview: vi.fn(),
  documentsForOrg: vi.fn(),
  securityOverview: vi.fn(),
  backupOverview: vi.fn(),
  listPortalRuns: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('auth', {
      scope: 'partner', partnerId: 'p-1', orgId: null, accessibleOrgIds: null,
      user: { id: 'staff-1', email: 'tess@msp.example', name: 'Tess' },
      canAccessOrg: () => true,
    });
    c.set('permissions', h.permsRef.current);
    await next();
  }),
  requireScope: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    const perms: Perm[] = c.get('permissions')?.permissions ?? [];
    const ok = perms.some(
      (p) => (p.resource === resource || p.resource === '*') && (p.action === action || p.action === '*'),
    );
    if (!ok) return c.json({ error: 'Forbidden' }, 403);
    return next();
  },
}));
vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => h.selectQueue()) })) })),
    })),
  },
}));
vi.mock('../db/schema', async (importOriginal) => await importOriginal());
vi.mock('../services/auditEvents', async (importOriginal) => ({ ...(await importOriginal<object>()), writeRouteAudit: (...a: unknown[]) => h.audit(...a) }));
vi.mock('../services/portal/dashboard', () => ({ dashboardForOrg: h.dashboardForOrg }));
vi.mock('../services/portal/serviceReadModel', () => ({ serviceOverview: h.serviceOverview }));
vi.mock('../services/portal/documentsReadModel', () => ({ documentsForOrg: h.documentsForOrg }));
vi.mock('../services/portal/securityReadModel', () => ({ securityOverview: h.securityOverview }));
vi.mock('../services/portal/backupReadModel', () => ({ backupOverview: h.backupOverview }));
vi.mock('../services/portal/reportsSelfService', () => ({ listPortalRuns: h.listPortalRuns }));
vi.mock('../services/portal/timezone', () => ({ resolveOrgTimezone: vi.fn(async () => 'UTC') }));
vi.mock('./portal/ticketOwnership', () => ({ portalTicketOwnership: vi.fn(() => ({})) }));

import { authMiddleware } from '../middleware/auth';
import { PORTAL_SECTION_GATES } from './portal/featureFlags';
import { registerOrgPortalPreviewRoutes } from './orgPortalPreview';

const ORG = '7c0a1f7e-1111-4222-8333-444455556666';
const flagNames = [...new Set(PORTAL_SECTION_GATES.flatMap((g) => g.flags))] as string[];
const allFlagsRow = () => ({
  ...Object.fromEntries(flagNames.map((f) => [f, true])),
  logoUrl: 'logo', primaryColor: null, welcomeMessage: null, supportEmail: null, supportPhone: null,
});

const READ_MODELS = () => [h.dashboardForOrg, h.serviceOverview, h.documentsForOrg, h.securityOverview, h.backupOverview, h.listPortalRuns];

function as(...perms: string[]) {
  h.permsRef.current = {
    allowedSiteIds: null,
    permissions: perms.map((p) => { const [resource, action] = p.split(':'); return { resource, action }; }),
  };
}
function get() {
  const app = new Hono();
  app.use('*', authMiddleware as any);
  registerOrgPortalPreviewRoutes(app);
  h.selectQueue.mockResolvedValueOnce([{ id: ORG, partnerId: 'p-1' }]).mockResolvedValueOnce([allFlagsRow()]);
  return app.request(`/organizations/${ORG}/portal-preview`);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.dashboardForOrg.mockResolvedValue({ securityScore: { status: 'ok' }, support: { openTickets: 2 } });
  h.serviceOverview.mockResolvedValue({ groups: [] });
  h.documentsForOrg.mockResolvedValue({ groups: [{ documents: [{ id: 'd' }] }] });
  h.securityOverview.mockResolvedValue({ dataStatus: 'ok' });
  h.backupOverview.mockResolvedValue({ dataStatus: 'ok' });
  h.listPortalRuns.mockResolvedValue({ data: [{ id: 'r' }], pagination: { page: 1, limit: 20, total: 1 } });
});

describe('GET /organizations/:id/portal-preview — per-section staff permission (#9350)', () => {
  it('no organizations:read → 403 before anything is read', async () => {
    as('devices:read', 'reports:read', 'tickets:read');
    expect((await get()).status).toBe(403);
    for (const fn of READ_MODELS()) expect(fn).not.toHaveBeenCalled();
  });

  it('organizations:read only → 200 but every section is withheld and no read model runs', async () => {
    as('organizations:read');
    const res = await get();
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.sections.length).toBe(PORTAL_SECTION_GATES.length);
    for (const s of data.sections) {
      expect(s, s.key).toMatchObject({ enabled: true, data: null, previewAvailable: false, reason: 'permission' });
    }
    expect(data.readiness.map((r: any) => r.code)).toEqual([]);
    for (const fn of READ_MODELS()) expect(fn).not.toHaveBeenCalled();
  });

  it('a Security-Approver-like role (organizations:read + devices:read) sees device-data sections, not reports/tickets/documents/contracts/backup', async () => {
    as('organizations:read', 'devices:read');
    const { data } = await (await get()).json();
    const reasonOf = (k: string) => data.sections.find((s: any) => s.key === k).reason;
    expect(reasonOf('security')).toBeUndefined();
    expect(h.securityOverview).toHaveBeenCalledTimes(1);
    expect(reasonOf('dashboard')).toBeUndefined();
    expect(data.sections.find((s: any) => s.key === 'dashboard').data).not.toHaveProperty('support');
    for (const k of ['reports', 'service', 'documents', 'backups', 'supportUsage', 'ticketUsage']) {
      expect(reasonOf(k), k).toBe('permission');
    }
    expect(h.listPortalRuns).not.toHaveBeenCalled();
    expect(h.serviceOverview).not.toHaveBeenCalled();
    expect(h.documentsForOrg).not.toHaveBeenCalled();
    expect(h.backupOverview).not.toHaveBeenCalled();
  });

  it('wildcard role sees everything', async () => {
    as('*:*');
    const { data } = await (await get()).json();
    for (const s of data.sections) expect(s).not.toHaveProperty('reason');
    for (const fn of READ_MODELS()) expect(fn).toHaveBeenCalledTimes(1);
  });
});
