import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { permissionGate, mfaGate } = vi.hoisted(() => ({
  permissionGate: { deny: false },
  mfaGate: { deny: false }
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  }
}));

vi.mock('../db/schema', () => ({
  devices: {},
  dnsActionEnum: { enumValues: ['allowed', 'blocked'] },
  dnsEventAggregations: {},
  dnsFilterIntegrations: {
    id: 'id',
    orgId: 'orgId',
    provider: 'provider',
    name: 'name',
    description: 'description',
    apiKey: 'apiKey',
    apiSecret: 'apiSecret',
    config: 'config',
    isActive: 'isActive',
    lastSync: 'lastSync',
    lastSyncStatus: 'lastSyncStatus',
    lastSyncError: 'lastSyncError',
    totalEventsProcessed: 'totalEventsProcessed',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
    createdBy: 'createdBy'
  },
  dnsPolicies: {},
  dnsProviderEnum: { enumValues: ['umbrella', 'cloudflare', 'pihole', 'adguard_home'] },
  dnsSecurityEvents: {},
  dnsThreatCategoryEnum: { enumValues: ['malware', 'phishing'] }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'organization',
      orgId: '11111111-1111-1111-1111-111111111111',
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111',
      user: { id: 'user-123', email: 'test@example.com' }
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (permissionGate.deny) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (mfaGate.deny) {
      return c.json({ error: 'MFA required' }, 403);
    }
    return next();
  })
}));

vi.mock('../jobs/dnsSyncJob', () => ({
  scheduleDnsEventSync: vi.fn(),
  schedulePolicySync: vi.fn()
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

vi.mock('../services/secretCrypto', () => ({
  encryptSecret: vi.fn((value: string | undefined) => `enc:${value ?? ''}`)
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    ORGS_WRITE: { resource: 'organizations', action: 'write' }
  },
  // Faithful to the real implementation: unrestricted callers (no
  // allowedSiteIds) always pass; otherwise the site must be in the allowlist.
  canAccessSite: (perms: any, siteId: string) =>
    !perms?.allowedSiteIds || perms.allowedSiteIds.includes(siteId)
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { dnsSecurityRoutes } from './dnsSecurity';

describe('dns security routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    permissionGate.deny = false;
    mfaGate.deny = false;

    app = new Hono();
    app.route('/dns-security', dnsSecurityRoutes);
  });

  it('rejects integration creation when permission check fails', async () => {
    permissionGate.deny = true;

    const res = await app.request('/dns-security/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'cloudflare',
        name: 'Cloudflare DNS',
        apiKey: 'api-key-123',
        config: { accountId: 'acct-123' }
      })
    });

    expect(res.status).toBe(403);
  });

  it('rejects integration creation when MFA check fails', async () => {
    mfaGate.deny = true;

    const res = await app.request('/dns-security/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'cloudflare',
        name: 'Cloudflare DNS',
        apiKey: 'api-key-123',
        config: { accountId: 'acct-123' }
      })
    });

    expect(res.status).toBe(403);
  });

  it('rejects pihole apiEndpoint pointing at cloud-metadata (SSRF)', async () => {
    const res = await app.request('/dns-security/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'pihole',
        name: 'Pi-hole',
        apiKey: 'api-key-123',
        config: { apiEndpoint: 'http://169.254.169.254/admin' }
      })
    });

    expect(res.status).toBe(400);
  });

  it('rejects adguard_home apiEndpoint pointing at loopback (SSRF)', async () => {
    const res = await app.request('/dns-security/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'adguard_home',
        name: 'AdGuard Home',
        apiKey: 'admin',
        apiSecret: 'pw',
        config: { apiEndpoint: 'http://127.0.0.1:3000' }
      })
    });

    expect(res.status).toBe(400);
  });

  it('rejects cloudflare apiEndpoint pointing off the cloudflare.com allowlist (SSRF)', async () => {
    const res = await app.request('/dns-security/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'cloudflare',
        name: 'Cloudflare DNS',
        apiKey: 'api-key-123',
        config: { accountId: 'acct-123', apiEndpoint: 'https://internal-vault.cluster.local/' }
      })
    });

    expect(res.status).toBe(400);
  });

  it('accepts pihole apiEndpoint on RFC1918 (legitimate on-prem)', async () => {
    // We don't expect this to succeed end-to-end (the DB insert isn't mocked
    // here) — just that validation doesn't reject the URL as SSRF.
    const res = await app.request('/dns-security/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'pihole',
        name: 'Pi-hole',
        apiKey: 'api-key-123',
        config: { apiEndpoint: 'http://192.168.1.50' }
      })
    });

    // Anything other than 400 means the URL passed validation. The downstream
    // DB layer isn't mocked, so a 500 is also acceptable here — the assertion
    // is that we didn't reject at validation time.
    expect(res.status).not.toBe(400);
  });

  // ──────────────── Site-scope enforcement (reads) ────────────────
  // A site-restricted org user (permissions.allowedSiteIds set) must not read
  // DNS query/block events or hostnames for devices in sites outside their
  // allowlist. Site is an app-layer concept only — RLS does not defend it.
  // `dnsSecurityEvents.deviceId` is NULLABLE (provider-level events aren't
  // device-bound), so provider-level rows must stay visible.
  const SITE_ALLOWED = 'aaaaaaaa-0000-0000-0000-000000000001';
  const SITE_DENIED = 'bbbbbbbb-0000-0000-0000-000000000002';
  const DEVICE_ALLOWED = '33333333-3333-3333-3333-333333333333';
  const DEVICE_DENIED = '55555555-5555-5555-5555-555555555555';

  function setSiteScopedAuth(allowedSiteIds: string[] | undefined) {
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: 'organization',
        orgId: '11111111-1111-1111-1111-111111111111',
        accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
        canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111',
        orgCondition: () => undefined,
        user: { id: 'user-123', email: 'test@example.com' }
      });
      if (allowedSiteIds !== undefined) c.set('permissions', { allowedSiteIds });
      return next();
    });
  }

  // Device-resolution query a restricted reader runs first:
  // db.select({id, siteId}).from(devices).where(eq(orgId, ...)) → rows
  function mockDeviceResolution(rows: Array<{ id: string; siteId: string | null }>) {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows)
      })
    } as any);
  }

  describe('GET /events — site scope', () => {
    it('denies an explicit deviceId outside the caller site allowlist (403)', async () => {
      setSiteScopedAuth([SITE_ALLOWED]);
      mockDeviceResolution([
        { id: DEVICE_ALLOWED, siteId: SITE_ALLOWED },
        { id: DEVICE_DENIED, siteId: SITE_DENIED }
      ]);

      const res = await app.request(`/dns-security/events?deviceId=${DEVICE_DENIED}`);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('Device not found or access denied');
    });

    it('narrows to accessible + provider-level (null-device) rows', async () => {
      setSiteScopedAuth([SITE_ALLOWED]);
      mockDeviceResolution([{ id: DEVICE_ALLOWED, siteId: SITE_ALLOWED }]);
      // events list + count
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    offset: vi.fn().mockResolvedValue([
                      { id: 'evt-1', deviceId: DEVICE_ALLOWED, domain: 'bad.example' },
                      { id: 'evt-2', deviceId: null, domain: 'provider.example' }
                    ])
                  })
                })
              })
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 2 }])
          })
        } as any);

      const res = await app.request('/dns-security/events');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
    });

    it('does not narrow for unrestricted callers', async () => {
      setSiteScopedAuth(undefined);
      // No device-resolution select should run; first select is the events list.
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    offset: vi.fn().mockResolvedValue([{ id: 'evt-1', deviceId: DEVICE_DENIED }])
                  })
                })
              })
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 1 }])
          })
        } as any);

      const res = await app.request('/dns-security/events');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });
  });

  describe('GET /stats — site scope', () => {
    it('denies an explicit deviceId outside the caller site allowlist (403)', async () => {
      setSiteScopedAuth([SITE_ALLOWED]);
      mockDeviceResolution([
        { id: DEVICE_ALLOWED, siteId: SITE_ALLOWED },
        { id: DEVICE_DENIED, siteId: SITE_DENIED }
      ]);

      const res = await app.request(`/dns-security/stats?deviceId=${DEVICE_DENIED}`);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('Device not found or access denied');
    });

    it('narrows raw stats query for a restricted caller (200)', async () => {
      setSiteScopedAuth([SITE_ALLOWED]);
      mockDeviceResolution([{ id: DEVICE_ALLOWED, siteId: SITE_ALLOWED }]);
      // raw path: summary, topBlockedDomains, topCategories, topDevices
      const summarySel = {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { totalQueries: 5, blockedQueries: 2, allowedQueries: 3, redirectedQueries: 0 }
          ])
        })
      };
      const groupSel = {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            groupBy: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([])
              })
            })
          })
        })
      };
      const deviceGroupSel = {
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([])
                })
              })
            })
          })
        })
      };
      vi.mocked(db.select)
        .mockReturnValueOnce(summarySel as any)
        .mockReturnValueOnce(groupSel as any)
        .mockReturnValueOnce(groupSel as any)
        .mockReturnValueOnce(deviceGroupSel as any);

      const res = await app.request('/dns-security/stats');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.summary.totalQueries).toBe(5);
      expect(body.source).toBe('raw');
    });
  });
});
