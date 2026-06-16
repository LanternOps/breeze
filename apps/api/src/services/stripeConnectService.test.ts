// apps/api/src/services/stripeConnectService.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const oauthToken = vi.fn();
const oauthDeauthorize = vi.fn();
const redisSet = vi.fn();
vi.mock('./stripeClient', () => ({
  getStripe: () => ({ oauth: { token: oauthToken, deauthorize: oauthDeauthorize } }),
  isStripeConfigured: () => true
}));
vi.mock('../config/validate', () => ({ getConfig: () => ({
  STRIPE_CONNECT_CLIENT_ID: 'ca_test', STRIPE_OAUTH_REDIRECT_URL: 'https://app/cb'
}) }));
vi.mock('./redis', () => ({
  getRedis: () => ({ set: redisSet, get: vi.fn(), del: vi.fn() })
}));
vi.mock('./secretCrypto', () => ({ encryptSecret: (v: string | null) => (v ? `enc:${v}` : null) }));
const selectRows = vi.hoisted(() => ({ value: [] as unknown[] }));
vi.mock('../db', () => ({
  db: {
    insert: vi.fn(() => ({ values: () => ({ onConflictDoUpdate: () => Promise.resolve() }) })),
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(selectRows.value) }) }),
    })),
  },
  withSystemDbAccessContext: (fn: () => Promise<unknown>) => fn()
}));

import { buildOAuthUrl, completeOAuth, getConnectionByAccount } from './stripeConnectService';

beforeEach(() => { oauthToken.mockReset(); oauthDeauthorize.mockReset(); redisSet.mockReset(); });

describe('buildOAuthUrl', () => {
  it('includes client_id, scope, redirect_uri and the signed state', async () => {
    const { url } = await buildOAuthUrl({ partnerId: 'p1', userId: 'u1' });
    expect(url).toContain('client_id=ca_test');
    expect(url).toContain('scope=read_write');
    expect(url).toContain('redirect_uri=');
    expect(url).toContain('state=');
  });
});

describe('completeOAuth', () => {
  it('exchanges the code and returns the connected account id', async () => {
    oauthToken.mockResolvedValue({ stripe_user_id: 'acct_99', access_token: 'tok', livemode: false, scope: 'read_write' });
    const result = await completeOAuth({ code: 'ac_1', partnerId: 'p1', userId: 'u1' });
    expect(oauthToken).toHaveBeenCalledWith({ grant_type: 'authorization_code', code: 'ac_1' });
    expect(result.stripeAccountId).toBe('acct_99');
  });
});

describe('getConnectionByAccount', () => {
  beforeEach(() => { selectRows.value = []; });

  it('returns the row for a known account (read in system context)', async () => {
    selectRows.value = [{ partnerId: 'p1', stripeAccountId: 'acct_5', livemode: true, status: 'connected' }];
    const row = await getConnectionByAccount('acct_5');
    expect(row).toMatchObject({ partnerId: 'p1', livemode: true });
  });

  it('returns null for an unknown account', async () => {
    selectRows.value = [];
    const row = await getConnectionByAccount('acct_missing');
    expect(row).toBeNull();
  });
});
