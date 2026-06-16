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

vi.mock('../../services/stripeConnectService', () => ({
  buildOAuthUrl: vi.fn().mockResolvedValue({ url: 'https://connect.stripe.com/oauth/authorize?x=1' }),
  getConnection: vi.fn().mockResolvedValue({ status: 'connected', stripeAccountId: 'acct_9', livemode: false }),
  consumeState: vi.fn().mockResolvedValue(true),
  completeOAuth: vi.fn().mockResolvedValue({ stripeAccountId: 'acct_9' }),
  disconnect: vi.fn().mockResolvedValue(undefined),
}));

import { stripeConnectRoutes } from './index';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  buildOAuthUrl,
  getConnection,
  consumeState,
  completeOAuth,
  disconnect,
} from '../../services/stripeConnectService';

describe('stripe-connect routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authGates.permissionDenied = false;
    authGates.mfaDenied = false;
    authState.value = {
      user: { id: '11111111-1111-1111-1111-111111111111', email: 'u@example.com', name: 'U' },
      partnerId: 'partner-1',
    };
    (buildOAuthUrl as any).mockResolvedValue({ url: 'https://connect.stripe.com/oauth/authorize?x=1' });
    (getConnection as any).mockResolvedValue({ status: 'connected', stripeAccountId: 'acct_9', livemode: false });
    (consumeState as any).mockResolvedValue(true);
    (completeOAuth as any).mockResolvedValue({ stripeAccountId: 'acct_9' });
    (disconnect as any).mockResolvedValue(undefined);
  });

  it('POST /oauth/start returns an authorize url', async () => {
    const res = await stripeConnectRoutes.request('/oauth/start', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ url: expect.stringContaining('connect.stripe.com') });
    expect(buildOAuthUrl).toHaveBeenCalledWith({
      partnerId: 'partner-1',
      userId: '11111111-1111-1111-1111-111111111111',
    });
  });

  it('GET / returns connection status', async () => {
    const res = await stripeConnectRoutes.request('/', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'connected', stripeAccountId: 'acct_9', livemode: false });
  });

  it('GET / returns disconnected when no connected row', async () => {
    (getConnection as any).mockResolvedValue(null);
    const res = await stripeConnectRoutes.request('/', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'disconnected' });
  });

  it('GET /oauth/callback consumes state, completes oauth, audits, and REDIRECTS to billing settings', async () => {
    const res = await stripeConnectRoutes.request('/oauth/callback?code=ac_1&state=st_1', { method: 'GET' });
    // UX: redirect the browser back to the partner billing-settings page (not raw JSON).
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/settings/billing');
    expect(location).toContain('stripe_connected=1');
    expect(consumeState).toHaveBeenCalledWith('st_1', 'partner-1');
    expect(completeOAuth).toHaveBeenCalledWith({
      code: 'ac_1',
      partnerId: 'partner-1',
      userId: '11111111-1111-1111-1111-111111111111',
    });
    expect(writeRouteAudit).toHaveBeenCalled();
  });

  it('GET /oauth/callback REDIRECTS with an error flag on invalid state', async () => {
    (consumeState as any).mockResolvedValue(false);
    const res = await stripeConnectRoutes.request('/oauth/callback?code=ac_1&state=bad', { method: 'GET' });
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/settings/billing');
    expect(location).toContain('stripe_error=');
    expect(completeOAuth).not.toHaveBeenCalled();
  });

  it('GET /oauth/callback REDIRECTS with an error flag on missing code/state', async () => {
    const res = await stripeConnectRoutes.request('/oauth/callback', { method: 'GET' });
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/settings/billing');
    expect(location).toContain('stripe_error=');
  });

  it('DELETE / disconnects and audits', async () => {
    const res = await stripeConnectRoutes.request('/', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'disconnected' });
    expect(disconnect).toHaveBeenCalledWith('partner-1');
    expect(writeRouteAudit).toHaveBeenCalled();
  });

  it('403s when no partner context', async () => {
    authState.value = { user: { id: '11111111-1111-1111-1111-111111111111', email: 'u@example.com', name: 'U' }, partnerId: null };
    const res = await stripeConnectRoutes.request('/oauth/start', { method: 'POST' });
    expect(res.status).toBe(403);
  });
});
