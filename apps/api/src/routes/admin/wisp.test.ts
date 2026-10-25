import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';

const { overviewMock, grantsMock, outsideMock, systemMock, wispEnabledMock } = vi.hoisted(() => ({
  overviewMock: vi.fn(),
  grantsMock: vi.fn(),
  outsideMock: vi.fn((fn: () => unknown) => fn()),
  systemMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  wispEnabledMock: vi.fn(() => true),
}));
vi.mock('../../services/wisp/adminOverview', () => ({
  buildWispOverview: overviewMock,
  listGrantsForPartner: grantsMock,
}));
vi.mock('../../config/env', async () => ({
  ...await vi.importActual<typeof import('../../config/env')>('../../config/env'),
  wispEnabled: wispEnabledMock,
}));
vi.mock('../../db', async () => ({
  ...await vi.importActual<typeof import('../../db')>('../../db'),
  runOutsideDbContext: outsideMock,
  withSystemDbAccessContext: systemMock,
}));
vi.mock('../../services/auditService', () => ({
  createAuditLog: vi.fn(async () => undefined),
  createAuditLogAsync: vi.fn(async () => undefined),
}));
vi.mock('../../services/clientIp', () => ({ getTrustedClientIpOrUndefined: vi.fn(() => '127.0.0.1') }));
vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<typeof import('../../middleware/auth')>('../../middleware/auth');
  const { HTTPException } = await import('hono/http-exception');
  return {
    ...actual,
    authMiddleware: vi.fn(async (c: Context, next: () => Promise<void>) => {
      if (!c.get('auth')) throw new HTTPException(401, { message: 'Not authenticated' });
      await next();
    }),
  };
});

import { Hono } from 'hono';
import { adminRoutes } from './index';

function buildApp(isPlatformAdmin: boolean | null) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (isPlatformAdmin !== null) c.set('auth', {
      user: { id: '11111111-1111-4111-8111-111111111111', email: 'admin@breeze.test', isPlatformAdmin },
      token: { mfa: true },
    } as never);
    await next();
  });
  app.route('/admin', adminRoutes);
  return app;
}

const PARTNER = '22222222-2222-4222-8222-222222222222';
const partnerRow = {
  partnerId: PARTNER, partnerName: 'Acme MSP', plan: 'pro', activeGrants: 1, pausedGrants: {},
  assessmentsToday: 2, specialistRequestsToday: 0, openConcerns: 3, budgetExhaustedGrantsToday: 0,
};
const grantRow = {
  id: '33333333-3333-4333-8333-333333333333', orgId: null, grantorUserId: '44444444-4444-4444-8444-444444444444',
  grantorName: 'Ada', status: 'active', pausedReason: null, expiresAt: '2027-01-01T00:00:00.000Z',
  budgetCentsPerDay: 200, floorTickMinutes: 30, currentRevisionId: '55555555-5555-4555-8555-555555555555',
  assessmentsToday: 2,
};

describe('admin Wisp overview routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wispEnabledMock.mockReturnValue(true);
    overviewMock.mockResolvedValue([partnerRow]);
    grantsMock.mockResolvedValue([grantRow]);
  });

  it.each([[null, 401], [false, 403]] as const)('rejects auth=%s with %s (platformAdminMiddleware)', async (auth, status) => {
    const app = buildApp(auth);
    expect((await app.request('/admin/wisp/overview')).status).toBe(status);
    expect((await app.request(`/admin/wisp/grants?partnerId=${PARTNER}`)).status).toBe(status);
    expect(overviewMock).not.toHaveBeenCalled();
    expect(grantsMock).not.toHaveBeenCalled();
    expect(systemMock).not.toHaveBeenCalled();
  });

  it.each([[null, 401], [false, 403]] as const)(
    'with the flag off still answers auth=%s with %s — the gate runs first, so non-admins cannot probe the flag',
    async (auth, status) => {
      wispEnabledMock.mockReturnValue(false);
      const res = await buildApp(auth).request('/admin/wisp/overview');
      expect(res.status).toBe(status);
      expect(await res.text()).not.toContain('wisp_disabled');
    },
  );

  it('404s with a distinguishable wisp_disabled body when wispEnabled() is false', async () => {
    wispEnabledMock.mockReturnValue(false);
    const app = buildApp(true);
    for (const path of ['/admin/wisp/overview', `/admin/wisp/grants?partnerId=${PARTNER}`]) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'wisp_disabled' });
    }
    expect(overviewMock).not.toHaveBeenCalled();
    expect(grantsMock).not.toHaveBeenCalled();
  });

  it('returns the overview rows under a fresh system read', async () => {
    const res = await buildApp(true).request('/admin/wisp/overview');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ partners: [partnerRow] });
    expect(outsideMock).toHaveBeenCalledOnce();
    expect(systemMock).toHaveBeenCalledWith(expect.any(Function), 'wispAdminOverview');
    expect(outsideMock.mock.invocationCallOrder[0]).toBeLessThan(systemMock.mock.invocationCallOrder[0]!);
    expect(systemMock.mock.invocationCallOrder[0]).toBeLessThan(overviewMock.mock.invocationCallOrder[0]!);
  });

  it('returns a partner\'s grants under a fresh system read', async () => {
    const res = await buildApp(true).request(`/admin/wisp/grants?partnerId=${PARTNER}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ grants: [grantRow] });
    expect(grantsMock).toHaveBeenCalledWith(PARTNER);
    expect(systemMock).toHaveBeenCalledWith(expect.any(Function), 'wispAdminGrants');
    expect(systemMock.mock.invocationCallOrder[0]).toBeLessThan(grantsMock.mock.invocationCallOrder[0]!);
  });

  it.each([[''], ['?partnerId='], ['?partnerId=not-a-uuid']])('400s /grants%s without a uuid partnerId', async (qs) => {
    const res = await buildApp(true).request(`/admin/wisp/grants${qs}`);
    expect(res.status).toBe(400);
    expect(grantsMock).not.toHaveBeenCalled();
  });
});
