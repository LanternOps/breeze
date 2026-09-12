import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { tagRoutes } from './tags';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID_2 = '22222222-2222-2222-2222-222222222222';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';

vi.mock('../services', () => ({}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn()
  }
,
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: {
    id: 'id',
    orgId: 'orgId',
    siteId: 'siteId',
    hostname: 'hostname',
    displayName: 'displayName',
    status: 'status',
    osType: 'osType',
    tags: 'tags'
  },
  manualAssets: {
    id: 'ma_id',
    orgId: 'ma_orgId',
    siteId: 'ma_siteId',
    name: 'ma_name',
    tags: 'ma_tags',
    retiredAt: 'ma_retiredAt',
    linkedDeviceId: 'ma_linkedDeviceId',
    linkedDiscoveredAssetId: 'ma_linkedDiscoveredAssetId'
  }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: '11111111-1111-1111-1111-111111111111',
      partnerId: null,
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111'
    });
    return next();
  }),
  // `x-restrict-site` -> single-site allowlist; `x-restrict-site-empty` ->
  // empty allowlist (zero accessible sites). Absent -> unset (full org access).
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    const restrictSite = c.req.header('x-restrict-site');
    const emptyAllowlist = c.req.header('x-restrict-site-empty');
    let allowedSiteIds: string[] | undefined;
    if (emptyAllowlist) allowedSiteIds = [];
    else if (restrictSite) allowedSiteIds = [restrictSite];
    c.set('permissions', {
      permissions: [{ resource: 'devices', action: 'read' }],
      partnerId: null,
      orgId: ORG_ID,
      roleId: 'role-1',
      scope: 'organization',
      ...(allowedSiteIds !== undefined ? { allowedSiteIds } : {})
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next())
}));

import { db } from '../db';
import { manualAssets } from '../db/schema';
import { authMiddleware } from '../middleware/auth';

describe('tag routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
        scope: 'organization',
        orgId: ORG_ID,
        partnerId: null,
        accessibleOrgIds: [ORG_ID],
        canAccessOrg: (orgId: string) => orgId === ORG_ID
      });
      return next();
    });
    // Both endpoints issue two queries (devices, then manual assets). Tests that
    // only care about the device arm queue a single `mockReturnValueOnce`; this
    // default answers the manual-asset query with no rows.
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([])
      })
    } as any);
    app = new Hono();
    app.route('/tags', tagRoutes);
  });

  // ----------------------------------------------------------------
  // GET / - List tags
  // ----------------------------------------------------------------
  describe('GET /tags', () => {
    it('should list unique tags with device counts', async () => {
      const deviceRows = [
        { tags: ['prod', 'web'] },
        { tags: ['prod', 'db'] },
        { tags: ['web'] }
      ];
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(deviceRows)
        })
      } as any);

      const res = await app.request('/tags', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(3);
      // 'prod' has 2 devices, 'web' has 2, 'db' has 1
      const prodTag = body.data.find((t: any) => t.tag === 'prod');
      expect(prodTag.deviceCount).toBe(2);
      const webTag = body.data.find((t: any) => t.tag === 'web');
      expect(webTag.deviceCount).toBe(2);
      const dbTag = body.data.find((t: any) => t.tag === 'db');
      expect(dbTag.deviceCount).toBe(1);
    });

    it('should filter tags by search term', async () => {
      const deviceRows = [
        { tags: ['production', 'staging'] },
        { tags: ['production'] }
      ];
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(deviceRows)
        })
      } as any);

      const res = await app.request('/tags?search=prod', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.data[0].tag).toBe('production');
    });

    it('should handle devices with no tags', async () => {
      const deviceRows = [
        { tags: null },
        { tags: [] },
        { tags: ['active'] }
      ];
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(deviceRows)
        })
      } as any);

      const res = await app.request('/tags', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.data[0].tag).toBe('active');
    });

    it('should return empty for org scope with no orgId', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          scope: 'organization',
          orgId: null,
          partnerId: null,
          accessibleOrgIds: [],
          canAccessOrg: () => false
        });
        return next();
      });

      const res = await app.request('/tags', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('should sort tags by device count descending, then alphabetically', async () => {
      const deviceRows = [
        { tags: ['alpha', 'beta'] },
        { tags: ['beta', 'gamma'] },
        { tags: ['beta'] }
      ];
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(deviceRows)
        })
      } as any);

      const res = await app.request('/tags', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data[0].tag).toBe('beta');
      expect(body.data[0].deviceCount).toBe(3);
    });

    it('unions manual-asset tags into the tag counts', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ tags: ['prod', 'web'] }])
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ tags: ['prod', 'printer'] }, { tags: ['printer'] }])
          })
        } as any);

      const res = await app.request('/tags', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      const byTag = Object.fromEntries(body.data.map((t: any) => [t.tag, t.deviceCount]));
      expect(byTag).toEqual({ prod: 2, printer: 2, web: 1 });
      expect(body.total).toBe(3);
    });

    it('queries manual assets from the manual_assets table', async () => {
      const manualFrom = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) })
        } as any)
        .mockReturnValueOnce({ from: manualFrom } as any);

      await app.request('/tags', { method: 'GET', headers: { Authorization: 'Bearer token' } });

      expect(manualFrom).toHaveBeenCalledWith(manualAssets);
    });

    it('should ignore empty string tags', async () => {
      const deviceRows = [
        { tags: ['', '  ', 'valid'] }
      ];
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(deviceRows)
        })
      } as any);

      const res = await app.request('/tags', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.data[0].tag).toBe('valid');
    });
  });

  // ----------------------------------------------------------------
  // GET /devices - Get devices by tag
  // ----------------------------------------------------------------
  describe('GET /tags/devices', () => {
    it('should return devices matching a tag', async () => {
      const deviceList = [
        { id: 'dev-1', hostname: 'host-1', displayName: 'Host 1', status: 'online', osType: 'linux', tags: ['prod'] },
        { id: 'dev-2', hostname: 'host-2', displayName: 'Host 2', status: 'offline', osType: 'windows', tags: ['prod', 'web'] }
      ];
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(deviceList)
        })
      } as any);

      const res = await app.request('/tags/devices?tag=prod', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.total).toBe(2);
      expect(body.data[0].id).toBe('dev-1');
    });

    it('includes manual assets carrying the tag, shaped as deviceClass=manual', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: 'dev-1', hostname: 'host-1', displayName: 'Host 1', status: 'online', osType: 'linux', tags: ['prod'] }
            ])
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: 'ma-1', name: 'Lobby Printer', tags: ['prod', 'printer'] }
            ])
          })
        } as any);

      const res = await app.request('/tags/devices?tag=prod', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(2);
      expect(body.data[0]).toMatchObject({ id: 'dev-1', deviceClass: 'agent' });
      expect(body.data[1]).toEqual({
        id: 'ma-1',
        deviceClass: 'manual',
        hostname: 'Lobby Printer',
        displayName: 'Lobby Printer',
        status: 'unknown',
        osType: null,
        tags: ['prod', 'printer']
      });
    });

    it('filters manual assets by the requested tag in SQL', async () => {
      // The mock DB ignores the WHERE, so without this assertion the handler
      // could return every manual asset regardless of tag and still look green.
      const where = captureManualWhere([]);

      const res = await app.request('/tags/devices?tag=printer-fleet', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      expect(where).toHaveBeenCalledTimes(1);
      const whereText = conditionText(where.mock.calls[0]?.[0]);
      expect(whereText).toContain('ma_tags');
      expect(whereText).toContain('printer-fleet');
    });

    it('should validate that tag query parameter is required', async () => {
      const res = await app.request('/tags/devices', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
    });

    it('should return empty for org with no orgId', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          scope: 'organization',
          orgId: null,
          partnerId: null,
          accessibleOrgIds: [],
          canAccessOrg: () => false
        });
        return next();
      });

      const res = await app.request('/tags/devices?tag=prod', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('should handle devices with null tags', async () => {
      const deviceList = [
        { id: 'dev-1', hostname: 'host-1', displayName: null, status: 'online', osType: 'linux', tags: null }
      ];
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(deviceList)
        })
      } as any);

      const res = await app.request('/tags/devices?tag=prod', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data[0].tags).toEqual([]);
    });
  });

  // ----------------------------------------------------------------
  // Partner scope multi-tenant tests
  // ----------------------------------------------------------------
  describe('partner scope', () => {
    beforeEach(() => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-456', email: 'partner@example.com', name: 'Partner User' },
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_ID,
          accessibleOrgIds: [ORG_ID, ORG_ID_2],
          canAccessOrg: (orgId: string) => [ORG_ID, ORG_ID_2].includes(orgId)
        });
        return next();
      });
    });

    it('should list tags across multiple orgs', async () => {
      const deviceRows = [
        { tags: ['shared-tag'] },
        { tags: ['shared-tag', 'org2-only'] }
      ];
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(deviceRows)
        })
      } as any);

      const res = await app.request('/tags', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(2);
    });

    it('narrows the manual-asset arm to every accessible org', async () => {
      // The org axis is RLS-backed, but the app-layer condition is what keeps a
      // partner's query from asking for rows outside accessibleOrgIds — drop it
      // and this arm silently widens.
      const where = captureManualWhere([]);

      const res = await app.request('/tags', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      expect(where).toHaveBeenCalledTimes(1);
      const whereText = conditionText(where.mock.calls[0]?.[0]);
      expect(whereText).toContain('ma_orgId');
      expect(whereText).toContain(ORG_ID);
      expect(whereText).toContain(ORG_ID_2);
    });

    it('unions manual-asset tags from every accessible org', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ tags: ['shared-tag'] }])
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ tags: ['shared-tag', 'org2-printer'] }])
          })
        } as any);

      const res = await app.request('/tags', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(db.select).toHaveBeenCalledTimes(2);
      const byTag = Object.fromEntries(body.data.map((t: any) => [t.tag, t.deviceCount]));
      expect(byTag).toEqual({ 'shared-tag': 2, 'org2-printer': 1 });
    });

    it('should return empty when partner has no accessible orgs', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-456', email: 'partner@example.com', name: 'Partner User' },
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_ID,
          accessibleOrgIds: [],
          canAccessOrg: () => false
        });
        return next();
      });

      const res = await app.request('/tags', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
    });
  });

  // ----------------------------------------------------------------
  // System scope tests
  // ----------------------------------------------------------------
  describe('system scope', () => {
    beforeEach(() => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'admin-1', email: 'admin@example.com', name: 'Admin' },
          scope: 'system',
          orgId: null,
          partnerId: null,
          accessibleOrgIds: null,
          canAccessOrg: () => true
        });
        return next();
      });
    });

    it('should list all tags across all orgs', async () => {
      const deviceRows = [
        { tags: ['global-tag'] }
      ];
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(deviceRows)
        })
      } as any);

      const res = await app.request('/tags', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);
    });
  });

  // ----------------------------------------------------------------
  // Site-scope enforcement (Finding #2)
  //
  // RLS enforces the org axis only; the site axis (permissions.allowedSiteIds)
  // is app-layer. A site-restricted user must not see the tag taxonomy or the
  // device list for devices in sites outside their allowlist. Mirrors the
  // devices/core.ts semantics: empty allowlist -> no rows; unset -> full org.
  //
  // The mock DB ignores the WHERE clause (it just resolves the rows we rig),
  // so these tests assert on the WHERE *condition* the handler builds — the
  // narrowing must be present — and on the empty-allowlist short-circuit.
  // ----------------------------------------------------------------
  const ALLOWED_SITE_ID = 'site-a';

  // Captures the WHERE of the SECOND query (the manual-asset arm, #5425). The
  // manual arm is narrowed on the same axes as the device arm — org (also
  // RLS-backed) and the app-layer site allowlist — so a dropped condition here
  // would leak another tenant's or another site's manual-asset tags.
  function captureManualWhere(rows: unknown[]) {
    const where = vi.fn().mockResolvedValue(rows);
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) })
      } as any)
      .mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where }) } as any);
    return where;
  }

  function captureWhere(rows: unknown[]) {
    const where = vi.fn().mockResolvedValue(rows);
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({ where })
    } as any);
    return where;
  }

  // Serialize the drizzle WHERE condition the handler passes to .where() so we
  // can assert the constructed SQL actually contains the site-axis narrowing
  // (the mock DB ignores the WHERE, so an `expect.anything()` check would still
  // pass even if the `inArray(devices.siteId, ...)` push were removed). Mirrors
  // the `conditionText` technique in cisHardening_site_scope.test.ts. The
  // schema mock maps `devices.siteId -> 'siteId'`, so an in-site filter
  // serializes to include that column token and the site id.
  function conditionText(value: unknown): string {
    return JSON.stringify(value, (_key, nested) =>
      typeof nested === 'function' ? '[function]' : nested
    );
  }

  describe('site-scope enforcement', () => {
    it('GET /tags narrows the taxonomy to the site allowlist', async () => {
      // Only the allowed-site device's tags come back from the (narrowed) query.
      const where = captureWhere([{ tags: ['finance'] }]);

      const res = await app.request('/tags', {
        method: 'GET',
        headers: { Authorization: 'Bearer token', 'x-restrict-site': ALLOWED_SITE_ID }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.data[0].tag).toBe('finance');
      // The handler must have built a WHERE that actually narrows by site —
      // serialize the condition and assert it carries the site-axis filter
      // (column + allowed site id), not just "some object".
      expect(where).toHaveBeenCalledTimes(1);
      const whereText = conditionText(where.mock.calls[0]?.[0]);
      expect(whereText).toContain('siteId');
      expect(whereText).toContain(ALLOWED_SITE_ID);
    });

    it('GET /tags/devices excludes out-of-site devices via the site allowlist', async () => {
      // The narrowed query only returns the in-site device.
      const where = captureWhere([
        { id: 'dev-a', hostname: 'host-a', displayName: 'A', status: 'online', osType: 'linux', tags: ['finance'] }
      ]);

      const res = await app.request('/tags/devices?tag=finance', {
        method: 'GET',
        headers: { Authorization: 'Bearer token', 'x-restrict-site': ALLOWED_SITE_ID }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.data[0].id).toBe('dev-a');
      expect(where).toHaveBeenCalledTimes(1);
      const whereText = conditionText(where.mock.calls[0]?.[0]);
      expect(whereText).toContain('siteId');
      expect(whereText).toContain(ALLOWED_SITE_ID);
    });

    it('GET /tags emits a never-true (sql`false`) condition when the allowlist is empty', async () => {
      // Empty allowlist = zero accessible sites. The handler can't know which
      // rows Postgres would drop (the unit mock ignores WHERE), so we assert the
      // contract that guarantees zero rows in real PG: a `sql\`false\`` fragment
      // is pushed into the WHERE. Mirrors devices/core.ts' `sql\`false\`` branch.
      const where = captureWhere([]);

      const res = await app.request('/tags', {
        method: 'GET',
        headers: { Authorization: 'Bearer token', 'x-restrict-site-empty': '1' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      // Inspect the constructed WHERE: an `and(...)` of real drizzle conditions.
      // The serialized SQL must contain the literal `false` short-circuit.
      expect(where).toHaveBeenCalledTimes(1);
      const whereArg = where.mock.calls[0]?.[0];
      // The sql`false` chunk specifically: a bare 'false' substring also matches
      // drizzle's `"shouldInlineParams":false` and would pass without it.
      expect(JSON.stringify(whereArg)).toContain('"value":["false"]');
    });

    it('GET /tags narrows the manual-asset arm to the site allowlist', async () => {
      const where = captureManualWhere([{ tags: ['finance'] }]);

      const res = await app.request('/tags', {
        method: 'GET',
        headers: { Authorization: 'Bearer token', 'x-restrict-site': ALLOWED_SITE_ID }
      });

      expect(res.status).toBe(200);
      expect(where).toHaveBeenCalledTimes(1);
      const whereText = conditionText(where.mock.calls[0]?.[0]);
      expect(whereText).toContain('ma_siteId');
      expect(whereText).toContain(ALLOWED_SITE_ID);
      // Retired and already-linked assets never reach the taxonomy.
      expect(whereText).toContain('ma_retiredAt');
      expect(whereText).toContain('ma_linkedDeviceId');
      expect(whereText).toContain('ma_linkedDiscoveredAssetId');
    });

    it('GET /tags/devices emits a never-true manual-asset condition when the allowlist is empty', async () => {
      const where = captureManualWhere([]);

      const res = await app.request('/tags/devices?tag=finance', {
        method: 'GET',
        headers: { Authorization: 'Bearer token', 'x-restrict-site-empty': '1' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(where).toHaveBeenCalledTimes(1);
      // Match the sql`false` chunk itself — a bare `.toContain('false')` also
      // matches drizzle's own `"shouldInlineParams":false` and would pass with
      // the short-circuit removed.
      expect(JSON.stringify(where.mock.calls[0]?.[0])).toContain('"value":["false"]');
    });

    it('GET /tags applies no site filter when allowlist is unset (full org access)', async () => {
      const where = captureWhere([{ tags: ['a'] }, { tags: ['b'] }]);

      // No x-restrict-site header -> allowedSiteIds undefined.
      const res = await app.request('/tags', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(2);
      expect(where).toHaveBeenCalledTimes(1);
      // Unset allowlist = full org access: the WHERE must NOT carry a site
      // filter (only the org-axis condition).
      expect(conditionText(where.mock.calls[0]?.[0])).not.toContain('siteId');
    });
  });
});
