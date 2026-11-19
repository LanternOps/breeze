import { beforeEach, describe, expect, it, vi } from 'vitest';

const restoreBillingFraudRestriction = vi.hoisted(() => vi.fn());
vi.mock('../../services/partnerTrustFraudFlags', () => ({ restoreBillingFraudRestriction }));

vi.mock('../../middleware/auth', () => ({
  requireMfa: vi.fn(() => async (c: any, next: () => Promise<void>) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Not authenticated' }, 401);
    if (auth.token?.mfa === false) return c.json({ error: 'MFA required' }, 403);
    await next();
  }),
}));

import { Hono } from 'hono';
import { trustFraudFlagAdminRoutes } from './trustFraudFlags';

const PARTNER_ID = '22222222-2222-4222-8222-222222222222';
const FLAG_ROW_ID = '33333333-3333-4333-8333-333333333333';
const auth = {
  user: { id: '11111111-1111-4111-8111-111111111111', email: 'admin@breeze.test', isPlatformAdmin: true },
  token: { mfa: true },
};

function buildApp(injected: unknown = auth) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', injected as never);
    await next();
  });
  app.route('/admin', trustFraudFlagAdminRoutes);
  return app;
}

function post(app: Hono, partnerId: string, body: unknown) {
  return app.request(`/admin/partners/${partnerId}/trust/fraud-flag-restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /admin/partners/:id/trust/fraud-flag-restore', () => {
  beforeEach(() => {
    restoreBillingFraudRestriction.mockReset();
  });

  it('restores with the acting admin, the seen flag rows and the optional reason', async () => {
    restoreBillingFraudRestriction.mockResolvedValue({ status: 'restored', trustState: 'trusted', restoredFlagIds: [FLAG_ROW_ID] });

    const res = await post(buildApp(), PARTNER_ID, { flagIds: [FLAG_ROW_ID], reason: 'reviewed' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, trustState: 'trusted', restoredFlagIds: [FLAG_ROW_ID] });
    expect(restoreBillingFraudRestriction).toHaveBeenCalledWith({
      partnerId: PARTNER_ID,
      actorUserId: auth.user.id,
      flagIds: [FLAG_ROW_ID],
      operatorReason: 'reviewed',
    });
  });

  it('does not require a reason (one click)', async () => {
    restoreBillingFraudRestriction.mockResolvedValue({ status: 'restored', trustState: 'probation', restoredFlagIds: [FLAG_ROW_ID] });

    const res = await post(buildApp(), PARTNER_ID, { flagIds: [FLAG_ROW_ID] });

    expect(res.status).toBe(200);
    expect(restoreBillingFraudRestriction).toHaveBeenCalledWith(expect.objectContaining({ operatorReason: null }));
  });

  it.each([
    ['not_restorable', /promote with override/],
    ['stale', /refresh/],
  ])('answers 409 when the service says %s', async (status, message) => {
    restoreBillingFraudRestriction.mockResolvedValue({ status });

    const res = await post(buildApp(), PARTNER_ID, { flagIds: [FLAG_ROW_ID] });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(message);
  });

  it.each([
    ['a non-uuid partner id', 'not-a-uuid', { flagIds: [FLAG_ROW_ID] }],
    ['no flag ids', PARTNER_ID, { flagIds: [] }],
    ['a non-uuid flag id', PARTNER_ID, { flagIds: ['x'] }],
  ])('rejects %s with 400 and never calls the service', async (_label, partnerId, body) => {
    const res = await post(buildApp(), partnerId, body);

    expect(res.status).toBe(400);
    expect(restoreBillingFraudRestriction).not.toHaveBeenCalled();
  });

  it('requires the MFA step-up', async () => {
    const res = await post(buildApp({ ...auth, token: { mfa: false } }), PARTNER_ID, { flagIds: [FLAG_ROW_ID] });

    expect(res.status).toBe(403);
    expect(restoreBillingFraudRestriction).not.toHaveBeenCalled();
  });
});
