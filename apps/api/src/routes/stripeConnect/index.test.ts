import { beforeEach, describe, expect, it, vi } from 'vitest';

const authGates = vi.hoisted(() => ({
  permissionDenied: false,
  mfaDenied: false,
}));

const authState: { value: any } = {
  value: {
    user: { id: '11111111-1111-1111-1111-111111111111', email: 'u@example.com', name: 'U' },
    partnerId: 'partner-1',
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

// Re-export the real PartnerStripeError so the route's `instanceof` check matches.
vi.mock('../../services/partnerStripe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/partnerStripe')>();
  return {
    PartnerStripeError: actual.PartnerStripeError,
    savePartnerStripeKey: vi.fn(),
    getPartnerStripeStatus: vi.fn(),
    disconnectPartnerStripe: vi.fn(),
  };
});

import { stripeConnectRoutes } from './index';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  savePartnerStripeKey,
  getPartnerStripeStatus,
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
      partnerId: 'partner-1',
    };
    (savePartnerStripeKey as any).mockResolvedValue({ stripeAccountId: 'acct_9', last4: '4242', livemode: false });
    (getPartnerStripeStatus as any).mockResolvedValue({ connected: true, stripeAccountId: 'acct_9', last4: '4242', livemode: false });
    (disconnectPartnerStripe as any).mockResolvedValue(undefined);
  });

  it('POST /key saves the key, audits, and returns connected status', async () => {
    const res = await postKey('sk_test_abcdefghijkl');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'connected', stripeAccountId: 'acct_9', livemode: false, last4: '4242' });
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

  it('GET / returns connected status with last4', async () => {
    const res = await stripeConnectRoutes.request('/', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'connected', stripeAccountId: 'acct_9', livemode: false, last4: '4242' });
  });

  it('GET / returns disconnected when no key is configured', async () => {
    (getPartnerStripeStatus as any).mockResolvedValue({ connected: false, last4: null });
    const res = await stripeConnectRoutes.request('/', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'disconnected' });
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

  it('403s when MFA is not satisfied', async () => {
    authGates.mfaDenied = true;
    const res = await postKey('sk_test_abcdefghijkl');
    expect(res.status).toBe(403);
    expect(savePartnerStripeKey).not.toHaveBeenCalled();
  });
});
