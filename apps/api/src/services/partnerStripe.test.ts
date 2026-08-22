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
    selectWheres: [] as unknown[],
    insertedValues: [] as Record<string, unknown>[],
    upsertConfigs: [] as Record<string, unknown>[],
    upsertErrors: [] as unknown[],
    updatedValues: [] as Record<string, unknown>[],
    updateWheres: [] as unknown[],
    // queue of rows for successive db.update()...returning() terminals
    updateReturning: [] as unknown[][],
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
  decryptSecret: (x: string) => {
    const m = /^enc\((.*)\)$/.exec(x);
    if (!m) throw new Error('bad ciphertext');
    return m[1];
  },
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
        where: vi.fn((cond: unknown) => {
          dbMocks.selectWheres.push(cond);
          const run = () => {
            dbMocks.callOrder.push('select');
            return Promise.resolve(dbMocks.selectResults.shift() ?? []);
          };
          return {
            limit: vi.fn(run),
            // listPartnersNeedingStripeAccountBootstrap terminates on orderBy.
            orderBy: vi.fn(run),
          };
        }),
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
        return {
          where: vi.fn((cond: unknown) => {
            dbMocks.updateWheres.push(cond);
            return {
              returning: vi.fn(() => Promise.resolve(dbMocks.updateReturning.shift() ?? [])),
            };
          }),
        };
      }),
    })),
  },
}));

import {
  STRIPE_ACCOUNT_BOOTSTRAP_RECHECK_MS,
  getPartnerStripeStatus,
  getPartnerStripeAccountSnapshot,
  PartnerStripeError,
  listPartnersNeedingStripeAccountBootstrap,
  refreshPartnerStripeAccount,
  savePartnerStripeKey,
} from './partnerStripe';

/**
 * Walk a drizzle SQL tree and collect every bound parameter value + referenced
 * column name, so where-clause assertions check the REAL guard rather than a
 * vacuous "where was called" (see memory: vacuous Drizzle where-clause assertions).
 */
function collectSqlTerms(node: unknown, out: { params: unknown[]; columns: string[] } = { params: [], columns: [] }) {
  if (!node || typeof node !== 'object') return out;
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.queryChunks)) for (const c of n.queryChunks) collectSqlTerms(c, out);
  else if (Array.isArray(node)) for (const c of node) collectSqlTerms(c, out);
  else if ('value' in n && 'encoder' in n) out.params.push(n.value);
  else if (typeof n.name === 'string' && 'table' in n) out.columns.push(n.name);
  return out;
}

const TEST_KEY = ['sk', 'test', '51UNITtestKEY9999'].join('_');
const CLAIM_MESSAGE =
  'That Stripe account is already connected to another partner. Use a key for a different Stripe account.';

beforeEach(() => {
  dbMocks.selectResults.length = 0;
  dbMocks.selectWheres.length = 0;
  dbMocks.insertedValues.length = 0;
  dbMocks.upsertConfigs.length = 0;
  dbMocks.upsertErrors.length = 0;
  dbMocks.updatedValues.length = 0;
  dbMocks.updateWheres.length = 0;
  dbMocks.updateReturning.length = 0;
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

  // Review F6: a Stripe outage at save time is not a bad paste. It used to
  // reuse an inline copy of the transient predicate and still return
  // INVALID_STRIPE_KEY/400, telling the partner to fix a key that is fine.
  it.each(['StripeConnectionError', 'StripeAPIError', 'StripeRateLimitError'])(
    'a transient %s during validation maps to STRIPE_UNAVAILABLE (503), not INVALID_STRIPE_KEY',
    async (type) => {
      accountsRetrieveMock.mockRejectedValue(Object.assign(new Error('stripe down'), { type }));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(savePartnerStripeKey({ partnerId: PARTNER_A, apiKey: TEST_KEY, userId: USER_ID }))
          .rejects.toMatchObject({
            name: 'PartnerStripeError',
            code: 'STRIPE_UNAVAILABLE',
            status: 503,
            message: 'Could not reach Stripe to verify the key right now — please try again in a moment.',
          });
      } finally {
        consoleSpy.mockRestore();
      }
      expect(dbMocks.insertedValues).toHaveLength(0);
    },
  );

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
  const connectedRow = (stripeAccountId = 'acct_unit') => ({
    apiKey: 'enc(sk_test_x)',
    status: 'connected',
    stripeAccountId,
    defaultCurrency: 'USD',
  });
  const returnedRow = (over: Record<string, unknown> = {}) => ({
    stripeAccountId: 'acct_unit',
    keyLast4: '9999',
    livemode: false,
    defaultCurrency: 'GBP',
    accountCountry: 'GB',
    accountRefreshedAt: new Date(),
    ...over,
  });

  it('retrieves fresh account fields, updates the cache via RETURNING, and returns the persisted row', async () => {
    dbMocks.selectResults.push([connectedRow()]);
    accountsRetrieveMock.mockResolvedValue({ id: 'acct_unit', default_currency: 'gbp', country: 'GB' });
    dbMocks.updateReturning.push([returnedRow()]);

    const res = await refreshPartnerStripeAccount(PARTNER_A);

    expect(res).toEqual({
      stripeAccountId: 'acct_unit',
      last4: '9999',
      livemode: false,
      defaultCurrency: 'GBP',
      accountCountry: 'GB',
      accountRefreshedAt: expect.any(Date),
    });
    expect(dbMocks.updatedValues).toHaveLength(1);
    const written = dbMocks.updatedValues[0]!;
    expect(written).toEqual({
      defaultCurrency: 'GBP',
      accountCountry: 'GB',
      accountRefreshedAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    expect(written.updatedAt).toBe(written.accountRefreshedAt); // one `now` stamp
  });

  it('guards the update on partner + account id + connected status (review F9)', async () => {
    dbMocks.selectResults.push([connectedRow()]);
    accountsRetrieveMock.mockResolvedValue({ id: 'acct_unit', default_currency: 'gbp', country: 'GB' });
    dbMocks.updateReturning.push([returnedRow()]);

    await refreshPartnerStripeAccount(PARTNER_A);

    const terms = collectSqlTerms(dbMocks.updateWheres[0]);
    expect(terms.columns).toEqual(expect.arrayContaining(['partner_id', 'stripe_account_id', 'status']));
    expect(terms.params).toEqual(expect.arrayContaining([PARTNER_A, 'acct_unit', 'connected']));
  });

  it('zero rows updated (key replaced mid-flight): retries against the NEW account instead of returning unpersisted values', async () => {
    dbMocks.selectResults.push([connectedRow('acct_old')], [connectedRow('acct_new')]);
    accountsRetrieveMock
      .mockResolvedValueOnce({ id: 'acct_old', default_currency: 'usd', country: 'US' })
      .mockResolvedValueOnce({ id: 'acct_new', default_currency: 'eur', country: 'DE' });
    dbMocks.updateReturning.push([], [returnedRow({ stripeAccountId: 'acct_new', defaultCurrency: 'EUR', accountCountry: 'DE' })]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const res = await refreshPartnerStripeAccount(PARTNER_A);
      expect(res).toMatchObject({ stripeAccountId: 'acct_new', defaultCurrency: 'EUR', accountCountry: 'DE' });
    } finally {
      warnSpy.mockRestore();
    }
    expect(accountsRetrieveMock).toHaveBeenCalledTimes(2);
    // Second guard is keyed on the NEW account id.
    expect(collectSqlTerms(dbMocks.updateWheres[1]).params).toEqual(expect.arrayContaining(['acct_new']));
  });

  // Review F4: an exhausted RETURNING guard is a local key-replacement race, not
  // a Stripe outage — it must not claim "could not reach Stripe" (nor be counted
  // as a transient Stripe failure by the sweep).
  it('zero rows updated twice: throws STRIPE_CONNECTION_CHANGED (409), never STRIPE_UNAVAILABLE', async () => {
    dbMocks.selectResults.push([connectedRow()], [connectedRow()]);
    accountsRetrieveMock.mockResolvedValue({ id: 'acct_unit', default_currency: 'gbp', country: 'GB' });
    dbMocks.updateReturning.push([], []);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(refreshPartnerStripeAccount(PARTNER_A)).rejects.toMatchObject({
        name: 'PartnerStripeError',
        code: 'STRIPE_CONNECTION_CHANGED',
        status: 409,
        message: 'Your Stripe connection changed while it was being refreshed — reload the page and try again.',
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('zero rows updated because the account was disconnected mid-flight: surfaces NO_STRIPE_KEY', async () => {
    dbMocks.selectResults.push([connectedRow()], [{ ...connectedRow(), status: 'disconnected', apiKey: null }]);
    accountsRetrieveMock.mockResolvedValue({ id: 'acct_unit', default_currency: 'gbp', country: 'GB' });
    dbMocks.updateReturning.push([]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(refreshPartnerStripeAccount(PARTNER_A)).rejects.toMatchObject({ code: 'NO_STRIPE_KEY' });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('maps transient Stripe failures to STRIPE_UNAVAILABLE (503) and does not update the cache', async () => {
    dbMocks.selectResults.push([connectedRow()]);
    accountsRetrieveMock.mockRejectedValue({ type: 'StripeConnectionError' });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(refreshPartnerStripeAccount(PARTNER_A)).rejects.toMatchObject({
        name: 'PartnerStripeError',
        code: 'STRIPE_UNAVAILABLE',
        status: 503,
        message: 'Could not reach Stripe right now — try again in a moment.',
      });
    } finally {
      consoleSpy.mockRestore();
    }
    expect(dbMocks.updatedValues).toHaveLength(0);
  });

  it('maps a StripeAuthenticationError — the one failure that proves the key is dead — to INVALID_STRIPE_KEY (400)', async () => {
    dbMocks.selectResults.push([connectedRow()]);
    accountsRetrieveMock.mockRejectedValue(Object.assign(new Error('Invalid API Key provided'), { type: 'StripeAuthenticationError' }));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(refreshPartnerStripeAccount(PARTNER_A)).rejects.toMatchObject({
        code: 'INVALID_STRIPE_KEY',
        status: 400,
      });
    } finally {
      consoleSpy.mockRestore();
    }
    expect(dbMocks.updatedValues).toHaveLength(0);
  });

  // Review F2: a restricted key without accounts.retrieve, an odd invalid-request,
  // or an untyped network error say NOTHING about whether checkout still works.
  // They must not be reported as a dead key.
  it.each([
    ['StripePermissionError', Object.assign(new Error('key lacks accounts read'), { type: 'StripePermissionError' })],
    ['StripeInvalidRequestError', Object.assign(new Error('no such account'), { type: 'StripeInvalidRequestError' })],
    ['an untyped error', new Error('socket hang up')],
  ])('%s degrades to STRIPE_ACCOUNT_UNKNOWN, never INVALID_STRIPE_KEY', async (_label, err) => {
    dbMocks.selectResults.push([connectedRow()]);
    accountsRetrieveMock.mockRejectedValue(err);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(refreshPartnerStripeAccount(PARTNER_A)).rejects.toMatchObject({
        code: 'STRIPE_ACCOUNT_UNKNOWN',
        status: 503,
      });
    } finally {
      consoleSpy.mockRestore();
    }
    expect(dbMocks.updatedValues).toHaveLength(0);
  });
});

describe('getPartnerStripeAccountSnapshot', () => {
  const statusRow = (over: Record<string, unknown> = {}) => ({
    status: 'connected',
    apiKey: 'enc(sk_test_x)',
    stripeAccountId: 'acct_unit',
    keyLast4: '9999',
    livemode: false,
    defaultCurrency: 'USD',
    accountCountry: 'US',
    accountRefreshedAt: new Date(),
    ...over,
  });

  it('returns a fresh connected snapshot from ONE read without calling Stripe', async () => {
    const accountRefreshedAt = new Date();
    dbMocks.selectResults.push([statusRow({ accountRefreshedAt })]);

    await expect(getPartnerStripeAccountSnapshot(PARTNER_A)).resolves.toEqual({
      connected: true,
      stripeAccountId: 'acct_unit',
      last4: '9999',
      livemode: false,
      defaultCurrency: 'USD',
      accountCountry: 'US',
      accountRefreshedAt,
      cacheState: 'fresh',
      error: null,
    });
    expect(accountsRetrieveMock).not.toHaveBeenCalled();
    expect(dbMocks.callOrder).toEqual(['select']);
  });

  it('returns disconnected when there is no connected key', async () => {
    dbMocks.selectResults.push([{ status: 'disconnected', apiKey: null, keyLast4: '1234' }]);
    await expect(getPartnerStripeAccountSnapshot(PARTNER_A)).resolves.toEqual({ connected: false, last4: '1234' });
  });

  it('refreshes a connected entry older than the TTL and returns the PERSISTED refreshed row as the snapshot', async () => {
    dbMocks.selectResults.push(
      [statusRow({ accountRefreshedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })],
      [{ apiKey: 'enc(sk_test_x)', status: 'connected', stripeAccountId: 'acct_unit', defaultCurrency: 'USD' }],
    );
    accountsRetrieveMock.mockResolvedValue({ id: 'acct_unit', default_currency: 'cad', country: 'CA' });
    dbMocks.updateReturning.push([{
      stripeAccountId: 'acct_unit', keyLast4: '7777', livemode: true,
      defaultCurrency: 'CAD', accountCountry: 'CA', accountRefreshedAt: new Date(),
    }]);

    const res = await getPartnerStripeAccountSnapshot(PARTNER_A);

    expect(res).toEqual({
      connected: true,
      stripeAccountId: 'acct_unit',
      last4: '7777', // from the updated row, not the pre-refresh read
      livemode: true,
      defaultCurrency: 'CAD',
      accountCountry: 'CA',
      accountRefreshedAt: expect.any(Date),
      cacheState: 'fresh',
      error: null,
    });
    expect(accountsRetrieveMock).toHaveBeenCalledTimes(1);
  });

  it('a legacy row (never cached, accountRefreshedAt null) is treated as stale and refreshed', async () => {
    dbMocks.selectResults.push(
      [statusRow({ defaultCurrency: null, accountCountry: null, accountRefreshedAt: null })],
      [{ apiKey: 'enc(sk_test_x)', status: 'connected', stripeAccountId: 'acct_unit', defaultCurrency: null }],
    );
    accountsRetrieveMock.mockResolvedValue({ id: 'acct_unit', default_currency: 'eur', country: 'DE' });
    dbMocks.updateReturning.push([{
      stripeAccountId: 'acct_unit', keyLast4: '9999', livemode: false,
      defaultCurrency: 'EUR', accountCountry: 'DE', accountRefreshedAt: new Date(),
    }]);

    await expect(getPartnerStripeAccountSnapshot(PARTNER_A)).resolves.toMatchObject({ defaultCurrency: 'EUR', cacheState: 'fresh' });
  });

  it('serves the cached value flagged stale ONLY for a transient Stripe failure (review F4)', async () => {
    const accountRefreshedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    dbMocks.selectResults.push(
      [statusRow({ accountRefreshedAt })],
      [{ apiKey: 'enc(sk_test_x)', status: 'connected', stripeAccountId: 'acct_unit', defaultCurrency: 'USD' }],
    );
    accountsRetrieveMock.mockRejectedValue({ type: 'StripeRateLimitError' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(getPartnerStripeAccountSnapshot(PARTNER_A)).resolves.toEqual({
        connected: true,
        stripeAccountId: 'acct_unit',
        last4: '9999',
        livemode: false,
        defaultCurrency: 'USD',
        accountCountry: 'US',
        accountRefreshedAt,
        cacheState: 'stale',
        error: { code: 'STRIPE_UNAVAILABLE', message: 'Could not reach Stripe right now — try again in a moment.' },
      });
    } finally {
      warnSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('a revoked/invalid key is NOT served as stale success — the snapshot says reconnect_required (review F4)', async () => {
    const accountRefreshedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    dbMocks.selectResults.push(
      [statusRow({ accountRefreshedAt })],
      [{ apiKey: 'enc(sk_test_x)', status: 'connected', stripeAccountId: 'acct_unit', defaultCurrency: 'USD' }],
    );
    accountsRetrieveMock.mockRejectedValue(Object.assign(new Error('Invalid API Key provided'), { type: 'StripeAuthenticationError' }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(getPartnerStripeAccountSnapshot(PARTNER_A)).resolves.toMatchObject({
        connected: true,
        last4: '9999',
        cacheState: 'reconnect_required',
        error: { code: 'INVALID_STRIPE_KEY', message: 'Stripe rejected the stored key — reconnect Stripe.' },
      });
    } finally {
      errSpy.mockRestore();
    }
  });

  // Review F2: the snapshot for a restricted/unclassifiable failure must be a
  // quiet `unknown` cache — a partner whose checkout works must never be told
  // their payments are broken.
  it('a permission/unknown refresh failure reports cacheState unknown, NOT reconnect_required', async () => {
    const accountRefreshedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    dbMocks.selectResults.push(
      [statusRow({ accountRefreshedAt })],
      [{ apiKey: 'enc(sk_test_x)', status: 'connected', stripeAccountId: 'acct_unit', defaultCurrency: 'USD' }],
    );
    accountsRetrieveMock.mockRejectedValue(Object.assign(new Error('key lacks accounts read'), { type: 'StripePermissionError' }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(getPartnerStripeAccountSnapshot(PARTNER_A)).resolves.toMatchObject({
        connected: true,
        defaultCurrency: 'USD', // the cached value is still shown
        cacheState: 'unknown',
        error: { code: 'STRIPE_ACCOUNT_UNKNOWN' },
      });
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  // Review F4: the same local race seen through the snapshot — an unknown cache,
  // not "Stripe is down" and not "reconnect".
  it('a key-replacement race reports cacheState unknown with STRIPE_CONNECTION_CHANGED', async () => {
    const accountRefreshedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    dbMocks.selectResults.push(
      [statusRow({ accountRefreshedAt })],
      [{ apiKey: 'enc(sk_test_x)', status: 'connected', stripeAccountId: 'acct_unit', defaultCurrency: 'USD' }],
      [{ apiKey: 'enc(sk_test_x)', status: 'connected', stripeAccountId: 'acct_unit', defaultCurrency: 'USD' }],
    );
    accountsRetrieveMock.mockResolvedValue({ id: 'acct_unit', default_currency: 'usd', country: 'US' });
    dbMocks.updateReturning.push([], []); // both guarded updates hit zero rows
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(getPartnerStripeAccountSnapshot(PARTNER_A)).resolves.toMatchObject({
        connected: true,
        cacheState: 'unknown',
        error: { code: 'STRIPE_CONNECTION_CHANGED' },
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('undecryptable stored ciphertext is NOT served as stale success — reconnect_required with STRIPE_KEY_UNREADABLE', async () => {
    const accountRefreshedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    dbMocks.selectResults.push(
      [statusRow({ accountRefreshedAt, apiKey: 'garbage' })],
      [{ apiKey: 'garbage', status: 'connected', stripeAccountId: 'acct_unit', defaultCurrency: 'USD' }],
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(getPartnerStripeAccountSnapshot(PARTNER_A)).resolves.toMatchObject({
        connected: true,
        cacheState: 'reconnect_required',
        error: { code: 'STRIPE_KEY_UNREADABLE' },
      });
    } finally {
      errSpy.mockRestore();
    }
    expect(accountsRetrieveMock).not.toHaveBeenCalled();
  });

  it('disconnected between the snapshot read and the refresh collapses to disconnected', async () => {
    dbMocks.selectResults.push(
      [statusRow({ accountRefreshedAt: null })],
      [{ apiKey: null, status: 'disconnected', stripeAccountId: 'acct_unit', defaultCurrency: null }],
    );
    await expect(getPartnerStripeAccountSnapshot(PARTNER_A)).resolves.toEqual({ connected: false, last4: '9999' });
  });
});

/**
 * Review F5: the bootstrap re-check window must be STRICTLY shorter than the
 * sweep's own cadence. With both at 24h, a row stamped by yesterday's 03:45 run
 * is a few seconds NEWER than `now - 24h`, so today's run skips it and the
 * "daily" re-check silently becomes every other day.
 */
describe('listPartnersNeedingStripeAccountBootstrap', () => {
  const DAILY_CRON_MS = 24 * 60 * 60 * 1000;

  it('re-checks a row stamped by YESTERDAY\'s sweep (cutoff is strictly inside the cron period)', async () => {
    const now = new Date('2026-08-22T03:45:00.000Z');
    dbMocks.selectResults.push([]);

    await listPartnersNeedingStripeAccountBootstrap(now);

    const cutoff = collectSqlTerms(dbMocks.selectWheres[0]).params.find((p): p is Date => p instanceof Date);
    expect(cutoff).toBeInstanceOf(Date);
    // Yesterday's run stamped the row a beat AFTER its own tick; it must still
    // fall before the cutoff, i.e. still be selected today.
    const stampedByYesterdaysSweep = new Date(now.getTime() - DAILY_CRON_MS + 5_000);
    expect(cutoff!.getTime()).toBeGreaterThan(stampedByYesterdaysSweep.getTime());
    // ...and not so short that the same row is re-hammered within one sweep period.
    expect(cutoff!.getTime()).toBe(now.getTime() - STRIPE_ACCOUNT_BOOTSTRAP_RECHECK_MS);
    expect(STRIPE_ACCOUNT_BOOTSTRAP_RECHECK_MS).toBeLessThan(DAILY_CRON_MS);
  });
});
