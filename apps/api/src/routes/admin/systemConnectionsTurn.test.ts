/**
 * GET/POST /api/v1/admin/system/connections/turn (#9372). The UDP transport is
 * mocked at the service boundary: no test here touches the network.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/auditService', () => ({
  createAuditLog: vi.fn(async () => undefined),
  createAuditLogAsync: vi.fn(async () => undefined),
}));
vi.mock('../../services/clientIp', () => ({
  getTrustedClientIpOrUndefined: vi.fn(() => '127.0.0.1'),
}));
vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<typeof import('../../middleware/auth')>('../../middleware/auth');
  const { HTTPException } = await import('hono/http-exception');
  return {
    ...actual,
    authMiddleware: vi.fn(async (c: any, next: () => Promise<void>) => {
      if (!c.get('auth')) throw new HTTPException(401, { message: 'Not authenticated' });
      await next();
    }),
  };
});

const runMock = vi.fn();
const lastMock = vi.fn();
vi.mock('../../services/system/connections/turnPreflight', () => ({
  startTurnPreflight: (...a: unknown[]) => runMock(...a),
  getLastTurnPreflight: () => lastMock(),
}));

import { Hono } from 'hono';
import { adminRoutes } from './index';

const platformAdmin = {
  scope: 'partner',
  user: { id: 'admin-1', email: 'admin@breeze.test', name: 'PA', isPlatformAdmin: true },
  token: { mfa: true },
};
const partnerAdmin = {
  scope: 'partner',
  user: { id: 'pa-1', email: 'partner@x.com', name: 'Partner', isPlatformAdmin: false },
  token: { mfa: true },
};

function buildApp(auth: unknown) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (auth) c.set('auth', auth as never);
    await next();
  });
  app.route('/admin', adminRoutes);
  return app;
}

const PATH = '/admin/system/connections/turn';
const sample = { status: 'warn', message: 'm', checkedAt: '2026-10-21T00:00:00.000Z' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TURN preflight routes', () => {
  it('GET returns the cached startup result without probing', async () => {
    lastMock.mockReturnValue(sample);
    const res = await buildApp(platformAdmin).request(PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: sample });
    expect(runMock).not.toHaveBeenCalled();
  });

  it('GET returns null data before the startup check has completed', async () => {
    lastMock.mockReturnValue(null);
    const res = await buildApp(platformAdmin).request(PATH);
    expect(await res.json()).toEqual({ data: null });
  });

  it('POST re-runs the probe against process.env', async () => {
    runMock.mockResolvedValue(sample);
    const res = await buildApp(platformAdmin).request(`${PATH}/probe`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: sample });
    expect(runMock).toHaveBeenCalledWith(process.env);
  });

  it('rejects non-platform-admins and unauthenticated callers', async () => {
    expect((await buildApp(partnerAdmin).request(PATH)).status).toBe(403);
    expect((await buildApp(null).request(`${PATH}/probe`, { method: 'POST' })).status).toBe(401);
    expect(runMock).not.toHaveBeenCalled();
  });
});
