import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * Site-scope enforcement on software inventory routes.
 *
 * Before Task 12 of the launch-readiness fixes, `GET /software/inventory`
 * and `GET /software/inventory/:deviceId` only checked org-scope on the
 * device — partner-scope users restricted to a subset of sites within an
 * org could read inventory for devices in sites outside their allowlist.
 *
 * Mocks follow the same pattern as `cisHardening_site_scope.test.ts`:
 * `requirePermission` populates `permissions.allowedSiteIds` when the
 * request sends `x-restrict-site`.
 */

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  softwareCatalog: { id: 'id', orgId: 'org_id' },
  softwareVersions: { id: 'id', catalogId: 'catalog_id', isLatest: 'is_latest' },
  softwareDeployments: { id: 'id', orgId: 'org_id' },
  deploymentResults: { deploymentId: 'deployment_id', status: 'status' },
  softwareInventory: { deviceId: 'device_id', name: 'name' },
  devices: { id: 'id', orgId: 'org_id', siteId: 'site_id', agentId: 'agent_id' },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (id: string) => id === ORG_ID,
      orgCondition: () => undefined,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    const allowedSiteIds = c.req.header('x-restrict-site')
      ? [c.req.header('x-restrict-site') as string]
      : undefined;
    c.set('permissions', {
      permissions: [{ resource: 'devices', action: 'read' }],
      partnerId: null,
      orgId: ORG_ID,
      roleId: 'role-1',
      scope: 'organization',
      ...(allowedSiteIds ? { allowedSiteIds } : {}),
    });
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/deploymentTargetResolver', () => ({
  resolveDeploymentTargets: vi.fn().mockResolvedValue([]),
}));
vi.mock('../services/s3Storage', () => ({
  uploadBinary: vi.fn(),
  getPresignedUrl: vi.fn(),
  isS3Configured: vi.fn(() => false),
}));
vi.mock('./agentWs', () => ({ sendCommandToAgent: vi.fn() }));

const ORG_ID = 'org-111';
const ALLOWED_SITE_ID = 'site-a';
const FORBIDDEN_SITE_ID = 'site-b';
const ALLOWED_DEVICE_ID = '11111111-1111-1111-1111-111111111111';
const FORBIDDEN_DEVICE_ID = '22222222-2222-2222-2222-222222222222';

import { softwareRoutes } from './software';
import { db } from '../db';

function rigDeviceLookup(device: unknown) {
  // Per-device handler runs `db.select({...}).from(devices).where(...)` — no
  // `.limit()` on this path. Mirror that exact shape so the destructuring
  // (`const [device] = ...`) gets the array.
  const where = vi.fn().mockResolvedValue(device ? [device] : []);
  const from = vi.fn().mockReturnValue({ where });
  vi.mocked(db.select).mockReturnValueOnce({ from } as never);
}

function rigOrgDeviceListLookup(devicesList: Array<{ id: string; siteId: string | null }>) {
  // List handler runs `db.select({id, siteId}).from(devices).where(eq(orgId,...))`.
  const where = vi.fn().mockResolvedValue(devicesList);
  const from = vi.fn().mockReturnValue({ where });
  vi.mocked(db.select).mockReturnValueOnce({ from } as never);
}

function rigInventoryListLookup(rows: unknown[]) {
  // After org+site filtering, the handler runs:
  //   db.select().from(softwareInventory).where(...).orderBy(...)
  const orderBy = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where });
  vi.mocked(db.select).mockReturnValueOnce({ from } as never);
}

describe('software inventory — site-scope enforcement', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/software', softwareRoutes);
  });

  describe('GET /software/inventory/:deviceId', () => {
    it('returns 403 when caller is site-restricted away from the device site', async () => {
      rigDeviceLookup({ id: FORBIDDEN_DEVICE_ID, siteId: FORBIDDEN_SITE_ID });
      const res = await app.request(`/software/inventory/${FORBIDDEN_DEVICE_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer t', 'x-restrict-site': ALLOWED_SITE_ID },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/site/i);
    });

    it('allows the request through when caller is restricted to the device site', async () => {
      rigDeviceLookup({ id: ALLOWED_DEVICE_ID, siteId: ALLOWED_SITE_ID });
      rigInventoryListLookup([]);
      const res = await app.request(`/software/inventory/${ALLOWED_DEVICE_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer t', 'x-restrict-site': ALLOWED_SITE_ID },
      });
      expect(res.status).toBe(200);
    });

    it('returns 404 when device is not found in the org', async () => {
      rigDeviceLookup(null);
      const res = await app.request(`/software/inventory/${ALLOWED_DEVICE_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer t' },
      });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /software/inventory (list)', () => {
    it('returns 403 when filtering to a deviceId in a site outside the allowlist', async () => {
      // Org device list returns 2 devices, one in each site.
      rigOrgDeviceListLookup([
        { id: ALLOWED_DEVICE_ID, siteId: ALLOWED_SITE_ID },
        { id: FORBIDDEN_DEVICE_ID, siteId: FORBIDDEN_SITE_ID },
      ]);
      const res = await app.request(
        `/software/inventory?deviceId=${FORBIDDEN_DEVICE_ID}`,
        {
          method: 'GET',
          headers: { Authorization: 'Bearer t', 'x-restrict-site': ALLOWED_SITE_ID },
        },
      );
      expect(res.status).toBe(403);
    });

    it('returns 200 with inventory limited to devices in the site allowlist', async () => {
      rigOrgDeviceListLookup([
        { id: ALLOWED_DEVICE_ID, siteId: ALLOWED_SITE_ID },
        { id: FORBIDDEN_DEVICE_ID, siteId: FORBIDDEN_SITE_ID },
      ]);
      // After filtering, only the allowed device remains; inventory query
      // returns whatever rows are visible.
      rigInventoryListLookup([
        { deviceId: ALLOWED_DEVICE_ID, name: 'pkg-a' },
      ]);
      const res = await app.request('/software/inventory', {
        method: 'GET',
        headers: { Authorization: 'Bearer t', 'x-restrict-site': ALLOWED_SITE_ID },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.data)).toBe(true);
    });
  });
});
