import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

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

  it('disconnect requires MFA', async () => {
    authState.mfa = false;

    const res = await app.request('/accounting/quickbooks/disconnect', { method: 'POST' });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: 'MFA required' });
    expect(mocks.deleteConnection).not.toHaveBeenCalled();
  });
});
