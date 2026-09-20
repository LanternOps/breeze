import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';

const { reportMock, outsideMock, systemMock } = vi.hoisted(() => ({
  reportMock: vi.fn(),
  outsideMock: vi.fn((fn: () => unknown) => fn()),
  systemMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../../services/aiToolUsageReport', () => ({ buildToolUsageReport: reportMock }));
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

const report = { days: 30, generatedAt: '2026-09-19T00:00:00.000Z', rows: [], coldTools: ['query_devices'], registeredToolCount: 1 };

describe('admin AI tool usage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reportMock.mockResolvedValue(report);
  });
  it.each([[null, 401], [false, 403]] as const)('rejects auth=%s with %s', async (auth, status) => {
    const res = await buildApp(auth).request('/admin/ai/tool-usage');
    expect(res.status).toBe(status);
    expect(reportMock).not.toHaveBeenCalled();
    expect(systemMock).not.toHaveBeenCalled();
  });
  it('returns the report under a fresh system context for a platform admin', async () => {
    const res = await buildApp(true).request('/admin/ai/tool-usage?days=30');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(report);
    expect(reportMock).toHaveBeenCalledWith(30);
    expect(outsideMock).toHaveBeenCalledOnce();
    expect(systemMock).toHaveBeenCalledWith(expect.any(Function), 'aiToolUsageReport');
    expect(outsideMock.mock.invocationCallOrder[0]).toBeLessThan(systemMock.mock.invocationCallOrder[0]!);
    expect(systemMock.mock.invocationCallOrder[0]).toBeLessThan(reportMock.mock.invocationCallOrder[0]!);
  });
  it('defaults to 90 days', async () => {
    expect((await buildApp(true).request('/admin/ai/tool-usage')).status).toBe(200);
    expect(reportMock).toHaveBeenCalledWith(90);
  });
  it.each(['0', '400', '1.5', 'abc'])('rejects days=%s', async (days) => {
    expect((await buildApp(true).request(`/admin/ai/tool-usage?days=${days}`)).status).toBe(400);
    expect(reportMock).not.toHaveBeenCalled();
  });
  it('returns 500 when report generation fails', async () => {
    reportMock.mockRejectedValueOnce(new Error('Report unavailable'));
    expect((await buildApp(true).request('/admin/ai/tool-usage')).status).toBe(500);
  });
});
