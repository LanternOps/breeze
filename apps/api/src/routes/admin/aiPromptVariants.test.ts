import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';

const { reportMock, outsideMock, systemMock } = vi.hoisted(() => ({
  reportMock: vi.fn(),
  outsideMock: vi.fn((fn: () => unknown) => fn()),
  systemMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../../services/aiModels/promptVariantReport', () => ({
  buildPromptVariantReport: reportMock,
  defaultPromptVariantRange: () => ({ from: '2026-09-20', to: '2026-10-17' }),
}));
vi.mock('../../services/aiModels/qualityQueries', () => {
  class QualityQueryTimeoutError extends Error {}
  return { QualityQueryTimeoutError };
});
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
import { QualityQueryTimeoutError } from '../../services/aiModels/qualityQueries';

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

describe('admin prompt variant report', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reportMock.mockResolvedValue({ from: 'a', to: 'b', minConversations: 30, rows: [], sources: { failovers: false, continuations: false } });
  });
  it.each([[null, 401], [false, 403]] as const)('rejects auth=%s with %s', async (auth, status) => {
    expect((await buildApp(auth).request('/admin/ai/prompt-variants')).status).toBe(status);
    expect(reportMock).not.toHaveBeenCalled();
  });
  it('defaults the range and reads in system context outside the request context', async () => {
    expect((await buildApp(true).request('/admin/ai/prompt-variants')).status).toBe(200);
    expect(reportMock).toHaveBeenCalledWith({ from: '2026-09-20', to: '2026-10-17' });
    expect(outsideMock).toHaveBeenCalled();
    expect(systemMock).toHaveBeenCalledWith(expect.any(Function), 'aiPromptVariantReport');
  });
  it('passes an explicit range and 400s one over 31 days', async () => {
    await buildApp(true).request('/admin/ai/prompt-variants?from=2026-09-01&to=2026-09-30');
    expect(reportMock).toHaveBeenCalledWith({ from: '2026-09-01', to: '2026-09-30' });
    expect((await buildApp(true).request('/admin/ai/prompt-variants?from=2026-08-01&to=2026-09-30')).status).toBe(400);
  });
  it('a statement timeout is a 503 quality_timeout', async () => {
    reportMock.mockRejectedValueOnce(new QualityQueryTimeoutError());
    const res = await buildApp(true).request('/admin/ai/prompt-variants');
    expect([res.status, (await res.json()).code]).toEqual([503, 'quality_timeout']);
  });
});
