import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
  // GET /partner/me reads `partners` through readWithPartnerAxisVisibility
  // (#2822); the helper probes the ambient scope, so the factory must export it.
  getCurrentDbAccessContext: vi.fn(() => undefined),
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn()
  }
}));

const emailMock = vi.hoisted(() => ({ getEmailService: vi.fn() }));
vi.mock('../services/email', () => emailMock);

vi.mock('../db/schema', () => ({
  partners: {
    id: 'id', name: 'name', slug: 'slug', status: 'status', settings: 'settings'
  },
  partnerUsers: { userId: 'userId', partnerId: 'partnerId' },
  organizations: {
    id: 'id',
    name: 'name',
    status: 'status',
    deletedAt: 'deletedAt'
  },
  devices: {
    id: 'id',
    orgId: 'orgId',
    hostname: 'hostname',
    status: 'status',
    lastSeenAt: 'lastSeenAt'
  },
  alerts: { orgId: 'alerts.orgId', deviceId: 'alerts.deviceId', status: 'alerts.status' }
}));

// Compliance comes from the persisted security-posture scores (#11039).
const postureMock = vi.hoisted(() => ({ listLatestPostureScoresByOrgs: vi.fn(async () => [] as any[]) }));
vi.mock('../services/securityPosture', () => postureMock);

const currentPermissions: { value: Array<{ resource: string; action: string }> } = { value: [{ resource: '*', action: '*' }] };

// Mutable so a test can swap in an ORGANIZATION-scoped caller — the population
// GET /partner/me was silently 404ing for (#2822).
const currentAuth: { value: Record<string, unknown> } = {
  value: {
    user: { id: 'user-123', email: 'partner@example.com', name: 'Partner User' },
    scope: 'partner',
    orgId: null,
    partnerId: 'partner-123',
    accessibleOrgIds: ['org-123'],
    canAccessOrg: (orgId: string) => orgId === 'org-123'
  },
};

// requireScope stays REAL: GET /partner/dashboard's site-scope exemption rests on
// its scope gate, so a no-op mock here would let that gate disappear unnoticed.
vi.mock('../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth')>();
  return {
    authMiddleware: vi.fn((c: any, next: any) => {
      c.set('auth', currentAuth.value);
      c.set('permissions', { permissions: currentPermissions.value });
      return next();
    }),
    requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
    requireScope: actual.requireScope,
  };
});

// Multi-currency wave 7 (#3779): the dashboard's per-currency MRR comes from
// contractMrr (#9828). This file mocks `../db` wholesale, so mock the service
// rather than extending the db.select mock queue with its two reads.
vi.mock('../services/contractMrr', () => ({
  summarizeActiveContractMrrByOrg: vi.fn(async () => new Map([
    ['org-123', [{ currencyCode: 'EUR', amount: '410.00' }, { currencyCode: 'USD', amount: '1230.00' }]],
  ])),
}));

// GET /partner/me/entitlements (#9907) reads through the resolver; its own
// real-Postgres contract lives in partnerEntitlementsRls.integration.test.ts.
const entitlementsMock = vi.hoisted(() => {
  class EntitlementResolutionError extends Error {}
  return { getEntitlements: vi.fn(), EntitlementResolutionError };
});
vi.mock('../services/entitlements', () => entitlementsMock);

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { summarizeActiveContractMrrByOrg } from '../services/contractMrr';
import { partnerRoutes } from './partner';

describe('partner routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    currentAuth.value = {
      user: { id: 'user-123', email: 'partner@example.com', name: 'Partner User' },
      scope: 'partner',
      orgId: null,
      partnerId: 'partner-123',
      accessibleOrgIds: ['org-123'],
      canAccessOrg: (orgId: string) => orgId === 'org-123',
    };
    app = new Hono();
    app.route('/partner', partnerRoutes);
  });

  describe('GET /partner/me', () => {
    // `partners` is partner-axis and an ORG-scoped JWT carries a non-null
    // partnerId but accessiblePartnerIds = []. This route has authMiddleware and
    // NO requireScope, and is exempt from partnerGuard so the client can ask
    // "what is my partner's status?" while that partner is inactive. Pre-#2822
    // the read returned zero rows and every org-scoped user got a bare 404 —
    // which apps/web's AccountInactiveGuard swallows (`if (!res.ok) return
    // null`), so suspended-tenant users were never redirected.
    it('resolves the partner for an ORG-scoped caller (was a silent 404)', async () => {
      currentAuth.value = {
        user: { id: 'user-456', email: 'orguser@example.com', name: 'Org User' },
        scope: 'organization',
        orgId: 'org-123',
        partnerId: 'partner-123',
        accessibleOrgIds: ['org-123'],
        canAccessOrg: (orgId: string) => orgId === 'org-123',
      };

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'partner-123',
              name: 'Acme MSP',
              slug: 'acme',
              status: 'suspended',
              settings: { statusMessage: 'Billing on hold' },
            }]),
          }),
        }),
      } as any);

      const res = await app.request('/partner/me', {
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id: 'partner-123',
        status: 'suspended',
        statusMessage: 'Billing on hold',
      });
      // The escape must actually be taken for an org-scoped caller.
      expect(runOutsideDbContext).toHaveBeenCalled();
      expect(withSystemDbAccessContext).toHaveBeenCalled();
    });

    it('404s when the partner row genuinely does not exist', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        }),
      } as any);

      const res = await app.request('/partner/me', {
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(404);
    });

    const mockPartnerRow = (settings: Record<string, unknown> = {}) => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'partner-123',
              name: 'Acme MSP',
              slug: 'acme',
              status: 'pending',
              settings,
            }]),
          }),
        }),
      } as any);
    };

    it('surfaces the configured meeting link for pending partners', async () => {
      vi.stubEnv('PENDING_ACCOUNT_MEETING_URL', ' https://calendly.example.com/breeze ');
      vi.stubEnv('PENDING_ACCOUNT_MEETING_LABEL', 'Book a demo');
      try {
        mockPartnerRow();
        const res = await app.request('/partner/me', {
          headers: { Authorization: 'Bearer token' },
        });
        expect(await res.json()).toMatchObject({
          statusMeetingUrl: 'https://calendly.example.com/breeze',
          statusMeetingLabel: 'Book a demo',
        });
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('reports emailConfigured=true when an email transport exists, false when not (#9256)', async () => {
      emailMock.getEmailService.mockReturnValueOnce({ sendEmail: vi.fn() });
      mockPartnerRow();
      const on = await app.request('/partner/me', { headers: { Authorization: 'Bearer token' } });
      expect((await on.json()).emailConfigured).toBe(true);

      emailMock.getEmailService.mockReturnValueOnce(null);
      mockPartnerRow();
      const off = await app.request('/partner/me', { headers: { Authorization: 'Bearer token' } });
      expect((await off.json()).emailConfigured).toBe(false);
    });

    it('drops a non-http(s) meeting URL and nulls when unset', async () => {
      vi.stubEnv('PENDING_ACCOUNT_MEETING_URL', 'javascript:alert(1)');
      try {
        mockPartnerRow();
        const res = await app.request('/partner/me', {
          headers: { Authorization: 'Bearer token' },
        });
        expect(await res.json()).toMatchObject({
          statusMeetingUrl: null,
          statusMeetingLabel: null,
        });
      } finally {
        vi.unstubAllEnvs();
      }

      mockPartnerRow();
      const res = await app.request('/partner/me', {
        headers: { Authorization: 'Bearer token' },
      });
      expect(await res.json()).toMatchObject({ statusMeetingUrl: null });
    });
  });

  it('returns partner dashboard customer payload', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([
              { id: 'org-123', name: 'Acme Co', status: 'active' }
            ])
          })
        })
      } as never)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              id: 'device-1',
              orgId: 'org-123',
              hostname: 'host-1',
              status: 'online',
              lastSeenAt: new Date('2026-02-08T00:00:00.000Z')
            }
          ])
        })
      } as never)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ groupBy: vi.fn().mockResolvedValue([]) })
        })
      } as never);

    const res = await app.request('/partner/dashboard', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe('Acme Co');
    expect(body.data[0].deviceCount).toBe(1);
    expect(body.data[0].devices[0].name).toBe('host-1');
    // Wave 7 (#3779): real per-currency MRR, plus the deprecated always-zero
    // `mrr` kept for one release so an already-loaded bundle keeps rendering.
    expect(body.data[0].mrrByCurrency).toEqual([
      { currencyCode: 'EUR', amount: '410.00' },
      { currencyCode: 'USD', amount: '1230.00' },
    ]);
    expect(body.data[0].mrr).toBe(0);
    expect(vi.mocked(summarizeActiveContractMrrByOrg)).toHaveBeenCalledWith(['org-123']);
  });

  it('gives an org with no active contracts an empty mrrByCurrency, never a zero in an assumed currency', async () => {
    vi.mocked(summarizeActiveContractMrrByOrg).mockResolvedValueOnce(new Map());
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([
              { id: 'org-123', name: 'Acme Co', status: 'active' }
            ])
          })
        })
      } as never)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) })
      } as never)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ groupBy: vi.fn().mockResolvedValue([]) })
        })
      } as never);

    const res = await app.request('/partner/dashboard', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].mrrByCurrency).toEqual([]);
    expect(body.data[0].mrr).toBe(0);
  });
});

describe('GET /partner/me/entitlements', () => {
  let app: Hono;
  const expires = new Date('2026-11-01T00:00:00.000Z');
  const grace = new Date('2026-11-15T00:00:00.000Z');
  const resolved = {
    plan: 'pro',
    entitlements: {
      // Deliberately out of registry order: the response must follow ENTITLEMENT_KEYS.
      wisp: {
        key: 'wisp', state: 'enabled', source: 'billing',
        limits: { maxGrants: 25, budgetCentsPerDayCeiling: 1000, minFloorTickMinutes: 15 },
        expiresAt: expires, graceUntil: grace, reason: null,
      },
      onboarding_supervisor: {
        key: 'onboarding_supervisor', state: 'disabled', source: 'manual', limits: null,
        expiresAt: null, graceUntil: null, reason: 'held during pilot',
      },
      verified_library: {
        key: 'verified_library', state: 'enabled', source: 'plan', limits: { maxVerifiedPackages: null },
        expiresAt: null, graceUntil: null, reason: null,
      },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    currentAuth.value = {
      user: { id: 'user-123', email: 'partner@example.com', name: 'Partner User' },
      scope: 'partner',
      orgId: null,
      partnerId: 'partner-123',
      accessibleOrgIds: ['org-123'],
      canAccessOrg: (orgId: string) => orgId === 'org-123',
    };
    app = new Hono();
    app.route('/partner', partnerRoutes);
  });

  it('returns plan + one entry per registry key in ENTITLEMENT_KEYS order with ISO dates', async () => {
    entitlementsMock.getEntitlements.mockResolvedValue(resolved);
    const res = await app.request('/partner/me/entitlements');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(entitlementsMock.getEntitlements).toHaveBeenCalledWith('partner-123');
    expect(body.plan).toBe('pro');
    expect(body.entitlements.map((e: { key: string }) => e.key)).toEqual(['onboarding_supervisor', 'verified_library', 'wisp']);
    expect(body.entitlements[2]).toEqual({
      key: 'wisp',
      label: 'Wisp',
      why: 'Wisp triages your fleet continuously and nudges the right person; available on Pro and above.',
      state: 'enabled',
      source: 'billing',
      limits: { maxGrants: 25, budgetCentsPerDayCeiling: 1000, minFloorTickMinutes: 15 },
      expiresAt: '2026-11-01T00:00:00.000Z',
      graceUntil: '2026-11-15T00:00:00.000Z',
      reason: null,
    });
    expect(body.entitlements[0]).toMatchObject({ key: 'onboarding_supervisor', state: 'disabled', source: 'manual', reason: 'held during pilot', expiresAt: null });
  });

  it('serves an ORGANIZATION-scoped caller (partnerId from the JWT)', async () => {
    currentAuth.value = { ...currentAuth.value, scope: 'organization', orgId: 'org-123', partnerId: 'partner-123' };
    entitlementsMock.getEntitlements.mockResolvedValue(resolved);
    const res = await app.request('/partner/me/entitlements');
    expect(res.status).toBe(200);
    expect(entitlementsMock.getEntitlements).toHaveBeenCalledWith('partner-123');
    expect(db.select).not.toHaveBeenCalled();
    // The free-text operator reason is MSP-internal: never shown to an
    // org-scoped caller (which can be a customer org's own user).
    const body = await res.json();
    expect(body.entitlements[0]).toMatchObject({ key: 'onboarding_supervisor', source: 'manual', reason: null });
  });

  it('resolves the partner from partner_users when the JWT has none', async () => {
    currentAuth.value = { ...currentAuth.value, scope: 'system', partnerId: null };
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ partnerId: 'partner-777' }]) }),
      }),
    } as any);
    entitlementsMock.getEntitlements.mockResolvedValue(resolved);
    const res = await app.request('/partner/me/entitlements');
    expect(res.status).toBe(200);
    expect(entitlementsMock.getEntitlements).toHaveBeenCalledWith('partner-777');
  });

  it('404 No partner association when neither JWT nor partner_users yields a partner', async () => {
    currentAuth.value = { ...currentAuth.value, scope: 'system', partnerId: null };
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
      }),
    } as any);
    const res = await app.request('/partner/me/entitlements');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'No partner association' });
    expect(entitlementsMock.getEntitlements).not.toHaveBeenCalled();
  });

  it('503 entitlement_check_failed with Retry-After when the resolver throws EntitlementResolutionError', async () => {
    entitlementsMock.getEntitlements.mockRejectedValue(new entitlementsMock.EntitlementResolutionError('db down'));
    const res = await app.request('/partner/me/entitlements');
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(await res.json()).toEqual({ code: 'entitlement_check_failed', error: 'Entitlement check temporarily unavailable' });
  });

  describe('GET /partner/dashboard per-org alertCount / compliance (#11039)', () => {
    const queueDashboardReads = (alertRows: unknown[]) => {
      const alertWhere = vi.fn().mockReturnValue({ groupBy: vi.fn().mockResolvedValue(alertRows) });
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([
                { id: 'org-123', name: 'Acme Co', status: 'active' },
                { id: 'org-456', name: 'Beta Co', status: 'active' },
              ])
            })
          })
        } as never)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: 'device-1', orgId: 'org-123', hostname: 'h1', status: 'online', lastSeenAt: null },
              { id: 'device-2', orgId: 'org-456', hostname: 'h2', status: 'online', lastSeenAt: null },
            ])
          })
        } as never)
        .mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where: alertWhere }) } as never);
      return alertWhere;
    };

    beforeEach(() => {
      currentAuth.value = { ...currentAuth.value, accessibleOrgIds: ['org-123', 'org-456'] };
    });

    // The handler has no site narrowing because no site-restricted caller can
    // reach it: allowedSiteIds is an organization-scope axis, and this route is
    // partner/system only (SITE_SCOPE_INPUT_EXEMPT in site-scope-coverage). If
    // organization scope is ever admitted, the rollups must narrow by site first.
    it('refuses a site-restricted organization-scope caller before reading anything', async () => {
      currentAuth.value = {
        ...currentAuth.value,
        scope: 'organization',
        orgId: 'org-123',
        accessibleOrgIds: ['org-123'],
        allowedSiteIds: ['site-allowed'],
        canAccessSite: (siteId: string | null | undefined) => siteId === 'site-allowed',
      };

      const res = await app.request('/partner/dashboard');

      expect(res.status).toBe(403);
      expect(db.select).not.toHaveBeenCalled();
      expect(postureMock.listLatestPostureScoresByOrgs).not.toHaveBeenCalled();
    });

    it('does not read or expose alert counts without alerts:read', async () => {
      currentPermissions.value = [{ resource: 'orgs', action: 'read' }, { resource: 'devices', action: 'read' }];
      try {
        vi.mocked(db.select)
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockResolvedValue([{ id: 'org-123', name: 'Acme Co', status: 'active' }])
              })
            })
          } as never)
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([
                { id: 'device-1', orgId: 'org-123', hostname: 'h1', status: 'online', lastSeenAt: null },
              ])
            })
          } as never);
        const res = await app.request('/partner/dashboard', { headers: { Authorization: 'Bearer token' } });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data[0].alertCount).toBe(0);
        expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2); // orgs + devices only, no alerts read
      } finally {
        currentPermissions.value = [{ resource: '*', action: '*' }];
      }
    });

    it('fills real open-alert counts and posture scores per org and device', async () => {
      const alertWhere = queueDashboardReads([
        { orgId: 'org-123', deviceId: 'device-1', n: 1 },
        { orgId: 'org-123', deviceId: null, n: 1 },
        // Open alert on a device the card does not list (decommissioned/hidden).
        { orgId: 'org-123', deviceId: 'hidden-device', n: 5 },
      ]);
      postureMock.listLatestPostureScoresByOrgs.mockResolvedValueOnce([
        { orgId: 'org-123', deviceId: 'device-1', overallScore: 70 },
        { orgId: 'org-123', deviceId: 'device-x', overallScore: 80 },
      ]);

      const res = await app.request('/partner/dashboard', { headers: { Authorization: 'Bearer token' } });
      const body = await res.json();
      const [acme, beta] = body.data;

      expect(acme.alertCount).toBe(2);
      expect(acme.devices[0].alertCount).toBe(1);
      expect(acme.compliance).toBe(75);
      expect(acme.devices[0].compliance).toBe(70);
      // No alerts / no posture snapshot: 0 and null, never the old literal 100.
      expect(beta.alertCount).toBe(0);
      expect(beta.compliance).toBeNull();
      expect(beta.devices[0].compliance).toBeNull();

      // One batched read, scoped to the partner's orgs only.
      expect(postureMock.listLatestPostureScoresByOrgs).toHaveBeenCalledTimes(1);
      expect(postureMock.listLatestPostureScoresByOrgs).toHaveBeenCalledWith(['org-123', 'org-456'], ['device-1', 'device-2']);

      // The alert filter counts only active/acknowledged — not resolved/suppressed/dismissed.
      const params: unknown[] = [];
      const walk = (n: any) => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (n && typeof n === 'object') {
          if ('value' in n && !('queryChunks' in n)) params.push(n.value);
          Object.values(n).forEach(walk);
        } else if (typeof n === 'string') params.push(n);
      };
      walk(alertWhere.mock.calls[0]?.[0]);
      const flat = params.flat();
      expect(flat).toEqual(expect.arrayContaining(['active', 'acknowledged', 'org-123', 'org-456']));
      for (const closed of ['resolved', 'suppressed', 'dismissed']) {
        expect(flat).not.toContain(closed);
      }
    });
  });
});
