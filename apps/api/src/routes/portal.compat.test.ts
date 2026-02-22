import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { portalRoutes } from './portal';

vi.mock('nanoid', () => ({
  nanoid: vi.fn(() => 'portal-session-token')
}));

vi.mock('../services/password', () => ({
  hashPassword: vi.fn().mockResolvedValue('hashed-password'),
  isPasswordStrong: vi.fn(() => ({ valid: true, errors: [] })),
  verifyPassword: vi.fn()
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([]))
        }))
      }))
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve())
      }))
    }))
  }
}));

vi.mock('../db/schema', () => ({
  assetCheckouts: {},
  devices: {},
  portalBranding: {
    id: 'portalBranding.id',
    customDomain: 'portalBranding.customDomain',
    domainVerified: 'portalBranding.domainVerified'
  },
  portalUsers: {
    id: 'portalUsers.id',
    orgId: 'portalUsers.orgId',
    email: 'portalUsers.email',
    name: 'portalUsers.name',
    passwordHash: 'portalUsers.passwordHash',
    receiveNotifications: 'portalUsers.receiveNotifications',
    status: 'portalUsers.status',
    lastLoginAt: 'portalUsers.lastLoginAt',
    updatedAt: 'portalUsers.updatedAt'
  },
  ticketComments: {},
  tickets: {}
}));

import { db } from '../db';
import { verifyPassword } from '../services/password';

const portalUser = {
  id: 'portal-user-1',
  orgId: 'f1b0c8a6-45d1-4f84-8b8b-0ad0ce620001',
  email: 'portal@example.com',
  name: 'Portal User',
  passwordHash: 'hash',
  receiveNotifications: true,
  status: 'active'
};

function mockSelectLimit(result: unknown) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(result)
      })
    })
  } as never;
}

function mockUpdateWhere(result?: unknown) {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(result)
    })
  } as never;
}

describe('portal compatibility routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/portal', portalRoutes);
  });

  it('extends cookie session expiry on authenticated activity', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    try {
      vi.mocked(verifyPassword).mockResolvedValue(true);
      vi.mocked(db.select)
        .mockReturnValueOnce(mockSelectLimit([portalUser])) // login lookup
        .mockReturnValueOnce(mockSelectLimit([portalUser])) // auth middleware on first profile call
        .mockReturnValueOnce(mockSelectLimit([portalUser])); // auth middleware on second profile call
      vi.mocked(db.update).mockReturnValueOnce(mockUpdateWhere());

      const loginRes = await app.request('/portal/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'portal@example.com',
          password: 'password123'
        })
      });
      expect(loginRes.status).toBe(200);

      const cookie = loginRes.headers
        .get('set-cookie')
        ?.split(';')[0];
      expect(cookie).toBeTruthy();
      if (!cookie) {
        throw new Error('Expected portal session cookie');
      }

      // Touch the session near the original expiry to trigger sliding extension.
      vi.setSystemTime(new Date('2026-01-01T23:59:00.000Z'));
      const profileRes1 = await app.request('/portal/profile', {
        method: 'GET',
        headers: { Cookie: cookie }
      });
      expect(profileRes1.status).toBe(200);
      expect(profileRes1.headers.get('set-cookie')).toContain('breeze_portal_session=');

      // Past the original 24h expiry, the session should still be valid because it was active.
      vi.setSystemTime(new Date('2026-01-02T00:01:00.000Z'));
      const profileRes2 = await app.request('/portal/profile', {
        method: 'GET',
        headers: { Cookie: cookie }
      });
      expect(profileRes2.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('POST /portal/auth/login accepts optional orgId and returns compatibility tokens', async () => {
    vi.mocked(verifyPassword).mockResolvedValue(true);
    vi.mocked(db.select).mockReturnValueOnce(mockSelectLimit([portalUser]));
    vi.mocked(db.update).mockReturnValueOnce(mockUpdateWhere());

    const res = await app.request('/portal/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'portal@example.com',
        password: 'password123'
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accessToken).toBe('portal-session-token');
    expect(body.tokens?.accessToken).toBe('portal-session-token');
    expect(body.user?.orgId).toBe(portalUser.orgId);
  });

  it('POST /portal/auth/logout invalidates session token', async () => {
    vi.mocked(verifyPassword).mockResolvedValue(true);
    vi.mocked(db.select)
      .mockReturnValueOnce(mockSelectLimit([portalUser])) // login user lookup
      .mockReturnValueOnce(mockSelectLimit([portalUser])); // auth middleware user lookup
    vi.mocked(db.update).mockReturnValueOnce(mockUpdateWhere());

    const loginRes = await app.request('/portal/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'portal@example.com',
        password: 'password123'
      })
    });
    const loginBody = await loginRes.json();
    const token = loginBody.accessToken as string;

    const logoutRes = await app.request('/portal/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(logoutRes.status).toBe(200);

    const profileRes = await app.request('/portal/profile', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(profileRes.status).toBe(401);
  });

  it('POST /portal/profile/password changes password and invalidates prior session', async () => {
    vi.mocked(verifyPassword).mockResolvedValue(true);
    vi.mocked(db.select)
      .mockReturnValueOnce(mockSelectLimit([portalUser])) // login
      .mockReturnValueOnce(mockSelectLimit([portalUser])) // auth middleware for password route
      .mockReturnValueOnce(mockSelectLimit([portalUser])); // password route user lookup
    vi.mocked(db.update)
      .mockReturnValueOnce(mockUpdateWhere()) // login lastLoginAt update
      .mockReturnValueOnce(mockUpdateWhere()); // password update

    const loginRes = await app.request('/portal/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'portal@example.com',
        password: 'password123'
      })
    });
    const loginBody = await loginRes.json();
    const token = loginBody.accessToken as string;

    const changeRes = await app.request('/portal/profile/password', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        currentPassword: 'password123',
        newPassword: 'NewStrongPass123'
      })
    });
    expect(changeRes.status).toBe(200);

    const profileRes = await app.request('/portal/profile', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(profileRes.status).toBe(401);
  });
});
