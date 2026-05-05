import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./auth', () => ({
  authMiddleware: vi.fn(),
}));

vi.mock('../services/auditService', () => ({
  createAuditLogAsync: vi.fn(),
}));

vi.mock('../services/clientIp', () => ({
  getTrustedClientIpOrUndefined: vi.fn(() => '127.0.0.1'),
}));

import { Hono } from 'hono';
import { platformAdminMiddleware } from './platformAdmin';
import { authMiddleware } from './auth';
import { createAuditLogAsync } from '../services/auditService';

type AuthShape = {
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean };
};

function makeApp(authToInject: AuthShape | null) {
  const app = new Hono();

  vi.mocked(authMiddleware).mockImplementation(async (c, next) => {
    if (authToInject) {
      c.set('auth', authToInject as never);
    }
    await next();
  });

  app.use('*', platformAdminMiddleware);
  app.get('/admin/partners/:id/anything', (c) => c.json({ ok: true, partnerId: c.req.param('id') }));
  return app;
}

describe('platformAdminMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 403 when not authenticated (no auth context after auth middleware)', async () => {
    const app = makeApp(null);
    const res = await app.request('/admin/partners/p-1/anything');
    expect(res.status).toBe(403);
    expect(createAuditLogAsync).not.toHaveBeenCalled();
  });

  it('returns 403 when authenticated but not a platform admin', async () => {
    const app = makeApp({
      user: { id: 'u1', email: 'u@x.com', name: 'U', isPlatformAdmin: false },
    });
    const res = await app.request('/admin/partners/p-1/anything');
    expect(res.status).toBe(403);
    expect(createAuditLogAsync).not.toHaveBeenCalled();
  });

  it('passes through and audit-logs when caller is platform admin', async () => {
    const app = makeApp({
      user: { id: 'u1', email: 'pa@x.com', name: 'PA', isPlatformAdmin: true },
    });
    const res = await app.request('/admin/partners/p-1/anything');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(createAuditLogAsync).toHaveBeenCalledTimes(1);
    const audit = vi.mocked(createAuditLogAsync).mock.calls[0]![0];
    expect(audit.action).toMatch(/^platform_admin\./);
    expect(audit.actorId).toBe('u1');
    expect(audit.resourceType).toBe('platform_admin');
  });
});
