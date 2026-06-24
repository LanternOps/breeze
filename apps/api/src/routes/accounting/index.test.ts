import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createHmac } from 'crypto';

// The route's signingSecret() falls through APP_ENCRYPTION_KEY/SECRET_ENCRYPTION_KEY/
// SESSION_SECRET to JWT_SECRET, which the api test setup (src/__tests__/setup.ts)
// sets. Mint state with that same ambient secret — do NOT stub env here, or it
// perturbs the shared-worker process.env that secretCrypto reads in sibling tests.
const FIXED_SECRET = 'test-jwt-secret-must-be-at-least-32-characters-long';

function mintState(partnerId: string, userId: string | null, exp = Date.now() + 60_000): { state: string; cookie: string } {
  const payload = { partnerId, userId, nonce: 'test-nonce', exp };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', FIXED_SECRET).update(`accounting-oauth:${encoded}`).digest('base64url');
  const state = `${encoded}.${sig}`;
  const cookie = createHmac('sha256', FIXED_SECRET).update(`accounting-oauth-cookie:${state}`).digest('base64url');
  return { state, cookie };
}

const { authState, mocks } = vi.hoisted(() => ({
  authState: {
    scope: 'partner' as 'partner' | 'system' | 'organization',
    partnerId: '11111111-1111-1111-1111-111111111111' as string | null,
    mfa: true,
  },
  mocks: {
    getConnection: vi.fn(),
    upsertConnection: vi.fn(),
    deleteConnection: vi.fn(),
    exchangeCode: vi.fn(),
    buildAuthUrl: vi.fn((state: string) => `https://qbo.example.test/connect?scope=com.intuit.quickbooks.accounting&state=${encodeURIComponent(state)}`),
  },
}));

vi.mock('../../db', () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => []),
        })),
      })),
    })),
  },
  runOutsideDbContext: <T>(fn: () => T) => fn(),
  withSystemDbAccessContext: <T>(fn: () => T) => fn(),
}));

vi.mock('../../config/env', () => ({
  QBO_CLIENT_ID: 'client-id',
  QBO_CLIENT_SECRET: 'client-secret',
  QBO_REDIRECT_URI: 'https://api.example.test/accounting/quickbooks/callback',
  QBO_ENVIRONMENT: 'production',
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('auth', {
      scope: authState.scope,
      partnerId: authState.partnerId,
      orgId: null,
      accessibleOrgIds: [],
      canAccessOrg: vi.fn(() => true),
      user: { id: '33333333-3333-3333-3333-333333333333', email: 'admin@example.com', name: 'Admin' },
      token: { mfa: authState.mfa },
    });
    return next();
  }),
  requireScope: vi.fn((...scopes: string[]) => async (c: any, next: any) => {
    if (!scopes.includes(authState.scope)) return c.json({ error: 'Insufficient permissions' }, 403);
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (!authState.mfa) return c.json({ error: 'MFA required' }, 403);
    return next();
  }),
}));

vi.mock('../../services/accounting/accountingConnectionService', () => ({
  getConnection: mocks.getConnection,
  upsertConnection: mocks.upsertConnection,
  deleteConnection: mocks.deleteConnection,
}));

vi.mock('../../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../../services/accounting/providerRegistry', () => ({
  getAccountingProvider: vi.fn(() => ({
    provider: 'quickbooks',
    buildAuthUrl: mocks.buildAuthUrl,
    exchangeCode: mocks.exchangeCode,
  })),
}));

import { accountingRoutes } from './index';

describe('accounting routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    authState.scope = 'partner';
    authState.partnerId = '11111111-1111-1111-1111-111111111111';
    authState.mfa = true;
    app = new Hono();
    app.route('/accounting', accountingRoutes);
  });

  it('connect returns an authUrl containing the QuickBooks accounting scope', async () => {
    const res = await app.request('/accounting/quickbooks/connect');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authUrl).toContain('com.intuit.quickbooks.accounting');
    expect(mocks.buildAuthUrl).toHaveBeenCalledWith(expect.any(String));
  });

  it('status returns connection status without token fields', async () => {
    mocks.getConnection.mockResolvedValueOnce({
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      partnerId: authState.partnerId,
      provider: 'quickbooks',
      realmId: 'realm-1',
      accessToken: 'secret-access-token',
      refreshToken: 'secret-refresh-token',
      accessTokenExpiresAt: new Date(),
      refreshTokenExpiresAt: new Date(),
      environment: 'production',
      homeCurrency: null,
      defaultIncomeAccountRef: null,
      defaultTaxCodeRef: null,
      pushMode: 'auto',
      status: 'connected',
      createdAt: new Date('2026-06-23T00:00:00Z'),
      updatedAt: new Date(),
      lastError: null,
    });

    const res = await app.request('/accounting/quickbooks');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('connected');
    expect(body.accessToken).toBeUndefined();
    expect(body.refreshToken).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('secret-access-token');
  });

  it('callback with a bad state returns 400', async () => {
    const res = await app.request('/accounting/quickbooks/callback?code=abc&realmId=realm-1&state=bad-state');

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('OAuth state') });
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
    expect(mocks.upsertConnection).not.toHaveBeenCalled();
  });

  it('callback is NOT behind authMiddleware (signed state + cookie authenticate it)', async () => {
    mocks.exchangeCode.mockResolvedValueOnce({
      realmId: 'realm-1',
      accessToken: 'at',
      refreshToken: 'rt',
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      refreshTokenExpiresAt: new Date(Date.now() + 8_640_000_000),
    });
    const { state, cookie } = mintState(authState.partnerId!, '33333333-3333-3333-3333-333333333333');

    const res = await app.request(
      `/accounting/quickbooks/callback?code=abc&realmId=realm-1&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: `breeze_accounting_oauth_state=${cookie}` } },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('connected=1');
    expect(mocks.exchangeCode).toHaveBeenCalledWith('abc', 'realm-1');
    expect(mocks.upsertConnection).toHaveBeenCalledWith(
      expect.anything(),
      authState.partnerId,
      'quickbooks',
      expect.objectContaining({ accessToken: 'at', refreshToken: 'rt', connectedBy: '33333333-3333-3333-3333-333333333333' }),
    );
  });

  it('callback with a valid state but MISSING binding cookie is rejected (CSRF)', async () => {
    const { state } = mintState(authState.partnerId!, null);

    const res = await app.request(
      `/accounting/quickbooks/callback?code=abc&realmId=realm-1&state=${encodeURIComponent(state)}`,
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('binding') });
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
    expect(mocks.upsertConnection).not.toHaveBeenCalled();
  });

  it('callback with a PRESENT but MISMATCHED binding cookie is rejected (CSRF)', async () => {
    const { state } = mintState(authState.partnerId!, null);
    const other = mintState(authState.partnerId!, null, Date.now() + 120_000); // a DIFFERENT state's cookie

    const res = await app.request(
      `/accounting/quickbooks/callback?code=abc&realmId=realm-1&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: `breeze_accounting_oauth_state=${other.cookie}` } },
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('binding') });
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
  });

  it('callback with an EXPIRED state is rejected', async () => {
    const { state, cookie } = mintState(authState.partnerId!, null, Date.now() - 1000);

    const res = await app.request(
      `/accounting/quickbooks/callback?code=abc&realmId=realm-1&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: `breeze_accounting_oauth_state=${cookie}` } },
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('OAuth state') });
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
  });

  it('callback redirects to error=exchange_failed when token exchange throws (no connection persisted)', async () => {
    mocks.exchangeCode.mockRejectedValueOnce(new Error('intuit 400 invalid_grant'));
    const { state, cookie } = mintState(authState.partnerId!, '33333333-3333-3333-3333-333333333333');

    const res = await app.request(
      `/accounting/quickbooks/callback?code=bad&realmId=realm-1&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: `breeze_accounting_oauth_state=${cookie}` } },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('error=exchange_failed');
    expect(mocks.upsertConnection).not.toHaveBeenCalled();
  });

  it('disconnect requires MFA', async () => {
    authState.mfa = false;

    const res = await app.request('/accounting/quickbooks/disconnect', { method: 'POST' });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: 'MFA required' });
    expect(mocks.deleteConnection).not.toHaveBeenCalled();
  });
});
