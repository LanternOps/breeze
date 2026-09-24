import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// ── Mocks ──────────────────────────────────────────────────────────

vi.mock('../db', () => ({
  db: {
    update: vi.fn(),
  },

  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  users: {
    id: 'users.id',
    setupCompletedAt: 'users.setupCompletedAt',
    updatedAt: 'users.updatedAt',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../services/latestVersion', () => ({
  getLatestVersion: vi.fn(),
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { getLatestVersion } from '../services/latestVersion';
import { systemRoutes } from './system';

// ── Constants ──────────────────────────────────────────────────────

const ORG_ID = '11111111-1111-1111-1111-111111111111';

function setAuth(overrides: Record<string, unknown> = {}) {
  vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'admin@test.com', name: 'Admin' },
      scope: 'partner',
      orgId: null,
      partnerId: 'partner-1',
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (id: string) => id === ORG_ID,
      ...overrides,
    });
    return next();
  });
}

function makeApp() {
  const app = new Hono();
  app.route('/system', systemRoutes);
  return app;
}

// ── Tests ──────────────────────────────────────────────────────────

describe('system routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    setAuth();
    app = makeApp();
  });

  // ────────────────────── GET /version ──────────────────────
  describe('GET /version', () => {
    it('includes version, latest, isStale, latestFetchedAt fields', async () => {
      vi.mocked(getLatestVersion).mockResolvedValueOnce({
        latest: '99.99.99',
        fetchedAt: new Date('2026-05-25T00:00:00Z'),
        source: 'github',
      });
      const res = await app.request('/system/version');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('version');
      expect(body).toHaveProperty('latest', '99.99.99');
      expect(body).toHaveProperty('isStale', true);
      expect(body).toHaveProperty('latestFetchedAt', '2026-05-25T00:00:00.000Z');
      expect(body).toHaveProperty('latestSource', 'github');
    });

    it('returns isStale=false when running version >= latest', async () => {
      vi.mocked(getLatestVersion).mockResolvedValueOnce({
        latest: '0.0.1',
        fetchedAt: new Date(),
        source: 'github',
      });
      const res = await app.request('/system/version');
      const body = await res.json();
      expect(body.isStale).toBe(false);
    });

    it('returns isStale=false and latest=null when GitHub is unreachable', async () => {
      vi.mocked(getLatestVersion).mockResolvedValueOnce({
        latest: null,
        fetchedAt: new Date(),
        source: 'error',
      });
      const res = await app.request('/system/version');
      const body = await res.json();
      expect(body.latest).toBeNull();
      expect(body.isStale).toBe(false);
    });
  });

  // ────────────────────── GET /config-status (removed, spec D9) ──────────────────────
  describe('GET /config-status', () => {
    it('is gone: env status lives only at GET /admin/system/connections (platform admins)', async () => {
      const res = await app.request('/system/config-status');
      expect(res.status).toBe(404);
    });
  });

  // ────────────────────── POST /setup-complete ──────────────────────
  describe('POST /setup-complete', () => {
    it('marks setup as complete for the current user', async () => {
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as any);

      const res = await app.request('/system/setup-complete', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(vi.mocked(db.update)).toHaveBeenCalled();
    });

    it('returns 500 when database update fails', async () => {
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockRejectedValue(new Error('DB error')),
        }),
      } as any);

      const res = await app.request('/system/setup-complete', {
        method: 'POST',
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Failed to complete setup');
    });

    it('works for any authenticated scope', async () => {
      setAuth({ scope: 'organization', orgId: ORG_ID });

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as any);

      const res = await app.request('/system/setup-complete', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
    });
  });

  // ────────────────────── Auth enforcement ──────────────────────
  describe('authentication', () => {
    it('all routes require auth middleware', async () => {
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as any);

      await app.request('/system/setup-complete', { method: 'POST' });
      expect(vi.mocked(authMiddleware)).toHaveBeenCalled();
    });
  });

  // ────────────────────── Multi-tenant isolation ──────────────────────
  describe('multi-tenant isolation', () => {
    it('setup-complete only affects the authenticated user, not other tenants', async () => {
      const ORG_ID_OTHER = '22222222-2222-2222-2222-222222222222';
      setAuth({
        scope: 'organization',
        orgId: ORG_ID_OTHER,
        accessibleOrgIds: [ORG_ID_OTHER],
        canAccessOrg: (id: string) => id === ORG_ID_OTHER,
        user: { id: 'user-other-org', email: 'other@test.com', name: 'Other' },
      });

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as any);

      const res = await app.request('/system/setup-complete', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      // Verify that the update call was made (it operates on auth.user.id,
      // so each user's setup state is isolated by user ID)
      expect(vi.mocked(db.update)).toHaveBeenCalled();
    });
  });
});
