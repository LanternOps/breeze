/**
 * Unit tests for savePartnerStripeKey (issue #2189 fix).
 *
 * The cross-partner "Stripe account already claimed" case must be detected by
 * the SYSTEM-context pre-check SELECT (partner-axis RLS hides the other
 * partner's row from the request context) and surface as a typed
 * PartnerStripeError — never by letting the acct_uq 23505 raise inside the
 * request transaction, where postgres.js re-throws the raw error at commit and
 * clobbers the mapped response into a 500.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const PARTNER_A = '11111111-1111-4111-8111-111111111111';
const PARTNER_B = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

const { dbMocks, accountsRetrieveMock, systemContextCalls } = vi.hoisted(() => ({
  dbMocks: {
    // queue of results for successive db.select()...limit() terminals
    selectResults: [] as unknown[][],
    insertedValues: [] as Record<string, unknown>[],
    upsertConfigs: [] as Record<string, unknown>[],
    upsertErrors: [] as unknown[],
    updatedValues: [] as Record<string, unknown>[],
    callOrder: [] as string[],
    insertSystemContextDepths: [] as number[],
  },
  accountsRetrieveMock: vi.fn(),
  systemContextCalls: { count: 0, depth: 0 },
}));

vi.mock('stripe', () => ({
  default: class MockStripe {
    accounts = { retrieve: accountsRetrieveMock };
    constructor(_key: string, _opts?: unknown) {}
  },
}));

vi.mock('./secretCrypto', () => ({
  encryptSecret: (x: string) => `enc(${x})`,
  decryptSecret: (x: string) => x.replace(/^enc\((.*)\)$/, '$1'),
}));

vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: async (fn: () => unknown) => {
    systemContextCalls.count += 1;
    systemContextCalls.depth += 1;
    try {
      return await fn();
    } finally {
      systemContextCalls.depth -= 1;
    }
  },
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => {
            dbMocks.callOrder.push('select');
            return Promise.resolve(dbMocks.selectResults.shift() ?? []);
          }),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((vals: Record<string, unknown>) => {
        dbMocks.callOrder.push('insert');
        dbMocks.insertSystemContextDepths.push(systemContextCalls.depth);
        dbMocks.insertedValues.push(vals);
        return {
          onConflictDoUpdate: vi.fn((cfg: Record<string, unknown>) => {
            dbMocks.upsertConfigs.push(cfg);
            const err = dbMocks.upsertErrors.shift();
            return err ? Promise.reject(err) : Promise.resolve();
          }),
        };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((vals: Record<string, unknown>) => {
        dbMocks.callOrder.push('update');
        dbMocks.updatedValues.push(vals);
        return { where: vi.fn(() => Promise.resolve()) };
      }),
    })),
  },
}));

import {
  getPartnerStripeStatus,
  getStripeAccountCurrency,
  PartnerStripeError,
  refreshPartnerStripeAccount,
  savePartnerStripeKey,
} from './partnerStripe';

const TEST_KEY = ['sk', 'test', '51UNITtestKEY9999'].join('_');
const CLAIM_MESSAGE =
  'That Stripe account is already connected to another partner. Use a key for a different Stripe account.';

beforeEach(() => {
  dbMocks.selectResults.length = 0;
  dbMocks.insertedValues.length = 0;
  dbMocks.upsertConfigs.length = 0;
  dbMocks.upsertErrors.length = 0;
  dbMocks.updatedValues.length = 0;
  dbMocks.callOrder.length = 0;
  dbMocks.insertSystemContextDepths.length = 0;
  systemContextCalls.count = 0;
  systemContextCalls.depth = 0;
  accountsRetrieveMock.mockReset();
  accountsRetrieveMock.mockResolvedValue({ id: 'acct_unit' });
});

describe('savePartnerStripeKey', () => {
  it('happy path: validates the key, pre-checks under a system context, then upserts encrypted', async () => {
    dbMocks.selectResults.push([]); // account not claimed by anyone

    const res = await savePartnerStripeKey({ partnerId: PARTNER_A, apiKey: TEST_KEY, userId: USER_ID });

    expect(res).toEqual({
      stripeAccountId: 'acct_unit',
      last4: '9999',
      livemode: false,
      defaultCurrency: null,
      accountCountry: null,
      accountRefreshedAt: expect.any(Date),
    });
    // Pre-check ran inside the system context (partner-axis RLS would hide a
    // cross-partner claim from the request context).
    expect(systemContextCalls.count).toBe(2);
    expect(dbMocks.callOrder).toEqual(['select', 'insert']);
    expect(dbMocks.insertSystemContextDepths).toEqual([1]);
    const vals = dbMocks.insertedValues[0]!;
    expect(vals.partnerId).toBe(PARTNER_A);
    expect(vals.apiKey).toBe(`enc(${TEST_KEY})`); // never plaintext
    expect(vals.stripeAccountId).toBe('acct_unit');
    expect(dbMocks.upsertConfigs).toHaveLength(1); // partner_id upsert reached
  });

  it('captures and normalizes Stripe account currency and country in both upsert arms', async () => {
    accountsRetrieveMock.mockResolvedValue({ id: 'acct_unit', default_currency: 'eur', country: 'DE' });
    dbMocks.selectResults.push([]);

    const res = await savePartnerStripeKey({ partnerId: PARTNER_A, apiKey: TEST_KEY, userId: USER_ID });

    expect(res).toEqual({
      stripeAccountId: 'acct_unit',
      last4: '9999',
      livemode: false,
      defaultCurrency: 'EUR',
      accountCountry: 'DE',
      accountRefreshedAt: expect.any(Date),
    });
    expect(dbMocks.insertedValues[0]).toMatchObject({ defaultCurrency: 'EUR', accountCountry: 'DE' });
    expect(dbMocks.upsertConfigs[0]!.set).toMatchObject({ defaultCurrency: 'EUR', accountCountry: 'DE' });
  });

  it('account claimed by ANOTHER partner: throws the typed error BEFORE any write', async () => {
    dbMocks.selectResults.push([{ partnerId: PARTNER_B }]);

    await expect(savePartnerStripeKey({ partnerId: PARTNER_A, apiKey: TEST_KEY, userId: USER_ID }))
      .rejects.toMatchObject({
        name: 'PartnerStripeError',
        code: 'INVALID_STRIPE_KEY',
        status: 400,
        message: CLAIM_MESSAGE,
      });

    // The write never runs, so no statement can raise inside the request
    // transaction — the mapped error survives to the route (#2189).
    expect(dbMocks.insertedValues).toHaveLength(0);
  });

  it('account claimed by the SAME partner (key rotation / reconnect): proceeds with the upsert', async () => {
    dbMocks.selectResults.push([{ partnerId: PARTNER_A }]);

    const res = await savePartnerStripeKey({ partnerId: PARTNER_A, apiKey: TEST_KEY, userId: USER_ID });

    expect(res.stripeAccountId).toBe('acct_unit');
    expect(dbMocks.insertedValues).toHaveLength(1);
  });

  it('concurrent-race backstop: an acct_uq 23505 from the upsert still maps to the typed error', async () => {
    dbMocks.selectResults.push([]); // pre-check saw nothing (claim landed after it)
    const pgError = Object.assign(new Error('duplicate key value violates unique constraint "stripe_connect_accounts_acct_uq"'), {
      code: '23505',
      constraint_name: 'stripe_connect_accounts_acct_uq',
    });
    dbMocks.upsertErrors.push(Object.assign(new Error('Failed query: insert ...'), { cause: pgError }));

    await expect(savePartnerStripeKey({ partnerId: PARTNER_A, apiKey: TEST_KEY, userId: USER_ID }))
      .rejects.toMatchObject({ name: 'PartnerStripeError', code: 'INVALID_STRIPE_KEY', message: CLAIM_MESSAGE });
  });

  it('a non-unique-violation upsert error is rethrown unchanged', async () => {
    dbMocks.selectResults.push([]);
    const dbDown = new Error('connection terminated');
    dbMocks.upsertErrors.push(dbDown);

    await expect(savePartnerStripeKey({ partnerId: PARTNER_A, apiKey: TEST_KEY, userId: USER_ID }))
      .rejects.toBe(dbDown);
  });

  it('a key Stripe rejects maps to INVALID_STRIPE_KEY without touching the DB', async () => {
    accountsRetrieveMock.mockRejectedValue(
      Object.assign(new Error('Invalid API Key provided'), { type: 'StripeAuthenticationError' })
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(savePartnerStripeKey({ partnerId: PARTNER_A, apiKey: TEST_KEY, userId: USER_ID }))
        .rejects.toMatchObject({ name: 'PartnerStripeError', code: 'INVALID_STRIPE_KEY' });
    } finally {
      consoleSpy.mockRestore();
    }
    expect(systemContextCalls.count).toBe(0);
    expect(dbMocks.insertedValues).toHaveLength(0);
  });

  it('a live-mode key sets livemode=true', async () => {
    dbMocks.selectResults.push([]);
    const liveKey = ['rk', 'live', '51LIVEkey8888'].join('_');
    const res = await savePartnerStripeKey({ partnerId: PARTNER_A, apiKey: liveKey, userId: USER_ID });
    expect(res.livemode).toBe(true);
    expect(dbMocks.insertedValues[0]!.livemode).toBe(true);
  });
});

describe('getPartnerStripeStatus', () => {
  it('returns cached account fields for a connected account', async () => {
    const accountRefreshedAt = new Date('2026-08-21T12:00:00.000Z');
    dbMocks.selectResults.push([{
      status: 'connected',
      apiKey: 'enc(sk_test_x)',
      stripeAccountId: 'acct_unit',
      keyLast4: '9999',
      livemode: false,
      defaultCurrency: 'EUR',
      accountCountry: 'DE',
      accountRefreshedAt,
    }]);

    await expect(getPartnerStripeStatus(PARTNER_A)).resolves.toEqual({
      connected: true,
      stripeAccountId: 'acct_unit',
      last4: '9999',
      livemode: false,
      defaultCurrency: 'EUR',
      accountCountry: 'DE',
      accountRefreshedAt,
    });
  });
});

describe('refreshPartnerStripeAccount', () => {
  it('retrieves fresh account fields and updates the cache', async () => {
    dbMocks.selectResults.push([{
      apiKey: 'enc(sk_test_x)',
      status: 'connected',
      stripeAccountId: 'acct_unit',
      defaultCurrency: 'USD',
    }]);
    accountsRetrieveMock.mockResolvedValue({ id: 'acct_unit', default_currency: 'gbp', country: 'GB' });

    const res = await refreshPartnerStripeAccount(PARTNER_A);

    expect(res).toEqual({
      defaultCurrency: 'GBP',
      accountCountry: 'GB',
      accountRefreshedAt: expect.any(Date),
    });
    expect(dbMocks.updatedValues).toHaveLength(1);
    expect(dbMocks.updatedValues[0]).toEqual({
      defaultCurrency: 'GBP',
      accountCountry: 'GB',
      accountRefreshedAt: res.accountRefreshedAt,
      updatedAt: res.accountRefreshedAt,
    });
  });

  it('maps transient Stripe failures and does not update the cache', async () => {
    dbMocks.selectResults.push([{
      apiKey: 'enc(sk_test_x)',
      status: 'connected',
      stripeAccountId: 'acct_unit',
      defaultCurrency: 'USD',
    }]);
    accountsRetrieveMock.mockRejectedValue({ type: 'StripeConnectionError' });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(refreshPartnerStripeAccount(PARTNER_A)).rejects.toMatchObject({
        name: 'PartnerStripeError',
        code: 'INVALID_STRIPE_KEY',
        message: 'Could not reach Stripe right now — try again in a moment.',
      });
    } finally {
      consoleSpy.mockRestore();
    }
    expect(dbMocks.updatedValues).toHaveLength(0);
  });
});

describe('getStripeAccountCurrency', () => {
  it('returns a fresh connected cache entry without calling Stripe', async () => {
    const accountRefreshedAt = new Date();
    dbMocks.selectResults.push([{
      defaultCurrency: 'USD',
      accountCountry: 'US',
      accountRefreshedAt,
      status: 'connected',
    }]);

    await expect(getStripeAccountCurrency(PARTNER_A)).resolves.toEqual({
      defaultCurrency: 'USD',
      accountCountry: 'US',
      accountRefreshedAt,
      stale: false,
    });
    expect(accountsRetrieveMock).not.toHaveBeenCalled();
  });

  it('refreshes a connected cache entry older than the TTL', async () => {
    dbMocks.selectResults.push(
      [{
        defaultCurrency: 'USD',
        accountCountry: 'US',
        accountRefreshedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        status: 'connected',
      }],
      [{
        apiKey: 'enc(sk_test_x)',
        status: 'connected',
        stripeAccountId: 'acct_unit',
        defaultCurrency: 'USD',
      }],
    );
    accountsRetrieveMock.mockResolvedValue({ id: 'acct_unit', default_currency: 'cad', country: 'CA' });

    const res = await getStripeAccountCurrency(PARTNER_A);

    expect(res).toEqual({
      defaultCurrency: 'CAD',
      accountCountry: 'CA',
      accountRefreshedAt: expect.any(Date),
      stale: false,
    });
    expect(accountsRetrieveMock).toHaveBeenCalledTimes(1);
  });

  it('serves stale cached values when refresh fails', async () => {
    const accountRefreshedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    dbMocks.selectResults.push(
      [{ defaultCurrency: 'USD', accountCountry: 'US', accountRefreshedAt, status: 'connected' }],
      [{
        apiKey: 'enc(sk_test_x)',
        status: 'connected',
        stripeAccountId: 'acct_unit',
        defaultCurrency: 'USD',
      }],
    );
    accountsRetrieveMock.mockRejectedValue({ type: 'StripeConnectionError' });
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(getStripeAccountCurrency(PARTNER_A)).resolves.toEqual({
        defaultCurrency: 'USD',
        accountCountry: 'US',
        accountRefreshedAt,
        stale: true,
      });
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
