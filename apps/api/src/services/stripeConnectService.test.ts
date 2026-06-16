// apps/api/src/services/stripeConnectService.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const oauthToken = vi.fn();
const oauthDeauthorize = vi.fn();
// Controllable Redis mock: a single instance whose get/set/del are stable spies,
// and a `present` flag so a test can simulate Redis being offline (getRedis → null).
const { redisSet, redisGet, redisDel, redisState } = vi.hoisted(() => ({
  redisSet: vi.fn(),
  redisGet: vi.fn(),
  redisDel: vi.fn(),
  redisState: { present: true },
}));
vi.mock('./stripeClient', () => ({
  getStripe: () => ({ oauth: { token: oauthToken, deauthorize: oauthDeauthorize } }),
  isStripeConfigured: () => true
}));
vi.mock('../config/validate', () => ({ getConfig: () => ({
  STRIPE_CONNECT_CLIENT_ID: 'ca_test', STRIPE_OAUTH_REDIRECT_URL: 'https://app/cb'
}) }));
vi.mock('./redis', () => ({
  getRedis: () => (redisState.present ? { set: redisSet, get: redisGet, del: redisDel } : null)
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

import { buildOAuthUrl, completeOAuth, getConnectionByAccount, consumeState } from './stripeConnectService';

beforeEach(() => {
  oauthToken.mockReset(); oauthDeauthorize.mockReset();
  redisSet.mockReset(); redisGet.mockReset(); redisDel.mockReset();
  redisState.present = true;
});

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

describe('consumeState (CSRF + partner pinning, single-use)', () => {
  it('returns true and DELETES the key (single-use) when the stored partner matches', async () => {
    redisGet.mockResolvedValue('partner-1');
    const ok = await consumeState('st_1', 'partner-1');
    expect(ok).toBe(true);
    // Single-use: the state key must be deleted exactly once so a replay fails.
    expect(redisDel).toHaveBeenCalledTimes(1);
    expect(redisDel).toHaveBeenCalledWith('stripe:oauth:state:st_1');
  });

  it('returns false when the stored partner does NOT match (state bound to another partner)', async () => {
    redisGet.mockResolvedValue('partner-OTHER');
    const ok = await consumeState('st_1', 'partner-1');
    expect(ok).toBe(false);
    // Still single-use: the key is consumed even on a mismatch.
    expect(redisDel).toHaveBeenCalledTimes(1);
  });

  it('returns false when the state is missing/expired (no stored value)', async () => {
    redisGet.mockResolvedValue(null);
    const ok = await consumeState('st_missing', 'partner-1');
    expect(ok).toBe(false);
  });

  it('returns false (fail closed) when Redis is offline', async () => {
    redisState.present = false;
    const ok = await consumeState('st_1', 'partner-1');
    expect(ok).toBe(false);
    expect(redisGet).not.toHaveBeenCalled();
  });
});
