import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { permissionGate, mfaGate, permsState } = vi.hoisted(() => ({
  permissionGate: { deny: false, deniedPermission: null as string | null },
  mfaGate: { deny: false },
  permsState: { permissions: undefined as { allowedSiteIds?: string[] } | undefined }
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
      orgCondition: () => undefined,
      user: { id: 'user-123', email: 'test@example.com' }
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    if (permissionGate.deny || permissionGate.deniedPermission === `${resource}:${action}`) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    // Mirror prod: requirePermission (not authMiddleware) populates `permissions`.
    c.set('permissions', permsState.permissions);
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
    ORGS_WRITE: { resource: 'organizations', action: 'write' },
    DEVICES_READ: { resource: 'devices', action: 'read' }
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
    permissionGate.deniedPermission = null;
    mfaGate.deny = false;

    app = new Hono();
    app.route('/dns-security', dnsSecurityRoutes);
  });

  describe('DNS configuration read permission', () => {
    it('rejects integration configuration reads before database access when devices:read is denied', async () => {
      permissionGate.deniedPermission = 'devices:read';

      const res = await app.request('/dns-security/integrations');

      expect(res.status).toBe(403);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('rejects policy configuration reads before database access when devices:read is denied', async () => {
      permissionGate.deniedPermission = 'devices:read';

      const res = await app.request('/dns-security/policies');

      expect(res.status).toBe(403);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('allows integration configuration reads with devices:read', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: () => ({
          where: () => ({
            orderBy: () => Promise.resolve([{ id: 'integration-1', name: 'DNS Filter' }])
          })
        })
      } as any);

      const res = await app.request('/dns-security/integrations');

      expect(res.status).toBe(200);
      expect((await res.json()).data).toEqual([{ id: 'integration-1', name: 'DNS Filter' }]);
    });

    it('allows policy configuration reads with devices:read', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              orderBy: () => Promise.resolve([{ id: 'policy-1', name: 'Block malware' }])
            })
          })
        })
      } as any);

      const res = await app.request('/dns-security/policies');

      expect(res.status).toBe(200);
      expect((await res.json()).data).toEqual([{ id: 'policy-1', name: 'Block malware' }]);
    });
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

  it('rejects a pihole apiEndpoint on carrier-grade NAT by default', async () => {
    const res = await app.request('/dns-security/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'pihole',
        name: 'Pi-hole over Tailscale',
        apiKey: 'api-key-123',
        config: { apiEndpoint: 'http://100.100.5.6/admin' }
      })
    });

    expect(res.status).toBe(400);
  });

  it('accepts a pihole apiEndpoint on carrier-grade NAT with the explicit opt-in', async () => {
    // The opt-in is honoured for the on-prem appliance provider; the connect-time
    // factory additionally requires a self-hosted deployment, so this cannot
    // widen egress on hosted. Validation acceptance is what we assert — the DB
    // layer isn't mocked, so anything other than 400 means the URL passed.
    const res = await app.request('/dns-security/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'pihole',
        name: 'Pi-hole over Tailscale',
        apiKey: 'api-key-123',
        config: { apiEndpoint: 'http://100.100.5.6/admin', allowCarrierNatEgress: true }
      })
    });

    expect(res.status).not.toBe(400);
  });

  it('ignores the carrier-NAT opt-in for a strict cloud provider', async () => {
    const res = await app.request('/dns-security/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'cloudflare',
        name: 'Cloudflare DNS',
        apiKey: 'api-key-123',
        config: {
          accountId: 'acct-123',
          apiEndpoint: 'http://100.100.5.6/',
          allowCarrierNatEgress: true
        }
      })
    });

    expect(res.status).toBe(400);
  });

  // The next-gen Umbrella Reports API takes no organization id — the OAuth2
  // token's own `sub` claim scopes the request — so demanding one at creation
  // time rejects a perfectly usable credential (#4597).
  it('accepts a Cisco Umbrella integration without config.organizationId (#4597)', async () => {
    const res = await app.request('/dns-security/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'umbrella',
        name: 'Contoso Umbrella',
        apiKey: 'api-key-123',
        apiSecret: 'api-secret-123'
      })
    });

    // The DB layer isn't mocked, so anything other than 400 means validation
    // let it through.
    expect(res.status).not.toBe(400);
  });

  it('still accepts a Cisco Umbrella integration that supplies organizationId', async () => {
    const res = await app.request('/dns-security/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'umbrella',
        name: 'Contoso Umbrella',
        apiKey: 'api-key-123',
        apiSecret: 'api-secret-123',
        config: { organizationId: 'umbrella-org-id' }
      })
    });

    expect(res.status).not.toBe(400);
  });

  // Control: the umbrella branch of the validator is still live, so the test
  // above is proving something.
  it('still rejects a Cisco Umbrella integration with no apiSecret', async () => {
    const res = await app.request('/dns-security/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'umbrella',
        name: 'Contoso Umbrella',
        apiKey: 'api-key-123'
      })
    });

    expect(res.status).toBe(400);
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
    // `permissions` is populated by requirePermission (see global mock), not
    // authMiddleware — faithful to prod, so a route lacking the permission gate
    // will not receive site scoping and its tests will fail.
    permsState.permissions = allowedSiteIds !== undefined ? { allowedSiteIds } : undefined;
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: 'organization',
        orgId: '11111111-1111-1111-1111-111111111111',
        accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
        canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111',
        orgCondition: () => undefined,
        user: { id: 'user-123', email: 'test@example.com' }
      });
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

  describe('GET /top-blocked — site scope + permission gate', () => {
    // Mirrors /events and /stats: gated by requirePermission(devices.read) and
    // site-narrowed so a site-restricted caller's top-blocked ranking + the
    // per-domain distinct-device counts only span devices in their allowed
    // sites. Provider-level (null-device) rows stay visible.
    it('returns 403 when the caller lacks devices.read', async () => {
      setSiteScopedAuth(undefined);
      permissionGate.deny = true;

      const res = await app.request('/dns-security/top-blocked');
      expect(res.status).toBe(403);
    });

    it('narrows the raw top-blocked query for a restricted caller (200)', async () => {
      setSiteScopedAuth([SITE_ALLOWED]);
      // 1) device-resolution select, 2) the grouped top-blocked select
      mockDeviceResolution([{ id: DEVICE_ALLOWED, siteId: SITE_ALLOWED }]);

      const whereSpy = vi.fn().mockReturnValue({
        groupBy: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              { domain: 'bad.example', category: 'malware', count: 4, devices: 1 }
            ])
          })
        })
      });
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: whereSpy })
      } as any);

      const res = await app.request('/dns-security/top-blocked');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.source).toBe('raw');
      expect(body.data).toHaveLength(1);
      // The grouped query must have received a (site-narrowing) where clause —
      // an unnarrowed handler would still pass conditions, but the presence of
      // the device-resolution select above proves the narrowing path ran.
      expect(whereSpy).toHaveBeenCalled();
    });

    it('does not run device resolution for unrestricted callers (200)', async () => {
      setSiteScopedAuth(undefined);
      // For an unrestricted caller the FIRST (and only) select is the grouped
      // top-blocked query — there is no device-resolution select. If the handler
      // wrongly ran site narrowing, this mock would be consumed by the device
      // resolution and the grouped query would blow up.
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            groupBy: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  { domain: 'bad.example', category: 'malware', count: 9, devices: 3 }
                ])
              })
            })
          })
        })
      } as any);

      const res = await app.request('/dns-security/top-blocked');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.source).toBe('raw');
      expect(body.data).toHaveLength(1);
      expect(body.data[0].devices).toBe(3);
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

  // ──────────────── Org-wide policy writes refuse a site ceiling ────────────────
  // A DNS allow/block policy applies to the whole organization (it has no site
  // axis), so a caller restricted to specific sites — or a device-bound run —
  // may not create or edit one, regardless of orgs:write.
  describe('policy writes — site ceiling', () => {
    const ORG_ID = '11111111-1111-1111-1111-111111111111';
    const INTEGRATION_ID = '22222222-2222-2222-2222-222222222222';
    const POLICY_ID = '44444444-4444-4444-4444-444444444444';

    function setCeilingAuth(ceiling: { allowedSiteIds?: string[]; allowedDeviceIds?: string[] }) {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'organization',
          orgId: ORG_ID,
          accessibleOrgIds: [ORG_ID],
          canAccessOrg: (orgId: string) => orgId === ORG_ID,
          orgCondition: () => undefined,
          user: { id: 'user-123', email: 'test@example.com' },
          ...ceiling
        });
        return next();
      });
    }

    const createBody = JSON.stringify({
      integrationId: INTEGRATION_ID,
      name: 'Block list',
      type: 'blocklist',
      domains: [{ domain: 'example.com' }]
    });
    const patchBody = JSON.stringify({ add: [{ domain: 'example.org' }] });

    const ceilings: Array<[string, { allowedSiteIds?: string[]; allowedDeviceIds?: string[] }]> = [
      ['a site allowlist', { allowedSiteIds: ['aaaaaaaa-0000-0000-0000-000000000001'] }],
      ['an empty site allowlist', { allowedSiteIds: [] }],
      ['an exact-device ceiling', { allowedDeviceIds: ['33333333-3333-3333-3333-333333333333'] }]
    ];

    for (const [label, ceiling] of ceilings) {
      it(`POST /policies refuses a caller with ${label} before database access`, async () => {
        setCeilingAuth(ceiling);

        const res = await app.request('/dns-security/policies', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: createBody
        });

        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.error).toMatch(/Site-restricted users cannot modify organization-wide settings/);
        expect(db.select).not.toHaveBeenCalled();
        expect(db.insert).not.toHaveBeenCalled();
      });

      it(`PATCH /policies/:id/domains refuses a caller with ${label} before database access`, async () => {
        setCeilingAuth(ceiling);

        const res = await app.request(`/dns-security/policies/${POLICY_ID}/domains`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: patchBody
        });

        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.error).toMatch(/Site-restricted users cannot modify organization-wide settings/);
        expect(db.select).not.toHaveBeenCalled();
        expect(db.update).not.toHaveBeenCalled();
      });
    }

    it('POST /policies still lets an unrestricted org caller through to the integration lookup', async () => {
      setCeilingAuth({});
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/dns-security/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: createBody
      });

      expect(res.status).toBe(404);
      expect(db.select).toHaveBeenCalledTimes(1);
    });

    it('PATCH /policies/:id/domains still lets an unrestricted org caller through to the policy lookup', async () => {
      setCeilingAuth({});
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request(`/dns-security/policies/${POLICY_ID}/domains`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: patchBody
      });

      expect(res.status).toBe(404);
      expect(db.select).toHaveBeenCalledTimes(1);
    });
  });

  // ──────────────── #8329: policy owner org derived from the integration ────────────────
  // DNS integrations are org-owned and a policy is created against one, so the
  // route takes the owning org from the integration (after an access check)
  // instead of requiring the client to send `orgId`. A partner user with 2+
  // orgs used to get 400 "orgId is required for this scope".
  describe('POST /policies — owner org from the integration (#8329)', () => {
    const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const ORG_OTHER = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const INTEGRATION_ID = '22222222-2222-2222-2222-222222222222';
    const POLICY_ID = '44444444-4444-4444-4444-444444444444';
    const orgCondition = vi.fn(() => undefined);

    function setPartnerAuth() {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'partner',
          orgId: null,
          partnerId: 'partner-1',
          accessibleOrgIds: [ORG_A, ORG_B],
          canAccessOrg: (orgId: string) => orgId === ORG_A || orgId === ORG_B,
          orgCondition,
          user: { id: 'user-123', email: 'test@example.com' }
        });
        return next();
      });
    }

    function mockIntegrationLookup(rows: Array<{ id: string; orgId: string }>) {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(rows)
          })
        })
      } as any);
    }

    function mockPolicyInsert() {
      const values = vi.fn().mockReturnValue({
        returning: vi.fn().mockImplementation(async () => [{
          id: POLICY_ID,
          orgId: values.mock.calls[0]![0].orgId,
          integrationId: INTEGRATION_ID,
          name: 'Block list',
          type: 'blocklist'
        }])
      });
      vi.mocked(db.insert).mockReturnValueOnce({ values } as any);
      return values;
    }

    function post(body: Record<string, unknown>) {
      return app.request('/dns-security/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integrationId: INTEGRATION_ID,
          name: 'Block list',
          type: 'blocklist',
          domains: [{ domain: 'example.com' }],
          ...body
        })
      });
    }

    beforeEach(() => {
      // clearAllMocks keeps queued mockReturnValueOnce values; drop any a
      // failed earlier test left behind so each case sees only its own.
      vi.mocked(db.select).mockReset();
      vi.mocked(db.insert).mockReset();
      orgCondition.mockClear();
      setPartnerAuth();
    });

    it('creates the policy in the integration org for a partner with 2+ orgs and no body orgId', async () => {
      mockIntegrationLookup([{ id: INTEGRATION_ID, orgId: ORG_B }]);
      const values = mockPolicyInsert();

      const res = await post({});

      expect(res.status).toBe(201);
      expect(values).toHaveBeenCalledTimes(1);
      expect(values.mock.calls[0]![0]).toMatchObject({ orgId: ORG_B, integrationId: INTEGRATION_ID });
      expect((await res.json()).orgId).toBe(ORG_B);
      // The lookup is scoped to the caller's accessible orgs.
      expect(orgCondition).toHaveBeenCalledWith('orgId');
    });

    it('accepts an explicit body orgId that matches the integration org', async () => {
      mockIntegrationLookup([{ id: INTEGRATION_ID, orgId: ORG_B }]);
      const values = mockPolicyInsert();

      const res = await post({ orgId: ORG_B });

      expect(res.status).toBe(201);
      expect(values.mock.calls[0]![0]).toMatchObject({ orgId: ORG_B });
    });

    it('returns 404 when the integration is not visible to the caller', async () => {
      mockIntegrationLookup([]);

      const res = await post({});

      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe('Integration not found');
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('returns 404 when the integration belongs to an org the caller cannot access', async () => {
      // Defence in depth: even if the scoped lookup returned a row from a
      // foreign org, the route re-checks canAccessOrg on the integration org.
      mockIntegrationLookup([{ id: INTEGRATION_ID, orgId: ORG_OTHER }]);

      const res = await post({});

      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe('Integration not found');
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('rejects an explicit body orgId that differs from the integration org with 400', async () => {
      mockIntegrationLookup([{ id: INTEGRATION_ID, orgId: ORG_B }]);

      const res = await post({ orgId: ORG_A });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/orgId/);
      expect(body.error).toMatch(/integration/i);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('still rejects an explicit body orgId the caller cannot access with 403, before the lookup', async () => {
      const res = await post({ orgId: ORG_OTHER });

      expect(res.status).toBe(403);
      expect(db.select).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('returns 404 for an org-scope caller whose integration belongs to another org', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'organization',
          orgId: ORG_A,
          accessibleOrgIds: [ORG_A],
          canAccessOrg: (orgId: string) => orgId === ORG_A,
          orgCondition,
          user: { id: 'user-123', email: 'test@example.com' }
        });
        return next();
      });
      mockIntegrationLookup([{ id: INTEGRATION_ID, orgId: ORG_B }]);

      const res = await post({});

      expect(res.status).toBe(404);
      expect(db.insert).not.toHaveBeenCalled();
    });
  });
});
