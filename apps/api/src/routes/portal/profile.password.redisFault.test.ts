import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.hoisted(() => {
  process.env.PORTAL_STATE_BACKEND = 'redis';
});

const { updateSet, redis } = vi.hoisted(() => ({
  updateSet: vi.fn(),
  redis: {
    smembers: vi.fn(() => Promise.reject(new Error('synthetic Redis read fault'))),
    del: vi.fn(),
  },
}));

vi.mock('../../db', () => ({
  runOutsideDbContext: <T,>(fn: () => T) => fn(),
  withDbAccessContext: (_context: unknown, fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{
            id: 'portal-user-1',
            passwordHash: 'old-hash',
            email: 'customer@example.test',
            orgId: 'org-1',
            name: 'Customer',
          }]),
        }),
      }),
    }),
    update: () => ({
      set: (value: unknown) => {
        updateSet(value);
        return { where: () => Promise.resolve() };
      },
    }),
  },
}));

vi.mock('../../db/schema', () => ({
  discoveredAssetTypeEnum: { enumValues: [] },
  portalUsers: {
    id: 'id',
    passwordHash: 'passwordHash',
    email: 'email',
    orgId: 'orgId',
    name: 'name',
    authEpoch: 'authEpoch',
  },
}));

vi.mock('../../services/password', () => ({
  verifyPassword: vi.fn(() => Promise.resolve(true)),
  hashPassword: vi.fn(() => Promise.resolve('new-hash')),
  isPasswordStrong: vi.fn(() => ({ valid: true, errors: [] })),
}));

vi.mock('../../services/redis', () => ({ getRedis: () => redis }));

vi.mock('./helpers', () => ({
  applyPortalCacheHeaders: vi.fn(),
  buildWeakEtag: vi.fn(() => 'etag'),
  buildPortalUserPayload: vi.fn((user) => user),
  checkRateLimit: vi.fn(() => Promise.resolve({ allowed: true })),
  isEtagFresh: vi.fn(() => false),
  portalSessions: new Map(),
  validatePortalCookieCsrfRequest: vi.fn(() => null),
  writePortalAudit: vi.fn(),
}));

import { profileRoutes } from './profile';

describe('portal password epoch under Redis cleanup faults', () => {
  beforeEach(() => vi.clearAllMocks());

  it('commits the durable epoch advance before a Redis fault and never reports success', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('portalAuth', {
        user: {
          id: 'portal-user-1', orgId: 'org-1', email: 'customer@example.test',
          name: 'Customer', contactId: null, receiveNotifications: true, status: 'active',
        },
        token: 'current-token', authMethod: 'bearer', timezone: 'UTC',
      });
      await next();
    });
    app.route('/', profileRoutes);

    const res = await app.request('/profile/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'Old-password-1!', newPassword: 'New-password-2!' }),
    });

    expect(res.status).toBe(500);
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({
      passwordHash: 'new-hash',
      authEpoch: expect.anything(),
    }));
    expect(redis.smembers).toHaveBeenCalledWith('portal:user-sessions:portal-user-1');
    expect(redis.del).not.toHaveBeenCalled();
  });
});
