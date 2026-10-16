import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A real grant store: mint, validate and consume run unmocked against this
// in-memory Redis, so the binding (operation, epochs, sid, resource digest) is
// what decides each answer, not a stubbed boolean.
const h = vi.hoisted(() => ({
  store: new Map<string, string>(),
  enable2fa: { value: true },
  epochs: { authEpoch: 3, mfaEpoch: 5 } as { authEpoch: number; mfaEpoch: number } | null,
}));
vi.mock('../services/redis', () => ({
  getRedis: () => ({
    setex: async (key: string, _ttl: number, value: string) => { h.store.set(key, value); return 'OK'; },
    get: async (key: string) => h.store.get(key) ?? null,
    getdel: async (key: string) => { const value = h.store.get(key) ?? null; h.store.delete(key); return value; },
  }),
}));
vi.mock('../services/authEpochs', () => ({ getUserEpochs: async () => h.epochs }));
vi.mock('./auth/schemas', async importOriginal => ({
  ...(await importOriginal<typeof import('./auth/schemas')>()),
  get ENABLE_2FA() { return h.enable2fa.value; },
}));

import {
  autopayChargeNowResourceDigest,
  autopayRequestRecipientResourceDigest,
  mintStepUpGrant,
  orgPaymentSettingsResourceDigest,
  partnerPaymentSettingsResourceDigest,
} from '../services/mfaStepUpGrant';
import { requireBillingStepUp } from './billingStepUp';

const userId = '11111111-1111-4111-8111-111111111111';
const invoiceA = '22222222-2222-4222-8222-222222222222';
const invoiceB = '33333333-3333-4333-8333-333333333333';
let auth: Record<string, any>;

function appFor(invoiceId: string) {
  const app = new Hono();
  app.post('/charge', async c => {
    c.set('auth', auth as never);
    const body = await c.req.json().catch(() => ({})) as { stepUpGrant?: string };
    const refusal = await requireBillingStepUp(c, {
      operation: 'autopay_charge_now', resource: { invoiceId },
      resourceDigest: autopayChargeNowResourceDigest({ invoiceId }), grant: body.stepUpGrant,
    });
    return refusal ?? c.json({ ok: true });
  });
  return app;
}
const post = (app: Hono, body: unknown = {}) => app.request('/charge', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const mint = (invoiceId: string, overrides: Partial<{ sid: string; operation: any; userId: string }> = {}) => mintStepUpGrant({
  userId: overrides.userId ?? userId, operation: overrides.operation ?? 'autopay_charge_now',
  authEpoch: 3, mfaEpoch: 5, sid: overrides.sid ?? 'sid-1',
  resourceDigest: autopayChargeNowResourceDigest({ invoiceId }),
});

beforeEach(() => {
  h.store.clear(); h.enable2fa.value = true; h.epochs = { authEpoch: 3, mfaEpoch: 5 };
  auth = { user: { id: userId }, token: { mfa: true, sid: 'sid-1' }, principal: { kind: 'user_session' } };
});

describe('requireBillingStepUp', () => {
  it('asks for a step-up naming the operation and the exact resource when no grant is sent', async () => {
    const res = await post(appFor(invoiceA));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Step-up required', code: 'STEP_UP_REQUIRED',
      stepUp: { operation: 'autopay_charge_now', resource: { invoiceId: invoiceA } } });
  });

  it('accepts a grant bound to this invoice exactly once', async () => {
    const grant = await mint(invoiceA);
    expect((await post(appFor(invoiceA), { stepUpGrant: grant })).status).toBe(200);
    // Single use: the same grant cannot authorize a second charge.
    const replay = await post(appFor(invoiceA), { stepUpGrant: grant });
    expect(replay.status).toBe(403);
    expect((await replay.json()).code).toBe('STEP_UP_REQUIRED');
  });

  it.each([
    ['another invoice', () => mint(invoiceB)],
    ['another operation', () => mint(invoiceA, { operation: 'device_move_org' })],
    ['another session', () => mint(invoiceA, { sid: 'sid-2' })],
    ['another user', () => mint(invoiceA, { userId: '44444444-4444-4444-8444-444444444444' })],
  ])('refuses a grant minted for %s', async (_case, makeGrant) => {
    const res = await post(appFor(invoiceA), { stepUpGrant: await makeGrant() });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('STEP_UP_REQUIRED');
  });

  it('refuses a grant after a factor change bumped the MFA epoch', async () => {
    const grant = await mint(invoiceA);
    h.epochs = { authEpoch: 3, mfaEpoch: 6 };
    expect((await post(appFor(invoiceA), { stepUpGrant: grant })).status).toBe(403);
  });

  it('requires an MFA-assured session before looking at any grant', async () => {
    auth.token.mfa = false;
    const res = await post(appFor(invoiceA), { stepUpGrant: await mint(invoiceA) });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('MFA_REQUIRED');
  });

  it.each(['api_key', 'mcp_oauth', 'ai_agent'])('refuses a %s principal outright', async kind => {
    auth.principal = { kind };
    const res = await post(appFor(invoiceA), { stepUpGrant: await mint(invoiceA) });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Interactive user session required' });
  });

  it('answers 503 when the session epochs cannot be read', async () => {
    const grant = await mint(invoiceA);
    h.epochs = null;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post(appFor(invoiceA), { stepUpGrant: grant });
    expect(res.status).toBe(503);
    // Coded, so a client can tell nothing was attempted; logged, so the cause is visible.
    expect(await res.json()).toEqual({ error: 'Second-factor verification is temporarily unavailable', code: 'STEP_UP_UNAVAILABLE' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('autopay_charge_now'));
    error.mockRestore();
  });

  it('needs no step-up on a deployment with two-factor authentication disabled', async () => {
    h.enable2fa.value = false; auth.token = {};
    expect((await post(appFor(invoiceA))).status).toBe(200);
  });
});

describe('billing step-up digests', () => {
  const partnerId = '55555555-5555-4555-8555-555555555555';
  it('binds payment settings to the partner and every saved value, independent of key order', () => {
    const a = partnerPaymentSettingsResourceDigest({ partnerId, settings: { autopayCapEnabled: true, autopayCapAmount: '500.00', autopayCapCurrency: 'USD' } });
    const b = partnerPaymentSettingsResourceDigest({ partnerId, settings: { autopayCapCurrency: 'USD', autopayCapAmount: '500.00', autopayCapEnabled: true } });
    expect(a).toBe(b);
    expect(partnerPaymentSettingsResourceDigest({ partnerId, settings: { autopayCapEnabled: true, autopayCapAmount: '5000.00', autopayCapCurrency: 'USD' } })).not.toBe(a);
    expect(partnerPaymentSettingsResourceDigest({ partnerId: invoiceA, settings: { autopayCapEnabled: true, autopayCapAmount: '500.00', autopayCapCurrency: 'USD' } })).not.toBe(a);
    // Nested values are bound too.
    const attested = (value: boolean) => partnerPaymentSettingsResourceDigest({ partnerId,
      settings: { feeAttestation: { doesNotExceedAcceptanceCost: true, acquirerAndNetworksNotified30DaysAgo: value } } });
    expect(attested(true)).not.toBe(attested(false));
  });

  it('binds organization payment settings to the organization and every saved value, apart from the partner binding', () => {
    const orgId = '66666666-6666-4666-8666-666666666666';
    const settings = { autopayCapEnabled: true, autopayCapAmount: '500.00', autopayCapCurrency: 'USD' };
    const a = orgPaymentSettingsResourceDigest({ orgId, settings });
    expect(orgPaymentSettingsResourceDigest({ orgId: orgId.toUpperCase(),
      settings: { autopayCapCurrency: 'USD', autopayCapAmount: '500.00', autopayCapEnabled: true } })).toBe(a);
    expect(orgPaymentSettingsResourceDigest({ orgId, settings: { ...settings, autopayCapAmount: '5000.00' } })).not.toBe(a);
    expect(orgPaymentSettingsResourceDigest({ orgId: partnerId, settings })).not.toBe(a);
    // A partner grant for the same id and values never fits an organization save.
    expect(partnerPaymentSettingsResourceDigest({ partnerId: orgId, settings })).not.toBe(a);
  });

  it('binds a redirected authorization request to the exact org set, recipient and mode', () => {
    const base = autopayRequestRecipientResourceDigest({ orgIds: [invoiceA, invoiceB], recipientOverride: 'accounts@example.test' });
    expect(autopayRequestRecipientResourceDigest({ orgIds: [invoiceB, invoiceA, invoiceA], recipientOverride: 'accounts@example.test', mode: 'request' })).toBe(base);
    expect(autopayRequestRecipientResourceDigest({ orgIds: [invoiceA], recipientOverride: 'accounts@example.test' })).not.toBe(base);
    expect(autopayRequestRecipientResourceDigest({ orgIds: [invoiceA, invoiceB], recipientOverride: 'other@example.test' })).not.toBe(base);
    expect(autopayRequestRecipientResourceDigest({ orgIds: [invoiceA, invoiceB], recipientOverride: 'accounts@example.test', mode: 'reauthorize' })).not.toBe(base);
  });

  it('binds a charge to one invoice id, independent of letter case', () => {
    expect(autopayChargeNowResourceDigest({ invoiceId: invoiceA })).not.toBe(autopayChargeNowResourceDigest({ invoiceId: invoiceB }));
    expect(autopayChargeNowResourceDigest({ invoiceId: invoiceA.toUpperCase() })).toBe(autopayChargeNowResourceDigest({ invoiceId: invoiceA }));
  });
});
