import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { orgRoutes, createOrganizationSchema, updateOrganizationSchema } from './orgs';

vi.mock('../services', () => ({}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
  isSentryEnabled: vi.fn().mockReturnValue(false)
}));

vi.mock('../services/clientIp', () => ({
  getTrustedClientIpOrUndefined: vi.fn()
}));

// PATCH /partners/me fans a partner-wide aiBudgets change out to every org's
// budget evaluation (#4388 W02) — mocked so these route tests pin the CALL,
// not the queue/worker machinery (covered by jobs/aiBudgetAlertDelivery.test.ts).
vi.mock('../jobs/aiBudgetAlertDelivery', () => ({
  enqueueAiBudgetEvaluationForPartner: vi.fn().mockResolvedValue(undefined),
}));

// GET /orgs/sites rides the org's resolved enrollment defaults along for the
// Add Device modal (#2776). Mocked so these route tests don't depend on the
// org⋈partner settings join.
vi.mock('../services/enrollmentDefaults', () => ({
  getEnrollmentDefaultsForOrg: vi.fn(async () => ({
    ttlMinutes: 10080,
    deviceCount: 25,
    maxTtlMinutes: 43200
  }))
}));

// Archived orgs are read through a dedicated READ ONLY DB context (Wave 4
// Task 3), which needs a real transaction — mocked here so these route tests
// pin the CALL (partner pinning, when it fires) rather than the DB machinery.
// The archived-context guarantees themselves are proven against real Postgres
// in __tests__/integration/orgArchiveReadContext.integration.test.ts.
vi.mock('../services/archivedOrgReads', () => ({
  listArchivedOrgs: vi.fn(async () => ({ orgs: [], truncated: false })),
  loadArchivedOrg: vi.fn(async () => null)
}));

// Per-org selection boundary (Wave 4 review fix I-1). The mock mirrors the
// real resolver's fail-closed rules (its own suite is
// services/partnerOrgSelection.test.ts) so existing 'all'-access cases need no
// wiring, and a 'selected' case only sets `selectedOrgIds`.
const { selectedOrgIds } = vi.hoisted(() => ({ selectedOrgIds: { current: [] as string[] } }));
vi.mock('../services/partnerOrgSelection', () => ({
  resolvePartnerOrgReach: vi.fn(async (auth: any) => {
    if (!auth.partnerId) return { kind: 'none' };
    if (auth.partnerOrgAccess === 'all') return { kind: 'allOfPartner' };
    if (auth.partnerOrgAccess === 'selected') return { kind: 'selection', orgIds: selectedOrgIds.current };
    return { kind: 'none' };
  }),
  partnerMemberMayReachOrg: vi.fn(async (auth: any, orgId: string) => {
    if (auth.partnerOrgAccess === 'all') return true;
    if (auth.partnerOrgAccess === 'selected') return selectedOrgIds.current.includes(orgId);
    return false;
  })
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

// Spread the REAL module so its exported settings-key constants come from the
// one source of truth (services/orgSettingsInternalKeys.ts imports them, and
// re-declaring them here as literals would leave this suite green through a
// rename while every consumer broke). Only the side-effecting functions below
// are stubbed.
vi.mock('../services/tenantOffboarding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/tenantOffboarding')>()),
  beginOrganizationOffboarding: vi.fn().mockResolvedValue({
    revocation: {
      apiKeysRevoked: 0,
      userSessionsRevoked: 0,
      oauthGrantsRevoked: 0,
      oauthRefreshTokensRevoked: 0,
      agentTokensSuspended: 0,
      enrollmentKeysInvalidated: 0
    },
    devicesTargeted: 0,
    uninstallsQueued: 0,
    otherCommandsCancelled: 0
  }),
  beginPartnerOffboarding: vi.fn().mockResolvedValue({
    revocation: {
      apiKeysRevoked: 0,
      userSessionsRevoked: 0,
      oauthGrantsRevoked: 0,
      oauthRefreshTokensRevoked: 0,
      agentTokensSuspended: 0,
      enrollmentKeysInvalidated: 0
    },
    devicesTargeted: 0,
    uninstallsQueued: 0,
    otherCommandsCancelled: 0
  }),
  abortOrganizationOffboarding: vi.fn().mockResolvedValue({ aborted: false, uninstallsCancelled: 0 }),
  abortPartnerOffboarding: vi.fn().mockResolvedValue({ aborted: false, uninstallsCancelled: 0 })
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
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
  // PATCH /orgs/organizations/:id calls assertNotLocked, whose partner-axis
  // read now goes through readWithPartnerAxisVisibility (#2822). That helper
  // probes the ambient scope, so the factory must export it — `undefined`
  // (no ambient context) makes it take the escape, which these pass-through
  // stubs then flatten.
  getCurrentDbAccessContext: vi.fn(() => undefined)
}));

vi.mock('../services/ticketConfigService', () => ({
  seedSystemTicketStatuses: vi.fn().mockResolvedValue(undefined)
}));

// Bulk org/site import (#3242): the service is unit-tested in
// services/orgImport/orgImport.test.ts — these route tests only cover gating,
// validation, partner resolution, and the audit fan-out.
const orgImportMocks = vi.hoisted(() => ({
  previewOrgImport: vi.fn(),
  commitOrgImport: vi.fn(),
}));
vi.mock('../services/orgImport', () => ({
  previewOrgImport: orgImportMocks.previewOrgImport,
  commitOrgImport: orgImportMocks.commitOrgImport,
  MAX_IMPORT_ROWS: 1000,
}));

vi.mock('../db/schema', () => ({
  partners: {},
  // #2879 — sentinel columns (same pattern as sites.id below) so the
  // suspended-org override tests can assert the UPDATE's WHERE re-asserts
  // eq(organizations.status,'suspended') / eq(organizations.partnerId,...)
  // via the eq spy. Real drizzle eq/isNull build SQL lazily, so plain-object
  // sentinels are safe — the mocked db never executes them.
  organizations: {
    id: { __column: 'organizations.id' },
    partnerId: { __column: 'organizations.partnerId' },
    // #3967 — the slug-clash probe interpolates this column into a raw
    // lower(...) comparison, so it needs a sentinel of its own.
    slug: { __column: 'organizations.slug' },
    status: { __column: 'organizations.status' },
    deletedAt: { __column: 'organizations.deletedAt' },
    createdAt: { __column: 'organizations.createdAt' }
  },
  // #2879 — the suspended-org lifecycle override re-reads the caller's raw
  // partner_users.org_ids selection under a system context.
  partnerUsers: { userId: {}, partnerId: {}, orgIds: {} },
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
    inArray: vi.fn((column: unknown, values: unknown) => ({ __inArray: { column, values } })),
    // #2879 — spy with the REAL implementation so tests can assert the
    // suspended-org lifecycle override re-asserts its WHERE predicates
    // (eq(organizations.status,'suspended') / eq(organizations.partnerId,...))
    // without changing any behavior for the rest of the file.
    eq: vi.fn(actual.eq)
  };
});

// Mutable switch for the requirePermission mock so individual tests can
// simulate a caller whose role LACKS the gated permission (the real middleware
// 403s). `granted = false` denies everything; `denied` denies specific
// `resource:action` pairs so a test can withhold ONE permission (e.g.
// sites:write) while the rest stay granted. Hoisted because the vi.mock
// factory below references it. Reset to granted/empty in beforeEach.
const permissionMockState = vi.hoisted(() => ({ granted: true, denied: new Set<string>() }));

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
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    if (!permissionMockState.granted || permissionMockState.denied.has(`${resource}:${action}`)) {
      return c.json({ error: 'Permission denied' }, 403);
    }
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next())
}));

import { eq, inArray, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db, withSystemDbAccessContext } from '../db';
import { organizations, sites } from '../db/schema';
import { getEnrollmentDefaultsForOrg } from '../services/enrollmentDefaults';
import { authMiddleware } from '../middleware/auth';
import { getTrustedClientIpOrUndefined } from '../services/clientIp';
import { clearPartnerAllowlistCache, readPartnerAllowlist } from '../services/ipAllowlist';
import { listArchivedOrgs, loadArchivedOrg } from '../services/archivedOrgReads';
import {
  restoreOrganizationTenantAccess,
  restorePartnerTenantAccess,
  revokeOrganizationTenantAccess,
  revokePartnerTenantAccess,
} from '../services/tenantLifecycle';
import {
  abortOrganizationOffboarding,
  abortPartnerOffboarding,
  beginOrganizationOffboarding,
  beginPartnerOffboarding,
} from '../services/tenantOffboarding';
import { captureException } from '../services/sentry';
import { seedSystemTicketStatuses } from '../services/ticketConfigService';
import { enqueueAiBudgetEvaluationForPartner } from '../jobs/aiBudgetAlertDelivery';

describe('org routes', () => {
  let app: Hono;

  const setAuthContext = (overrides: Partial<{
    user: { id: string; email: string; name: string; isPlatformAdmin?: boolean };
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
    permissionMockState.denied.clear();
    selectedOrgIds.current = [];
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

      // The page query (second select) must use an explicit projection that
      // excludes internal metadata columns rather than the whole partners row.
      const pageProjection = vi.mocked(db.select).mock.calls[1]?.[0] as Record<string, unknown> | undefined;
      expect(pageProjection).toBeDefined();
      const keys = Object.keys(pageProjection!);
      expect(keys).toContain('id');
      expect(keys).toContain('name');
      expect(keys).toContain('status');
      for (const internal of [
        'signupIp', 'paymentMethodAttachedAt', 'stripeCustomerId', 'ssoConfig', 'mcpOriginIp',
        'billingCardholderName', 'billingCardFingerprint', 'billingSubscriptionStatus',
        'billingPaymentMethodsFirstSeenAt', 'billingPaymentMethodsLastSeenAt',
      ]) {
        expect(keys).not.toContain(internal);
      }
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

      // Explicit projection: internal metadata columns must not be selected.
      const projection = vi.mocked(db.select).mock.calls[0]?.[0] as Record<string, unknown> | undefined;
      expect(projection).toBeDefined();
      const keys = Object.keys(projection!);
      expect(keys).toContain('id');
      expect(keys).toContain('settings');
      for (const internal of [
        'signupIp', 'paymentMethodAttachedAt', 'stripeCustomerId', 'ssoConfig', 'mcpOriginIp',
        'billingCardholderName', 'billingCardFingerprint', 'billingSubscriptionStatus',
        'billingPaymentMethodsFirstSeenAt', 'billingPaymentMethodsLastSeenAt',
      ]) {
        expect(keys).not.toContain(internal);
      }
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

    // #2774 — partner offboarding drains rather than severs.
    it('begins the partner offboarding drain when status is set to offboarding', async () => {
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'partner-1', name: 'P', status: 'offboarding', settings: {} }])
          })
        })
      } as any);

      const res = await app.request('/orgs/partners/partner-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'offboarding' })
      });

      expect(res.status).toBe(200);
      expect(beginPartnerOffboarding).toHaveBeenCalledWith('partner-1', expect.anything());
      expect(revokePartnerTenantAccess).not.toHaveBeenCalled();
      expect(restorePartnerTenantAccess).not.toHaveBeenCalled();
    });

    it('aborts a partner drain before severing when forced to suspended', async () => {
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
      expect(abortPartnerOffboarding).toHaveBeenCalledWith('partner-1');
      expect(revokePartnerTenantAccess).toHaveBeenCalledWith('partner-1');
    });

    it('aborts a partner drain on reactivation so in-flight uninstalls cannot fire later', async () => {
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
      expect(abortPartnerOffboarding).toHaveBeenCalledWith('partner-1');
      expect(restorePartnerTenantAccess).toHaveBeenCalledWith('partner-1');
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

    describe('contact.website scheme allowlist', () => {
      // The website is rendered as a link in branded PDFs, invoices and email
      // footers, so an unvalidated scheme here is stored XSS that fires for
      // whoever opens the document. It used to accept any string and persist
      // the payload verbatim on a 200.
      function seedPartner() {
        vi.mocked(db.select).mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
              limit: vi.fn().mockResolvedValue([{ id: 'partner-123', name: 'P', settings: {} }])
            })
          })
        } as any);
      }

      async function patchWebsite(website: string) {
        return app.request('/orgs/partners/me', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings: { contact: { website } } })
        });
      }

      it.each([
        ['javascript:alert(1)'],
        ['data:text/html,<script>alert(1)</script>'],
        ['vbscript:msgbox(1)'],
        ['acme.example.com'], // schemeless — not a full URL, cannot be linkified safely
      ])('rejects %s with 400 and never writes it', async (website) => {
        setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
        seedPartner();
        const setSpy = vi.fn();
        vi.mocked(db.update).mockReturnValue({ set: setSpy } as any);

        const res = await patchWebsite(website);

        expect(res.status).toBe(400);
        expect(setSpy).not.toHaveBeenCalled();
      });

      it.each([['https://acme.example.com'], ['http://acme.example.com/path'], ['']])(
        'accepts %s',
        async (website) => {
          setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
          seedPartner();
          vi.mocked(db.update).mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([{ id: 'partner-123', name: 'P', settings: {} }])
              })
            })
          } as any);

          const res = await patchWebsite(website);

          expect(res.status).toBe(200);
        }
      );
    });

    // The three sibling URL fields share the same helper as contact.website but
    // had NO coverage of their own — the suite stayed 213/213 green with all
    // three guards deleted (#3430 review). They are defense-in-depth (egress is
    // separately guarded by safeFetch), which is exactly why a silent
    // regression here would go unnoticed.
    describe('sibling URL fields share the scheme allowlist', () => {
      function seedPartner() {
        vi.mocked(db.select).mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
              limit: vi.fn().mockResolvedValue([{ id: 'partner-123', name: 'P', settings: {} }])
            })
          })
        } as any);
      }

      async function patchSettings(settings: Record<string, unknown>) {
        return app.request('/orgs/partners/me', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings })
        });
      }

      const BAD = 'javascript:alert(1)';
      const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
        [
          'notifications.slackWebhookUrl',
          { notifications: { slackWebhookUrl: BAD } },
          { notifications: { slackWebhookUrl: 'https://hooks.slack.example/x' } },
        ],
        [
          'notifications.webhooks[]',
          { notifications: { webhooks: [BAD] } },
          { notifications: { webhooks: ['https://hooks.example.com/x'] } },
        ],
        [
          'eventLogs.elasticsearchUrl',
          { eventLogs: { elasticsearchUrl: BAD } },
          { eventLogs: { elasticsearchUrl: 'https://es.example.com:9200' } },
        ],
      ];

      it.each(cases)('rejects a dangerous scheme on %s with 400 and never writes it', async (_label, bad) => {
        setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
        seedPartner();
        const setSpy = vi.fn();
        vi.mocked(db.update).mockReturnValue({ set: setSpy } as any);

        const res = await patchSettings(bad);

        expect(res.status).toBe(400);
        expect(setSpy).not.toHaveBeenCalled();
      });

      it.each(cases)('accepts an https value on %s', async (_label, _bad, good) => {
        setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
        seedPartner();
        vi.mocked(db.update).mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'partner-123', name: 'P', settings: {} }])
            })
          })
        } as any);

        const res = await patchSettings(good);

        expect(res.status).toBe(200);
      });
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

  describe('PATCH /orgs/partners/me — timeTracking.sessionSuggestions (W06 #3900)', () => {
    // Local copies of the helpers above (plain functions, safe to duplicate —
    // same pattern the ticketing.inbound describe uses).
    function mockCurrentPartnerSelect(settings: Record<string, unknown>) {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
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

    it('accepts settings.timeTracking.sessionSuggestions and deep-merges one level', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      // A sibling block from the location-suggestions spec must survive a save
      // that only carries sessionSuggestions.
      mockCurrentPartnerSelect({ timeTracking: { locationSuggestions: { enabled: true } } });
      const getCaptured = mockUpdateCapture();

      const res = await patchMe({ settings: { timeTracking: { sessionSuggestions: {
        enabled: true, minSessionSeconds: 300, mergeGapMinutes: 5,
      } } } });

      expect(res.status).toBe(200);
      expect(getCaptured().settings.timeTracking).toEqual({
        locationSuggestions: { enabled: true },
        sessionSuggestions: { enabled: true, minSessionSeconds: 300, mergeGapMinutes: 5 },
      });
    });

    it('rejects out-of-range suggestion thresholds with 400', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      mockCurrentPartnerSelect({});
      const getCaptured = mockUpdateCapture();

      const res = await patchMe({ settings: { timeTracking: { sessionSuggestions: {
        enabled: true, minSessionSeconds: 5,
      } } } });

      expect(res.status).toBe(400);
      expect(getCaptured()).toBeUndefined();
    });

    it('rejects an unknown key inside sessionSuggestions (400) so a typo is never silently stored', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      mockCurrentPartnerSelect({});
      const res = await patchMe({ settings: { timeTracking: { sessionSuggestions: { enabledd: true } } } });
      expect(res.status).toBe(400);
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

  describe('PATCH /orgs/partners/me — remoteAccessProviders referential validation (#3401)', () => {
    // Local helper copies, same shape as the sibling blocks above.
    function mockCurrentPartnerSelect() {
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

    function provider(id: string, overrides: Record<string, unknown> = {}) {
      return {
        id,
        name: `Provider ${id}`,
        urlTemplate: 'rustdesk://{id}?password={password}',
        customFieldKey: 'rustdesk_id',
        enabled: true,
        ...overrides,
      };
    }

    beforeEach(() => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
    });

    // Resolution is a first-match find over the providers array, and each entry
    // carries its own urlTemplate and password — duplicated ids make credential
    // selection order-dependent. Must be rejected before any DB write.
    it('rejects duplicate provider ids with 400 and never writes', async () => {
      const setSpy = vi.fn();
      vi.mocked(db.update).mockReturnValue({ set: setSpy } as any);

      const res = await patchMe({ settings: { remoteAccessProviders: {
        defaultProviderId: 'rustdesk',
        providers: [provider('rustdesk'), provider('rustdesk', { name: 'Shadow copy' })],
      } } });

      expect(res.status).toBe(400);
      expect(setSpy).not.toHaveBeenCalled();
    });

    // A dangling default silently resolves to no_provider_configured at launch
    // time (the Connect button just disappears) — reject it at save time instead.
    it('rejects a defaultProviderId that names no configured provider', async () => {
      const setSpy = vi.fn();
      vi.mocked(db.update).mockReturnValue({ set: setSpy } as any);

      const res = await patchMe({ settings: { remoteAccessProviders: {
        defaultProviderId: 'screenconnect',
        providers: [provider('rustdesk')],
      } } });

      expect(res.status).toBe(400);
      expect(setSpy).not.toHaveBeenCalled();
    });

    // The merge replaces the sub-object wholesale, so a default with no provider
    // list at all is the same dangling state.
    it('rejects a defaultProviderId sent without any providers', async () => {
      const setSpy = vi.fn();
      vi.mocked(db.update).mockReturnValue({ set: setSpy } as any);

      const res = await patchMe({ settings: { remoteAccessProviders: {
        defaultProviderId: 'rustdesk',
      } } });

      expect(res.status).toBe(400);
      expect(setSpy).not.toHaveBeenCalled();
    });

    // The UI's cleared state is defaultProviderId: '' (PartnerRemoteAccessTab) —
    // it must not be treated as a dangling reference.
    it('accepts an empty-string defaultProviderId as "no default"', async () => {
      mockCurrentPartnerSelect();
      const getCaptured = mockUpdateCapture();

      const res = await patchMe({ settings: { remoteAccessProviders: {
        defaultProviderId: '',
        providers: [provider('rustdesk')],
      } } });

      expect(res.status).toBe(200);
      expect(getCaptured().settings.remoteAccessProviders.providers).toHaveLength(1);
    });

    it('round-trips a valid config where the default names an existing provider', async () => {
      mockCurrentPartnerSelect();
      const getCaptured = mockUpdateCapture();

      const res = await patchMe({ settings: { remoteAccessProviders: {
        defaultProviderId: 'mesh',
        providers: [provider('rustdesk'), provider('mesh', { customFieldKey: 'mesh_node_id' })],
      } } });

      expect(res.status).toBe(200);
      const written = getCaptured().settings.remoteAccessProviders;
      expect(written.defaultProviderId).toBe('mesh');
      expect(written.providers.map((p: any) => p.id)).toEqual(['rustdesk', 'mesh']);
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
    // GET /orgs/organizations ends with one grouped per-org device-count query
    // (#3699), shaped as db.select({...}).from(devices).where(...).groupBy(...).
    // Mirrors mockSiteDeviceCounts, which does the same for GET /orgs/sites.
    // Only needed when the page returns rows — an empty page skips the query.
    const mockOrgDeviceCounts = (rows: Array<{ orgId: string; count: number }>) =>
      ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            groupBy: vi.fn().mockResolvedValue(rows)
          })
        })
      }) as any;

    // Partner scope reads partners.settings for the preferred org order. Since
    // #4004 that order is the leading ORDER BY term of the page query itself,
    // so the read lands BETWEEN the count and the page query — ahead of the
    // rows it sorts, not after them. It has to be queued explicitly once
    // anything follows it, or it consumes the next mock.
    const mockPartnerOrderSettings = () =>
      ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      }) as any;

    it('should return organizations with pagination', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 1 }])
          })
        } as any)
        .mockReturnValueOnce(mockPartnerOrderSettings())
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
        } as any)
        .mockReturnValueOnce(mockOrgDeviceCounts([{ orgId: 'org-1', count: 2 }]));

      const res = await app.request('/orgs/organizations?page=1&limit=1');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.pagination.total).toBe(1);
    });

    // #3699 — the web card renders `{{count}} devices`. With no count in the
    // payload that interpolated to a bare " devices", which reads as either a
    // loading bug or an empty tenant on the one screen where the number is the
    // point. An org absent from the grouped result is a real 0, not unknown.
    it('returns a device count per organization, defaulting an org with none to 0', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123', accessibleOrgIds: ['org-1', 'org-2'] });
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 2 }])
          })
        } as any)
        .mockReturnValueOnce(mockPartnerOrderSettings())
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockReturnValue({
                  orderBy: vi.fn().mockResolvedValue([{ id: 'org-1' }, { id: 'org-2' }])
                })
              })
            })
          })
        } as any)
        // org-2 has no devices, so the grouped query simply omits it.
        .mockReturnValueOnce(mockOrgDeviceCounts([{ orgId: 'org-1', count: 12 }]));

      const res = await app.request('/orgs/organizations?page=1&limit=10');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.find((o: { id: string }) => o.id === 'org-1').deviceCount).toBe(12);
      expect(body.data.find((o: { id: string }) => o.id === 'org-2').deviceCount).toBe(0);
    });

    // ── includeArchived (Wave 4 Task 3) ────────────────────────────────────
    // Archived orgs are NOT in accessibleOrgIds (computeAccessibleOrgIds
    // allowlists active|trial), so they can never come out of the paginated
    // query — they are read through the READ ONLY archived context and
    // appended. These cases pin WHEN that read fires and WHO it is scoped to.
    describe('includeArchived', () => {
      // Queues EXACTLY the db.select calls the handler makes: count, page rows,
      // partner-order settings, and — only when the page returned rows — the
      // grouped device count. An extra queued `mockReturnValueOnce` is not
      // harmless: `vi.clearAllMocks()` clears calls but NOT the once-queue, so
      // a leftover leaks into the next test and cascades through the file.
      const mockOnePartnerPage = (orgIds: string[], total = orgIds.length) => {
        vi.mocked(db.select)
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ count: total }])
            })
          } as any)
          .mockReturnValueOnce(mockPartnerOrderSettings())
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockReturnValue({
                    orderBy: vi.fn().mockResolvedValue(orgIds.map((id) => ({ id })))
                  })
                })
              })
            })
          } as any);
        if (orgIds.length > 0) {
          vi.mocked(db.select).mockReturnValueOnce(mockOrgDeviceCounts([]));
        }
      };

      it('does not read archived orgs at all without the flag', async () => {
        setAuthContext({ scope: 'partner', partnerId: 'partner-123', accessibleOrgIds: ['org-1'] });
        mockOnePartnerPage(['org-1']);

        const res = await app.request('/orgs/organizations?page=1&limit=10');

        expect(res.status).toBe(200);
        expect(listArchivedOrgs).not.toHaveBeenCalled();
      });

      it('appends flagged archived orgs, scoped to the caller partner', async () => {
        setAuthContext({ scope: 'partner', partnerId: 'partner-123', accessibleOrgIds: ['org-1'] });
        mockOnePartnerPage(['org-1']);
        vi.mocked(listArchivedOrgs).mockResolvedValueOnce({
          orgs: [{ id: 'org-archived', status: 'archived', archived: true, deviceCount: 4 } as any],
          truncated: false
        });

        const res = await app.request('/orgs/organizations?page=1&limit=10&includeArchived=true');

        expect(res.status).toBe(200);
        expect(listArchivedOrgs).toHaveBeenCalledWith({
          scope: { kind: 'partner', partnerId: 'partner-123' },
          search: undefined,
          limit: 10
        });
        const body = await res.json();
        expect(body.data.map((o: { id: string }) => o.id)).toEqual(['org-1', 'org-archived']);
        expect(body.data[1].archived).toBe(true);
        // Archived rows ride along OUTSIDE the pagination arithmetic.
        expect(body.pagination.total).toBe(1);
        expect(body.archivedTruncated).toBe(false);
      });

      // The archived block is capped at `limit` instead of being paginated, so
      // the response has to SAY when that cap dropped tenants — an archived org
      // silently missing from the list is one whose purge timer nobody sees.
      it('reports archivedTruncated when the archived block hit its cap', async () => {
        setAuthContext({ scope: 'partner', partnerId: 'partner-123', accessibleOrgIds: ['org-1'] });
        mockOnePartnerPage(['org-1']);
        vi.mocked(listArchivedOrgs).mockResolvedValueOnce({
          orgs: Array.from({ length: 10 }, (_, i) => (
            { id: `org-archived-${i}`, status: 'archived', archived: true, deviceCount: 0 } as any
          )),
          truncated: true
        });

        const res = await app.request('/orgs/organizations?page=1&limit=10&includeArchived=true');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data).toHaveLength(11); // 1 live + the capped 10
        expect(body.archivedTruncated).toBe(true);
      });

      // An empty page past the end of the live list is NOT the tail: with
      // total=1 and limit=1, page 2 is empty and would otherwise append a
      // second copy of every archived org to a page walk.
      it('does not append on an empty page past the end of the live list', async () => {
        setAuthContext({ scope: 'partner', partnerId: 'partner-123', accessibleOrgIds: ['org-1'] });
        mockOnePartnerPage([], 1);

        const res = await app.request('/orgs/organizations?page=2&limit=1&includeArchived=true');

        expect(res.status).toBe(200);
        expect((await res.json()).data).toEqual([]);
        expect(listArchivedOrgs).not.toHaveBeenCalled();
      });

      // fetchAllOrganizations.ts walks every page and concatenates. Appending
      // on each one would repeat every archived org per page.
      it('appends only on the final page of the live result set', async () => {
        setAuthContext({ scope: 'partner', partnerId: 'partner-123', accessibleOrgIds: ['org-1', 'org-2'] });
        mockOnePartnerPage(['org-1'], 2);

        const res = await app.request('/orgs/organizations?page=1&limit=1&includeArchived=true');

        expect(res.status).toBe(200);
        expect(listArchivedOrgs).not.toHaveBeenCalled();
      });

      // A partner whose only orgs are archived has an EMPTY accessibleOrgIds.
      // That short-circuited the whole handler before Wave 4, which would have
      // made the flag a no-op for exactly the tenant it exists to serve.
      it('still returns archived orgs when the partner has no live orgs', async () => {
        setAuthContext({ scope: 'partner', partnerId: 'partner-123', accessibleOrgIds: [] });
        vi.mocked(listArchivedOrgs).mockResolvedValueOnce({
          orgs: [{ id: 'org-archived', status: 'archived', archived: true, deviceCount: 0 } as any],
          truncated: false
        });

        const res = await app.request('/orgs/organizations?includeArchived=true');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.map((o: { id: string }) => o.id)).toEqual(['org-archived']);
        // No live-org queries were issued at all — there is nothing to query.
        expect(db.select).not.toHaveBeenCalled();
      });

      // A partner token with no partnerId must get NOTHING, never every
      // partner's archived orgs (partnerId: null means "all" in the service).
      it('reads nothing for a partner-scope caller with no partner id', async () => {
        setAuthContext({ scope: 'partner', partnerId: null, accessibleOrgIds: [] });

        const res = await app.request('/orgs/organizations?includeArchived=true');

        expect(res.status).toBe(200);
        expect(listArchivedOrgs).not.toHaveBeenCalled();
        expect((await res.json()).data).toEqual([]);
      });

      // Review fix I-1: archived orgs are absent from accessibleOrgIds for
      // EVERY member, so partner-id-only scoping meant archiving an org WIDENED
      // who could read its full row (settings blob included) to techs who were
      // 404'd on it the day before.
      it("narrows the archived read to a 'selected' member's own selection", async () => {
        selectedOrgIds.current = ['org-archived-mine'];
        setAuthContext({
          scope: 'partner', partnerId: 'partner-123',
          partnerOrgAccess: 'selected', accessibleOrgIds: ['org-1']
        });
        mockOnePartnerPage(['org-1']);
        vi.mocked(listArchivedOrgs).mockResolvedValueOnce({ orgs: [], truncated: false });

        const res = await app.request('/orgs/organizations?page=1&limit=10&includeArchived=true');

        expect(res.status).toBe(200);
        expect(listArchivedOrgs).toHaveBeenCalledWith({
          scope: { kind: 'partnerSelection', partnerId: 'partner-123', orgIds: ['org-archived-mine'] },
          search: undefined,
          limit: 10
        });
      });

      it("reads nothing at all for an org_access='none' member", async () => {
        setAuthContext({
          scope: 'partner', partnerId: 'partner-123',
          partnerOrgAccess: 'none', accessibleOrgIds: []
        });

        const res = await app.request('/orgs/organizations?includeArchived=true');

        expect(res.status).toBe(200);
        expect(listArchivedOrgs).not.toHaveBeenCalled();
      });
    });

    // The grouped count is ONE query for the whole page, not a per-row
    // subselect: this endpoint is walked page-by-page by fetchAllOrganizations,
    // so a correlated count would multiply into hundreds of queries per render.
    it('costs one grouped query for the page rather than one per organization', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123', accessibleOrgIds: ['org-1', 'org-2', 'org-3'] });
      const groupBySpy = vi.fn().mockResolvedValue([]);
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 3 }])
          })
        } as any)
        .mockReturnValueOnce(mockPartnerOrderSettings())
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockReturnValue({
                  orderBy: vi.fn().mockResolvedValue([{ id: 'org-1' }, { id: 'org-2' }, { id: 'org-3' }])
                })
              })
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ groupBy: groupBySpy })
          })
        } as any);

      const res = await app.request('/orgs/organizations?page=1&limit=10');

      expect(res.status).toBe(200);
      expect(groupBySpy).toHaveBeenCalledTimes(1);
      const body = await res.json();
      expect(body.data.every((o: { deviceCount: number }) => o.deviceCount === 0)).toBe(true);
    });

    // #3462: apps/web/src/lib/fetchAllOrganizations.ts pages through this
    // general (partner/system-scope) branch with LIMIT/OFFSET. `created_at`
    // is `defaultNow()` and Postgres `now()` is the TRANSACTION timestamp, so
    // every org written in one transaction (seed, bulk import, migration)
    // shares a byte-identical value — ordering on that tied key alone leaves
    // row order undefined between two page fetches, and the walk would
    // silently see some orgs twice and miss others. This exercises the
    // general paginated branch (partner scope), NOT the own-org early-return
    // branch covered by the projection test below.
    //
    // This asserts the ARGUMENTS handed to a mocked `orderBy`, which cannot see
    // what Postgres would actually run. The compiled-SQL assertions in
    // `orgs.listQuery.test.ts` are the real guard on the emitted ORDER BY; this
    // case pins only that the route reaches the builder on the partner branch.
    it('appends a unique id tiebreaker to the sort so paging is stable', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      let capturedOrderBy: unknown[] = [];
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 0 }])
          })
        } as any)
        // No stored order, so the sort is the bare tiebreaker.
        .mockReturnValueOnce(mockPartnerOrderSettings())
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockReturnValue({
                  orderBy: vi.fn().mockImplementation((...args: unknown[]) => {
                    capturedOrderBy = args;
                    return Promise.resolve([]);
                  })
                })
              })
            })
          })
        } as any);

      const res = await app.request('/orgs/organizations');

      expect(res.status).toBe(200);
      expect(capturedOrderBy).toEqual([organizations.createdAt, organizations.id]);
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
        .mockReturnValueOnce(mockPartnerOrderSettings())
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockReturnValue({ orderBy: orderBySpy })
              })
            })
          })
        } as any)
        .mockReturnValueOnce(mockOrgDeviceCounts([]));

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
    // db.select is called twice on this path: the partner currency lookup, then
    // the #3967 slug-clash probe. Both are `.from().where().limit()`, so each
    // test queues them in order rather than relying on a single blanket mock
    // (or, as these two used to, on a mock leaking in from an earlier test).
    const selectRows = (rows: unknown[]) => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows)
        })
      })
    }) as any;

    const queueCreateSelects = (clashRows: unknown[] = []) => {
      vi.mocked(db.select)
        .mockReturnValueOnce(selectRows([{ currencyCode: 'USD' }]))
        .mockReturnValueOnce(selectRows(clashRows));
    };

    it('should create an organization', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      queueCreateSelects();
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
      queueCreateSelects();
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

    // #3967 — organizations.slug had no unique index and no app-layer guard, so
    // two orgs under one partner could both be created with the same slug and
    // both return 201.
    describe('slug uniqueness (#3967)', () => {
      it('returns 409 instead of creating a second org with the same slug', async () => {
        setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
        queueCreateSelects([{ id: 'org-existing', deletedAt: null }]);

        const res = await app.request('/orgs/organizations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'QA Sweep Org Dup', slug: 'qa-sweep-org' })
        });

        expect(res.status).toBe(409);
        expect((await res.json()).error).toBe('That organization slug is already in use');
        expect(db.insert).not.toHaveBeenCalled();
      });

      it('says so when the slug is held by a soft-deleted org the caller cannot see', async () => {
        setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
        queueCreateSelects([{ id: 'org-gone', deletedAt: new Date('2026-01-01') }]);

        const res = await app.request('/orgs/organizations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Acme Again', slug: 'acme' })
        });

        expect(res.status).toBe(409);
        expect((await res.json()).error).toBe('That organization slug is still reserved by a deleted organization');
      });

      it('scopes the clash probe to the partner and compares case-insensitively', async () => {
        setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
        const clashWhere: unknown[] = [];
        vi.mocked(db.select)
          .mockReturnValueOnce(selectRows([{ currencyCode: 'USD' }]))
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn((condition: unknown) => {
                clashWhere.push(condition);
                return { limit: vi.fn().mockResolvedValue([]) };
              })
            })
          } as any);
        vi.mocked(db.insert).mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'org-1', name: 'Org' }])
          })
        } as any);

        const res = await app.request('/orgs/organizations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Org', slug: 'Mixed-Case-Slug' })
        });

        expect(res.status).toBe(201);
        expect(clashWhere).toHaveLength(1);
        // Compile the real predicate: a shape assertion on the mock would pass
        // just as happily against a global, case-sensitive query.
        const compiled = new PgDialect().sqlToQuery(clashWhere[0] as any);
        // Case-insensitive on BOTH sides, matching (partner_id, lower(slug)).
        expect(compiled.sql).toMatch(/lower\(\$\d+\) = lower\(\$\d+\)/);
        expect(compiled.params).toContainEqual({ __column: 'organizations.slug' });
        expect(compiled.params).toContain('Mixed-Case-Slug');
        // Partner-scoped, not global.
        expect(compiled.params).toContainEqual({ __column: 'organizations.partnerId' });
        expect(compiled.params).toContain('partner-123');
        // Lifetime scope: a soft-deleted holder still owns its slug, so the
        // probe must NOT filter deleted_at (see the migration's rationale).
        expect(compiled.params).not.toContainEqual({ __column: 'organizations.deletedAt' });
      });

      it('maps the unique-index violation to 409 when two creates race past the probe', async () => {
        setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
        queueCreateSelects();
        vi.mocked(db.insert).mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockRejectedValue(
              Object.assign(new Error('duplicate key value violates unique constraint'), {
                cause: { code: '23505', constraint_name: 'organizations_partner_slug_uniq' }
              })
            )
          })
        } as any);

        const res = await app.request('/orgs/organizations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Org', slug: 'org' })
        });

        expect(res.status).toBe(409);
        expect((await res.json()).error).toBe('That organization slug is already in use');
      });

      it('rethrows a unique violation that is not the slug index', async () => {
        setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
        queueCreateSelects();
        vi.mocked(db.insert).mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockRejectedValue(
              Object.assign(new Error('duplicate key'), {
                cause: { code: '23505', constraint_name: 'organizations_partner_quick_support_uniq' }
              })
            )
          })
        } as any);

        const res = await app.request('/orgs/organizations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Org', slug: 'org' })
        });

        expect(res.status).toBe(500);
      });
    });
  });

  describe('GET /orgs/organizations/:id', () => {
    it('should return an organization', async () => {
      // UUID-shaped: the handler rejects a malformed `:id` with a 404 before
      // any lookup, because it would otherwise reach a uuid column as 22P02.
      const orgId = '11111111-1111-1111-1111-111111111111';
      setAuthContext({
        scope: 'partner',
        partnerId: 'partner-123',
        accessibleOrgIds: [orgId]
      });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: orgId, name: 'Org' }])
          })
        })
      } as any);

      const res = await app.request(`/orgs/organizations/${orgId}`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(orgId);
    });

    it('should return 404 when organization not found', async () => {
      // In the caller's accessible set AND uuid-shaped, so this reaches the
      // real lookup and 404s on an empty result — not on the scope check or
      // the malformed-id guard, either of which would make it vacuous.
      const orgId = '22222222-2222-2222-2222-222222222222';
      setAuthContext({
        scope: 'partner',
        partnerId: 'partner-123',
        accessibleOrgIds: [orgId]
      });
      const limit = vi.fn().mockResolvedValue([]);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit })
        })
      } as any);

      const res = await app.request(`/orgs/organizations/${orgId}`);

      expect(res.status).toBe(404);
      expect(limit).toHaveBeenCalled();
    });

    it('should block partner access when org is outside selected scope', async () => {
      setAuthContext({
        scope: 'partner',
        partnerId: 'partner-123',
        accessibleOrgIds: ['org-1'],
        canAccessOrg: (orgId) => orgId === 'org-1'
      });

      // UUID-shaped on purpose: a malformed id short-circuits to 404 before
      // any of this, which would make the case vacuous.
      const res = await app.request('/orgs/organizations/99999999-9999-9999-9999-999999999999');

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Organization not found' });
      // The org row is never queried in the caller's own context. Since Wave 4
      // the handler does probe for an ARCHIVED org first — that probe is
      // hard-pinned to the caller's own partner and returns null here, so the
      // 404 stands.
      expect(db.select).not.toHaveBeenCalled();
      expect(loadArchivedOrg).toHaveBeenCalledWith({
        orgId: '99999999-9999-9999-9999-999999999999',
        scope: { kind: 'partner', partnerId: 'partner-123' }
      });
    });

    it("scopes the archived detail probe to a 'selected' member's selection", async () => {
      selectedOrgIds.current = ['77777777-7777-7777-7777-777777777777'];
      setAuthContext({
        scope: 'partner',
        partnerId: 'partner-123',
        partnerOrgAccess: 'selected',
        accessibleOrgIds: ['org-1'],
        canAccessOrg: (orgId) => orgId === 'org-1'
      });

      await app.request('/orgs/organizations/77777777-7777-7777-7777-777777777777');

      expect(loadArchivedOrg).toHaveBeenCalledWith({
        orgId: '77777777-7777-7777-7777-777777777777',
        scope: {
          kind: 'partnerSelection',
          partnerId: 'partner-123',
          orgIds: ['77777777-7777-7777-7777-777777777777']
        }
      });
    });

    it("does not probe the archived door at all for an org_access='none' member", async () => {
      setAuthContext({
        scope: 'partner',
        partnerId: 'partner-123',
        partnerOrgAccess: 'none',
        accessibleOrgIds: [],
        canAccessOrg: () => false
      });

      const res = await app.request('/orgs/organizations/77777777-7777-7777-7777-777777777777');

      expect(res.status).toBe(404);
      expect(loadArchivedOrg).not.toHaveBeenCalled();
    });

    it('serves an archived org of the caller partner through the read-only archived context', async () => {
      setAuthContext({
        scope: 'partner',
        partnerId: 'partner-123',
        accessibleOrgIds: ['org-1'],
        canAccessOrg: (orgId) => orgId === 'org-1'
      });
      vi.mocked(loadArchivedOrg).mockResolvedValueOnce({
        id: '77777777-7777-7777-7777-777777777777',
        name: 'Archived Co',
        status: 'archived',
        archived: true
      } as any);

      const res = await app.request('/orgs/organizations/77777777-7777-7777-7777-777777777777');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe('77777777-7777-7777-7777-777777777777');
      expect(body.archived).toBe(true);
      // Served ONLY through the archived door — never through the request's own
      // read-write context.
      expect(db.select).not.toHaveBeenCalled();
    });

    // `:id` is a raw path segment and every lookup feeds it to a uuid column,
    // where a non-UUID raises Postgres 22P02 — an uncaught 500 plus a Sentry
    // event that any caller can pump with `/organizations/undefined`.
    it('404s a malformed id without touching the database', async () => {
      setAuthContext({
        scope: 'partner',
        partnerId: 'partner-123',
        accessibleOrgIds: ['33333333-3333-3333-3333-333333333333']
      });

      const res = await app.request('/orgs/organizations/not-a-uuid');

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Organization not found' });
      expect(loadArchivedOrg).not.toHaveBeenCalled();
      expect(db.select).not.toHaveBeenCalled();
    });

    it('404s a system-scope caller on a malformed id too (no 22P02 500)', async () => {
      setAuthContext({ scope: 'system' });

      const res = await app.request('/orgs/organizations/undefined');

      expect(res.status).toBe(404);
      expect(db.select).not.toHaveBeenCalled();
    });

    // A partner token with no partnerId has no tenant to scope the archived
    // probe to, so it must read nothing at all — never every partner's.
    it('does not probe for an archived org when the partner token carries no partner id', async () => {
      setAuthContext({
        scope: 'partner',
        partnerId: null,
        accessibleOrgIds: [],
        canAccessOrg: () => false
      });

      const res = await app.request('/orgs/organizations/44444444-4444-4444-4444-444444444444');

      expect(res.status).toBe(404);
      expect(loadArchivedOrg).not.toHaveBeenCalled();
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

    // ── lifecycle-internal settings keys (review r3) ───────────────────────
    // `settings` is a client-writable z.any() blob and this handler replaces
    // the column WHOLESALE, so without the strip a caller could seed the
    // purge-retry counter (neutering the ceiling) or the prior-status keys
    // (choosing what a later restore/unfence reactivates the tenant AS). The
    // strip helper's own matrix is services/orgSettingsInternalKeys.test.ts;
    // this pins that the write path actually applies it.
    describe('lifecycle-internal settings keys', () => {
      const patchSettings = async (settings: Record<string, unknown>) => {
        setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
        // assertNotLocked('defaults', ...) resolves with no locks.
        vi.mocked(db.select).mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ partnerId: 'partner-123', settings: {} }])
          })
        } as any);
        const captured: Record<string, unknown>[] = [];
        vi.mocked(db.update).mockReturnValue({
          set: vi.fn((values: Record<string, unknown>) => {
            captured.push(values);
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
          body: JSON.stringify({ settings })
        });
        return { res, written: captured[0]?.settings as Record<string, unknown> | undefined };
      };

      // `vi.clearAllMocks()` (global beforeEach) clears CALLS but not
      // implementations, so the persistent db.select stub above would leak a
      // `.limit`-less chain into every later test. Reinstate the factory
      // default explicitly.
      afterEach(() => {
        vi.mocked(db.select).mockImplementation((() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([])) })),
              limit: vi.fn(() => Promise.resolve([]))
            }))
          }))
        })) as any);
      });

      it('strips every engine-owned key from a client PATCH, keeping the rest', async () => {
        const { res, written } = await patchSettings({
          purgingRecoveryAttempts: -9999,
          archivePriorStatus: 'active',
          mergePriorStatus: 'active',
          archivePurgeWarn14SentAt: '2026-01-01T00:00:00.000Z',
          archivePurgeWarn1SentAt: '2026-01-01T00:00:00.000Z',
          branding: { primaryColor: '#123456' }
        });

        expect(res.status).toBe(200);
        expect(written).toEqual({ branding: { primaryColor: '#123456' } });
      });

      it('leaves an ordinary settings payload untouched', async () => {
        const { res, written } = await patchSettings({ branding: { primaryColor: '#abc' } });

        expect(res.status).toBe(200);
        expect(written).toEqual({ branding: { primaryColor: '#abc' } });
      });
    });

    // ── transitions OUT of a frozen status (review fix I-6) ────────────────
    // The update schema already excludes archived/purging/merging as a TARGET,
    // but nothing guarded the SOURCE side: for system scope `conditions` is
    // just `id = ? AND deleted_at IS NULL`, and an archived org has
    // `deleted_at IS NULL`. So PATCH {status:'active'} un-archived the org
    // through the WRONG door — `restoreOrganizationTenantAccess` lifts only
    // `tenant_suspended`, never Wave 4's `org_archived` tag, leaving a live,
    // billable org whose entire fleet 401s forever with stale purge_at.
    describe('lifecycle-frozen source statuses', () => {
      const queueCurrentStatus = (status: string) => {
        vi.mocked(db.select).mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ status }])
            })
          })
        } as any);
      };

      const patchStatus = (status = 'active') =>
        app.request('/orgs/organizations/org-1', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status })
        });

      it.each(['archived', 'purging', 'merging'])(
        '409s a status write on a %s org, for platform-admin system scope too',
        async (current) => {
          setAuthContext({
            scope: 'system', partnerId: null,
            user: { id: 'admin-1', email: 'a@b.test', name: 'Admin', isPlatformAdmin: true }
          });
          queueCurrentStatus(current);

          const res = await patchStatus();

          expect(res.status).toBe(409);
          const body = await res.json();
          expect(body.code).toBe('ORG_LIFECYCLE_FROZEN');
          expect(body.currentStatus).toBe(current);
          expect(db.update).not.toHaveBeenCalled();
        }
      );

      it('points an archived org at the restore endpoint', async () => {
        setAuthContext({ scope: 'system', partnerId: null });
        queueCurrentStatus('archived');

        const res = await patchStatus();

        expect((await res.json()).error).toContain('/restore');
      });

      it('points a merging org at the merge endpoints', async () => {
        setAuthContext({ scope: 'system', partnerId: null });
        queueCurrentStatus('merging');

        const res = await patchStatus();

        expect((await res.json()).error).toContain('merge');
      });

      it('does not block a status write on a normal org', async () => {
        setAuthContext({ scope: 'system', partnerId: null });
        queueCurrentStatus('suspended');
        vi.mocked(db.update).mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'org-1', name: 'Acme' }])
            })
          })
        } as any);

        const res = await patchStatus();

        expect(res.status).toBe(200);
      });

      // Review r3: the pre-read guard is a SEPARATE statement, so it is only
      // advisory — an archive request, the purge CAS or a merge fence can land
      // between the read and the UPDATE, whose base WHERE checks nothing but
      // id + deleted_at. The frozen set is re-asserted IN the mutation.
      it('re-asserts the frozen set inside the UPDATE WHERE (compiled SQL)', async () => {
        setAuthContext({ scope: 'system', partnerId: null });
        queueCurrentStatus('active');
        let capturedWhere: unknown;
        vi.mocked(db.update).mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn((cond: unknown) => {
              capturedWhere = cond;
              return { returning: vi.fn().mockResolvedValue([{ id: 'org-1', name: 'Acme' }]) };
            })
          })
        } as any);

        await patchStatus('suspended');

        // `../db/schema` is mocked with sentinel columns here, so compiled
        // columns render as bound params — the params ARE the signal: the
        // status column sentinel, constrained by NOT IN the frozen three.
        const { sql: compiled, params } = new PgDialect().sqlToQuery(capturedWhere as SQL);
        expect(compiled).toContain('not in');
        expect(params).toEqual(
          expect.arrayContaining([
            { __column: 'organizations.status' },
            'archived',
            'purging',
            'merging',
          ]),
        );
      });

      it('409s when the org froze BETWEEN the guard read and the UPDATE (0-row race)', async () => {
        setAuthContext({ scope: 'system', partnerId: null });
        queueCurrentStatus('active');   // guard read: not frozen, proceed
        vi.mocked(db.update).mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([]) // the WHERE excluded it
            })
          })
        } as any);
        queueCurrentStatus('archived'); // re-read: it got archived under us

        const res = await patchStatus();

        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.code).toBe('ORG_LIFECYCLE_FROZEN');
        expect(body.currentStatus).toBe('archived');
      });

      it('still 404s a 0-row status update when the org is simply gone', async () => {
        setAuthContext({ scope: 'system', partnerId: null });
        queueCurrentStatus('active');
        vi.mocked(db.update).mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) })
          })
        } as any);
        // Re-read finds nothing — not a frozen race, a missing org.

        const res = await patchStatus();

        expect(res.status).toBe(404);
        expect((await res.json()).error).toBe('Organization not found');
      });

      it('does not constrain the WHERE for a non-status update', async () => {
        setAuthContext({ scope: 'system', partnerId: null });
        let capturedWhere: unknown;
        vi.mocked(db.update).mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn((cond: unknown) => {
              capturedWhere = cond;
              return { returning: vi.fn().mockResolvedValue([{ id: 'org-1', name: 'Renamed' }]) };
            })
          })
        } as any);

        await app.request('/orgs/organizations/org-1', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Renamed' })
        });

        const { sql: compiled } = new PgDialect().sqlToQuery(capturedWhere as SQL);
        expect(compiled).not.toContain('not in');
      });

      it('does not read the status at all for a non-status update', async () => {
        setAuthContext({ scope: 'system', partnerId: null });
        vi.mocked(db.update).mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'org-1', name: 'Renamed' }])
            })
          })
        } as any);

        const res = await app.request('/orgs/organizations/org-1', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Renamed' })
        });

        expect(res.status).toBe(200);
        expect(db.select).not.toHaveBeenCalled();
      });
    });

    // #3967 — renaming an org's slug onto a sibling's must 409, not silently
    // produce a second holder (pre-fix) or a raw 23505 500 (index only).
    describe('slug uniqueness (#3967)', () => {
      const patchSlug = (body: Record<string, unknown> = { slug: 'taken-slug' }) =>
        app.request('/orgs/organizations/org-1', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

      const queueUpdateSelects = (
        clashRows: unknown[] = [],
        onClashWhere?: (condition: unknown) => void
      ) => {
        vi.mocked(db.select)
          // 1) the target org's own partner, read under a system context
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ partnerId: 'partner-777' }])
              })
            })
          } as any)
          // 2) the clash probe
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn((condition: unknown) => {
                onClashWhere?.(condition);
                return { limit: vi.fn().mockResolvedValue(clashRows) };
              })
            })
          } as any);
      };

      it('returns 409 when a sibling org already holds the new slug', async () => {
        setAuthContext({ scope: 'system', partnerId: null });
        queueUpdateSelects([{ id: 'org-2', deletedAt: null }]);

        const res = await patchSlug();

        expect(res.status).toBe(409);
        expect((await res.json()).error).toBe('That organization slug is already in use');
        expect(db.update).not.toHaveBeenCalled();
      });

      it('says so when the new slug is held by a soft-deleted org', async () => {
        setAuthContext({ scope: 'system', partnerId: null });
        queueUpdateSelects([{ id: 'org-gone', deletedAt: new Date('2026-01-01') }]);

        const res = await patchSlug();

        expect(res.status).toBe(409);
        expect((await res.json()).error).toBe('That organization slug is still reserved by a deleted organization');
        expect(db.update).not.toHaveBeenCalled();
      });

      it("resolves the partner from the org itself, and excludes the org's own row", async () => {
        setAuthContext({ scope: 'system', partnerId: null });
        let clashCondition: unknown;
        queueUpdateSelects([], (condition) => { clashCondition = condition; });
        vi.mocked(db.update).mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'org-1', slug: 'taken-slug' }])
            })
          })
        } as any);

        const res = await patchSlug();

        expect(res.status).toBe(200);
        const compiled = new PgDialect().sqlToQuery(clashCondition as any);
        // partner-777 comes from the org row, NOT from auth.partnerId — which is
        // null for this system-scope caller and would have scoped the probe to
        // the wrong tenant.
        expect(compiled.params).toContainEqual({ __column: 'organizations.partnerId' });
        expect(compiled.params).toContain('partner-777');
        expect(compiled.sql).toContain('<>');
        expect(compiled.params).toContainEqual({ __column: 'organizations.id' });
        expect(compiled.params).toContain('org-1');
      });

      it('404s when the org to rename does not exist', async () => {
        setAuthContext({ scope: 'system', partnerId: null });
        vi.mocked(db.select).mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) })
          })
        } as any);

        const res = await patchSlug();

        expect(res.status).toBe(404);
        expect(db.update).not.toHaveBeenCalled();
      });

      it('maps the unique-index violation to 409 when an update races past the probe', async () => {
        setAuthContext({ scope: 'system', partnerId: null });
        queueUpdateSelects();
        vi.mocked(db.update).mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              // No constraint_name on the driver node — exercises
              // isPgUniqueViolation's documented message fallback, which only
              // applies to the node that actually carries the SQLSTATE.
              returning: vi.fn().mockRejectedValue(
                Object.assign(new Error('update failed'), {
                  cause: {
                    code: '23505',
                    message: 'duplicate key value violates unique constraint "organizations_partner_slug_uniq"'
                  }
                })
              )
            })
          })
        } as any);

        const res = await patchSlug();

        expect(res.status).toBe(409);
        expect((await res.json()).error).toBe('That organization slug is already in use');
      });

      it('leaves updates that do not touch the slug alone', async () => {
        setAuthContext({ scope: 'system', partnerId: null });
        vi.mocked(db.update).mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'org-1', name: 'Renamed' }])
            })
          })
        } as any);

        const res = await patchSlug({ name: 'Renamed' });

        expect(res.status).toBe(200);
        expect(db.select).not.toHaveBeenCalled();
      });
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

    // #2774 — offboarding is the drain entry: users out via
    // beginOrganizationOffboarding (agent channel kept), NOT the immediate
    // sever of revokeOrganizationTenantAccess.
    it('begins the offboarding drain (not an immediate sever) when status is set to offboarding', async () => {
      setAuthContext({ scope: 'system', partnerId: null });
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'org-1', name: 'O', status: 'offboarding' }])
          })
        })
      } as any);

      const res = await app.request('/orgs/organizations/org-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'offboarding' })
      });

      expect(res.status).toBe(200);
      expect(beginOrganizationOffboarding).toHaveBeenCalledWith('org-1', expect.anything());
      expect(revokeOrganizationTenantAccess).not.toHaveBeenCalled();
      expect(restoreOrganizationTenantAccess).not.toHaveBeenCalled();
    });

    it('aborts a drain before severing when an org is forced to suspended', async () => {
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
      expect(abortOrganizationOffboarding).toHaveBeenCalledWith('org-1');
      expect(revokeOrganizationTenantAccess).toHaveBeenCalledWith('org-1');
    });

    it('aborts a drain on reactivation so in-flight uninstalls cannot fire later', async () => {
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
      expect(abortOrganizationOffboarding).toHaveBeenCalledWith('org-1');
      expect(restoreOrganizationTenantAccess).toHaveBeenCalledWith('org-1');
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

    // #2879 — suspended orgs are excluded from accessibleOrgIds, which made
    // suspended→offboarding (and reactivation) unreachable for the partner
    // that suspended the org. A narrow override lets a partner admin apply a
    // STATUS-ONLY lifecycle transition to a suspended org it owns; everything
    // else stays 404.
    describe('suspended-org lifecycle override (#2879)', () => {
      // db.select mock for one .select().from().where().limit() call.
      const selectLimitOnce = (rows: unknown[]) => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(rows)
          })
        })
      });

      const mockUpdateReturning = (rows: unknown[]) => {
        const returning = vi.fn().mockResolvedValue(rows);
        vi.mocked(db.update).mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ returning })
          })
        } as any);
        return returning;
      };

      // Partner admin whose accessible set does NOT include the suspended org
      // (that's the bug's precondition — computeAccessibleOrgIds filtered it out).
      const setSuspendedOrgPartnerContext = (
        partnerOrgAccess: 'all' | 'selected' | 'none' = 'all'
      ) => {
        setAuthContext({
          scope: 'partner',
          partnerId: 'partner-123',
          accessibleOrgIds: ['org-1'],
          partnerOrgAccess
        });
      };

      const patchOrg = (orgId: string, body: Record<string, unknown>) =>
        app.request(`/orgs/organizations/${orgId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

      it('lets the owning partner admin move a suspended org to offboarding', async () => {
        setSuspendedOrgPartnerContext('all');
        // Ownership probe: suspended org under the caller's partner.
        vi.mocked(db.select).mockReturnValueOnce(
          selectLimitOnce([{ partnerId: 'partner-123', status: 'suspended' }]) as any
        );
        const returning = mockUpdateReturning([{ id: 'org-suspended', name: 'O', status: 'offboarding' }]);

        const res = await patchOrg('org-suspended', { status: 'offboarding' });

        expect(res.status).toBe(200);
        expect(beginOrganizationOffboarding).toHaveBeenCalledWith('org-suspended', 'user-123');
        // The override WRITE must escape the partner RLS context (which cannot
        // see the suspended org) into its own fresh system-scope transaction —
        // the ownership probe alone is not enough (in production the UPDATE
        // would silently match 0 rows → 404, re-opening #2879). Assert ≥2
        // system-context entries happened BEFORE the UPDATE's returning()
        // executed (probe + update wrapper); the fire-and-forget audit write
        // always lands after the update, so it cannot satisfy this.
        const returningOrder = returning.mock.invocationCallOrder[0]!;
        const sysCtxEntriesBeforeUpdate = vi.mocked(withSystemDbAccessContext)
          .mock.invocationCallOrder.filter((order) => order < returningOrder).length;
        expect(sysCtxEntriesBeforeUpdate).toBeGreaterThanOrEqual(2);
        // The override UPDATE must re-assert, in its own WHERE, the facts the
        // probe checked — partner-owned AND still suspended — so a concurrent
        // change between check and write collapses to 0 rows instead of
        // resurrecting a churned/reparented org (TOCTOU guard).
        expect(eq).toHaveBeenCalledWith(organizations.status, 'suspended');
        expect(eq).toHaveBeenCalledWith(organizations.partnerId, 'partner-123');
      });

      it('does not add the override predicates on the normal accessible-org path', async () => {
        setSuspendedOrgPartnerContext('all');
        // org-1 IS in accessibleOrgIds → normal path, no override.
        mockUpdateReturning([{ id: 'org-1', name: 'O', status: 'active' }]);

        const res = await patchOrg('org-1', { status: 'active' });

        expect(res.status).toBe(200);
        expect(eq).not.toHaveBeenCalledWith(organizations.status, 'suspended');
      });

      it('lets the owning partner admin reactivate a suspended org to active', async () => {
        setSuspendedOrgPartnerContext('all');
        vi.mocked(db.select).mockReturnValueOnce(
          selectLimitOnce([{ partnerId: 'partner-123', status: 'suspended' }]) as any
        );
        mockUpdateReturning([{ id: 'org-suspended', name: 'O', status: 'active' }]);

        const res = await patchOrg('org-suspended', { status: 'active' });

        expect(res.status).toBe(200);
        expect(restoreOrganizationTenantAccess).toHaveBeenCalledWith('org-suspended');
      });

      it('denies the override for a cross-partner suspended org (404, no write)', async () => {
        setSuspendedOrgPartnerContext('all');
        vi.mocked(db.select).mockReturnValueOnce(
          selectLimitOnce([{ partnerId: 'partner-OTHER', status: 'suspended' }]) as any
        );

        const res = await patchOrg('org-suspended', { status: 'offboarding' });

        expect(res.status).toBe(404);
        expect(db.update).not.toHaveBeenCalled();
        expect(beginOrganizationOffboarding).not.toHaveBeenCalled();
      });

      it('denies the override when the target org is not actually suspended', async () => {
        setSuspendedOrgPartnerContext('all');
        // e.g. an org already flipped to churned out-of-band.
        vi.mocked(db.select).mockReturnValueOnce(
          selectLimitOnce([{ partnerId: 'partner-123', status: 'churned' }]) as any
        );

        const res = await patchOrg('org-invisible', { status: 'offboarding' });

        expect(res.status).toBe(404);
        expect(db.update).not.toHaveBeenCalled();
      });

      it('does NOT let a non-status edit ride the override — suspended orgs stay unwritable', async () => {
        setSuspendedOrgPartnerContext('all');

        const res = await patchOrg('org-suspended', { name: 'Renamed while suspended' });

        expect(res.status).toBe(404);
        expect(db.select).not.toHaveBeenCalled(); // rejected before any DB probe
        expect(db.update).not.toHaveBeenCalled();
      });

      it('does NOT allow extra fields alongside status on the override', async () => {
        setSuspendedOrgPartnerContext('all');

        const res = await patchOrg('org-suspended', { status: 'offboarding', name: 'sneaky' });

        expect(res.status).toBe(404);
        // Rejected on payload shape BEFORE any DB probe — without this pin the
        // test passes vacuously off the default empty select mock even if the
        // status-only guard is deleted (mutation-proven in review).
        expect(db.select).not.toHaveBeenCalled();
        expect(db.update).not.toHaveBeenCalled();
      });

      it('does NOT allow suspended→churned (must drain via offboarding)', async () => {
        setSuspendedOrgPartnerContext('all');

        const res = await patchOrg('org-suspended', { status: 'churned' });

        expect(res.status).toBe(404);
        // Same vacuity pin as above: churned must be rejected by the exit-status
        // allowlist itself, before any DB probe.
        expect(db.select).not.toHaveBeenCalled();
        expect(db.update).not.toHaveBeenCalled();
      });

      it('fails closed for a partner user with org_access none', async () => {
        setSuspendedOrgPartnerContext('none');

        const res = await patchOrg('org-suspended', { status: 'offboarding' });

        expect(res.status).toBe(404);
        expect(db.select).not.toHaveBeenCalled();
        expect(db.update).not.toHaveBeenCalled();
      });

      it("grants a 'selected' user the override only when the org is in their raw selection", async () => {
        setSuspendedOrgPartnerContext('selected');
        vi.mocked(db.select)
          .mockReturnValueOnce(selectLimitOnce([{ partnerId: 'partner-123', status: 'suspended' }]) as any)
          .mockReturnValueOnce(selectLimitOnce([{ orgIds: ['org-suspended', 'org-1'] }]) as any);
        const returning = mockUpdateReturning([{ id: 'org-suspended', name: 'O', status: 'offboarding' }]);

        const res = await patchOrg('org-suspended', { status: 'offboarding' });

        expect(res.status).toBe(200);
        expect(beginOrganizationOffboarding).toHaveBeenCalledWith('org-suspended', 'user-123');
        // Same system-context escape pin as the 'all' happy path (probe +
        // update wrapper both before the UPDATE executed).
        const returningOrder = returning.mock.invocationCallOrder[0]!;
        const sysCtxEntriesBeforeUpdate = vi.mocked(withSystemDbAccessContext)
          .mock.invocationCallOrder.filter((order) => order < returningOrder).length;
        expect(sysCtxEntriesBeforeUpdate).toBeGreaterThanOrEqual(2);
      });

      it("denies a 'selected' user whose selection does not include the org", async () => {
        setSuspendedOrgPartnerContext('selected');
        vi.mocked(db.select)
          .mockReturnValueOnce(selectLimitOnce([{ partnerId: 'partner-123', status: 'suspended' }]) as any)
          .mockReturnValueOnce(selectLimitOnce([{ orgIds: ['org-1'] }]) as any);

        const res = await patchOrg('org-suspended', { status: 'offboarding' });

        expect(res.status).toBe(404);
        expect(db.update).not.toHaveBeenCalled();
      });

      it('ordinary read routes still cannot see the suspended org (no visibility widening)', async () => {
        setSuspendedOrgPartnerContext('all');

        // The suspended org's id, UUID-shaped so the read route reaches its
        // real branches instead of the malformed-id short-circuit.
        const suspendedOrgId = '88888888-8888-8888-8888-888888888888';
        const res = await app.request(`/orgs/organizations/${suspendedOrgId}`);

        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Organization not found' });
        expect(db.select).not.toHaveBeenCalled();
        // Wave 4's archived probe is the only extra lookup, and it is scoped to
        // ARCHIVED orgs of the caller's own partner — a SUSPENDED org resolves
        // to null there (loadArchivedOrg checks the status itself), so this
        // route still cannot see it.
        expect(loadArchivedOrg).toHaveBeenCalledWith({
          orgId: suspendedOrgId,
          scope: { kind: 'partner', partnerId: 'partner-123' }
        });
      });
    });

    // #2879 — a membership-less platform admin has no role row, so plain
    // requirePermission 403s and system scope could not drive lifecycle
    // transitions. The update route grants scope=system + isPlatformAdmin
    // directly (mirroring platformAdminMiddleware's authority model).
    describe('platform-admin permission bypass on org update (#2879)', () => {
      it('lets a membership-less platform admin update an org when role permissions resolve to none', async () => {
        permissionMockState.granted = false; // simulate "No permissions found"
        setAuthContext({
          scope: 'system',
          partnerId: null,
          user: { id: 'admin-1', email: 'admin@example.com', name: 'Admin', isPlatformAdmin: true }
        });
        vi.mocked(db.update).mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'org-1', name: 'O', status: 'offboarding' }])
            })
          })
        } as any);

        const res = await app.request('/orgs/organizations/org-1', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'offboarding' })
        });

        expect(res.status).toBe(200);
        expect(beginOrganizationOffboarding).toHaveBeenCalledWith('org-1', 'admin-1');
      });

      it('does NOT bypass permissions for a system-scope caller without isPlatformAdmin', async () => {
        permissionMockState.granted = false;
        setAuthContext({
          scope: 'system',
          partnerId: null,
          user: { id: 'svc-1', email: 'svc@example.com', name: 'Svc', isPlatformAdmin: false }
        });

        const res = await app.request('/orgs/organizations/org-1', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'offboarding' })
        });

        expect(res.status).toBe(403);
        expect(db.update).not.toHaveBeenCalled();
      });

      it('does NOT bypass permissions for partner scope even for a platform admin flag', async () => {
        permissionMockState.granted = false;
        setAuthContext({
          scope: 'partner',
          partnerId: 'partner-123',
          user: { id: 'user-123', email: 'test@example.com', name: 'T', isPlatformAdmin: true }
        });

        const res = await app.request('/orgs/organizations/org-1', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'offboarding' })
        });

        expect(res.status).toBe(403);
        expect(db.update).not.toHaveBeenCalled();
      });

      it('does NOT extend the bypass to other org routes — DELETE still requires role permissions', async () => {
        permissionMockState.granted = false;
        setAuthContext({
          scope: 'system',
          partnerId: null,
          user: { id: 'admin-1', email: 'admin@example.com', name: 'Admin', isPlatformAdmin: true }
        });

        const res = await app.request('/orgs/organizations/org-1', { method: 'DELETE' });

        expect(res.status).toBe(403);
        expect(db.update).not.toHaveBeenCalled(); // soft-delete write never runs
      });
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

    // issue #2776: defaultEnrollmentTtlMinutes/defaultEnrollmentDeviceCount are
    // inherit-with-override, same contract as agentVersionPins above — a
    // partner-set value must NOT block an org override via assertNotLocked.
    it('lets an org override the partner TTL default without a 403', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      primeAcceptSelect([], { defaults: { defaultEnrollmentTtlMinutes: 10080 } });

      const res = await app.request('/orgs/organizations/org-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { defaults: { defaultEnrollmentTtlMinutes: 60 } } })
      });

      expect(res.status).toBe(200);
      expect(db.update).toHaveBeenCalled();
    });

    // maxEnrollmentLinkTtlMinutes is the hard ceiling — partner-only, deliberately
    // NOT exempt from assertNotLocked. An org attempting to raise it must 403.
    it('403s when an org tries to set the partner-owned cap', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      primeAcceptSelect([], { defaults: { maxEnrollmentLinkTtlMinutes: 129600 } });

      const res = await app.request('/orgs/organizations/org-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { defaults: { maxEnrollmentLinkTtlMinutes: 525600 } } })
      });

      expect(res.status).toBe(403);
      expect(db.update).not.toHaveBeenCalled();
    });

    // The org `settings` blob is z.any() — nothing structurally validates it
    // except the explicit enrollmentDefaultsSchema.safeParse check added for
    // issue #2776. An out-of-range value must 400 before any DB work.
    it('400s on an out-of-range org enrollment default (org settings are z.any())', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });

      const res = await app.request('/orgs/organizations/org-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { defaults: { defaultEnrollmentTtlMinutes: 525601 } } })
      });

      expect(res.status).toBe(400);
      expect(db.update).not.toHaveBeenCalled();
    });

    // Carried-forward edge case from the Task 3.1 review: `'field' in obj` is
    // true even when the value is explicitly `null`, which would make the
    // resolver fall through to the product default instead of the partner's
    // value. A stored null must be unreachable — reject it at write time.
    it('400s on a null enrollment default value instead of storing it', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });

      const res = await app.request('/orgs/organizations/org-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { defaults: { defaultEnrollmentTtlMinutes: null } } })
      });

      expect(res.status).toBe(400);
      expect(db.update).not.toHaveBeenCalled();
    });

    // #2752 — the org defaults editor posts the WHOLE category on every save, so a
    // partner-set `autoEnrollment` was re-submitted even when the operator only
    // touched the device group. The old presence-only lock check 403'd the entire
    // request, making every org-level default in the category unsaveable. Echoing
    // the partner's own value back is a no-op and must be accepted.
    it('accepts a save that re-sends a partner-locked field unchanged alongside edited fields (200)', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      const enforced = { enabled: false, requireApproval: false, sendWelcome: false };
      primeAcceptSelect([], { defaults: { autoEnrollment: enforced } });

      const res = await app.request('/orgs/organizations/org-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settings: {
            defaults: {
              autoEnrollment: enforced, // untouched, locked by the partner
              deviceGroup: 'Contractors', // the field the operator actually changed
              alertThreshold: 'medium',
              agentUpdatePolicy: 'manual',
              maintenanceWindow: '24/7',
            },
          },
        }),
      });

      expect(res.status).toBe(200);
      expect(db.update).toHaveBeenCalled();
    });

    it('still rejects a save that changes a partner-locked field (403)', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      primeAcceptSelect([], {
        defaults: { autoEnrollment: { enabled: false, requireApproval: false, sendWelcome: false } },
      });

      const res = await app.request('/orgs/organizations/org-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settings: {
            defaults: {
              autoEnrollment: { enabled: true, requireApproval: false, sendWelcome: false },
              deviceGroup: 'Contractors',
            },
          },
        }),
      });

      expect(res.status).toBe(403);
      // HTTPException surfaces its message as plain text, not a JSON envelope.
      expect(await res.text()).toContain('defaults.autoEnrollment');
      expect(db.update).not.toHaveBeenCalled();
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

  // The three db.select calls GET /orgs/sites makes for one page of results:
  // count, the page itself, then the grouped device counts.
  const mockSitesPage = () => {
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
      .mockReturnValueOnce(mockSiteDeviceCounts([{ siteId: 'site-1', count: 4 }]));
  };

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

    it('carries the org\'s resolved enrollment defaults for the Add Device modal (#2776)', async () => {
      setAuthContext({ scope: 'organization', orgId: '11111111-1111-1111-1111-111111111111' });
      mockSitesPage();

      const res = await app.request(
        '/orgs/sites?orgId=11111111-1111-1111-1111-111111111111&includeEnrollmentDefaults=1'
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      // Seeds the modal's pickers without a second round trip on the
      // device-add path.
      expect(body.enrollmentDefaults).toEqual({
        ttlMinutes: 10080,
        deviceCount: 25,
        maxTtlMinutes: 43200
      });
      expect(getEnrollmentDefaultsForOrg).toHaveBeenCalledWith(
        '11111111-1111-1111-1111-111111111111'
      );
    });

    it('does NOT resolve enrollment defaults unless the caller opts in', async () => {
      // The resolver escapes to a system context, taking a SECOND pooled
      // connection while this request still holds the first. postgres-js has no
      // acquire timeout, so at N concurrent requests >= DB_POOL_MAX the API
      // stalls indefinitely. This route fires on org switch, on Discovery, and
      // on every Add Device modal open — so only the caller that needs the
      // values pays for them.
      setAuthContext({ scope: 'organization', orgId: '11111111-1111-1111-1111-111111111111' });
      mockSitesPage();

      const res = await app.request('/orgs/sites?orgId=11111111-1111-1111-1111-111111111111');

      expect(res.status).toBe(200);
      expect('enrollmentDefaults' in (await res.json())).toBe(false);
      expect(getEnrollmentDefaultsForOrg).not.toHaveBeenCalled();
    });

    it('omits enrollment defaults when no single org is in scope', async () => {
      // A cross-org list has no one org whose defaults would be correct.
      setAuthContext({ scope: 'system' });
      mockSitesPage();

      const res = await app.request('/orgs/sites?includeEnrollmentDefaults=1');

      expect(res.status).toBe(200);
      expect('enrollmentDefaults' in (await res.json())).toBe(false);
      expect(getEnrollmentDefaultsForOrg).not.toHaveBeenCalled();
    });

    it('still serves the site list when the enrollment-defaults read fails', async () => {
      setAuthContext({ scope: 'organization', orgId: '11111111-1111-1111-1111-111111111111' });
      mockSitesPage();
      vi.mocked(getEnrollmentDefaultsForOrg).mockRejectedValueOnce(new Error('pg down'));

      const res = await app.request(
        '/orgs/sites?orgId=11111111-1111-1111-1111-111111111111&includeEnrollmentDefaults=1'
      );

      // A settings read must never take down a sites list — the client falls
      // back to the product defaults.
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect('enrollmentDefaults' in body).toBe(false);
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
          returning: vi.fn().mockResolvedValue([
            { id: 'site-3', orgId: '11111111-1111-1111-1111-111111111111', name: 'Site C' }
          ])
        })
      } as any);
      // A site created WITH a contact now mirrors it into `contacts`, which
      // reads the existing primary first. Earlier tests leave a narrower select
      // chain on the shared mock, so re-declare one that reaches .limit().
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) })
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
          returning: vi.fn().mockResolvedValue([
            { id: 'site-4', orgId: '11111111-1111-1111-1111-111111111111', name: 'Site D' }
          ])
        })
      } as any);
      // See the phone-only test above: the contact mirror reads before writing.
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) })
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

    it('selects an explicit column projection that excludes internal metadata columns', async () => {
      // Serialization hygiene: the handler must pass an explicit column map to
      // db.select() so internal columns (signup attribution, Stripe linkage,
      // MCP-origin metadata, ssoConfig) never reach partner-scoped tokens —
      // and a future column added to the schema does not auto-appear in the
      // response. The db is mocked, so the enforcing assertion here is the
      // projection object the handler hands to select(), not the mocked body.
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      let selectedColumns: Record<string, unknown> | undefined;
      vi.mocked(db.select).mockImplementationOnce(((columns: Record<string, unknown>) => {
        selectedColumns = columns;
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: 'partner-123', name: 'Acme MSP', slug: 'acme', settings: {} }])
            })
          })
        };
      }) as any);

      const res = await app.request('/orgs/partners/me');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ id: 'partner-123', name: 'Acme MSP', slug: 'acme' });

      expect(selectedColumns).toBeDefined();
      const keys = Object.keys(selectedColumns!);
      for (const expected of [
        'id', 'name', 'slug', 'type', 'plan', 'status', 'timezone', 'settings',
        'billingEmail', 'emailSignature', 'inboundLocalPart', 'currencyCode',
        'defaultTaxRate', 'invoiceNumberPrefix', 'invoiceTermsDays', 'invoiceFooter',
        'billingCompanyName', 'billingPhone', 'billingWebsite',
        'billingAddressLine1', 'billingAddressLine2', 'billingAddressCity',
        'billingAddressRegion', 'billingAddressPostalCode', 'billingAddressCountry',
        'billingTermsAndConditions', 'defaultMarkupPercent', 'autoTaxHardware',
        'catalogAiStyle', 'aiForOfficeEnabled', 'createdAt', 'updatedAt',
      ]) {
        expect(keys).toContain(expected);
      }
      for (const internal of [
        'signupIp', 'signupUserAgent', 'mcpOrigin', 'mcpOriginIp', 'mcpOriginUserAgent',
        'emailVerifiedAt', 'paymentMethodAttachedAt', 'stripeCustomerId', 'ssoConfig', 'deletedAt',
        // Billing identity snapshot (written by the billing service, read by
        // the abuse sweep). Cardholder name and card fingerprint must never be
        // served to a partner-scoped token.
        'billingCardholderName', 'billingCardCountry', 'billingCardFingerprint',
        'billingDistinctPaymentMethods', 'billingFailedAttempts',
        'billingPaymentMethodsFirstSeenAt', 'billingPaymentMethodsLastSeenAt',
        'billingIdentitySyncedAt', 'billingSubscriptionStatus',
      ]) {
        expect(keys).not.toContain(internal);
      }
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
    it.each(['pt-BR', 'es-419', 'fr-FR', 'fr-CA', 'de-DE', 'it-IT', 'tr-TR'] as const)(
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

    it('passes an explicit column projection to .returning() that excludes internal metadata columns', async () => {
      // Same serialization-hygiene contract as GET /partners/me: the updated
      // row is echoed back to a partner-scoped token, so the .returning()
      // clause must be an explicit projection — never the whole partners row.
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      const currentPartner = { id: 'partner-123', name: 'Acme MSP', settings: {} };
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([currentPartner]),
          }),
        }),
      } as any);
      let returningColumns: Record<string, unknown> | undefined;
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockImplementation((columns: Record<string, unknown>) => {
              returningColumns = columns;
              return Promise.resolve([{ ...currentPartner, name: 'Acme Managed Services' }]);
            }),
          }),
        }),
      } as any);

      const res = await app.request('/orgs/partners/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Acme Managed Services' }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: 'partner-123', name: 'Acme Managed Services' });

      expect(returningColumns).toBeDefined();
      const keys = Object.keys(returningColumns!);
      for (const expected of ['id', 'name', 'slug', 'status', 'settings', 'billingEmail', 'emailSignature', 'updatedAt']) {
        expect(keys).toContain(expected);
      }
      for (const internal of [
        'signupIp', 'signupUserAgent', 'mcpOrigin', 'mcpOriginIp', 'mcpOriginUserAgent',
        'emailVerifiedAt', 'paymentMethodAttachedAt', 'stripeCustomerId', 'ssoConfig', 'deletedAt',
        // Billing identity snapshot (written by the billing service, read by
        // the abuse sweep). Cardholder name and card fingerprint must never be
        // served to a partner-scoped token.
        'billingCardholderName', 'billingCardCountry', 'billingCardFingerprint',
        'billingDistinctPaymentMethods', 'billingFailedAttempts',
        'billingPaymentMethodsFirstSeenAt', 'billingPaymentMethodsLastSeenAt',
        'billingIdentitySyncedAt', 'billingSubscriptionStatus',
      ]) {
        expect(keys).not.toContain(internal);
      }
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

    // finding #2b: assertNotLocked (services/effectiveSettings.ts) compares with
    // isDeepStrictEqual, which is array-order-sensitive. PUT /ai/budget already
    // normalises alertThresholdPercents before persisting; this partner-scoped
    // aiBudgets write path (the partner-wide equivalent) must do the same so a
    // legitimate no-op resubmit in a different array order isn't stored
    // differently from what was actually enforced.
    it('normalises aiBudgets.alertThresholdPercents before persisting', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      const currentPartner = { id: 'partner-123', name: 'Acme MSP', settings: {} };
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([currentPartner]),
          }),
        }),
      } as any);
      let persistedSettings: Record<string, unknown> | undefined;
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockImplementation((data: Record<string, unknown>) => {
          persistedSettings = data.settings as Record<string, unknown>;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ ...currentPartner, settings: persistedSettings }]),
            }),
          };
        }),
      } as any);

      const res = await app.request('/orgs/partners/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settings: { aiBudgets: { alertThresholdPercents: [95, 50, 50] } },
        }),
      });

      expect(res.status).toBe(200);
      expect(persistedSettings?.aiBudgets).toMatchObject({ alertThresholdPercents: [50, 95] });
    });

    // spec §4.2 #3: a partner-wide cap/rung change must be re-evaluated for
    // every org off-request, since the effective budget for orgs with no
    // org-level override changes the instant the partner-wide default does.
    it('enqueues a partner-wide budget re-evaluation when aiBudgets change (#4388)', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      const currentPartner = { id: 'partner-123', name: 'Acme MSP', settings: {} };
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([currentPartner]),
          }),
        }),
      } as any);
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ ...currentPartner, settings: { aiBudgets: { monthlyBudgetCents: 5000 } } }]),
          }),
        }),
      } as any);

      const res = await app.request('/orgs/partners/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { aiBudgets: { monthlyBudgetCents: 5000 } } }),
      });

      expect(res.status).toBe(200);
      expect(enqueueAiBudgetEvaluationForPartner).toHaveBeenCalledWith('partner-123');
    });

    // W02 minor 8: `!== undefined` fires the fleet-wide fan-out on every save
    // of the AI settings card, including the many that re-post an unchanged
    // aiBudgets block alongside an edit to some other field. The fan-out walks
    // EVERY org of the partner and evaluates each one, so a no-op resubmit is
    // real, avoidable load. Compare the value actually being persisted against
    // the previous one.
    it('does NOT enqueue when the submitted aiBudgets is deep-equal to the stored one (#4388 W02)', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      const storedAiBudgets = { monthlyBudgetCents: 5000, alertThresholdPercents: [50, 95] };
      const currentPartner = { id: 'partner-123', name: 'Acme MSP', settings: { aiBudgets: storedAiBudgets } };
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([currentPartner]),
          }),
        }),
      } as any);
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([currentPartner]),
          }),
        }),
      } as any);

      const res = await app.request('/orgs/partners/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // Rungs resubmitted in a different order: normalisation makes this
        // byte-identical to what is already stored, so it is a true no-op.
        body: JSON.stringify({ settings: { aiBudgets: { monthlyBudgetCents: 5000, alertThresholdPercents: [95, 50] } } }),
      });

      expect(res.status).toBe(200);
      expect(enqueueAiBudgetEvaluationForPartner).not.toHaveBeenCalled();
    });

    // NOTE: `updatePartnerSettingsSchema`'s `aiBudgets` field is
    // `z.object({...}).optional()`, not `.nullable()` — an explicit
    // `{ aiBudgets: null }` is rejected by zValidator before the handler ever
    // runs (confirmed: zod's `invalid_type` on `null` for an optional object).
    // So the `!== undefined` check in the handler (rather than a truthy check)
    // is written to also cover a future null-clearing payload once the schema
    // allows one, but that scenario isn't reachable through this route today
    // and isn't exercised here — only the two reachable cases are.

    it('does NOT enqueue a partner-wide budget re-evaluation on a PATCH that does not touch aiBudgets', async () => {
      setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
      const currentPartner = { id: 'partner-123', name: 'Acme MSP', settings: {} };
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([currentPartner]),
          }),
        }),
      } as any);
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ ...currentPartner, name: 'Acme Managed Services' }]),
          }),
        }),
      } as any);

      const res = await app.request('/orgs/partners/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Acme Managed Services' }),
      });

      expect(res.status).toBe(200);
      expect(enqueueAiBudgetEvaluationForPartner).not.toHaveBeenCalled();
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

    // issue #2776: the partner `defaults` Zod block has no `.passthrough()`, so
    // unlisted keys are silently stripped rather than rejected — a partner PATCH
    // would appear to succeed while discarding the values unless all three
    // enrollment fields are listed explicitly in the schema.
    it('persists partner enrollment defaults through PATCH /partners/me', async () => {
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
      // Capture the ACTUAL settings object the handler sends to db.update rather
      // than trusting a hardcoded mock return value — otherwise this test can't
      // distinguish "persisted" from "silently stripped by zod then echoed back
      // by the mock" (the exact trap this task calls out: the partner `defaults`
      // block has no `.passthrough()`).
      let capturedUpdateData: any;
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockImplementation((data: any) => {
          capturedUpdateData = data;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{
                ...currentPartner,
                settings: data.settings,
              }])
            })
          };
        })
      } as any);

      const res = await app.request('/orgs/partners/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { defaults: {
          defaultEnrollmentTtlMinutes: 10080,
          maxEnrollmentLinkTtlMinutes: 43200,
        } } }),
      });

      expect(res.status).toBe(200);
      expect(capturedUpdateData.settings.defaults.defaultEnrollmentTtlMinutes).toBe(10080);
      expect(capturedUpdateData.settings.defaults.maxEnrollmentLinkTtlMinutes).toBe(43200);
      const body = await res.json();
      expect(body.settings.defaults.defaultEnrollmentTtlMinutes).toBe(10080);
      expect(body.settings.defaults.maxEnrollmentLinkTtlMinutes).toBe(43200);
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
      // 2) partner-settings read — throws. Since #4004 this runs BEFORE the
      // page query, because its result is the leading ORDER BY term; the
      // soft-fail therefore has to leave the list query itself still runnable.
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockRejectedValue(new Error('db blew up'))
          })
        })
      } as any);
      // 3) main list query — still runs, ordered by the created_at, id fallback
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
      // 4) grouped per-org device counts (#3699) — runs after the soft-fail,
      // proving the settings failure degrades ordering only and still yields
      // a fully-shaped list response.
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            groupBy: vi.fn().mockResolvedValue([{ orgId: 'org-1', count: 7 }])
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

  describe('POST /orgs/import/preview and /orgs/import (#3242)', () => {
    const previewBody = { rows: [{ organization: 'Acme', site: 'HQ' }] };

    it('preview returns the annotated rows for the partner scope caller', async () => {
      setAuthContext({ scope: 'partner' });
      orgImportMocks.previewOrgImport.mockResolvedValue([
        { index: 0, organization: 'Acme', site: 'HQ', annotation: 'create', slug: 'acme', organizationId: null },
      ]);

      const res = await app.request('/orgs/import/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(previewBody),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.rows).toHaveLength(1);
      expect(body.rows[0]).toMatchObject({ annotation: 'create', slug: 'acme' });
      expect(orgImportMocks.previewOrgImport).toHaveBeenCalledWith(previewBody.rows, 'partner-123');
    });

    it('rejects the organization scope (partner/system only)', async () => {
      setAuthContext({ scope: 'organization' });
      const res = await app.request('/orgs/import/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(previewBody),
      });
      expect(res.status).toBe(403);
      expect(orgImportMocks.previewOrgImport).not.toHaveBeenCalled();
    });

    it('403s when the caller lacks orgs:write', async () => {
      permissionMockState.granted = false;
      const res = await app.request('/orgs/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(previewBody),
      });
      expect(res.status).toBe(403);
      expect(orgImportMocks.commitOrgImport).not.toHaveBeenCalled();
    });

    it('403s commit when the caller lacks sites:write (the import creates sites too)', async () => {
      permissionMockState.denied.add('sites:write');
      const res = await app.request('/orgs/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(previewBody),
      });
      expect(res.status).toBe(403);
      expect(orgImportMocks.commitOrgImport).not.toHaveBeenCalled();
    });

    it('403s preview when the caller lacks sites:write (early honest failure)', async () => {
      permissionMockState.denied.add('sites:write');
      const res = await app.request('/orgs/import/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(previewBody),
      });
      expect(res.status).toBe(403);
      expect(orgImportMocks.previewOrgImport).not.toHaveBeenCalled();
    });

    it('rejects a partner-scope body naming a different partner', async () => {
      setAuthContext({ scope: 'partner' });
      const res = await app.request('/orgs/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...previewBody, partnerId: '99999999-9999-9999-9999-999999999999' }),
      });
      expect(res.status).toBe(403);
      expect(orgImportMocks.commitOrgImport).not.toHaveBeenCalled();
    });

    it('400s when system scope supplies no partnerId', async () => {
      setAuthContext({ scope: 'system', partnerId: null });
      const res = await app.request('/orgs/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(previewBody),
      });
      expect(res.status).toBe(400);
    });

    it('enforces the 1000-row cap at validation time', async () => {
      const rows = Array.from({ length: 1001 }, (_, i) => ({ organization: `Org ${i}` }));
      const res = await app.request('/orgs/import/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
      });
      expect(res.status).toBe(400);
      expect(orgImportMocks.previewOrgImport).not.toHaveBeenCalled();
    });

    it('rejects an invalid IANA timezone at validation time', async () => {
      const res = await app.request('/orgs/import/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: [{ organization: 'Acme', timezone: 'Not/AZone' }] }),
      });
      expect(res.status).toBe(400);
    });

    it('commit forwards rows, partner, actor, and mode to the service and returns its summary', async () => {
      setAuthContext({ scope: 'partner' });
      const summary = {
        imported: [{
          index: 0, organization: 'Acme', organizationId: 'org-1', siteId: 'site-1', siteName: 'HQ',
          createdOrganization: true, createdLink: true, slug: 'acme',
        }],
        updated: [],
        skipped: [],
        errors: [],
      };
      orgImportMocks.commitOrgImport.mockResolvedValue(summary);

      const res = await app.request('/orgs/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: [{ organization: 'Acme', site: 'HQ', externalId: '1', externalSystem: 'datto_rmm', expectedAnnotation: 'create' }],
          mode: 'update',
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(summary);
      expect(orgImportMocks.commitOrgImport).toHaveBeenCalledWith(
        [expect.objectContaining({ organization: 'Acme', expectedAnnotation: 'create' })],
        'partner-123',
        { userId: 'user-123' },
        'update',
      );
    });

    it('commit defaults mode to skip', async () => {
      orgImportMocks.commitOrgImport.mockResolvedValue({ imported: [], updated: [], skipped: [], errors: [] });
      const res = await app.request('/orgs/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(previewBody),
      });
      expect(res.status).toBe(200);
      expect(orgImportMocks.commitOrgImport).toHaveBeenCalledWith(
        expect.anything(), expect.anything(), expect.anything(), 'skip',
      );
    });

    it('rejects an unknown expectedAnnotation value', async () => {
      const res = await app.request('/orgs/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: [{ organization: 'Acme', expectedAnnotation: 'conflict' }] }),
      });
      expect(res.status).toBe(400);
    });
  });
});

describe('org status is not manually settable to lifecycle states', () => {
  for (const status of ['merging', 'archived', 'purging']) {
    it(`create rejects status='${status}'`, () => {
      const r = createOrganizationSchema.safeParse({ name: 'X', slug: 'x', status });
      expect(r.success).toBe(false);
      expect(r.error!.issues.some(i => i.path[0] === 'status')).toBe(true);
    });
    it(`update rejects status='${status}'`, () => {
      const r = updateOrganizationSchema.safeParse({ status });
      expect(r.success).toBe(false);
      expect(r.error!.issues.some(i => i.path[0] === 'status')).toBe(true);
    });
  }
});
