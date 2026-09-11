import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  hashPassword: vi.fn(async () => 'replacement-hash'),
  update: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
  returning: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('../../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db')>();
  return { ...actual, db: { update: mocks.update, select: vi.fn() } };
});

vi.mock('../../services/password', () => ({
  hashPassword: mocks.hashPassword,
  verifyPassword: vi.fn(),
  isPasswordStrong: vi.fn(() => ({ valid: true, errors: [] })),
}));

vi.mock('../../services/redis', () => ({ getRedis: vi.fn(() => null) }));

vi.mock('./helpers', async () => {
  const actual = await vi.importActual<typeof import('./helpers')>('./helpers');
  return {
    ...actual,
    validatePortalCookieCsrfRequest: vi.fn(() => null),
    writePortalAudit: mocks.audit,
  };
});

import { profileRoutes } from './profile';
import { portalSessions } from './helpers';

const AUTH_USER = {
  id: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222',
  email: 'customer@example.test',
  name: 'Customer',
  contactId: null,
  receiveNotifications: true,
  status: 'active',
};

function app() {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('portalAuth', {
      user: AUTH_USER,
      token: 'synthetic-session',
      authMethod: 'bearer',
      timezone: 'UTC',
    });
    await next();
  });
  hono.route('/', profileRoutes);
  return hono;
}

async function patchProfile(body: unknown) {
  return app().request('/profile', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PATCH /profile compatibility boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    portalSessions.clear();
    mocks.update.mockReturnValue({ set: mocks.set });
    mocks.set.mockReturnValue({ where: mocks.where });
    mocks.where.mockReturnValue({ returning: mocks.returning });
    mocks.returning.mockResolvedValue([{
      id: AUTH_USER.id,
      orgId: AUTH_USER.orgId,
      email: AUTH_USER.email,
      name: 'Updated Customer',
      receiveNotifications: false,
      status: 'active',
    }]);
  });

  it('rejects a legacy password-shaped request before password, database, or audit effects', async () => {
    portalSessions.set('other-session', {
      token: 'other-session',
      portalUserId: AUTH_USER.id,
      orgId: AUTH_USER.orgId,
      authEpoch: 1,
      createdAt: new Date(0),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const response = await patchProfile({
      name: 'Updated Customer',
      password: 'LegacyCompatibilityPassword123!',
    });

    expect(response.status).toBe(400);
    expect(mocks.hashPassword).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(portalSessions.has('other-session')).toBe(true);
  });

  it('preserves ordinary profile name and notification updates', async () => {
    const response = await patchProfile({
      name: 'Updated Customer',
      receiveNotifications: false,
    });

    expect(response.status).toBe(200);
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Updated Customer',
      receiveNotifications: false,
    }));
    expect(mocks.hashPassword).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledTimes(1);
  });
});
