import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { orgRoutes } from './orgs';

vi.mock('../services', () => ({}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
  isSentryEnabled: vi.fn().mockReturnValue(false)
}));

vi.mock('../services/clientIp', () => ({
  getTrustedClientIpOrUndefined: vi.fn()
}));

vi.mock('../services/ipAllowlist', () => ({
  clearPartnerAllowlistCache: vi.fn(),
  ipAllowlistMode: vi.fn(() => 'enforce'),
  readPartnerAllowlist: vi.fn(async () => [])
}));

vi.mock('../services/tenantLifecycle', () => ({
  revokePartnerTenantAccess: vi.fn().mockResolvedValue({
    apiKeysRevoked: 0,
    userSessionsRevoked: 0,
    oauthGrantsRevoked: 0,
    oauthRefreshTokensRevoked: 0,
    agentTokensSuspended: 0,
    enrollmentKeysInvalidated: 0
  }),
  revokeOrganizationTenantAccess: vi.fn().mockResolvedValue({
    apiKeysRevoked: 0,
    userSessionsRevoked: 0,
    oauthGrantsRevoked: 0,
    oauthRefreshTokensRevoked: 0,
    agentTokensSuspended: 0,
    enrollmentKeysInvalidated: 0
  }),
  restorePartnerTenantAccess: vi.fn().mockResolvedValue({ agentTokensRestored: 0 }),
  restoreOrganizationTenantAccess: vi.fn().mockResolvedValue({ agentTokensRestored: 0 })
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve([]))
          })),
          limit: vi.fn(() => Promise.resolve([]))
        }))
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([]))
      }))
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([]))
        }))
      }))
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve())
    })),
    // transaction: invoke the callback with a tx proxy that mirrors the db mock
    transaction: vi.fn(async (fn: (tx: any) => any) => {
      const tx = {
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve([]))
          }))
        }))
      };
      return fn(tx);
    })
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn())
}));

vi.mock('../services/ticketConfigService', () => ({
  seedSystemTicketStatuses: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../db/schema', () => ({
  partners: {},
  organizations: {},
  // Give sites.id a recognizable sentinel so the site-allowlist test can assert
  // inArray was called against the sites.id column specifically.
  sites: { id: { __column: 'sites.id' }, orgId: { __column: 'sites.orgId' } },
  // GET /orgs/sites enriches each site with a grouped device count (#1790).
  devices: { siteId: { __column: 'devices.siteId' } },
  // Agent version pins (issue #2124) validate against this table at save time.
  agentVersions: { id: {}, component: {}, version: {} }
}));

// Spy on inArray so the site-allowlist test can assert the GET /orgs/sites
// handler actually intersects the query with inArray(sites.id, allowedSiteIds).
// Keep every other drizzle-orm export real.
vi.mock('drizzle-orm', async (importActual) => {
  const actual = await importActual<typeof import('drizzle-orm')>();
  return {
    ...actual,
    // Return an opaque sentinel instead of building a real SQL fragment: the db
    // is fully mocked, so the return value is never executed, but the sentinel
    // columns ({ __column: ... }) aren't real Drizzle columns and would make the
    // real inArray throw on introspection.
    inArray: vi.fn((column: unknown, values: unknown) => ({ __inArray: { column, values } }))
  };
});

// Mutable switch for the requirePermission mock so individual tests can
// simulate a caller whose role LACKS the gated permission (the real middleware
// 403s). Hoisted because the vi.mock factory below references it. Reset to
// granted in beforeEach.
const permissionMockState = vi.hoisted(() => ({ granted: true }));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      token: {},
      partnerId: 'partner-123',
      orgId: 'org-123',
      scope: 'system',
      accessibleOrgIds: null,
      orgCondition: () => undefined,
      canAccessOrg: () => true
    } as any);
    return next();
  }),
  requireScope: vi.fn((...scopes: string[]) => (c: any, next: any) => {
    const auth = c.get('auth');
    if (!scopes.includes(auth?.scope)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return next();
  }),
  requirePartner: vi.fn((c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (!permissionMockState.granted) {
      return c.json({ error: 'Permission denied' }, 403);
    }
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next())
}));

import { inArray } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { sites } from '../db/schema';
import { authMiddleware } from '../middleware/auth';
import { getTrustedClientIpOrUndefined } from '../services/clientIp';
import { clearPartnerAllowlistCache, readPartnerAllowlist } from '../services/ipAllowlist';
import {
  restoreOrganizationTenantAccess,
  restorePartnerTenantAccess,
  revokeOrganizationTenantAccess,
  revokePartnerTenantAccess,
} from '../services/tenantLifecycle';
import { captureException } from '../services/sentry';
import { seedSystemTicketStatuses } from '../services/ticketConfigService';

describe('org routes', () => {
  let app: Hono;

  const setAuthContext = (overrides: Partial<{
    user: { id: string; email: string; name: string };
    token: Record<string, unknown>;
    partnerId: string | null;
    orgId: string | null;
    scope: 'system' | 'partner' | 'organization';
    partnerOrgAccess: 'all' | 'selected' | 'none' | null;
    accessibleOrgIds: string[] | null;
    canAccessOrg: (orgId: string) => boolean;
    // Per-user site confinement. When provided (even as []), it is exposed via
    // c.get('permissions').allowedSiteIds, mirroring the production permissions
    // middleware. Omit for an unconfined user (allowedSiteIds undefined).
    allowedSiteIds: string[];
  }> = {}) => {
    const scope = overrides.scope ?? 'system';
    const accessibleOrgIds = 'accessibleOrgIds' in overrides
      ? overrides.accessibleOrgIds
      : scope === 'partner'
        ? ['org-1']
        : null;

    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User', ...overrides.user },
        token: overrides.token ?? {},
        partnerId: 'partnerId' in overrides ? overrides.partnerId : 'partner-123',
        orgId: 'orgId' in overrides ? overrides.orgId : 'org-123',
        scope,
        partnerOrgAccess: 'partnerOrgAccess' in overrides
          ? overrides.partnerOrgAccess
          : scope === 'partner' ? 'all' : null,
        accessibleOrgIds,
        orgCondition: () => undefined,
        canAccessOrg: overrides.canAccessOrg ?? ((orgId: string) => {
          if (!Array.isArray(accessibleOrgIds)) return true;
          return accessibleOrgIds.includes(orgId);
        })
      } as any);
      c.set('permissions', {
        scope,
        allowedSiteIds: 'allowedSiteIds' in overrides ? overrides.allowedSiteIds : undefined
      } as any);
      return next();
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    permissionMockState.granted = true;
    setAuthContext();
    app = new Hono();
    app.route('/orgs', orgRoutes);
  });

  describe('GET /orgs/partners', () => {
    it('should return partners with pagination', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 2 }])
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockReturnValue({
                  orderBy: vi.fn().mockResolvedValue([{ id: 'partner-1' }, { id: 'partner-2' }])
                })
              })
            })
          })
        } as any);

      const res = await app.request('/orgs/partners?page=1&limit=2');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.pagination.total).toBe(2);
    });
  });

  describe('POST /orgs/partners', () => {
    it("returns 409 when the new slug collides with an existing partner's inbound local part", async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: 'other-partner' }])
          })
        })
      } as any);

      const res = await app.request('/orgs/partners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Partner',
          slug: 'support'
        })
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'That partner identifier is already in use' });
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('should create a partner and seed system ticket statuses', async () => {
      const partner = { id: 'partner-1', name: 'Partner' };
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);
      vi.mocked(db.transaction).mockImplementation(async (fn: (tx: any) => any) => {
        const tx = {
          insert: vi.fn(() => ({
            values: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue([partner])
            }))
          }))
        };
        return fn(tx);
      });

      const res = await app.request('/orgs/partners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Partner',
          slug: 'partner'
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe('partner-1');
      // Verify seedSystemTicketStatuses was called with the new partner's id
      expect(vi.mocked(seedSystemTicketStatuses)).toHaveBeenCalledWith(
        expect.anything(), // tx
        'partner-1'
      );
    });
  });

  describe('GET /orgs/partners/:id', () => {
    it('should return a partner', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: 'partner-1', name: 'Partner' }])
          })
        })
      } as any);

      const res = await app.request('/orgs/partners/partner-1');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe('partner-1');
    });

    it('should return 404 when partner not found', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/orgs/partners/missing');

      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /orgs/partners/:id', () => {
    it('should reject empty updates', async () => {
      const res = await app.request('/orgs/partners/partner-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(400);
    });

    it('should update a partner', async () => {
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'partner-1', name: 'Updated' }])
          })
        })
      } as any);

      const res = await app.request('/orgs/partners/partner-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Updated');
    });

    it("returns 409 when the updated slug collides with another partner's inbound local part", async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: 'other-partner' }])
          })
        })
      } as any);

      const res = await app.request('/orgs/partners/partner-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'support' })
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'That partner identifier is already in use' });
      expect(db.update).not.toHaveBeenCalled();
    });

    // #1318: a system-scoped wholesale settings write must mirror
    // settings.timezone into the first-class `partners.timezone` column the same
    // way PATCH /partners/me does, or resolveEffectiveTimezone (which reads the
    // column first) would silently desync.
    it('mirrors settings.timezone into the partners.timezone column on a system-scope write', async () => {
      const currentPartner = { id: 'partner-1', name: 'Acme MSP', settings: {} };
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            }),
            limit: vi.fn().mockResolvedValue([currentPartner])
          })
        })
      } as any);

      let capturedUpdateData: any;
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockImplementation((data: any) => {
          capturedUpdateData = data;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ ...currentPartner, settings: data.settings }])
            })
          };
        })
      } as any);

      const res = await app.request('/orgs/partners/partner-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { timezone: 'America/New_York' } })
      });

      expect(res.status).toBe(200);
      expect(capturedUpdateData.timezone).toBe('America/New_York');
      expect(capturedUpdateData.settings.timezone).toBe('America/New_York');
    });

    // #1318 cosmetic: a lowercase 'utc' settings value canonicalizes to the
    // 'UTC' sentinel so the column never holds a non-canonical default.
    it('canonicalizes a lowercase utc settings tz to the UTC sentinel in the column', async () => {
      const currentPartner = { id: 'partner-1', name: 'Acme MSP', settings: {} };
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            }),
            limit: vi.fn().mockResolvedValue([currentPartner])
          })
        })
      } as any);

      let capturedUpdateData: any;
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockImplementation((data: any) => {
          capturedUpdateData = data;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ ...currentPartner, settings: data.settings }])
            })
          };
        })
      } as any);

      const res = await app.request('/orgs/partners/partner-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { timezone: 'utc' } })
      });

      expect(res.status).toBe(200);
      expect(capturedUpdateData.timezone).toBe('UTC');
    });

    // #1318: updatePartnerSchema uses `settings: z.any()`, so an invalid IANA
    // settings.timezone is NOT caught by zod here (unlike /partners/me). It must
    // be rejected with a 400 rather than silently persisted into the JSONB while
    // the column write is skipped — that is the column<->settings desync this PR
    // exists to prevent.
    it('rejects an invalid IANA settings.timezone on a system-scope write (no JSONB desync)', async () => {
      const currentPartner = { id: 'partner-1', name: 'Acme MSP', settings: {} };
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            }),
            limit: vi.fn().mockResolvedValue([currentPartner])
          })
        })
      } as any);

      const setSpy = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([currentPartner])
        })
      });
      vi.mocked(db.update).mockReturnValue({ set: setSpy } as any);

      const res = await app.request('/orgs/partners/partner-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { timezone: 'Mars/Olympus_Mons' } })
      });

      expect(res.status).toBe(400);
      // The garbage tz must never reach the DB: no update should be issued.
      expect(setSpy).not.toHaveBeenCalled();
    });

    it('revokes tenant access (including the agent fleet) when a partner is suspended', async () => {
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'partner-1', name: 'P', status: 'suspended', settings: {} }])
          })
        })
      } as any);

      const res = await app.request('/orgs/partners/partner-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'suspended' })
      });

      expect(res.status).toBe(200);
      expect(revokePartnerTenantAccess).toHaveBeenCalledWith('partner-1');
      expect(restorePartnerTenantAccess).not.toHaveBeenCalled();
    });

    it('restores the agent fleet when a partner is reactivated to active', async () => {
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'partner-1', name: 'P', status: 'active', settings: {} }])
          })
        })
      } as any);

      const res = await app.request('/orgs/partners/partner-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' })
      });

      expect(res.status).toBe(200);
      expect(restorePartnerTenantAccess).toHaveBeenCalledWith('partner-1');
      expect(revokePartnerTenantAccess).not.toHaveBeenCalled();
    });

    it('does not sever the fleet on a transient active->pending transition (preserves enrollment keys)', async () => {
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'partner-1', name: 'P', status: 'pending', settings: {} }])
          })
        })
      } as any);

      const res = await app.request('/orgs/partners/partner-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'pending' })
      });

      expect(res.status).toBe(200);
      expect(revokePartnerTenantAccess).not.toHaveBeenCalled();
      expect(restorePartnerTenantAccess).not.toHaveBeenCalled();
    });

    it('rejects partner-scoped self-service users on broad partner update path', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });

      const res = await app.request('/orgs/partners/partner-123', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxOrganizations: 999 })
      });

      expect(res.status).toBe(403);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('should return 404 when partner not found', async () => {
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/orgs/partners/missing', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' })
      });

      expect(res.status).toBe(404);
    });

    describe('settings.security.ipAllowlist (system scope)', () => {
      function mockCurrentPartnerSelect(settings: Record<string, unknown>) {
        vi.mocked(db.select).mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([])
              }),
              limit: vi.fn().mockResolvedValue([{ id: 'partner-1', name: 'P', settings }])
            })
          })
        } as any);
      }

      function mockUpdateCapture() {
        let captured: any;
        vi.mocked(db.update).mockReturnValue({
          set: vi.fn().mockImplementation((data: any) => {
            captured = data;
            return {
              where: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([{ id: 'partner-1', name: 'P', settings: data.settings }])
              })
            };
          })
        } as any);
        return () => captured;
      }

      function patchPartner(body: unknown) {
        return app.request('/orgs/partners/partner-1', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
      }

      it('rejects a malformed ipAllowlist entry with 400 (same validation as /partners/me)', async () => {
        const res = await patchPartner({ settings: { security: { ipAllowlist: ['not-an-ip'] } } });
        expect(res.status).toBe(400);
        expect(db.update).not.toHaveBeenCalled();
      });

      it('accepts valid entries and clears the partner allowlist cache', async () => {
        mockCurrentPartnerSelect({});
        mockUpdateCapture();

        const res = await patchPartner({ settings: { security: { ipAllowlist: ['203.0.113.0/24', '2001:db8::/32'] } } });

        expect(res.status).toBe(200);
        expect(clearPartnerAllowlistCache).toHaveBeenCalledWith('partner-1');
      });

      it('does not clear the allowlist cache when settings are untouched', async () => {
        mockUpdateCapture();

        const res = await patchPartner({ name: 'Renamed' });

        expect(res.status).toBe(200);
        expect(clearPartnerAllowlistCache).not.toHaveBeenCalled();
      });

      it('preserves an active allowlist when the incoming security object omits the key', async () => {
        mockCurrentPartnerSelect({ security: { ipAllowlist: ['203.0.113.0/24'], requireMfa: true } });
        const getCaptured = mockUpdateCapture();

        const res = await patchPartner({ settings: { security: { requireMfa: false } } });

        expect(res.status).toBe(200);
        expect(getCaptured().settings.security.ipAllowlist).toEqual(['203.0.113.0/24']);
        expect(getCaptured().settings.security.requireMfa).toBe(false);
      });

      it('preserves an active allowlist when the incoming settings omit security entirely', async () => {
        mockCurrentPartnerSelect({ security: { ipAllowlist: ['203.0.113.0/24'] } });
        const getCaptured = mockUpdateCapture();

        const res = await patchPartner({ settings: { branding: { primaryColor: '#ff0000' } } });

        expect(res.status).toBe(200);
        expect(getCaptured().settings.security.ipAllowlist).toEqual(['203.0.113.0/24']);
        expect(getCaptured().settings.branding).toEqual({ primaryColor: '#ff0000' });
      });

      it('clears the allowlist when the caller sends an explicit empty array', async () => {
        mockCurrentPartnerSelect({ security: { ipAllowlist: ['203.0.113.0/24'] } });
        const getCaptured = mockUpdateCapture();

        const res = await patchPartner({ settings: { security: { ipAllowlist: [] } } });

        expect(res.status).toBe(200);
        expect(getCaptured().settings.security.ipAllowlist).toEqual([]);
        expect(clearPartnerAllowlistCache).toHaveBeenCalledWith('partner-1');
      });
    });

    // SR2-05: the system-scoped wholesale settings write is a THIRD write path
    // (alongside the org-settings write and PATCH /partners/me) that must fold
    // the legacy `security.allowedMfaMethods` alias into the canonical
    // `security.allowedMethods` — updatePartnerSchema's `settings: z.any()`
    // means nothing else strips or canonicalizes the alias key before it hits
    // the db.update(..).set(...) call.
    describe('settings.security.allowedMfaMethods alias (system scope)', () => {
      function mockCurrentPartnerSelect(settings: Record<string, unknown>) {
        vi.mocked(db.select).mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([])
              }),
              limit: vi.fn().mockResolvedValue([{ id: 'partner-1', name: 'P', settings }])
            })
          })
        } as any);
      }

      function mockUpdateCapture() {
        let captured: any;
        vi.mocked(db.update).mockReturnValue({
          set: vi.fn().mockImplementation((data: any) => {
            captured = data;
            return {
              where: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([{ id: 'partner-1', name: 'P', settings: data.settings }])
              })
            };
          })
        } as any);
        return () => captured;
      }

      it('folds the legacy security.allowedMfaMethods alias into allowedMethods and does not persist the alias', async () => {
        mockCurrentPartnerSelect({});
        const getCaptured = mockUpdateCapture();

        const res = await app.request('/orgs/partners/partner-1', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings: { security: { allowedMfaMethods: { sms: false } } } })
        });

        expect(res.status).toBe(200);
        expect(getCaptured().settings.security.allowedMethods.sms).toBe(false);
        expect(getCaptured().settings.security.allowedMfaMethods).toBeUndefined();
      });
    });

    // aiForOfficeEnabled — operator-only entitlement flag.
    // The field must flow through updatePartnerSchema → the db.update(..).set(...)
    // call unchanged. The partner-scope /partners/me route uses a separate
    // updatePartnerSettingsSchema that does NOT include aiForOfficeEnabled, so a
    // partner can never self-enable by posting to that endpoint.
    it('passes aiForOfficeEnabled: true through to the db update payload (system scope)', async () => {
      let capturedUpdateData: any;
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockImplementation((data: any) => {
          capturedUpdateData = data;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'partner-1', name: 'P', aiForOfficeEnabled: true }])
            })
          };
        })
      } as any);

      const res = await app.request('/orgs/partners/partner-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aiForOfficeEnabled: true })
      });

      expect(res.status).toBe(200);
      expect(capturedUpdateData.aiForOfficeEnabled).toBe(true);
    });

    it('passes aiForOfficeEnabled: false through to the db update payload (system scope)', async () => {
      let capturedUpdateData: any;
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockImplementation((data: any) => {
          capturedUpdateData = data;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'partner-1', name: 'P', aiForOfficeEnabled: false }])
            })
          };
        })
      } as any);

      const res = await app.request('/orgs/partners/partner-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aiForOfficeEnabled: false })
      });

      expect(res.status).toBe(200);
      expect(capturedUpdateData.aiForOfficeEnabled).toBe(false);
    });

    it('rejects a non-boolean aiForOfficeEnabled value with 400 (schema guard)', async () => {
      const setSpy = vi.fn();
      vi.mocked(db.update).mockReturnValue({ set: setSpy } as any);

      const res = await app.request('/orgs/partners/partner-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aiForOfficeEnabled: 'yes' })
      });

      expect(res.status).toBe(400);
      expect(setSpy).not.toHaveBeenCalled();
    });

    it('does not allow partner-scope user to set aiForOfficeEnabled via /partners/me (schema isolation)', async () => {
      // updatePartnerSettingsSchema (used by PATCH /partners/me) does NOT include
      // aiForOfficeEnabled. Any value sent in that field is stripped by Zod before
      // reaching the handler — the db write never sees the field.
      // This test exercises the schema-level boundary directly via the HTTP route.
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });

      let capturedUpdateData: any;
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            }),
            limit: vi.fn().mockResolvedValue([{ id: 'partner-123', name: 'P', settings: {} }])
          })
        })
      } as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockImplementation((data: any) => {
          capturedUpdateData = data;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'partner-123', name: 'P', settings: {} }])
            })
          };
        })
      } as any);

      const res = await app.request('/orgs/partners/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aiForOfficeEnabled: true })
      });

      // The route succeeds (200) because the unknown key is stripped, NOT because
      // it was accepted — Zod strips unrecognised keys from object schemas.
      // The key guarantee is that the db write does NOT carry aiForOfficeEnabled.
      expect(res.status).toBe(200);
      expect(capturedUpdateData?.aiForOfficeEnabled).toBeUndefined();
    });
  });

  describe('PATCH /orgs/partners/me — ticketing.inbound merge safety', () => {
    // Local copies of the :id-block helpers (plain functions, safe to duplicate).
    // mockCurrentPartnerSelect seeds the current partner row; mockUpdateCapture
    // captures the set(...) payload the route writes.
    function mockCurrentPartnerSelect(settings: Record<string, unknown>) {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            }),
            limit: vi.fn().mockResolvedValue([{ id: 'partner-123', name: 'P', settings }])
          })
        })
      } as any);
    }

    function mockUpdateCapture() {
      let captured: any;
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockImplementation((data: any) => {
          captured = data;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'partner-123', name: 'P', settings: data.settings }])
            })
          };
        })
      } as any);
      return () => captured;
    }

    function patchMe(body: unknown) {
      return app.request('/orgs/partners/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    it('preserves a pre-existing settings.ticketing.inbound.address override (blocker #1)', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      mockCurrentPartnerSelect({
        ticketing: { inbound: { enabled: false, address: 'support@tickets.acme.com', autoresponderEnabled: true } },
      });
      const getCaptured = mockUpdateCapture();

      // Card re-sends the COMPLETE ticketing.inbound including the override it read back.
      const res = await patchMe({ settings: { ticketing: { inbound: {
        enabled: true,
        defaultTriageOrgId: null,
        autoresponderEnabled: false,
        address: 'support@tickets.acme.com',
      } } } });

      expect(res.status).toBe(200);
      expect(getCaptured().settings.ticketing.inbound.address).toBe('support@tickets.acme.com');
      expect(getCaptured().settings.ticketing.inbound.enabled).toBe(true);
      expect(getCaptured().settings.ticketing.inbound.autoresponderEnabled).toBe(false);
    });

    it('preserves settings.security.ipAllowlist when only ticketing.inbound is patched (R8)', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      mockCurrentPartnerSelect({
        security: { ipAllowlist: ['203.0.113.0/24'], requireMfa: true },
        ticketing: { inbound: { enabled: false } },
      });
      const getCaptured = mockUpdateCapture();

      const res = await patchMe({ settings: { ticketing: { inbound: {
        enabled: true, defaultTriageOrgId: null, autoresponderEnabled: false,
      } } } });

      expect(res.status).toBe(200);
      expect(getCaptured().settings.security.ipAllowlist).toEqual(['203.0.113.0/24']);
      expect(getCaptured().settings.ticketing.inbound.enabled).toBe(true);
    });

    // defaultTriageOrgId write-time validation: the PATCH must reject (400) an id
    // that does not reference an org in the caller's partner, and accept one that
    // does. The first select() returns the current partner; the second is the org
    // ownership check (rows = match, [] = foreign/nonexistent).
    function mockPartnerThenOrg(settings: Record<string, unknown>, orgRows: unknown[]) {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: 'partner-123', name: 'P', settings }]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(orgRows),
            }),
          }),
        } as any);
    }

    it('rejects a defaultTriageOrgId that is not an org in the partner (400)', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      mockPartnerThenOrg({ ticketing: { inbound: { enabled: false } } }, []); // org check → no row
      const getCaptured = mockUpdateCapture();

      const res = await patchMe({ settings: { ticketing: { inbound: {
        enabled: true, defaultTriageOrgId: '11111111-1111-1111-1111-111111111111', autoresponderEnabled: true,
      } } } });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/defaultTriageOrgId must reference an organization/i);
      // The write must NOT have run.
      expect(getCaptured()).toBeUndefined();
    });

    it('accepts a defaultTriageOrgId that belongs to the partner (200)', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      const orgId = '22222222-2222-2222-2222-222222222222';
      mockPartnerThenOrg({ ticketing: { inbound: { enabled: false } } }, [{ id: orgId }]); // org check → match
      const getCaptured = mockUpdateCapture();

      const res = await patchMe({ settings: { ticketing: { inbound: {
        enabled: true, defaultTriageOrgId: orgId, autoresponderEnabled: true,
      } } } });

      expect(res.status).toBe(200);
      expect(getCaptured().settings.ticketing.inbound.defaultTriageOrgId).toBe(orgId);
    });

    it('skips the org check when defaultTriageOrgId is null (200)', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      // Only the current-partner select should be consumed; no org check select.
      mockCurrentPartnerSelect({ ticketing: { inbound: { enabled: false } } });
      const getCaptured = mockUpdateCapture();

      const res = await patchMe({ settings: { ticketing: { inbound: {
        enabled: true, defaultTriageOrgId: null, autoresponderEnabled: true,
      } } } });

      expect(res.status).toBe(200);
      expect(getCaptured().settings.ticketing.inbound.defaultTriageOrgId).toBeNull();
    });
  });

  describe('PATCH /orgs/partners/me — emailSignature', () => {
    // Local copies of the :id-block helpers (plain functions, safe to
    // duplicate — same pattern as the ticketing.inbound describe above).
    function mockCurrentPartnerSelect() {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            }),
            limit: vi.fn().mockResolvedValue([{ id: 'partner-123', name: 'P', settings: {}, emailSignature: null }])
          })
        })
      } as any);
    }

    function mockUpdateCapture() {
      let captured: any;
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockImplementation((data: any) => {
          captured = data;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'partner-123', name: 'P', settings: data.settings, emailSignature: data.emailSignature }])
            })
          };
        })
      } as any);
      return () => captured;
    }

    function patchMe(body: unknown) {
      return app.request('/orgs/partners/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    beforeEach(() => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
    });

    // body.emailSignature?.trim() || null (orgs.ts ~716): an all-whitespace
    // value trims to '', which is falsy, so it persists as null rather than
    // as a whitespace string.
    it('persists a whitespace-only signature as null', async () => {
      mockCurrentPartnerSelect();
      const getCaptured = mockUpdateCapture();

      const res = await patchMe({ emailSignature: '   \n\t  ' });

      expect(res.status).toBe(200);
      expect(getCaptured().emailSignature).toBeNull();
    });

    // updatePartnerSettingsSchema caps emailSignature at 2000 chars — a longer
    // value must 400 via zValidator before the handler runs any DB write.
    it('rejects a signature over 2000 chars with 400 and never writes to the DB', async () => {
      const setSpy = vi.fn();
      vi.mocked(db.update).mockReturnValue({ set: setSpy } as any);

      const res = await patchMe({ emailSignature: 'a'.repeat(2001) });

      expect(res.status).toBe(400);
      expect(setSpy).not.toHaveBeenCalled();
    });

    it('round-trips a valid signature into the update payload', async () => {
      mockCurrentPartnerSelect();
      const getCaptured = mockUpdateCapture();

      const res = await patchMe({ emailSignature: 'Best regards,\nAcme Support' });

      expect(res.status).toBe(200);
      expect(getCaptured().emailSignature).toBe('Best regards,\nAcme Support');
    });

    // body.emailSignature !== undefined gates the write (orgs.ts ~716) — an
    // omitted field must leave the column untouched rather than nulling it.
    it('leaves the signature untouched when the field is omitted', async () => {
      mockCurrentPartnerSelect();
      const getCaptured = mockUpdateCapture();

      const res = await patchMe({ name: 'Renamed Partner' });

      expect(res.status).toBe(200);
      expect(getCaptured()).not.toHaveProperty('emailSignature');
    });
  });

  describe('DELETE /orgs/partners/:id', () => {
    it('should delete a partner', async () => {
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'partner-1' }])
          })
        })
      } as any);

      const res = await app.request('/orgs/partners/partner-1', {
        method: 'DELETE'
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(revokePartnerTenantAccess).toHaveBeenCalledWith('partner-1');
    });

    it('should return 404 when partner not found', async () => {
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/orgs/partners/missing', {
        method: 'DELETE'
      });

      expect(res.status).toBe(404);
    });
  });

  describe('GET /orgs/organizations', () => {
    it('should return organizations with pagination', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 1 }])
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockReturnValue({
                  orderBy: vi.fn().mockResolvedValue([{ id: 'org-1' }])
                })
              })
            })
          })
        } as any);

      const res = await app.request('/orgs/organizations?page=1&limit=1');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.pagination.total).toBe(1);
    });

    // A partner with >50 orgs can't reach org #51+ via page/limit alone (#2280
    // review finding) — the panel needs server-side search to narrow within its
    // own tenant scope, not a client-side filter over one fetched page.
    it('narrows results by search within the caller scope, without loosening tenant scoping', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123', accessibleOrgIds: ['org-1', 'org-2'] });
      const whereSpy = vi.fn().mockResolvedValue([{ count: 1 }]);
      const orderBySpy = vi.fn().mockResolvedValue([{ id: 'org-1', name: 'Contoso Ltd' }]);
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({ where: whereSpy })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockReturnValue({ orderBy: orderBySpy })
              })
            })
          })
        } as any);

      const res = await app.request('/orgs/organizations?search=contoso');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.pagination.total).toBe(1);

      // The WHERE condition passed to both the count and data queries must still
      // include the tenant scoping (inArray over accessibleOrgIds) alongside the
      // search filter — search must never be able to widen scope.
      const countWhereArg = whereSpy.mock.calls[0]?.[0];
      expect(countWhereArg).toBeDefined();
      expect(JSON.stringify(countWhereArg)).toContain('org-1');
      expect(JSON.stringify(countWhereArg)).toContain('org-2');

      // The search term itself must also be ANDed into the WHERE — the
      // assertions above only prove scope survives, not that the ilike
      // condition was actually applied.
      expect(JSON.stringify(countWhereArg)).toContain('contoso');
    });

    it('returns 200 without error when a search param is supplied for an org-scope caller (moot but must not error)', async () => {
      setAuthContext({ scope: 'organization', orgId: 'org-123' });
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 1 }])
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockReturnValue({
                  orderBy: vi.fn().mockResolvedValue([
                    { id: 'org-123', name: 'Acme Corp', slug: 'acme', status: 'active' }
                  ])
                })
              })
            })
          })
        } as any);

      const res = await app.request('/orgs/organizations?search=anything');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });

    // #1245 residual: org-scope users (Org Admin/Technician/Viewer) lack the
    // organizations:read permission, but the tickets UI needs this route on
    // cold load just to render their own org's name. The route skips the
    // permission check for organization scope ONLY, and returns a projected
    // name-level row instead of the full org row.
    it('allows an org-scope user without organizations:read to read their own org', async () => {
      permissionMockState.granted = false;
      setAuthContext({ scope: 'organization', orgId: 'org-123' });
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 1 }])
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockReturnValue({
                  orderBy: vi.fn().mockResolvedValue([
                    { id: 'org-123', name: 'Acme Corp', slug: 'acme', status: 'active' }
                  ])
                })
              })
            })
          })
        } as any);

      const res = await app.request('/orgs/organizations');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe('org-123');
      expect(body.pagination.total).toBe(1);
    });

    it('projects the org-scope row to id/name/slug/status only (no privileged fields)', async () => {
      permissionMockState.granted = false;
      setAuthContext({ scope: 'organization', orgId: 'org-123' });
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 1 }])
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockReturnValue({
                  orderBy: vi.fn().mockResolvedValue([
                    { id: 'org-123', name: 'Acme Corp', slug: 'acme', status: 'active' }
                  ])
                })
              })
            })
          })
        } as any);

      const res = await app.request('/orgs/organizations');
      expect(res.status).toBe(200);

      // The data query (second db.select call, after the count) must pass an
      // explicit projection of exactly the safe fields — an unprojected
      // select() would return full rows incl. ssoConfig/billingContact.
      const dataSelectArg = vi.mocked(db.select).mock.calls[1]?.[0];
      expect(dataSelectArg).toBeDefined();
      expect(Object.keys(dataSelectArg as Record<string, unknown>).sort())
        .toEqual(['id', 'name', 'slug', 'status']);

      const row = (await res.json()).data[0];
      expect(row).not.toHaveProperty('ssoConfig');
      expect(row).not.toHaveProperty('billingContact');
      expect(row).not.toHaveProperty('settings');
      expect(row).not.toHaveProperty('maxDevices');
    });

    it('still requires organizations:read for partner scope', async () => {
      permissionMockState.granted = false;
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });

      const res = await app.request('/orgs/organizations');

      expect(res.status).toBe(403);
    });

    // The partner happy-path (permission granted → 200) is already covered by
    // the 'should return organizations with pagination' test above, which runs
    // with permissionMockState.granted = true (the beforeEach default) and
    // scope: 'partner'. Adding a duplicate would be noise.

    it('returns empty data when org-scope token has null orgId (null-guard path)', async () => {
      // Exercises the `if (!auth.orgId)` guard at ~line 715 of orgs.ts.
      // The org-scope branch short-circuits before any DB call and must return
      // 200 with an empty data array, not a 4xx or 5xx.
      permissionMockState.granted = false;
      setAuthContext({ scope: 'organization', orgId: null });

      const res = await app.request('/orgs/organizations');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.pagination.total).toBe(0);
    });
  });

  describe('POST /orgs/organizations', () => {
    it('should create an organization', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'org-1', name: 'Org' }])
        })
      } as any);

      const res = await app.request('/orgs/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Org',
          slug: 'org',
          contractStart: '2024-01-01',
          contractEnd: '2024-12-31'
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe('org-1');
    });

    it('should allow system scope create with explicit partnerId', async () => {
      setAuthContext({ scope: 'system', partnerId: null });
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'org-1', partnerId: 'partner-999', name: 'Org' }])
        })
      } as any);

      const res = await app.request('/orgs/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          partnerId: '99999999-9999-4999-8999-999999999999',
          name: 'Org',
          slug: 'org'
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe('org-1');
    });

    it('should require partnerId for system scope create', async () => {
      setAuthContext({ scope: 'system', partnerId: null });

      const res = await app.request('/orgs/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Org',
          slug: 'org-no-partner'
        })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('partnerId is required');
    });
  });

  describe('GET /orgs/organizations/:id', () => {
    it('should return an organization', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: 'org-1', name: 'Org' }])
          })
        })
      } as any);

      const res = await app.request('/orgs/organizations/org-1');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe('org-1');
    });

    it('should return 404 when organization not found', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/orgs/organizations/missing');

      expect(res.status).toBe(404);
    });

    it('should block partner access when org is outside selected scope', async () => {
      setAuthContext({
        scope: 'partner',
        partnerId: 'partner-123',
        accessibleOrgIds: ['org-1'],
        canAccessOrg: (orgId) => orgId === 'org-1'
      });

      const res = await app.request('/orgs/organizations/org-999');

      expect(res.status).toBe(404);
      expect(db.select).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /orgs/organizations/:id', () => {
    it('should reject empty updates', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      const res = await app.request('/orgs/organizations/org-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(400);
    });

    it('should update an organization', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'org-1', name: 'Updated' }])
          })
        })
      } as any);

      const res = await app.request('/orgs/organizations/org-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Updated');
    });

    it('revokes tenant access (including the agent fleet) when an org is suspended', async () => {
      setAuthContext({ scope: 'system', partnerId: null });
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'org-1', name: 'O', status: 'suspended' }])
          })
        })
      } as any);

      const res = await app.request('/orgs/organizations/org-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'suspended' })
      });

      expect(res.status).toBe(200);
      expect(revokeOrganizationTenantAccess).toHaveBeenCalledWith('org-1');
      expect(restoreOrganizationTenantAccess).not.toHaveBeenCalled();
    });

    it('restores the agent fleet when an org is reactivated to active', async () => {
      setAuthContext({ scope: 'system', partnerId: null });
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'org-1', name: 'O', status: 'active' }])
          })
        })
      } as any);

      const res = await app.request('/orgs/organizations/org-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' })
      });

      expect(res.status).toBe(200);
      expect(restoreOrganizationTenantAccess).toHaveBeenCalledWith('org-1');
      expect(revokeOrganizationTenantAccess).not.toHaveBeenCalled();
    });

    it('restores the agent fleet when an org is moved to trial', async () => {
      setAuthContext({ scope: 'system', partnerId: null });
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'org-1', name: 'O', status: 'trial' }])
          })
        })
      } as any);

      const res = await app.request('/orgs/organizations/org-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'trial' })
      });

      expect(res.status).toBe(200);
      expect(restoreOrganizationTenantAccess).toHaveBeenCalledWith('org-1');
      expect(revokeOrganizationTenantAccess).not.toHaveBeenCalled();
    });

    it('should return 404 when organization not found', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/orgs/organizations/missing', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' })
      });

      expect(res.status).toBe(404);
    });

    // issue #1963: the org write path feeds getOrgAgentUpdatePolicy, so a
    // malformed maintenance window must be rejected here (settings is z.any(),
    // so the handler validates this field explicitly) before it can reach the
    // heartbeat gate and silently fail open. Validation runs before any DB work.
    it('rejects a malformed agent-update maintenance window with 400', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      const res = await app.request('/orgs/organizations/org-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { defaults: { maintenanceWindow: '0000-2359' } } })
      });

      expect(res.status).toBe(400);
      expect(db.update).not.toHaveBeenCalled();
    });

    // Guards the accept branch of the same guard: a valid window must NOT be
    // rejected (catches a future inversion of the condition). db.select is
    // overridden so assertNotLocked('defaults', ...) resolves with no locks.
    it('accepts a valid agent-update maintenance window (200)', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ partnerId: 'partner-123', settings: {} }])
        })
      } as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'org-1', name: 'O' }])
          })
        })
      } as any);

      const res = await app.request('/orgs/organizations/org-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { defaults: { maintenanceWindow: 'Sun 02:00-04:00' } } })
      });

      expect(res.status).toBe(200);
      expect(db.update).toHaveBeenCalled();
    });

    // issue #2124: an agent/watchdog version pin must reference a registered
    // agent_versions row. The default db.select mock resolves [] (no matching
    // version), so an unknown pin is rejected before any DB write.
    it('rejects an unknown agent version pin with 400', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      // A clean select chain resolving [] (no matching registered version). Set
      // explicitly so a prior test's leaked db.select mock can't perturb this.
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);
      const res = await app.request('/orgs/organizations/org-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { defaults: { agentVersionPins: { agent: '9.9.9' } } } })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('9.9.9');
      expect(db.update).not.toHaveBeenCalled();
    });

    it('rejects a non-object agentVersionPins with 400 (z.any() settings blob has no structural guard)', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      // A string reaches the handler because org `settings` is z.any(); the
      // explicit validator must reject it rather than iterate a non-object.
      const res = await app.request('/orgs/organizations/org-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { defaults: { agentVersionPins: 'latest' } } })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/agentVersionPins must be an object/i);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('rejects when the SECOND component is unknown even though the first is valid', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      // agent '0.88.0' resolves (row found), watchdog '9.9.9' does not ([]) — the
      // loop must reject the second, not stop at the first valid one.
      const limit = vi.fn().mockResolvedValueOnce([{ id: 'ver-1' }]).mockResolvedValue([]);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit }) })
      } as any);

      const res = await app.request('/orgs/organizations/org-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { defaults: { agentVersionPins: { agent: '0.88.0', watchdog: '9.9.9' } } } })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('9.9.9');
      expect(body.error).toMatch(/watchdog/i);
      expect(db.update).not.toHaveBeenCalled();
    });

    // A single select mock that serves BOTH seams the accept path hits:
    //  - validateAgentVersionPins uses `.where().limit()` → `pinRows`
    //  - assertNotLocked uses `.where().then(rows => rows[0])` → an org row that
    //    carries partnerId + settings (one row satisfies its org & partner reads)
    function primeAcceptSelect(pinRows: unknown[], partnerSettings: Record<string, unknown> = {}) {
      const whereRet: any = Promise.resolve([{ partnerId: 'partner-123', settings: partnerSettings }]);
      whereRet.limit = vi.fn().mockResolvedValue(pinRows);
      whereRet.orderBy = vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue(whereRet) })
      } as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'org-1', name: 'O' }])
          })
        })
      } as any);
    }

    it('accepts a registered agent version pin (200)', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      primeAcceptSelect([{ id: 'ver-1' }]); // agentVersions lookup finds the pin

      const res = await app.request('/orgs/organizations/org-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { defaults: { agentVersionPins: { agent: '0.88.0' } } } })
      });

      expect(res.status).toBe(200);
      expect(db.update).toHaveBeenCalled();
    });

    it('accepts the "latest" sentinel pin without a registry lookup (200)', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      // pinRows is irrelevant: 'latest' normalizes to null so no lookup happens.
      primeAcceptSelect([]);

      const res = await app.request('/orgs/organizations/org-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { defaults: { agentVersionPins: { agent: 'latest', watchdog: 'latest' } } } })
      });

      expect(res.status).toBe(200);
      expect(db.update).toHaveBeenCalled();
    });

    it('lets an org override a partner-set pin — agentVersionPins is exempt from assertNotLocked (200)', async () => {
      // Partner has pinned agent for all its orgs. Under a lock model this org
      // PATCH would 403; under inherit-with-override the org may still pin its
      // OWN version, so assertNotLocked must NOT block agentVersionPins.
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      primeAcceptSelect([{ id: 'ver-1' }], { defaults: { agentVersionPins: { agent: '0.87.0' } } });

      const res = await app.request('/orgs/organizations/org-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { defaults: { agentVersionPins: { agent: '0.88.0' } } } })
      });

      expect(res.status).toBe(200);
      expect(db.update).toHaveBeenCalled();
    });

    // SR2-05: `security.allowedMfaMethods` is a legacy input alias — it must be
    // folded into the canonical `security.allowedMethods` before the write and
    // never persisted as a second key (the dead spelling the SMS-enable reader
    // used to consult, silently no-opping the restriction).
    it('folds the legacy security.allowedMfaMethods alias into allowedMethods and does not persist the alias', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      // assertNotLocked('security', ['allowedMethods']) needs an org row (for
      // partnerId) and a partner row (for its settings) — an empty partner
      // settings object means nothing is locked.
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(Promise.resolve([{ partnerId: 'partner-123', settings: {} }]))
        })
      } as any);

      let capturedUpdateData: any;
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockImplementation((data: any) => {
          capturedUpdateData = data;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'org-1', name: 'O' }])
            })
          };
        })
      } as any);

      const res = await app.request('/orgs/organizations/org-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { security: { allowedMfaMethods: { sms: false } } } })
      });

      expect(res.status).toBe(200);
      expect(capturedUpdateData.settings.security.allowedMethods.sms).toBe(false);
      expect(capturedUpdateData.settings.security.allowedMfaMethods).toBeUndefined();
    });

    it('should allow system scope updates without partnerId context', async () => {
      setAuthContext({ scope: 'system', partnerId: null });
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'org-1', name: 'Updated by system' }])
          })
        })
      } as any);

      const res = await app.request('/orgs/organizations/org-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated by system' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Updated by system');
    });
  });

  describe('DELETE /orgs/organizations/:id', () => {
    it('should delete an organization', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'org-1' }])
          })
        })
      } as any);

      const res = await app.request('/orgs/organizations/org-1', {
        method: 'DELETE'
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(revokeOrganizationTenantAccess).toHaveBeenCalledWith('org-1');
    });

    it('should return 404 when organization not found', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/orgs/organizations/missing', {
        method: 'DELETE'
      });

      expect(res.status).toBe(404);
    });

    it('should allow system scope delete without partnerId context', async () => {
      setAuthContext({ scope: 'system', partnerId: null });
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'org-1' }])
          })
        })
      } as any);

      const res = await app.request('/orgs/organizations/org-1', {
        method: 'DELETE'
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });

  // Mocks the grouped per-site device-count query the GET /orgs/sites handler
  // runs after fetching the site page (issue #1790). The handler shapes the
  // call as db.select({...}).from(devices).where(...).groupBy(...).
  const mockSiteDeviceCounts = (rows: Array<{ siteId: string; count: number }>) =>
    ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          groupBy: vi.fn().mockResolvedValue(rows)
        })
      })
    }) as any;

  describe('GET /orgs/sites', () => {
    it('should return sites with pagination', async () => {
      setAuthContext({ scope: 'organization', orgId: '11111111-1111-1111-1111-111111111111' });
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 1 }])
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockReturnValue({
                  orderBy: vi.fn().mockResolvedValue([{ id: 'site-1' }])
                })
              })
            })
          })
        } as any)
        // Per-site device-count query (issue #1790): grouped count over devices.
        .mockReturnValueOnce(mockSiteDeviceCounts([{ siteId: 'site-1', count: 4 }]));

      const res = await app.request('/orgs/sites?orgId=11111111-1111-1111-1111-111111111111');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].deviceCount).toBe(4);
      expect(body.pagination.total).toBe(1);
    });

    it('should allow partner scope access for matching org', async () => {
      setAuthContext({
        scope: 'partner',
        partnerId: 'partner-123',
        accessibleOrgIds: ['11111111-1111-1111-1111-111111111111']
      });
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 1 }])
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockReturnValue({
                  orderBy: vi.fn().mockResolvedValue([{ id: 'site-1' }])
                })
              })
            })
          })
        } as any)
        .mockReturnValueOnce(mockSiteDeviceCounts([{ siteId: 'site-1', count: 2 }]));

      const res = await app.request('/orgs/sites?orgId=11111111-1111-1111-1111-111111111111');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].deviceCount).toBe(2);
    });

    it('should deny access when org scope does not match', async () => {
      setAuthContext({ scope: 'organization', orgId: '22222222-2222-2222-2222-222222222222' });

      const res = await app.request('/orgs/sites?orgId=11111111-1111-1111-1111-111111111111');

      expect(res.status).toBe(403);
    });

    it('should return empty list for partner with no accessible orgs', async () => {
      setAuthContext({
        scope: 'partner',
        partnerId: 'partner-123',
        accessibleOrgIds: []
      });

      const res = await app.request('/orgs/sites');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.pagination.total).toBe(0);
      expect(db.select).not.toHaveBeenCalled();
    });
  });

  describe('POST /orgs/sites', () => {
    it('should create a site', async () => {
      setAuthContext({ scope: 'organization', orgId: '11111111-1111-1111-1111-111111111111' });
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'site-1', name: 'HQ' }])
        })
      } as any);

      const res = await app.request('/orgs/sites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgId: '11111111-1111-1111-1111-111111111111',
          name: 'HQ',
          timezone: 'UTC'
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe('site-1');
    });

    it('should deny access when org scope does not match', async () => {
      setAuthContext({ scope: 'organization', orgId: '22222222-2222-2222-2222-222222222222' });

      const res = await app.request('/orgs/sites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgId: '11111111-1111-1111-1111-111111111111',
          name: 'HQ'
        })
      });

      expect(res.status).toBe(403);
    });

    it('accepts a name-only POST (no address, no contact, no timezone)', async () => {
      setAuthContext({ scope: 'organization', orgId: '11111111-1111-1111-1111-111111111111' });
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'site-2', name: 'Remote-LA' }])
        })
      } as any);

      const res = await app.request('/orgs/sites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgId: '11111111-1111-1111-1111-111111111111',
          name: 'Remote-LA'
        })
      });

      expect(res.status).toBe(201);
    });

    it('rejects an invalid IANA timezone', async () => {
      setAuthContext({ scope: 'organization', orgId: '11111111-1111-1111-1111-111111111111' });

      const res = await app.request('/orgs/sites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgId: '11111111-1111-1111-1111-111111111111',
          name: 'Mars-HQ',
          timezone: 'Mars/Olympus_Mons'
        })
      });

      expect(res.status).toBe(400);
    });

    it('rejects an invalid contact email format', async () => {
      setAuthContext({ scope: 'organization', orgId: '11111111-1111-1111-1111-111111111111' });

      const res = await app.request('/orgs/sites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgId: '11111111-1111-1111-1111-111111111111',
          name: 'HQ',
          contact: { email: 'not-an-email' }
        })
      });

      expect(res.status).toBe(400);
    });

    it('accepts a phone-only contact (no email)', async () => {
      setAuthContext({ scope: 'organization', orgId: '11111111-1111-1111-1111-111111111111' });
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'site-3', name: 'Site C' }])
        })
      } as any);

      const res = await app.request('/orgs/sites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgId: '11111111-1111-1111-1111-111111111111',
          name: 'Site C',
          contact: { phone: '555-1212' }
        })
      });

      expect(res.status).toBe(201);
    });

    it('accepts a contact with empty-string email (form sends empty for absent)', async () => {
      setAuthContext({ scope: 'organization', orgId: '11111111-1111-1111-1111-111111111111' });
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'site-4', name: 'Site D' }])
        })
      } as any);

      const res = await app.request('/orgs/sites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgId: '11111111-1111-1111-1111-111111111111',
          name: 'Site D',
          contact: { name: 'Ops', email: '', phone: '+1 555 1212' }
        })
      });

      expect(res.status).toBe(201);
    });
  });

  describe('GET /orgs/sites/:id', () => {
    it('should return a site', async () => {
      setAuthContext({ scope: 'organization', orgId: '11111111-1111-1111-1111-111111111111' });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'site-1',
              name: 'HQ',
              orgId: '11111111-1111-1111-1111-111111111111'
            }])
          })
        })
      } as any);

      const res = await app.request('/orgs/sites/site-1');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe('site-1');
    });

    it('should return 404 when site not found', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/orgs/sites/missing');

      expect(res.status).toBe(404);
    });

    it('should return 403 when access is denied', async () => {
      setAuthContext({ scope: 'organization', orgId: '22222222-2222-2222-2222-222222222222' });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'site-1',
              orgId: '11111111-1111-1111-1111-111111111111'
            }])
          })
        })
      } as any);

      const res = await app.request('/orgs/sites/site-1');

      expect(res.status).toBe(403);
    });
  });

  describe('PATCH /orgs/sites/:id', () => {
    it('should reject empty updates', async () => {
      const res = await app.request('/orgs/sites/site-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(400);
    });

    it('should return 404 when site not found', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/orgs/sites/missing', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' })
      });

      expect(res.status).toBe(404);
    });

    it('should return 403 when access is denied', async () => {
      setAuthContext({ scope: 'organization', orgId: '22222222-2222-2222-2222-222222222222' });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'site-1',
              orgId: '11111111-1111-1111-1111-111111111111'
            }])
          })
        })
      } as any);

      const res = await app.request('/orgs/sites/site-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' })
      });

      expect(res.status).toBe(403);
    });

    it('should update a site', async () => {
      setAuthContext({ scope: 'organization', orgId: '11111111-1111-1111-1111-111111111111' });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'site-1',
              orgId: '11111111-1111-1111-1111-111111111111'
            }])
          })
        })
      } as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'site-1', name: 'Updated' }])
          })
        })
      } as any);

      const res = await app.request('/orgs/sites/site-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Updated');
    });

    it('rejects an invalid IANA timezone on update', async () => {
      const res = await app.request('/orgs/sites/site-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timezone: 'Mars/Olympus_Mons' })
      });

      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /orgs/sites/:id', () => {
    it('should return 404 when site not found', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/orgs/sites/missing', {
        method: 'DELETE'
      });

      expect(res.status).toBe(404);
    });

    it('should return 403 when access is denied', async () => {
      setAuthContext({ scope: 'organization', orgId: '22222222-2222-2222-2222-222222222222' });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'site-1',
              orgId: '11111111-1111-1111-1111-111111111111'
            }])
          })
        })
      } as any);

      const res = await app.request('/orgs/sites/site-1', {
        method: 'DELETE'
      });

      expect(res.status).toBe(403);
    });

    it('should delete a site', async () => {
      setAuthContext({ scope: 'organization', orgId: '11111111-1111-1111-1111-111111111111' });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'site-1',
              orgId: '11111111-1111-1111-1111-111111111111'
            }])
          })
        })
      } as any);

      const res = await app.request('/orgs/sites/site-1', {
        method: 'DELETE'
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });

  // Per-user site confinement (allowedSiteIds). A site-confined org user must
  // not be able to read, rename, or delete sibling sites in the same org, nor
  // enumerate them. The org-axis ensureOrgAccess check passes for all sites in
  // the user's org, so the site-axis check is the only defense (RLS is
  // org-axis only for `sites`). F1 — broken access control, intra-org.
  describe('site-scope confinement (allowedSiteIds)', () => {
    const ORG = '11111111-1111-1111-1111-111111111111';
    // site-y belongs to the same org as the user but is NOT in allowedSiteIds.
    const siblingSiteRow = (id: string) => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id, name: 'Sibling', orgId: ORG }])
        })
      })
    });

    describe('GET /orgs/sites/:id', () => {
      it('denies a site-confined user reading a sibling site (site-y) with 403', async () => {
        setAuthContext({ scope: 'organization', orgId: ORG, allowedSiteIds: ['site-x'] });
        vi.mocked(db.select).mockReturnValue(siblingSiteRow('site-y') as any);

        const res = await app.request('/orgs/sites/site-y');

        expect(res.status).toBe(403);
      });

      it('allows a site-confined user reading their own site (site-x)', async () => {
        setAuthContext({ scope: 'organization', orgId: ORG, allowedSiteIds: ['site-x'] });
        vi.mocked(db.select).mockReturnValue(siblingSiteRow('site-x') as any);

        const res = await app.request('/orgs/sites/site-x');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.id).toBe('site-x');
      });

      it('allows an unconfined user (allowedSiteIds undefined) to read any sibling site', async () => {
        setAuthContext({ scope: 'organization', orgId: ORG });
        vi.mocked(db.select).mockReturnValue(siblingSiteRow('site-y') as any);

        const res = await app.request('/orgs/sites/site-y');

        expect(res.status).toBe(200);
      });
    });

    describe('PATCH /orgs/sites/:id', () => {
      it('denies a site-confined user renaming a sibling site (site-y) with 403', async () => {
        setAuthContext({ scope: 'organization', orgId: ORG, allowedSiteIds: ['site-x'] });
        vi.mocked(db.select).mockReturnValue(siblingSiteRow('site-y') as any);
        const updateSpy = vi.mocked(db.update).mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'site-y', name: 'Pwned' }])
            })
          })
        } as any);

        const res = await app.request('/orgs/sites/site-y', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Pwned' })
        });

        expect(res.status).toBe(403);
        expect(updateSpy).not.toHaveBeenCalled();
      });

      it('allows a site-confined user renaming their own site (site-x)', async () => {
        setAuthContext({ scope: 'organization', orgId: ORG, allowedSiteIds: ['site-x'] });
        vi.mocked(db.select).mockReturnValue(siblingSiteRow('site-x') as any);
        vi.mocked(db.update).mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'site-x', name: 'Renamed' }])
            })
          })
        } as any);

        const res = await app.request('/orgs/sites/site-x', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Renamed' })
        });

        expect(res.status).toBe(200);
      });

      it('allows an unconfined user to rename any sibling site', async () => {
        setAuthContext({ scope: 'organization', orgId: ORG });
        vi.mocked(db.select).mockReturnValue(siblingSiteRow('site-y') as any);
        vi.mocked(db.update).mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'site-y', name: 'Renamed' }])
            })
          })
        } as any);

        const res = await app.request('/orgs/sites/site-y', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Renamed' })
        });

        expect(res.status).toBe(200);
      });
    });

    describe('DELETE /orgs/sites/:id', () => {
      it('denies a site-confined user hard-deleting a sibling site (site-y) with 403', async () => {
        setAuthContext({ scope: 'organization', orgId: ORG, allowedSiteIds: ['site-x'] });
        vi.mocked(db.select).mockReturnValue(siblingSiteRow('site-y') as any);
        const deleteSpy = vi.mocked(db.delete).mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        } as any);

        const res = await app.request('/orgs/sites/site-y', { method: 'DELETE' });

        expect(res.status).toBe(403);
        expect(deleteSpy).not.toHaveBeenCalled();
      });

      it('allows a site-confined user deleting their own site (site-x)', async () => {
        setAuthContext({ scope: 'organization', orgId: ORG, allowedSiteIds: ['site-x'] });
        vi.mocked(db.select).mockReturnValue(siblingSiteRow('site-x') as any);
        vi.mocked(db.delete).mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        } as any);

        const res = await app.request('/orgs/sites/site-x', { method: 'DELETE' });

        expect(res.status).toBe(200);
      });

      it('allows an unconfined user to delete any sibling site', async () => {
        setAuthContext({ scope: 'organization', orgId: ORG });
        vi.mocked(db.select).mockReturnValue(siblingSiteRow('site-y') as any);
        vi.mocked(db.delete).mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        } as any);

        const res = await app.request('/orgs/sites/site-y', { method: 'DELETE' });

        expect(res.status).toBe(200);
      });
    });

    describe('GET /orgs/sites (list)', () => {
      it('returns an empty page without querying when allowedSiteIds is empty', async () => {
        setAuthContext({ scope: 'organization', orgId: ORG, allowedSiteIds: [] });

        const res = await app.request(`/orgs/sites?orgId=${ORG}`);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data).toEqual([]);
        expect(body.pagination.total).toBe(0);
        expect(db.select).not.toHaveBeenCalled();
      });

      it('restricts the list to allowed sites for a confined user (only site-x)', async () => {
        setAuthContext({ scope: 'organization', orgId: ORG, allowedSiteIds: ['site-x'] });
        // The handler must intersect the org filter with inArray(sites.id,
        // allowedSiteIds); the mocked DB echoes back only what an
        // allowlist-filtered query would: site-x, never site-y.
        vi.mocked(db.select)
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ count: 1 }])
            })
          } as any)
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockReturnValue({
                    orderBy: vi.fn().mockResolvedValue([{ id: 'site-x' }])
                  })
                })
              })
            })
          } as any)
          .mockReturnValueOnce(mockSiteDeviceCounts([{ siteId: 'site-x', count: 3 }]));

        const res = await app.request(`/orgs/sites?orgId=${ORG}`);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data).toEqual([{ id: 'site-x', deviceCount: 3 }]);
        expect(body.data.map((s: { id: string }) => s.id)).not.toContain('site-y');
        // Meaningful assertion: the handler must have intersected the query with
        // inArray(sites.id, allowedSiteIds). This fails if the intersection in
        // orgs.ts is removed (mocked DB would echo site-x regardless otherwise).
        expect(inArray).toHaveBeenCalledWith(sites.id, ['site-x']);
      });

      it('does not restrict the list for an unconfined user (allowedSiteIds undefined)', async () => {
        setAuthContext({ scope: 'organization', orgId: ORG });
        vi.mocked(db.select)
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ count: 2 }])
            })
          } as any)
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockReturnValue({
                    orderBy: vi.fn().mockResolvedValue([{ id: 'site-x' }, { id: 'site-y' }])
                  })
                })
              })
            })
          } as any)
          .mockReturnValueOnce(mockSiteDeviceCounts([{ siteId: 'site-x', count: 1 }]));

        const res = await app.request(`/orgs/sites?orgId=${ORG}`);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data).toHaveLength(2);
        // site-x has a device count; site-y (no devices) defaults to 0.
        expect(body.data.find((s: { id: string }) => s.id === 'site-x').deviceCount).toBe(1);
        expect(body.data.find((s: { id: string }) => s.id === 'site-y').deviceCount).toBe(0);
      });

      it('skips the device-count query when the site page is empty (#1790 guard)', async () => {
        // The org is accessible and the count/page queries run, but the page
        // comes back empty (e.g. an org with no sites). The handler's
        // `siteIds.length > 0` guard must skip the device-count query rather
        // than issue a malformed `site_id IN ()`. Only TWO db.select calls
        // (count + page) should happen — never a third.
        setAuthContext({ scope: 'organization', orgId: ORG });
        vi.mocked(db.select)
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ count: 0 }])
            })
          } as any)
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockReturnValue({
                    orderBy: vi.fn().mockResolvedValue([])
                  })
                })
              })
            })
          } as any);

        const res = await app.request(`/orgs/sites?orgId=${ORG}`);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data).toEqual([]);
        // Exactly two selects: the device-count query was skipped for the empty page.
        expect(db.select).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('GET /orgs/partners/me', () => {
    it('returns partner details for a partner-scoped user', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: 'partner-123', name: 'Acme MSP', settings: {} }])
          })
        })
      } as any);

      const res = await app.request('/orgs/partners/me');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe('partner-123');
      expect(body.name).toBe('Acme MSP');
    });

    it('returns 404 when the partner record is not found (soft-deleted)', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/orgs/partners/me');

      expect(res.status).toBe(404);
    });
  });

  describe('GET /partners/me/ip-allowlist/status', () => {
    async function getStatus() {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      return app.request('/orgs/partners/me/ip-allowlist/status');
    }

    it('reports the current trusted IP and active=false when not enforced', async () => {
      vi.mocked(getTrustedClientIpOrUndefined).mockReturnValue('203.0.113.10');
      vi.mocked(readPartnerAllowlist).mockResolvedValueOnce([]);

      const res = await getStatus();

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        currentIp: '203.0.113.10',
        proxyTrustOk: true,
        enforced: false,
        active: false,
      });
    });

    it('reports active=true when an allowlist is set and the IP is trusted', async () => {
      vi.mocked(getTrustedClientIpOrUndefined).mockReturnValue('203.0.113.10');
      vi.mocked(readPartnerAllowlist).mockResolvedValueOnce(['203.0.113.0/24']);

      const res = await getStatus();

      expect(await res.json()).toMatchObject({ enforced: true, proxyTrustOk: true, active: true });
    });
  });

  describe('PATCH /orgs/partners/me', () => {
['pt-BR', 'es-419', 'fr-FR', 'fr-CA', 'de-DE', 'it-IT'] as const)(
      'accepts %s as the partner default language',
      async (language) => {
        setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
        const currentPartner = { id: 'partner-123', name: 'Acme MSP', settings: {} };
        vi.mocked(db.select)
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([currentPartner]),
              }),
            }),
          } as any)
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([{ id: 'org-1' }]),
                }),
              }),
            }),
          } as any);
        vi.mocked(db.update).mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{
                ...currentPartner,
                settings: { language },
              }]),
            }),
          }),
        } as any);

        const res = await app.request('/orgs/partners/me', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings: { language } }),
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ settings: { language } });
      },
    );

    it('rejects an unsupported partner default language', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });

      const res = await app.request('/orgs/partners/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { language: 'fr' } }),
      });

      expect(res.status).toBe(400);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('rejects a logoUrl exceeding 400 KB', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });

      const res = await app.request('/orgs/partners/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settings: {
            branding: {
              logoUrl: 'data:image/png;base64,' + 'A'.repeat(400_001)
            }
          }
        })
      });

      expect(res.status).toBe(400);
    });

    // issue #2124: a partner-locked pin can freeze every child org's fleet, so an
    // unknown version is rejected at save time (before the partner row is even
    // fetched). Default db.select resolves [] → no matching agent_versions row.
    it('rejects an unknown watchdog version pin on the partner defaults with 400', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      const res = await app.request('/orgs/partners/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settings: { defaults: { agentVersionPins: { watchdog: '9.9.9' } } }
        })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('9.9.9');
      expect(db.update).not.toHaveBeenCalled();
    });

    it('accepts a valid branding update within size limits', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      const currentPartner = { id: 'partner-123', name: 'Acme MSP', settings: {} };
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            }),
            limit: vi.fn().mockResolvedValue([currentPartner])
          })
        })
      } as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              ...currentPartner,
              settings: { branding: { primaryColor: '#ff0000' } }
            }])
          })
        })
      } as any);

      const res = await app.request('/orgs/partners/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settings: { branding: { primaryColor: '#ff0000' } }
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.settings.branding.primaryColor).toBe('#ff0000');
    });

    it('returns 404 when the partner record is not found during update', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/orgs/partners/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Name' })
      });

      expect(res.status).toBe(404);
    });

    it('returns 404 when the partner is deleted between pre-flight check and update', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      const currentPartner = { id: 'partner-123', name: 'Acme MSP', settings: {} };
      // Pre-flight select succeeds, but the update returns no rows (race-deleted)
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([currentPartner])
          })
        })
      } as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/orgs/partners/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Name' })
      });

      expect(res.status).toBe(404);
    });

    describe('PATCH /partners/me — inboundLocalPart', () => {
      function mockCurrentPartnerSelect() {
        const currentPartner = { id: 'partner-123', name: 'Acme MSP', settings: {} };
        vi.mocked(db.select)
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([currentPartner])
              })
            })
          } as any)
          .mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([])
                }),
                limit: vi.fn().mockResolvedValue([])
              })
            })
          } as any);
        return currentPartner;
      }

      async function patchPartnerMe(body: unknown) {
        setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
        return app.request('/orgs/partners/me', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
      }

      it('persists a valid inboundLocalPart', async () => {
        const currentPartner = mockCurrentPartnerSelect();
        let capturedUpdateData: any;
        vi.mocked(db.update).mockReturnValue({
          set: vi.fn().mockImplementation((data: any) => {
            capturedUpdateData = data;
            return {
              where: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([{ ...currentPartner, inboundLocalPart: data.inboundLocalPart }])
              })
            };
          })
        } as any);

        const res = await patchPartnerMe({ inboundLocalPart: 'support' });

        expect(res.status).toBe(200);
        expect(capturedUpdateData.inboundLocalPart).toBe('support');
      });

      it('rejects an invalid inboundLocalPart format with 422', async () => {
        const res = await patchPartnerMe({ inboundLocalPart: 'Bad Address!' });

        expect(res.status).toBe(422);
      });

      it('rejects a reserved inboundLocalPart with 422', async () => {
        mockCurrentPartnerSelect();

        const res = await patchPartnerMe({ inboundLocalPart: 'postmaster' });

        expect(res.status).toBe(422);
      });

      it('rejects an inboundLocalPart collision with another partner with 409', async () => {
        const currentPartner = { id: 'partner-123', name: 'Acme MSP', settings: {} };
        vi.mocked(db.select)
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([currentPartner])
              })
            })
          } as any)
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ id: 'other-partner' }])
              })
            })
          } as any);

        const res = await patchPartnerMe({ inboundLocalPart: 'taken' });

        expect(res.status).toBe(409);
      });

      it('clears inboundLocalPart when null is sent', async () => {
        const currentPartner = mockCurrentPartnerSelect();
        let capturedUpdateData: any;
        vi.mocked(db.update).mockReturnValue({
          set: vi.fn().mockImplementation((data: any) => {
            capturedUpdateData = data;
            return {
              where: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([{ ...currentPartner, inboundLocalPart: data.inboundLocalPart }])
              })
            };
          })
        } as any);

        const res = await patchPartnerMe({ inboundLocalPart: null });

        expect(res.status).toBe(200);
        expect(capturedUpdateData.inboundLocalPart).toBeNull();
      });
    });

    it('preserves existing settings keys when applying a partial update', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      const existingSettings = { branding: { primaryColor: '#aabbcc' }, notifications: { emailEnabled: true } };
      const currentPartner = { id: 'partner-123', name: 'Acme MSP', settings: existingSettings };
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            }),
            limit: vi.fn().mockResolvedValue([currentPartner])
          })
        })
      } as any);

      let capturedUpdateData: any;
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockImplementation((data: any) => {
          capturedUpdateData = data;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{
                ...currentPartner,
                settings: data.settings
              }])
            })
          };
        })
      } as any);

      await app.request('/orgs/partners/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { branding: { primaryColor: '#ff0000' } } })
      });

      // Both the new branding key and the pre-existing notifications key must be present
      expect(capturedUpdateData.settings).toMatchObject({
        branding: { primaryColor: '#ff0000' },
        notifications: { emailEnabled: true }
      });
    });

    it('replaces the entire branding sub-object when updating settings (shallow merge)', async () => {
      // settings is merged at the top level only — updating settings.branding replaces
      // the whole branding object; keys within branding that are not in the request body
      // are not preserved. This is intentional shallow-merge behavior.
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });

      const existingSettings = {
        branding: { primaryColor: '#000000', logoUrl: 'https://old.example.com/logo.png' },
        notifications: { emailEnabled: true }
      };
      const currentPartner = { id: 'partner-123', name: 'Test Partner', settings: existingSettings };
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            }),
            limit: vi.fn().mockResolvedValue([currentPartner])
          })
        })
      } as any);

      let capturedUpdateData: any;
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockImplementation((data: any) => {
          capturedUpdateData = data;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ ...currentPartner, settings: data.settings }])
            })
          };
        })
      } as any);

      await app.request('/orgs/partners/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { branding: { primaryColor: '#ff0000' } } })
      });

      // branding is replaced wholesale — logoUrl from the existing record is NOT preserved
      expect(capturedUpdateData.settings.branding).toEqual({ primaryColor: '#ff0000' });
      // top-level settings keys not in the request body ARE preserved (top-level merge only)
      expect(capturedUpdateData.settings.notifications).toEqual({ emailEnabled: true });
    });

    // #1318: a valid tz in settings is mirrored to the first-class
    // `partners.timezone` column so resolveEffectiveTimezone can read it.
    it('mirrors settings.timezone into the partners.timezone column', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      const currentPartner = { id: 'partner-123', name: 'Acme MSP', settings: {} };
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            }),
            limit: vi.fn().mockResolvedValue([currentPartner])
          })
        })
      } as any);

      let capturedUpdateData: any;
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockImplementation((data: any) => {
          capturedUpdateData = data;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ ...currentPartner, settings: data.settings }])
            })
          };
        })
      } as any);

      const res = await app.request('/orgs/partners/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { timezone: 'America/New_York' } })
      });

      expect(res.status).toBe(200);
      expect(capturedUpdateData.timezone).toBe('America/New_York');
      expect(capturedUpdateData.settings.timezone).toBe('America/New_York');
    });

    it('rejects an invalid IANA timezone in partner settings', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });

      const res = await app.request('/orgs/partners/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { timezone: 'Mars/Olympus_Mons' } })
      });

      expect(res.status).toBe(400);
    });

    it('accepts a fully populated address in settings', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      const currentPartner = { id: 'partner-123', name: 'Acme MSP', settings: {} };
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            }),
            limit: vi.fn().mockResolvedValue([currentPartner])
          })
        })
      } as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              ...currentPartner,
              settings: {
                address: {
                  street1: '123 Main St',
                  street2: 'Suite 400',
                  city: 'Denver',
                  region: 'CO',
                  postalCode: '80202',
                  country: 'US',
                }
              }
            }])
          })
        })
      } as any);

      const res = await app.request('/orgs/partners/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settings: {
            address: {
              street1: '123 Main St',
              street2: 'Suite 400',
              city: 'Denver',
              region: 'CO',
              postalCode: '80202',
              country: 'US',
            }
          }
        })
      });

      expect(res.status).toBe(200);
    });

    it('rejects an address country code longer than 2 characters', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });

      const res = await app.request('/orgs/partners/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settings: {
            address: { country: 'USA' }
          }
        })
      });

      expect(res.status).toBe(400);
    });

    it('accepts an empty-string address country', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      const currentPartner = { id: 'partner-123', name: 'Acme MSP', settings: {} };
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            }),
            limit: vi.fn().mockResolvedValue([currentPartner])
          })
        })
      } as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ ...currentPartner, settings: { address: { country: '' } } }])
          })
        })
      } as any);

      const res = await app.request('/orgs/partners/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { address: { country: '' } } })
      });

      expect(res.status).toBe(200);
    });

    it('rejects an address street1 longer than 255 characters', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });

      const res = await app.request('/orgs/partners/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settings: { address: { street1: 'a'.repeat(256) } }
        })
      });

      expect(res.status).toBe(400);
    });

    describe('PATCH /partners/me — ipAllowlist', () => {
      function mockPartnerSettingsUpdate(currentSettings: Record<string, unknown>) {
        const currentPartner = { id: 'partner-123', name: 'Acme MSP', settings: currentSettings };
        vi.mocked(db.select).mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([])
              }),
              limit: vi.fn().mockResolvedValue([currentPartner])
            })
          })
        } as any);
        vi.mocked(db.update).mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([currentPartner])
            })
          })
        } as any);
      }

      async function patchPartner(body: unknown) {
        setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
        return app.request('/orgs/partners/me', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
      }

      it('rejects a malformed CIDR entry with 400', async () => {
        const res = await patchPartner({ settings: { security: { ipAllowlist: ['not-an-ip'] } } });
        expect(res.status).toBe(400);
      });

      it('rejects enabling the allowlist when proxy trust is not configured (proxy_trust_required)', async () => {
        mockPartnerSettingsUpdate({});
        vi.mocked(getTrustedClientIpOrUndefined).mockReturnValue(undefined);

        const res = await patchPartner({ settings: { security: { ipAllowlist: ['203.0.113.0/24'] } } });

        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ code: 'proxy_trust_required' });
      });

      it('accepts a valid allowlist when proxy trust is working', async () => {
        mockPartnerSettingsUpdate({});
        vi.mocked(getTrustedClientIpOrUndefined).mockReturnValue('203.0.113.10');

        const res = await patchPartner({ settings: { security: { ipAllowlist: ['203.0.113.0/24'] } } });

        expect(res.status).toBe(200);
        expect(clearPartnerAllowlistCache).toHaveBeenCalledWith('partner-123');
      });

      function mockPartnerUpdateCapture(currentSettings: Record<string, unknown>) {
        const currentPartner = { id: 'partner-123', name: 'Acme MSP', settings: currentSettings };
        vi.mocked(db.select).mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([])
              }),
              limit: vi.fn().mockResolvedValue([currentPartner])
            })
          })
        } as any);
        let captured: any;
        vi.mocked(db.update).mockReturnValue({
          set: vi.fn().mockImplementation((data: any) => {
            captured = data;
            return {
              where: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([{ ...currentPartner, settings: data.settings }])
              })
            };
          })
        } as any);
        return () => captured;
      }

      it('deep-merges security: a PATCH omitting ipAllowlist preserves the active allowlist and siblings', async () => {
        const getCaptured = mockPartnerUpdateCapture({
          security: { ipAllowlist: ['203.0.113.0/24'], sessionTimeout: 30 }
        });
        vi.mocked(getTrustedClientIpOrUndefined).mockReturnValue('203.0.113.10');

        const res = await patchPartner({ settings: { security: { requireMfa: true } } });

        expect(res.status).toBe(200);
        expect(getCaptured().settings.security).toEqual({
          ipAllowlist: ['203.0.113.0/24'],
          sessionTimeout: 30,
          requireMfa: true
        });
      });

      it('a PATCH whose settings omit security entirely preserves the active allowlist', async () => {
        const getCaptured = mockPartnerUpdateCapture({
          security: { ipAllowlist: ['203.0.113.0/24'] }
        });
        vi.mocked(getTrustedClientIpOrUndefined).mockReturnValue('203.0.113.10');

        const res = await patchPartner({ settings: { branding: { primaryColor: '#ff0000' } } });

        expect(res.status).toBe(200);
        expect(getCaptured().settings.security).toEqual({ ipAllowlist: ['203.0.113.0/24'] });
      });

      it('an explicit empty ipAllowlist still clears the list deliberately', async () => {
        const getCaptured = mockPartnerUpdateCapture({
          security: { ipAllowlist: ['203.0.113.0/24'], requireMfa: true }
        });
        vi.mocked(getTrustedClientIpOrUndefined).mockReturnValue('203.0.113.10');

        const res = await patchPartner({ settings: { security: { ipAllowlist: [] } } });

        expect(res.status).toBe(200);
        expect(getCaptured().settings.security.ipAllowlist).toEqual([]);
        expect(getCaptured().settings.security.requireMfa).toBe(true);
        expect(clearPartnerAllowlistCache).toHaveBeenCalledWith('partner-123');
      });
    });
  });

  describe('scope enforcement on /partners/me routes', () => {
    it('returns 403 when a system-scoped token hits GET /partners/me', async () => {
      setAuthContext({ scope: 'system' });

      const res = await app.request('/orgs/partners/me');

      expect(res.status).toBe(403);
    });

    it('returns 403 when an organization-scoped token hits GET /partners/me', async () => {
      setAuthContext({ scope: 'organization' });

      const res = await app.request('/orgs/partners/me');

      expect(res.status).toBe(403);
    });

    it('returns 403 when a system-scoped token hits PATCH /partners/me', async () => {
      setAuthContext({ scope: 'system' });

      const res = await app.request('/orgs/partners/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Name' })
      });

      expect(res.status).toBe(403);
    });

    it('returns 403 when an organization-scoped token hits PATCH /partners/me', async () => {
      setAuthContext({ scope: 'organization' });

      const res = await app.request('/orgs/partners/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Name' })
      });

      expect(res.status).toBe(403);
    });

  });

  describe('PATCH /orgs/organizations/order', () => {
    const id1 = '00000000-0000-0000-0000-000000000001';
    const id2 = '00000000-0000-0000-0000-000000000002';
    const id3 = '00000000-0000-0000-0000-000000000003';

    // The handler issues two `db.select` calls in order:
    //   1) list of partner orgs (sanitization allowlist)   — chain: from→where (awaited)
    //   2) read current partner settings (read-modify-write) — chain: from→where→limit (awaited)
    // Mock them in that order.
    function mockReorderHandler(opts: {
      partnerOrgIds: string[];
      currentSettings: Record<string, unknown>;
    }) {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(opts.partnerOrgIds.map((id) => ({ id })))
        })
      } as any);
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ settings: opts.currentSettings }])
          })
        })
      } as any);
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'partner-123', name: 'Acme' }])
          })
        })
      } as any);
    }

    it.each(['selected', 'none'] as const)(
      'rejects partnerOrgAccess=%s before entering system context',
      async (partnerOrgAccess) => {
        setAuthContext({
          scope: 'partner',
          partnerOrgAccess,
          accessibleOrgIds: partnerOrgAccess === 'selected' ? [id1] : [],
        });

        const res = await app.request('/orgs/organizations/order', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderedIds: [id1] }),
        });

        expect(res.status).toBe(403);
        expect(withSystemDbAccessContext).not.toHaveBeenCalled();
        expect(db.update).not.toHaveBeenCalled();
      },
    );

    it('persists a sanitized order and returns 200', async () => {
      setAuthContext({ scope: 'partner', accessibleOrgIds: [id1, id2, id3] });
      mockReorderHandler({ partnerOrgIds: [id1, id2, id3], currentSettings: {} });

      const res = await app.request('/orgs/organizations/order', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds: [id3, id1, id2] })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.organizationOrder).toEqual([id3, id1, id2]);
    });

    it('drops IDs that do not belong to the partner', async () => {
      const stranger = '99999999-9999-9999-9999-999999999999';
      setAuthContext({ scope: 'partner', accessibleOrgIds: [id1, id2] });
      // Partner-level allowlist (from DB) is the source of truth: id1, id2.
      mockReorderHandler({ partnerOrgIds: [id1, id2], currentSettings: {} });

      const res = await app.request('/orgs/organizations/order', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds: [stranger, id2, id1] })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.organizationOrder).toEqual([id2, id1]);
    });

    // Regression test for the tenant-boundary fix: a partner admin whose JWT
    // accessibleOrgIds is narrower than the partner's full org list must be
    // able to persist an order that includes every partner org. Sanitization
    // is done against the DB-resolved partner org list, NOT auth.accessibleOrgIds.
    it('preserves partner orgs not present in caller accessibleOrgIds (tenant-boundary fix)', async () => {
      // Caller can only "see" id1 via RBAC, but the partner owns id1, id2, id3.
      setAuthContext({ scope: 'partner', accessibleOrgIds: [id1] });
      mockReorderHandler({ partnerOrgIds: [id1, id2, id3], currentSettings: {} });

      const res = await app.request('/orgs/organizations/order', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds: [id3, id1, id2] })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      // All three partner orgs survive — id2 and id3 would have been dropped
      // under the old auth.accessibleOrgIds-based sanitization.
      expect(body.organizationOrder).toEqual([id3, id1, id2]);
    });

    it('preserves other partner settings when merging', async () => {
      setAuthContext({ scope: 'partner', accessibleOrgIds: [id1, id2] });
      const setSpy = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'partner-123', name: 'Acme' }])
        })
      });
      // 1) Partner orgs allowlist
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: id1 }, { id: id2 }])
        })
      } as any);
      // 2) Current partner settings
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              settings: { timezone: 'America/Chicago', branding: { theme: 'dark' } }
            }])
          })
        })
      } as any);
      vi.mocked(db.update).mockReturnValueOnce({ set: setSpy } as any);

      const res = await app.request('/orgs/organizations/order', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds: [id2, id1] })
      });

      expect(res.status).toBe(200);
      const writtenArg = setSpy.mock.calls[0]![0];
      expect(writtenArg.settings.timezone).toBe('America/Chicago');
      expect(writtenArg.settings.branding).toEqual({ theme: 'dark' });
      expect(writtenArg.settings.organizationOrder).toEqual([id2, id1]);
    });

    it('rejects a system-scoped caller', async () => {
      setAuthContext({ scope: 'system' });

      const res = await app.request('/orgs/organizations/order', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds: [id1] })
      });

      expect(res.status).toBe(403);
    });

    it('rejects an organization-scoped caller', async () => {
      setAuthContext({ scope: 'organization' });

      const res = await app.request('/orgs/organizations/order', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds: [id1] })
      });

      expect(res.status).toBe(403);
    });

    it('rejects a non-uuid in the orderedIds array', async () => {
      setAuthContext({ scope: 'partner', accessibleOrgIds: [id1] });

      const res = await app.request('/orgs/organizations/order', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds: ['not-a-uuid'] })
      });

      expect(res.status).toBe(400);
    });
  });

  // Regression test for the partner-settings load-failure observability fix:
  // when the partner-settings read inside GET /organizations throws, the
  // handler must still return the org list (soft-fail to createdAt order) AND
  // surface the failure via console.error + captureException so on-call can
  // see chronically broken settings reads.
  describe('GET /orgs/organizations partner-settings soft-fail', () => {
    it('logs and captures when the partner-settings read throws', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123', accessibleOrgIds: ['org-1'] });

      // 1) count query
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 1 }])
        })
      } as any);
      // 2) main list query
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              offset: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockResolvedValue([{ id: 'org-1', name: 'Org 1' }])
              })
            })
          })
        })
      } as any);
      // 3) partner-settings read — throws
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockRejectedValue(new Error('db blew up'))
          })
        })
      } as any);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const captureSpy = vi.mocked(captureException);

      const res = await app.request('/orgs/organizations?page=1&limit=10');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('orgs.list.partnerSettings'),
        expect.objectContaining({ partnerId: 'partner-123' })
      );
      expect(captureSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });
});
