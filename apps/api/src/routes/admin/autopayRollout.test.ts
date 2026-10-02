import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
const m = vi.hoisted(() => ({
  auth: null as any, rows: [] as Array<{ id: string; autopayEnabled: boolean }>,
  update: vi.fn(), set: vi.fn(), audit: vi.fn(),
}));
vi.mock('../../db', () => ({
  db: { update: (...args: unknown[]) => { m.update(...args); return {
    set: (value: unknown) => { m.set(value); return { where: () => ({ returning: async () => m.rows }) }; },
  }; } },
  runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../../middleware/auth', async importOriginal => ({
  ...(await importOriginal<typeof import('../../middleware/auth')>()),
  authMiddleware: async (c: any, next: any) => {
    if (!m.auth) {
      const { HTTPException } = await import('hono/http-exception');
      throw new HTTPException(401, { message: 'Not authenticated' });
    }
    c.set('auth', m.auth); await next();
  },
  requireMfa: () => async (c: any, next: any) => m.auth?.token?.mfa ? next() : c.json({ code: 'MFA_REQUIRED' }, 403),
}));
vi.mock('../../services/auditService', () => ({ createAuditLogAsync: vi.fn() }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: (...args: unknown[]) => m.audit(...args) }));
import { platformAdminMiddleware } from '../../middleware/platformAdmin';
import { adminAutopayRolloutRoutes } from './autopayRollout';
const partnerId = '11111111-1111-4111-8111-111111111111';
const app = new Hono();
app.use('/admin/*', platformAdminMiddleware);
app.route('/admin', adminAutopayRolloutRoutes);
function request(body: unknown, id = partnerId) {
  return app.request(`/admin/partners/${id}/autopay`, { method: 'PATCH',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.clearAllMocks(); m.auth = { user: { id: partnerId, isPlatformAdmin: true }, token: { mfa: true } };
  m.rows = [{ id: partnerId, autopayEnabled: true }];
});
describe('autopay admin rollout', () => {
  it.each([true, false])('writes and audits autopayEnabled=%s', async autopayEnabled => {
    m.rows[0]!.autopayEnabled = autopayEnabled;
    const response = await request({ autopayEnabled });
    expect(response.status).toBe(200); expect(m.set).toHaveBeenCalledWith({ autopayEnabled });
    expect(m.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ resourceId: partnerId,
      action: 'partner.autopay_rollout.update', details: { autopayEnabled } }));
  });
  it('denies unauthenticated, partner-admin and missing-MFA callers', async () => {
    m.auth = null; expect((await request({ autopayEnabled: true })).status).toBe(401);
    m.auth = { user: { isPlatformAdmin: false }, token: { mfa: true } };
    expect((await request({ autopayEnabled: true })).status).toBe(403);
    m.auth = { user: { isPlatformAdmin: true }, token: { mfa: false } };
    expect((await request({ autopayEnabled: true })).status).toBe(403); expect(m.update).not.toHaveBeenCalled();
  });
  it.each([{}, { autopayEnabled: 'true' }, { autopayEnabled: true, partnerId }])('rejects %j', async body => {
    expect((await request(body)).status).toBe(400); expect(m.update).not.toHaveBeenCalled();
  });
  it('rejects malformed ids and returns 404 for absent partners', async () => {
    expect((await request({ autopayEnabled: true }, 'bad')).status).toBe(400);
    m.rows = []; expect((await request({ autopayEnabled: true })).status).toBe(404);
    expect(m.audit).not.toHaveBeenCalled();
  });
});
