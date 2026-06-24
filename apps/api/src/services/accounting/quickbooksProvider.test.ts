import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'crypto';

vi.mock('../../db', () => ({
  runOutsideDbContext: <T>(fn: () => T) => fn(),
}));

describe('QuickbooksProvider', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('buildAuthUrl embeds state, scope, redirect_uri', async () => {
    const { quickbooksProvider } = await import('./quickbooksProvider');
    const url = quickbooksProvider.buildAuthUrl('state-abc');
    expect(url).toContain('com.intuit.quickbooks.accounting');
    expect(url).toContain('state=state-abc');
    expect(url).toContain('response_type=code');
    expect(url).toContain('redirect_uri=');
  });

  it('refresh returns the ROTATED refresh token, not the input', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      access_token: 'new-at',
      refresh_token: 'ROTATED-rt',
      expires_in: 3600,
      x_refresh_token_expires_in: 8640000,
    }), { status: 200 })));

    const { quickbooksProvider } = await import('./quickbooksProvider');
    const tokens = await quickbooksProvider.refresh('old-rt');
    expect(tokens.refreshToken).toBe('ROTATED-rt');
    expect(tokens.accessToken).toBe('new-at');
    expect(tokens.accessTokenExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('exchangeCode posts grant_type=authorization_code and parses expiry', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
      x_refresh_token_expires_in: 8640000,
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { quickbooksProvider } = await import('./quickbooksProvider');
    const tokens = await quickbooksProvider.exchangeCode('the-code', 'realm-9');
    expect(tokens.realmId).toBe('realm-9');
    const body = String(fetchMock.mock.calls[0]?.[1]?.body ?? '');
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code=the-code');
  });

  it('verifies webhook signatures with HMAC-SHA256', async () => {
    const { quickbooksProvider } = await import('./quickbooksProvider');
    const body = '{"eventNotifications":[]}';
    const signature = createHmac('sha256', 'verifier-token').update(body).digest('base64');
    expect(quickbooksProvider.verifyWebhook(signature, body, 'verifier-token')).toBe(true);
    expect(quickbooksProvider.verifyWebhook(signature, body, 'wrong-token')).toBe(false);
  });
});
