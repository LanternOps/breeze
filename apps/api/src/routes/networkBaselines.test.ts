import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * Site-scope enforcement on `POST /` (network baseline create).
 *
 * The create handler authorizes `body.siteId` by org only — it confirms the
 * site belongs to the caller's org, but never consults
 * `permissions.allowedSiteIds`. Site-scope is an app-layer-only authz axis
 * (RLS does not defend it), so a site-restricted org user could create a
 * baseline for a site OUTSIDE their allowlist. These tests pin the gate:
 *
 *   - site-restricted caller, out-of-scope siteId  → 403
 *   - site-restricted caller, in-scope siteId       → 201
 *   - unrestricted caller (no allowedSiteIds)        → unchanged (201)
 *
 * Mocks mirror `cisHardening_site_scope.test.ts`: `requirePermission`
 * populates `permissions` in the Hono context, and `x-restrict-site` opts a
 * request into a single-site allowlist.
 */

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  networkBaselines: {
    id: 'networkBaselines.id',
    orgId: 'networkBaselines.orgId',
    siteId: 'networkBaselines.siteId',
    subnet: 'networkBaselines.subnet',
  },
  networkChangeEvents: {
    id: 'networkChangeEvents.id',
    orgId: 'networkChangeEvents.orgId',
  },
  discoveryProfiles: {
    id: 'discoveryProfiles.id',
    orgId: 'discoveryProfiles.orgId',
    siteId: 'discoveryProfiles.siteId',
    subnets: 'discoveryProfiles.subnets',
  },
  sites: {
    id: 'sites.id',
    orgId: 'sites.orgId',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    const allowedSiteIds = c.req.header('x-restrict-site')
      ? (c.req.header('x-restrict-site') === '__empty__' ? [] : [c.req.header('x-restrict-site') as string])
      : undefined;
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: 'org-111',
      accessibleOrgIds: ['org-111'],
      orgCondition: () => undefined,
      canAccessOrg: (id: string) => id === 'org-111',
    });
    c.set('permissions', allowedSiteIds ? {
      permissions: [{ resource: 'devices', action: 'read' }],
      partnerId: null,
      orgId: 'org-111',
      roleId: 'role-1',
      scope: 'organization',
      allowedSiteIds,
    } : undefined);
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    const allowedSiteIds = c.req.header('x-restrict-site')
      ? [c.req.header('x-restrict-site') as string]
      : undefined;
    c.set('permissions', {
      permissions: [{ resource: 'devices', action: 'write' }],
      partnerId: null,
      orgId: 'org-111',
      roleId: 'role-1',
      scope: 'organization',
      ...(allowedSiteIds ? { allowedSiteIds } : {}),
    });
    return next();
  }),
}));

// Faithful copy of the real `canAccessSite` semantics — unrestricted callers
// (no `allowedSiteIds`) always pass; restricted callers pass only for sites in
// their allowlist. A wrong mock here would 500 the route, masking the gate.
vi.mock('../services/permissions', () => ({
  canAccessSite: (perms: any, siteId: string) =>
    !perms?.allowedSiteIds || perms.allowedSiteIds.includes(siteId),
}));

vi.mock('../jobs/networkBaselineWorker', () => ({ enqueueBaselineScan: vi.fn() }));
vi.mock('../services/networkBaseline', () => ({
  normalizeBaselineAlertSettings: vi.fn((s: any) => s ?? {}),
  normalizeBaselineScanSchedule: vi.fn((s: any) => s ?? {}),
}));
vi.mock('../services/redis', () => ({ isRedisAvailable: vi.fn().mockResolvedValue(true) }));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('./networkShared', () => ({
  networkEventTypes: [],
  optionalQueryBooleanSchema: { optional: () => ({}) },
  mapNetworkChangeRow: vi.fn((r: any) => r),
  resolveOrgId: vi.fn((auth: any) => ({ orgId: auth.orgId })),
}));

import { networkBaselineRoutes } from './networkBaselines';
import { db } from '../db';

const ORG_ID = 'org-111';
const SITE_ID = '11111111-1111-1111-1111-111111111111';
const FORBIDDEN_SITE_ID = '22222222-2222-2222-2222-222222222222';
const SUBNET = '10.0.0.0/24';

/** Rigs the org-scoped site lookup: db.select(...).from(sites).where(...).limit(1). */
function rigSiteLookup(site: unknown) {
  const limit = vi.fn().mockResolvedValue(site ? [site] : []);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  vi.mocked(db.select).mockReturnValueOnce({ from } as never);
}

/** Rigs the insert chain: db.insert(...).values(...).returning(). */
function rigInsert(row: unknown) {
  const returning = vi.fn().mockResolvedValue([row]);
  const values = vi.fn().mockReturnValue({ returning });
  vi.mocked(db.insert).mockReturnValueOnce({ values } as never);
}

function postBaseline(siteId: string, restrictSite?: string) {
  const headers: Record<string, string> = {
    Authorization: 'Bearer t',
    'Content-Type': 'application/json',
  };
  if (restrictSite) headers['x-restrict-site'] = restrictSite;
  return app.request('/baselines', {
    method: 'POST',
    headers,
    body: JSON.stringify({ siteId, subnet: SUBNET }),
  });
}

let app: Hono;

describe('Network baselines — POST / site-scope enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/baselines', networkBaselineRoutes);
  });

  it('returns 403 on GET / when a site-restricted caller filters to an out-of-scope site', async () => {
    rigSiteLookup({ id: FORBIDDEN_SITE_ID });

    const res = await app.request(`/baselines?siteId=${FORBIDDEN_SITE_ID}`, {
      headers: { 'x-restrict-site': SITE_ID },
    });

    expect(res.status).toBe(403);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('returns an empty GET / list when the site allowlist is empty', async () => {
    const res = await app.request('/baselines', {
      headers: { 'x-restrict-site': '__empty__' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.pagination.total).toBe(0);
  });

  it('returns 403 when a site-restricted caller targets a site outside the allowlist', async () => {
    // Site belongs to the org, so the org-scope check passes — only the
    // site-scope gate should reject this.
    rigSiteLookup({ id: FORBIDDEN_SITE_ID });
    const res = await postBaseline(FORBIDDEN_SITE_ID, SITE_ID);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/site/i);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('allows creation when a site-restricted caller targets a site within the allowlist', async () => {
    rigSiteLookup({ id: SITE_ID });
    rigInsert({
      id: 'baseline-1',
      orgId: ORG_ID,
      siteId: SITE_ID,
      subnet: SUBNET,
      knownDevices: [],
      scanSchedule: {},
      alertSettings: {},
      lastScanAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await postBaseline(SITE_ID, SITE_ID);
    expect(res.status).toBe(201);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it('leaves unrestricted callers (no allowedSiteIds) unchanged', async () => {
    rigSiteLookup({ id: FORBIDDEN_SITE_ID });
    rigInsert({
      id: 'baseline-2',
      orgId: ORG_ID,
      siteId: FORBIDDEN_SITE_ID,
      subnet: SUBNET,
      knownDevices: [],
      scanSchedule: {},
      alertSettings: {},
      lastScanAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // No x-restrict-site header → no allowedSiteIds → gate must not engage.
    const res = await postBaseline(FORBIDDEN_SITE_ID);
    expect(res.status).toBe(201);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });
});
