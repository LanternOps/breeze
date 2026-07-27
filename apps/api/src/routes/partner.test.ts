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
  }
}));

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

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', currentAuth.value);
    return next();
  }),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next())
}));

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
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
  });
});
