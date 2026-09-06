import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// #4797: POST /profile/password had no rate limit on current-password guesses
// and answered a wrong guess with 401, which the portal client funnels into a
// forced logout. This suite covers both fixes: the dedicated portal-native
// rate limiter (checkRateLimit, in-memory mode here since PORTAL_USE_REDIS is
// false outside production/PORTAL_STATE_BACKEND=redis) and the 401 -> 400
// + stable `code` change.

const verifyPasswordMock = vi.fn(async (_hash: string, _plaintext: string) => true);
const hashPasswordMock = vi.fn(async (_plaintext: string) => 'new-hash');

const dbState: { userRow: unknown } = {
  userRow: {
    id: 'pu-1',
    passwordHash: 'argon2-hash',
    email: 'customer@example.com',
    orgId: 'org-1',
    name: 'Customer',
  },
};

const updateReturningMock = vi.fn(async () => [dbState.userRow]);

vi.mock('../../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db')>();
  return {
    ...actual,
    db: {
      select: vi.fn(),
      update: vi.fn(),
    },
  };
});

vi.mock('../../db/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/schema')>();
  return {
    ...actual,
    portalUsers: {
      id: 'portal_users.id',
      orgId: 'portal_users.org_id',
      email: 'portal_users.email',
      name: 'portal_users.name',
      passwordHash: 'portal_users.password_hash',
      receiveNotifications: 'portal_users.receive_notifications',
      status: 'portal_users.status',
    },
  };
});

vi.mock('../../services/password', () => ({
  hashPassword: (plaintext: string) => hashPasswordMock(plaintext),
  verifyPassword: (hash: string, plaintext: string) => verifyPasswordMock(hash, plaintext),
  isPasswordStrong: () => ({ valid: true, errors: [] }),
}));

vi.mock('../../services/redis', () => ({
  getRedis: vi.fn(() => null),
}));

vi.mock('./helpers', async () => {
  const actual = await vi.importActual<typeof import('./helpers')>('./helpers');
  return {
    ...actual,
    validatePortalCookieCsrfRequest: vi.fn(() => null),
    writePortalAudit: vi.fn(),
  };
});

import { profileRoutes } from './profile';
import { db } from '../../db';
import { portalRateLimitBuckets, writePortalAudit } from './helpers';

const AUTH_USER = {
  id: 'pu-1',
  orgId: 'org-1',
  email: 'customer@example.com',
  name: 'Customer',
  contactId: null,
  receiveNotifications: true,
  status: 'active',
};

function app() {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('portalAuth', { user: AUTH_USER, token: 'token', authMethod: 'bearer', timezone: 'UTC' });
    await next();
  });
  hono.route('/', profileRoutes);
  return hono;
}

function buildSelectChain() {
  vi.mocked(db.select as any).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockImplementation(() =>
          Promise.resolve(dbState.userRow ? [dbState.userRow] : [])
        ),
      }),
    }),
  });
}

function buildUpdateChain() {
  vi.mocked(db.update as any).mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  });
}

async function postPasswordChange(body: unknown) {
  return app().request('/profile/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /profile/password', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    portalRateLimitBuckets.clear();
    verifyPasswordMock.mockResolvedValue(true);
    dbState.userRow = {
      id: 'pu-1',
      passwordHash: 'argon2-hash',
      email: 'customer@example.com',
      orgId: 'org-1',
      name: 'Customer',
    };
    buildSelectChain();
    buildUpdateChain();
    updateReturningMock.mockClear();
  });

  it('happy path: a correct current password still succeeds', async () => {
    const res = await postPasswordChange({
      currentPassword: 'correct-horse',
      newPassword: 'battery-staple-9',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, message: 'Password changed successfully' });
    expect(verifyPasswordMock).toHaveBeenCalledWith('argon2-hash', 'correct-horse');
    expect(writePortalAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'portal.profile.password.change' })
    );
  });

  // The core #4797 fix: a wrong guess must never collide with the session
  // guard's 401, or the portal client's default fetch handler
  // (apps/portal/src/lib/api.ts) clears auth and redirects to /login —
  // signing the user out over a typo instead of showing the error.
  it('returns 400 with the stable invalid_credentials code on a wrong guess (#4797)', async () => {
    verifyPasswordMock.mockResolvedValueOnce(false);
    const res = await postPasswordChange({
      currentPassword: 'wrong',
      newPassword: 'battery-staple-9',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({
      error: 'Current password is incorrect',
      message: 'Current password is incorrect',
      code: 'invalid_credentials',
    });
  });

  it('never answers a wrong guess with 401', async () => {
    verifyPasswordMock.mockResolvedValueOnce(false);
    const res = await postPasswordChange({
      currentPassword: 'wrong',
      newPassword: 'battery-staple-9',
    });
    expect(res.status).not.toBe(401);
  });

  // N+1 guesses (the config allows 5) throttle the 6th request — before the
  // account is even looked up.
  it('rate-limits after maxAttempts guesses, regardless of correctness', async () => {
    verifyPasswordMock.mockResolvedValue(false);
    let last!: Response;
    for (let i = 0; i < 6; i += 1) {
      last = await postPasswordChange({
        currentPassword: `wrong-${i}`,
        newPassword: 'battery-staple-9',
      });
    }
    expect(last.status).toBe(429);
    expect(last.headers.get('retry-after')).toBeTruthy();
    // Only the first 5 attempts should have reached password verification —
    // the 6th was throttled before the DB lookup / argon2 verify ran.
    expect(verifyPasswordMock).toHaveBeenCalledTimes(5);
  });

  // A 429 must not leak whether the guess would have been right — throttling
  // has to happen before verifyPassword is ever called for the blocked
  // request, for both a correct and an incorrect guess.
  it('a 429 does not leak whether the password was right', async () => {
    for (let i = 0; i < 5; i += 1) {
      await postPasswordChange({ currentPassword: `wrong-${i}`, newPassword: 'battery-staple-9' });
    }
    verifyPasswordMock.mockClear();

    const blockedWithCorrect = await postPasswordChange({
      currentPassword: 'correct-horse',
      newPassword: 'battery-staple-9',
    });
    expect(blockedWithCorrect.status).toBe(429);
    expect(verifyPasswordMock).not.toHaveBeenCalled();

    const blockedBody = await blockedWithCorrect.json();
    // The blocked response carries no trace of the invalid_credentials
    // contract — it is a distinct shape from both the 200 and 400 bodies.
    expect(blockedBody).not.toHaveProperty('code');
  });

  it('throttles per portal user id, not globally', async () => {
    verifyPasswordMock.mockResolvedValue(false);
    for (let i = 0; i < 5; i += 1) {
      await postPasswordChange({ currentPassword: `wrong-${i}`, newPassword: 'battery-staple-9' });
    }
    const blocked = await postPasswordChange({ currentPassword: 'wrong-6', newPassword: 'battery-staple-9' });
    expect(blocked.status).toBe(429);

    // A different portal user's bucket is untouched.
    const otherApp = new Hono();
    otherApp.use('*', async (c, next) => {
      c.set('portalAuth', {
        user: { ...AUTH_USER, id: 'pu-2' },
        token: 'token',
        authMethod: 'bearer',
        timezone: 'UTC',
      });
      await next();
    });
    otherApp.route('/', profileRoutes);
    const otherUserRes = await otherApp.request('/profile/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'wrong', newPassword: 'battery-staple-9' }),
    });
    expect(otherUserRes.status).toBe(400); // rejected on password, not throttled
  });
});
