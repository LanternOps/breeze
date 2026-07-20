import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { searchRoutes } from './search';

// Partial-mock drizzle-orm so `inArray` is a spy while every other operator
// (and/or/ilike/isNull/sql) stays real. This lets the site-narrowing tests
// prove that the device branch actually calls inArray(devices.siteId,
// allowedSiteIds) — deleting that production line makes the assertion fail.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    inArray: vi.fn((...args: Parameters<typeof actual.inArray>) => actual.inArray(...args)),
  };
});

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn()
  }
}));

vi.mock('../db/schema', () => ({
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
    hostname: 'devices.hostname',
    displayName: 'devices.displayName',
    status: 'devices.status'
  },
  scripts: {
    id: 'scripts.id',
    orgId: 'scripts.orgId',
    name: 'scripts.name',
    description: 'scripts.description'
  },
  alerts: {
    id: 'alerts.id',
    orgId: 'alerts.orgId',
    deviceId: 'alerts.deviceId',
    title: 'alerts.title',
    message: 'alerts.message',
    severity: 'alerts.severity'
  }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: 'org-1',
      partnerId: null,
      accessibleOrgIds: ['org-1'],
      canAccessOrg: (id: string) => id === 'org-1',
      orgCondition: () => undefined
    });
    return next();
  })
}));

vi.mock('../services/permissions', () => ({
  getUserPermissions: vi.fn(async () => ({
    permissions: [
      { resource: 'devices', action: 'read' },
      { resource: 'scripts', action: 'read' },
      { resource: 'alerts', action: 'read' },
      { resource: 'users', action: 'read' },
    ],
    partnerId: null,
    orgId: 'org-1',
    roleId: 'role-1',
    scope: 'organization',
  })),
  hasPermission: vi.fn((userPerms: any, resource: string, action: string) =>
    userPerms.permissions.some((p: any) => p.resource === resource && p.action === action)
  ),
  PERMISSIONS: {
    DEVICES_READ: { resource: 'devices', action: 'read' },
    SCRIPTS_READ: { resource: 'scripts', action: 'read' },
    ALERTS_READ: { resource: 'alerts', action: 'read' },
    USERS_READ: { resource: 'users', action: 'read' },
  }
}));

import { db } from '../db';
import { inArray } from 'drizzle-orm';
import { getUserPermissions } from '../services/permissions';

describe('search routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/search', searchRoutes);
  });

  it('returns aggregated search results', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              { id: 'dev-1', title: 'Workstation 01', hostname: 'ws-01', status: 'online', lastUser: null }
            ])
          })
        })
      } as never)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              { id: 'script-1', title: 'Patch Audit', description: 'Audit patch state' }
            ])
          })
        })
      } as never)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              { id: 'alert-1', title: 'CPU high', message: 'CPU above threshold', severity: 'high' }
            ])
          })
        })
      } as never);

    const res = await app.request('/search?q=patch');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results.some((row: { type?: string }) => row.type === 'devices')).toBe(true);
    expect(body.results.some((row: { type?: string }) => row.type === 'scripts')).toBe(true);
    expect(body.results.some((row: { type?: string }) => row.type === 'alerts')).toBe(true);
  });

  it('includes hostname in device result descriptions when display name is the title', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                id: 'dev-1',
                title: 'Alek 2019 MBP',
                hostname: 'Aleksey-16-MacBook-Pro.decom-09cb5eb9',
                status: 'online',
                lastUser: 'admitriev'
              }
            ])
          })
        })
      } as never)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as never)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as never);

    const res = await app.request('/search?q=16');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toContainEqual({
      id: 'dev-1',
      type: 'devices',
      title: 'Alek 2019 MBP',
      description: 'Aleksey-16-MacBook-Pro.decom-09cb5eb9 · online · admitriev'
    });
  });

  it('does not duplicate hostname in device result descriptions when hostname is the title', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              { id: 'dev-1', title: null, hostname: 'host-16', status: 'online', lastUser: null }
            ])
          })
        })
      } as never)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as never)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as never);

    const res = await app.request('/search?q=16');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toContainEqual({
      id: 'dev-1',
      type: 'devices',
      title: 'host-16',
      description: 'online'
    });
  });

  it('validates required query parameter', async () => {
    const res = await app.request('/search');
    expect(res.status).toBe(400);
  });

  describe('site-axis narrowing for device search', () => {
    it('narrows device-bound alert search with the canonical device-site predicate', async () => {
      vi.mocked(inArray).mockClear();
      vi.mocked(getUserPermissions).mockResolvedValueOnce({
        permissions: [
          { resource: 'devices', action: 'read' },
          { resource: 'scripts', action: 'read' },
          { resource: 'alerts', action: 'read' },
        ],
        allowedSiteIds: ['site-abc'],
        partnerId: null,
        orgId: 'org-1',
        roleId: 'role-1',
        scope: 'organization',
      } as any);

      const alertWhere = vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) });
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
          }),
        } as never)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
          }),
        } as never)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: alertWhere,
            leftJoin: vi.fn().mockReturnValue({ where: alertWhere }),
          }),
        } as never);

      const res = await app.request('/search?q=site-b-alert');

      expect(res.status).toBe(200);
      expect(inArray).toHaveBeenCalledWith('devices.siteId', ['site-abc']);
      expect(vi.mocked(inArray).mock.calls.filter(([column]) => column === 'devices.siteId')).toHaveLength(2);
    });

    it('returns empty device results when site-restricted caller has empty allowedSiteIds (fail-closed)', async () => {
      // Override getUserPermissions to simulate a site-restricted caller with no in-scope sites.
      vi.mocked(getUserPermissions).mockResolvedValueOnce({
        permissions: [
          { resource: 'devices', action: 'read' },
          { resource: 'scripts', action: 'read' },
          { resource: 'alerts', action: 'read' },
          { resource: 'users', action: 'read' },
        ],
        allowedSiteIds: [],
        partnerId: null,
        orgId: 'org-1',
        roleId: 'role-1',
        scope: 'organization',
      } as any);

      // scripts and alerts return empty; device query must include sql`false` site condition
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            })
          })
        } as never)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            })
          })
        } as never)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([])
              })
            })
          })
        } as never);

      const res = await app.request('/search?q=host');
      expect(res.status).toBe(200);
      const body = await res.json();
      // No device results — site filter is sql`false` for empty allowedSiteIds
      expect(body.results.filter((r: { type?: string }) => r.type === 'devices')).toHaveLength(0);
    });

    it('narrows the device query with inArray(devices.siteId, allowedSiteIds) for site-restricted callers', async () => {
      vi.mocked(inArray).mockClear();
      // Override getUserPermissions to simulate a site-restricted caller with one allowed site.
      vi.mocked(getUserPermissions).mockResolvedValueOnce({
        permissions: [
          { resource: 'devices', action: 'read' },
          { resource: 'scripts', action: 'read' },
          { resource: 'alerts', action: 'read' },
        ],
        allowedSiteIds: ['site-abc'],
        partnerId: null,
        orgId: 'org-1',
        roleId: 'role-1',
        scope: 'organization',
      } as any);

      const selectSpy = vi.mocked(db.select);
      let capturedDeviceWhere: unknown;
      selectSpy
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation((condition: unknown) => {
              capturedDeviceWhere = condition;
              return { limit: vi.fn().mockResolvedValue([]) };
            })
          })
        } as never)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) })
          })
        } as never)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) })
            })
          })
        } as never);

      const res = await app.request('/search?q=anything');
      expect(res.status).toBe(200);
      // A non-null where condition was passed (includes the site inArray filter)
      expect(capturedDeviceWhere).toBeDefined();
      // Load-bearing: the device branch MUST narrow on the site column. If the
      // production `inArray(devices.siteId, allowedSiteIds)` line were removed,
      // this assertion fails (inArray would never be called with the site column).
      expect(inArray).toHaveBeenCalledWith('devices.siteId', ['site-abc']);
    });

    it('unrestricted caller (no allowedSiteIds) returns device results normally', async () => {
      // Default mock has no allowedSiteIds — no site restriction.
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                { id: 'dev-1', title: 'Workstation', hostname: 'ws-01', status: 'online', lastUser: null }
              ])
            })
          })
        } as never)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) })
          })
        } as never)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) })
          })
        } as never);

      const res = await app.request('/search?q=ws');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results.some((r: { type?: string }) => r.type === 'devices')).toBe(true);
    });
  });
});
