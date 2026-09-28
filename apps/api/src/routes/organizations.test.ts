const { ensureDefaultProfile } = vi.hoisted(() => ({ ensureDefaultProfile: vi.fn(async () => ({ id: 'default-profile' })) }));
vi.mock('../services/billingProfileService', () => ({ ensureDefaultProfile }));
vi.mock('../services/mfaPolicyActivation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/mfaPolicyActivation')>()),
  lockMfaPolicySettings: vi.fn().mockResolvedValue(undefined),
  countMfaPolicyLockouts: vi.fn().mockResolvedValue(0),
}));
// PR #7117 T3 — site delete removes the site's owned topology alerts first
// (proven against real Postgres in siteDeleteTopologyAlerts.integration).
// M4-D2 (#6000) — it also deletes the site's pinned topology AI investigations
// in the same transaction (children-first order proven against real Postgres
// in topologyAiSessionLifecycle / siteTopologySessions integration suites).
const siteDelete = vi.hoisted(() => ({
  calls: [] as string[],
  lockSiteForDelete: vi.fn(async () => true),
  deleteSiteOwnedTopologyAlerts: vi.fn(async () => 0),
  deleteSiteTopologyAiSessions: vi.fn(async () => ({ investigations: 0, messages: 0, toolExecutions: 0, actionPlans: 0, screenshots: 0 })),
}));
vi.mock('../services/siteOwnedAlerts', () => ({
  lockSiteForDelete: siteDelete.lockSiteForDelete,
  deleteSiteOwnedTopologyAlerts: siteDelete.deleteSiteOwnedTopologyAlerts,
}));
vi.mock('../services/topology/siteTopologySessions', () => ({
  deleteSiteTopologyAiSessions: siteDelete.deleteSiteTopologyAiSessions,
}));
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { orgRoutes } from './orgs';

vi.mock('../services', () => ({}));

vi.mock('../services/monitors/builtInMonitors', () => ({
  ensureBuiltInMonitorsForPartner: vi.fn(async () => ({ provisioned: true, monitorIds: [] })),
  ensureBuiltInMonitorsForAllPartners: vi.fn(async () => ({ provisioned: 0, skipped: 0, failed: 0 })),
}));
vi.mock('../db', () => {
  const db: Record<string, unknown> = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Object.assign(Promise.resolve([]), {
          limit: vi.fn(() => Promise.resolve([])),
          orderBy: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve([]))
          }))
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
    // #3996 — the abort bounds its lock waits with tightenLockTimeout /
    // tightenStatementTimeout (db/lockTimeout.ts), which are raw
    // `db.execute(sql\`...\`)` statements. An empty result reads back as "prior
    // value unknown", so the helpers leave the tighter bound in force and skip
    // the restore — the right shape for a transactionless double.
    execute: vi.fn(async () => [])
  };
  // POST /orgs/partners wraps insert + status seeding in db.transaction; the tx
  // delegates to the same mock so per-test db.insert overrides flow through.
  db.transaction = vi.fn(async (cb: any) => cb(db));
  return {
    db,
    withDbAccessContext: vi.fn(async (_ctx: any, fn: any) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: any) => fn()),
    runOutsideDbContext: vi.fn((fn: any) => fn()),
    // tenantOffboarding's inCallerOrSystemDbContext (#2877) consults the
    // ambient-context metadata at runtime on the DELETE partner/org paths
    // (abort*Offboarding); undefined = no ambient context → fresh system
    // context, matching this file's transactionless mock shape.
    getCurrentDbAccessContext: vi.fn(() => undefined),
    hasDbAccessContext: vi.fn(() => false),
    SYSTEM_DB_ACCESS_CONTEXT: { scope: 'system', orgId: null, accessibleOrgIds: null }
  };
});

/**
 * A select double that satisfies every shape the real `tenantOffboarding`
 * abort path builds — including `.limit(n).for('update')` and a bare
 * `.where(...)` that resolves. #3996 gave the DELETE handlers a lock phase
 * (`SELECT ... FOR UPDATE` on the tenant row, then on its non-terminal
 * `self_uninstall` rows) that runs BEFORE the status write, and this file
 * drives the real service rather than mocking it, so a `where`-only stub makes
 * those routes 500.
 */
function selectChainReturning(rows: unknown[] = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'innerJoin', 'where', 'orderBy', 'limit', 'for']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(rows), chain));
  }
  return chain;
}

vi.mock('../db/schema', () => ({
  ticketStatuses: {},
  partners: { id: 'partners.id', currencyCode: 'partners.currency_code', deletedAt: 'partners.deleted_at' },
  organizations: {},
  sites: {},
  // GET /orgs/sites enriches each site with a grouped device count (#1790).
  devices: { siteId: { __column: 'devices.siteId' } },
  partnerUsers: { partnerId: 'partner_id', userId: 'user_id' },
  organizationUsers: { orgId: 'org_id', userId: 'user_id' },
  apiKeys: { id: 'id', orgId: 'org_id', status: 'status', updatedAt: 'updated_at' },
  oauthGrants: { id: 'id', orgId: 'org_id', partnerId: 'partner_id', revokedAt: 'revoked_at' },
  oauthRefreshTokens: { id: 'id', orgId: 'org_id', partnerId: 'partner_id', revokedAt: 'revoked_at' },
  roles: {},
  permissions: {},
  rolePermissions: {}
}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  writeRouteAudit: vi.fn()
}));

// orgRoutes' suspend/delete paths call tenant revocation, which now also severs
// the agent fleet (devices/enrollmentKeys). Mock the whole service so this route
// test doesn't have to mock those schema tables; severance behavior is covered
// in tenantLifecycle.test.ts.
vi.mock('../services/tenantLifecycle', () => ({
  revokeOrganizationTenantAccess: vi.fn().mockResolvedValue({
    apiKeysRevoked: 0,
    userSessionsRevoked: 0,
    oauthGrantsRevoked: 0,
    oauthRefreshTokensRevoked: 0,
    agentTokensSuspended: 0,
    enrollmentKeysInvalidated: 0
  }),
  revokePartnerTenantAccess: vi.fn().mockResolvedValue({
    apiKeysRevoked: 0,
    userSessionsRevoked: 0,
    oauthGrantsRevoked: 0,
    oauthRefreshTokensRevoked: 0,
    agentTokensSuspended: 0,
    enrollmentKeysInvalidated: 0
  }),
  restoreOrganizationTenantAccess: vi.fn().mockResolvedValue({ agentTokensRestored: 0 }),
  restorePartnerTenantAccess: vi.fn().mockResolvedValue({ agentTokensRestored: 0 })
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'partner',
      partnerId: 'partner-123',
      orgId: null,
      accessibleOrgIds: ['org-1', 'org-2'],
      user: { id: 'user-123', email: 'test@example.com' },
      canAccessOrg: () => true
    });
    return next();
  }),
  requireScope: vi.fn((...scopes: string[]) => async (c: any, next: any) => {
    const auth = c.get('auth');
    if (!auth || !scopes.includes(auth.scope)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return next();
  }),
  requirePartner: vi.fn((c: any, next: any) => {
    const auth = c.get('auth');
    if (!auth?.partnerId) {
      return c.json({ error: 'Partner access required' }, 403);
    }
    return next();
  }),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';

describe('organization routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: 'partner',
        partnerId: 'partner-123',
        orgId: null,
        accessibleOrgIds: ['org-1', 'org-2'],
        user: { id: 'user-123', email: 'test@example.com' },
        canAccessOrg: () => true
      });
      return next();
    });
    app = new Hono();
    app.route('/orgs', orgRoutes);
  });

  describe('partner tenants', () => {
    it('should list partners for system scope', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'system',
          partnerId: null,
          orgId: null,
          user: { id: 'user-123', email: 'test@example.com' },
          canAccessOrg: () => true
        });
        return next();
      });

      const partners = [
        { id: 'partner-1', name: 'Acme', slug: 'acme', currencyCode: 'USD' },
        { id: 'partner-2', name: 'Globex', slug: 'globex' }
      ];

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
                  orderBy: vi.fn().mockResolvedValue(partners)
                })
              })
            })
          })
        } as any);

      const res = await app.request('/orgs/partners?page=1&limit=2', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.pagination.total).toBe(2);
    });

    it('should create a partner tenant', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'system',
          partnerId: null,
          orgId: null,
          user: { id: 'user-123', email: 'test@example.com' },
          canAccessOrg: () => true
        });
        return next();
      });

      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([
            { id: 'partner-1', name: 'Acme', slug: 'acme', currencyCode: 'USD' }
          ])
        })
      } as any);

      const res = await app.request('/orgs/partners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Acme',
          slug: 'acme'
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe('partner-1');
      expect(ensureDefaultProfile).toHaveBeenCalledWith('partner-1', 'USD', db);
    });

    it('should update a partner tenant', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'system',
          partnerId: null,
          orgId: null,
          user: { id: 'user-123', email: 'test@example.com' },
          canAccessOrg: () => true
        });
        return next();
      });

      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              { id: 'partner-1', name: 'Acme Updated', slug: 'acme' }
            ])
          })
        })
      } as any);

      const res = await app.request('/orgs/partners/partner-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Acme Updated' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Acme Updated');
    });

    it('should delete a partner tenant', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'system',
          partnerId: null,
          orgId: null,
          user: { id: 'user-123', email: 'test@example.com' },
          canAccessOrg: () => true
        });
        return next();
      });

      // tenantLifecycle queries organizations / partnerUsers / organizationUsers
      // via db.select(...).from(...).where(...) and expects an array result.
      vi.mocked(db.select).mockReturnValue(selectChainReturning() as any);

      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'partner-1' }])
          })
        })
      } as any);

      const res = await app.request('/orgs/partners/partner-1', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });

  describe('organizations', () => {
    it('should list partner organizations', async () => {
      const organizations = [
        { id: 'org-1', name: 'Org One', slug: 'org-one', partnerId: 'partner-123' }
      ];

      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 1 }])
          })
        } as any)
        // partner-settings read for the preferred org order — runs BEFORE the
        // page query since #4004, because it supplies the leading ORDER BY term
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockReturnValue({
                  orderBy: vi.fn().mockResolvedValue(organizations)
                })
              })
            })
          })
        } as any)
        // grouped per-org device counts (#3699)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockResolvedValue([{ orgId: 'org-1', count: 3 }])
            })
          })
        } as any);

      const res = await app.request('/orgs/organizations?page=1&limit=50', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.pagination.total).toBe(1);
    });

    it('should create an organization', async () => {
      vi.mocked(db.select)
        // 1) partner currency lookup
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ currencyCode: 'CAD' }])
            })
          })
        } as any)
        // 2) #3967 slug-clash probe — queued explicitly rather than left to the
        // factory default, which the previous test's persistent mockReturnValue
        // would otherwise shadow with a chain that has no .limit().
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            })
          })
        } as any);
      const values = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([
          { id: 'org-1', name: 'Org One', slug: 'org-one' }
        ])
      });
      vi.mocked(db.insert).mockReturnValue({
        values,
      } as any);

      const res = await app.request('/orgs/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Org One',
          slug: 'org-one'
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe('org-1');
      expect(values).toHaveBeenCalledWith(expect.objectContaining({ currencyCode: 'CAD' }));
      expect(ensureDefaultProfile).toHaveBeenCalledWith('partner-123', 'CAD', db);
    });

    it('should fetch an organization by id', async () => {
      // UUID-shaped: GET /organizations/:id rejects a malformed id with a 404
      // before any lookup (it would otherwise reach a uuid column as 22P02).
      const orgId = '11111111-1111-1111-1111-111111111111';
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              { id: orgId, name: 'Org One', slug: 'org-one' }
            ])
          })
        })
      } as any);

      const res = await app.request(`/orgs/organizations/${orgId}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.slug).toBe('org-one');
    });

    it('should update an organization', async () => {
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              { id: 'org-1', name: 'Org One Updated', slug: 'org-one' }
            ])
          })
        })
      } as any);

      const res = await app.request('/orgs/organizations/org-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Org One Updated' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Org One Updated');
    });

    it('should delete an organization', async () => {
      // tenantLifecycle queries organizationUsers via db.select(...).from(...).where(...)
      // and expects an array result.
      vi.mocked(db.select).mockReturnValue(selectChainReturning() as any);

      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'org-1' }])
          })
        })
      } as any);

      const res = await app.request('/orgs/organizations/org-1', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });

  describe('sites', () => {
    it('should list sites for an accessible organization', async () => {
      const orgId = '11111111-1111-1111-1111-111111111111';
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'organization',
          partnerId: null,
          orgId,
          user: { id: 'user-123', email: 'test@example.com' },
          canAccessOrg: (id: string) => id === orgId
        });
        return next();
      });

      const sites = [{ id: 'site-1', orgId, name: 'HQ' }];

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
                  orderBy: vi.fn().mockResolvedValue(sites)
                })
              })
            })
          })
        } as any)
        // Per-site device-count query (#1790): db.select().from(devices).where().groupBy().
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockResolvedValue([{ siteId: 'site-1', count: 1 }])
            })
          })
        } as any);

      const res = await app.request(`/orgs/sites?orgId=${orgId}&page=1&limit=50`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });

    it('should create a site for an accessible organization', async () => {
      const orgId = '11111111-1111-1111-1111-111111111111';
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'organization',
          partnerId: null,
          orgId,
          user: { id: 'user-123', email: 'test@example.com' },
          canAccessOrg: (id: string) => id === orgId
        });
        return next();
      });

      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([
            { id: 'site-1', orgId, name: 'HQ' }
          ])
        })
      } as any);

      const res = await app.request('/orgs/sites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId, name: 'HQ' })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe('site-1');
    });

    it('should fetch a site by id', async () => {
      const orgId = '11111111-1111-1111-1111-111111111111';
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'organization',
          partnerId: null,
          orgId,
          user: { id: 'user-123', email: 'test@example.com' },
          canAccessOrg: (id: string) => id === orgId
        });
        return next();
      });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              { id: 'site-1', orgId, name: 'HQ' }
            ])
          })
        })
      } as any);

      const res = await app.request('/orgs/sites/site-1', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('HQ');
    });

    it('should update a site', async () => {
      const orgId = '11111111-1111-1111-1111-111111111111';
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'organization',
          partnerId: null,
          orgId,
          user: { id: 'user-123', email: 'test@example.com' },
          canAccessOrg: (id: string) => id === orgId
        });
        return next();
      });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              { id: 'site-1', orgId, name: 'HQ' }
            ])
          })
        })
      } as any);

      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              { id: 'site-1', orgId, name: 'HQ Updated' }
            ])
          })
        })
      } as any);

      const res = await app.request('/orgs/sites/site-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'HQ Updated' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('HQ Updated');
    });

    it('should delete a site', async () => {
      const orgId = '11111111-1111-1111-1111-111111111111';
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'organization',
          partnerId: null,
          orgId,
          user: { id: 'user-123', email: 'test@example.com' },
          canAccessOrg: (id: string) => id === orgId
        });
        return next();
      });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              { id: 'site-1', orgId, name: 'HQ' }
            ])
          })
        })
      } as any);

      siteDelete.calls.length = 0;
      siteDelete.lockSiteForDelete.mockImplementation(async () => { siteDelete.calls.push('lock'); return true; });
      siteDelete.deleteSiteOwnedTopologyAlerts.mockImplementation(async () => { siteDelete.calls.push('alerts'); return 2; });
      siteDelete.deleteSiteTopologyAiSessions.mockImplementation(async () => {
        siteDelete.calls.push('topologySessions');
        return { investigations: 1, messages: 3, toolExecutions: 2, actionPlans: 0, screenshots: 0 };
      });
      vi.mocked(db.delete).mockReturnValue({
        where: vi.fn(async () => { siteDelete.calls.push('site'); })
      } as any);

      const res = await app.request('/orgs/sites/site-1', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      // Pinned topology investigations and owned alerts go first, under the
      // site row lock, in the same transaction as the site row.
      expect(siteDelete.calls).toEqual(['lock', 'alerts', 'topologySessions', 'site']);
      expect(siteDelete.deleteSiteTopologyAiSessions).toHaveBeenCalledWith(db, { orgId, siteId: 'site-1' });
      expect(vi.mocked(writeRouteAudit)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: 'site.delete',
        details: {
          removedTopologyAlerts: 2,
          topologyInvestigationsDeleted: { investigations: 1, messages: 3, toolExecutions: 2, actionPlans: 0, screenshots: 0 },
        },
      }));
    });
  });

  describe('access control', () => {
    it('should forbid partner routes for non-system scope', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'partner',
          partnerId: 'partner-123',
          orgId: null,
          user: { id: 'user-123', email: 'test@example.com' },
          canAccessOrg: () => true
        });
        return next();
      });

      const res = await app.request('/orgs/partners', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(403);
    });

    it('should return empty data for partner without accessible orgs', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'partner',
          partnerId: null,
          orgId: null,
          accessibleOrgIds: [],
          user: { id: 'user-123', email: 'test@example.com' },
          canAccessOrg: () => false
        });
        return next();
      });

      const res = await app.request('/orgs/organizations', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.pagination.total).toBe(0);
    });

    it('should forbid site access to other organizations', async () => {
      const orgId = '11111111-1111-1111-1111-111111111111';
      const otherOrgId = '22222222-2222-2222-2222-222222222222';
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'organization',
          partnerId: null,
          orgId,
          user: { id: 'user-123', email: 'test@example.com' },
          canAccessOrg: (id: string) => id === orgId
        });
        return next();
      });

      const res = await app.request(`/orgs/sites?orgId=${otherOrgId}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(403);
    });
  });
});
