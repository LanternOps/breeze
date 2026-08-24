import { beforeEach, describe, expect, it, vi } from 'vitest';

const authGates = vi.hoisted(() => ({
  permissionDenied: false,
  mfaDenied: false,
}));

const authState: { value: any } = {
  value: {
    user: { id: '11111111-1111-1111-1111-111111111111', email: 'u@example.com', name: 'U' },
    scope: 'partner',
    partnerId: 'partner-1',
    partnerOrgAccess: 'all',
  },
};

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', authState.value);
    await next();
  },
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (authGates.permissionDenied) {
      return c.json({ error: 'Permission denied' }, 403);
    }
    await next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (authGates.mfaDenied) {
      return c.json({ error: 'MFA required' }, 403);
    }
    await next();
  }),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    BILLING_MANAGE: { resource: 'billing', action: 'manage' },
  },
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn(async (callback: () => unknown) => callback()),
  withSystemDbAccessContext: vi.fn(async (callback: () => unknown) => callback()),
}));

// Re-export the real PartnerStripeError so the route's `instanceof` check matches.
vi.mock('../../services/partnerStripe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/partnerStripe')>();
  return {
    PartnerStripeError: actual.PartnerStripeError,
    savePartnerStripeKey: vi.fn(),
    getPartnerStripeAccountSnapshot: vi.fn(),
    refreshPartnerStripeAccount: vi.fn(),
    disconnectPartnerStripe: vi.fn(),
  };
});

import { stripeConnectRoutes } from './index';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  savePartnerStripeKey,
  getPartnerStripeAccountSnapshot,
  refreshPartnerStripeAccount,
  disconnectPartnerStripe,
  PartnerStripeError,
} from '../../services/partnerStripe';

function postKey(apiKey: unknown) {
  return stripeConnectRoutes.request('/key', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  });
}

describe('stripe-connect (API-key) routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authGates.permissionDenied = false;
    authGates.mfaDenied = false;
    authState.value = {
      user: { id: '11111111-1111-1111-1111-111111111111', email: 'u@example.com', name: 'U' },
      scope: 'partner',
      partnerId: 'partner-1',
      partnerOrgAccess: 'all',
    };
    (savePartnerStripeKey as any).mockResolvedValue({
      stripeAccountId: 'acct_9',
      last4: '4242',
      livemode: false,
      defaultCurrency: 'EUR',
      accountCountry: 'DE',
      accountRefreshedAt: new Date('2026-08-22T00:00:00.000Z'),
    });
    (getPartnerStripeAccountSnapshot as any).mockResolvedValue({
      connected: true,
      stripeAccountId: 'acct_9',
      last4: '4242',
      livemode: false,
      defaultCurrency: 'EUR',
      accountCountry: 'DE',
      accountRefreshedAt: new Date('2026-08-22T00:00:00.000Z'),
      cacheState: 'fresh',
      error: null,
    });
    (refreshPartnerStripeAccount as any).mockResolvedValue({
      stripeAccountId: 'acct_9',
      last4: '4242',
      livemode: false,
      defaultCurrency: 'EUR',
      accountCountry: 'DE',
      accountRefreshedAt: new Date('2026-08-22T00:00:00.000Z'),
    });
    (disconnectPartnerStripe as any).mockResolvedValue(undefined);
  });

  it('POST /key saves the key, audits, and returns connected status', async () => {
    const res = await postKey('sk_test_abcdefghijkl');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'connected',
      stripeAccountId: 'acct_9',
      livemode: false,
      last4: '4242',
      defaultCurrency: 'EUR',
      accountCountry: 'DE',
      accountRefreshedAt: '2026-08-22T00:00:00.000Z',
    });
    expect(savePartnerStripeKey).toHaveBeenCalledWith({
      partnerId: 'partner-1',
      apiKey: 'sk_test_abcdefghijkl',
      userId: '11111111-1111-1111-1111-111111111111',
    });
    expect(writeRouteAudit).toHaveBeenCalled();
  });

  it('POST /key rejects an empty/too-short key with 400 before hitting Stripe', async () => {
    const res = await postKey('sk_x');
    expect(res.status).toBe(400);
    expect(savePartnerStripeKey).not.toHaveBeenCalled();
  });

  it('POST /key surfaces a rejected key as a 400 with the service message (not a 500)', async () => {
    (savePartnerStripeKey as any).mockRejectedValue(
      new PartnerStripeError('That Stripe key was rejected — double-check it.', 'INVALID_STRIPE_KEY'),
    );
    const res = await postKey('sk_test_rejectedkey0');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('rejected') });
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('GET / returns ONE consistent snapshot (status + cache from the same row) — never a separate status read (review F9)', async () => {
    const res = await stripeConnectRoutes.request('/', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'connected',
      stripeAccountId: 'acct_9',
      livemode: false,
      last4: '4242',
      defaultCurrency: 'EUR',
      accountCountry: 'DE',
      accountRefreshedAt: '2026-08-22T00:00:00.000Z',
      cacheState: 'fresh',
      stale: false,
      error: null,
    });
    expect(getPartnerStripeAccountSnapshot).toHaveBeenCalledWith('partner-1');
  });

  it('GET / surfaces a transient refresh failure as stale (cached values kept, flagged) (review F4)', async () => {
    (getPartnerStripeAccountSnapshot as any).mockResolvedValue({
      connected: true,
      stripeAccountId: 'acct_9',
      last4: '4242',
      livemode: true,
      defaultCurrency: 'USD',
      accountCountry: 'US',
      accountRefreshedAt: new Date('2026-08-01T00:00:00.000Z'),
      cacheState: 'stale',
      error: { code: 'STRIPE_UNAVAILABLE', message: 'Could not reach Stripe right now — try again in a moment.' },
    });
    const res = await stripeConnectRoutes.request('/', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'connected',
      stripeAccountId: 'acct_9',
      livemode: true,
      last4: '4242',
      defaultCurrency: 'USD',
      accountCountry: 'US',
      accountRefreshedAt: '2026-08-01T00:00:00.000Z',
      cacheState: 'stale',
      stale: true,
      error: { code: 'STRIPE_UNAVAILABLE', message: 'Could not reach Stripe right now — try again in a moment.' },
    });
  });

  it('GET / reports a revoked/unreadable key as reconnect_required — NOT as connected (review F4)', async () => {
    (getPartnerStripeAccountSnapshot as any).mockResolvedValue({
      connected: true,
      stripeAccountId: 'acct_9',
      last4: '4242',
      livemode: true,
      defaultCurrency: 'USD',
      accountCountry: 'US',
      accountRefreshedAt: new Date('2026-08-01T00:00:00.000Z'),
      cacheState: 'reconnect_required',
      error: { code: 'INVALID_STRIPE_KEY', message: 'Stripe rejected the stored key — reconnect Stripe.' },
    });
    const res = await stripeConnectRoutes.request('/', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('reconnect_required');
    expect(body.cacheState).toBe('reconnect_required');
    expect(body.stale).toBe(true);
    expect(body.last4).toBe('4242');
    expect(body.error).toEqual({ code: 'INVALID_STRIPE_KEY', message: 'Stripe rejected the stored key — reconnect Stripe.' });
  });

  it('GET / returns disconnected when no key is configured', async () => {
    (getPartnerStripeAccountSnapshot as any).mockResolvedValue({ connected: false, last4: null });
    const res = await stripeConnectRoutes.request('/', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'disconnected' });
  });

  it('POST /refresh refreshes and returns account metadata', async () => {
    const res = await stripeConnectRoutes.request('/refresh', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'connected',
      stripeAccountId: 'acct_9',
      livemode: false,
      last4: '4242',
      defaultCurrency: 'EUR',
      accountCountry: 'DE',
      accountRefreshedAt: '2026-08-22T00:00:00.000Z',
      cacheState: 'fresh',
      stale: false,
      error: null,
    });
    expect(refreshPartnerStripeAccount).toHaveBeenCalledWith('partner-1');
    expect(writeRouteAudit).toHaveBeenCalledWith(
      expect.anything(),
      {
        orgId: null,
        action: 'stripe_connect.account_refreshed',
        resourceType: 'partner',
        resourceId: 'partner-1',
        details: { defaultCurrency: 'EUR', accountCountry: 'DE' },
      },
    );
  });

  it('POST /refresh returns the PartnerStripeError status and message', async () => {
    (refreshPartnerStripeAccount as any).mockRejectedValue(
      new PartnerStripeError('Online payment is not available — connect Stripe first.', 'NO_STRIPE_KEY'),
    );
    const res = await stripeConnectRoutes.request('/refresh', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Online payment is not available — connect Stripe first.',
    });
  });

  it('POST /refresh returns 403 without BILLING_MANAGE permission', async () => {
    authGates.permissionDenied = true;
    const res = await stripeConnectRoutes.request('/refresh', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(refreshPartnerStripeAccount).not.toHaveBeenCalled();
  });

  it('DELETE / disconnects and audits', async () => {
    const res = await stripeConnectRoutes.request('/', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'disconnected' });
    expect(disconnectPartnerStripe).toHaveBeenCalledWith('partner-1');
    expect(writeRouteAudit).toHaveBeenCalled();
  });

  it('403s when no partner context', async () => {
    authState.value = { user: { id: '11111111-1111-1111-1111-111111111111', email: 'u@example.com', name: 'U' }, partnerId: null };
    const res = await postKey('sk_test_abcdefghijkl');
    expect(res.status).toBe(403);
  });

  // Org-scoped tokens carry the org's partnerId, and billing:manage can be
  // granted to org-scope custom roles — the partnerId presence check alone
  // does not prove partner-wide authority over the payment credential.
  it.each([
    ['GET /', () => stripeConnectRoutes.request('/', { method: 'GET' })],
    ['POST /key', () => postKey('sk_test_abcdefghijkl')],
    ['POST /refresh', () => stripeConnectRoutes.request('/refresh', { method: 'POST' })],
    ['DELETE /', () => stripeConnectRoutes.request('/', { method: 'DELETE' })],
  ] as const)('%s rejects organization-scoped auth even when it carries a partnerId', async (_name, request) => {
    authState.value = {
      user: { id: '11111111-1111-1111-1111-111111111111', email: 'u@example.com', name: 'U' },
      scope: 'organization',
      orgId: 'org-1',
      partnerId: 'partner-1',
      partnerOrgAccess: null,
    };
    const res = await request();
    expect(res.status).toBe(403);
    expect(savePartnerStripeKey).not.toHaveBeenCalled();
    expect(disconnectPartnerStripe).not.toHaveBeenCalled();
  });

  it.each([
    ['POST /key', () => postKey('sk_test_abcdefghijkl')],
    ['DELETE /', () => stripeConnectRoutes.request('/', { method: 'DELETE' })],
  ] as const)('%s rejects partner auth limited to selected organizations', async (_name, request) => {
    authState.value = {
      user: { id: '11111111-1111-1111-1111-111111111111', email: 'u@example.com', name: 'U' },
      scope: 'partner',
      partnerId: 'partner-1',
      partnerOrgAccess: 'selected',
    };
    const res = await request();
    expect(res.status).toBe(403);
    expect(savePartnerStripeKey).not.toHaveBeenCalled();
    expect(disconnectPartnerStripe).not.toHaveBeenCalled();
  });

  it('403s when MFA is not satisfied', async () => {
    authGates.mfaDenied = true;
    const res = await postKey('sk_test_abcdefghijkl');
    expect(res.status).toBe(403);
    expect(savePartnerStripeKey).not.toHaveBeenCalled();
  });
});
