import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { decryptSecret, encryptSecret, hmacFingerprint } from '../secretCrypto';

const { captureExceptionMock } = vi.hoisted(() => ({ captureExceptionMock: vi.fn() }));
vi.mock('../sentry', () => ({ captureException: captureExceptionMock }));

// refreshRealmSettings resolves the ambient `db` from '../../db' itself (its
// signature is `(partnerId, provider)` — no db parameter), so it needs the
// module mocked. Every OTHER test in this file constructs its own local mock
// db and passes it directly as a function argument, so this mock does not
// affect them.
const { dbRef, ambientDb, getValidAccessTokenMock, ReauthRequiredErrorClass, fetchRealmSettingsMock } = vi.hoisted(() => {
  class ReauthRequiredErrorClass extends Error {
    constructor(message = 'Accounting connection requires reauthorization') {
      super(message);
      this.name = 'ReauthRequiredError';
    }
  }
  const dbRef: { current: any } = { current: null };
  const ambientDb = {
    select: (...args: any[]) => dbRef.current.select(...args),
    insert: (...args: any[]) => dbRef.current.insert(...args),
    update: (...args: any[]) => dbRef.current.update(...args),
    delete: (...args: any[]) => dbRef.current.delete(...args),
    transaction: (...args: any[]) => dbRef.current.transaction(...args),
  };
  return {
    dbRef,
    ambientDb,
    getValidAccessTokenMock: vi.fn(),
    ReauthRequiredErrorClass,
    fetchRealmSettingsMock: vi.fn(),
  };
});

// `getCurrentDbAccessContext` + the two spies: `resolveActiveConnectionFor`
// reads through `readWithPartnerAxisVisibility` (db/partnerAxisRead.ts), which
// imports all three by name.
const partnerAxis = vi.hoisted(() => ({
  scope: undefined as string | undefined,
  runOutside: vi.fn((fn: () => unknown) => fn()),
  withSystem: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock('../../db', () => ({
  db: ambientDb,
  hasDbAccessContext: () => ctx.depth > 0,
  getCurrentDbAccessContext: () => (partnerAxis.scope ? { scope: partnerAxis.scope } : undefined),
  runOutsideDbContext: partnerAxis.runOutside,
  withSystemDbAccessContext: partnerAxis.withSystem,
}));

/**
 * Context tracker for the `DbContextRunner` `refreshRealmSettings` now takes.
 * The db mock's `hasDbAccessContext` reads the same depth, so the real
 * (unmocked) `dbContextGuard.assertNoAmbientDbContext` runs its real logic.
 */
const ctx = vi.hoisted(() => ({ depth: 0 }));
const runCtx = async <T>(fn: () => Promise<T>): Promise<T> => {
  ctx.depth++;
  try {
    return await fn();
  } finally {
    ctx.depth--;
  }
};

vi.mock('./accountingTokens', () => ({
  getValidAccessToken: getValidAccessTokenMock,
  ReauthRequiredError: ReauthRequiredErrorClass,
}));

vi.mock('./providerRegistry', () => ({
  getAccountingProvider: () => ({ fetchRealmSettings: fetchRealmSettingsMock }),
  // AccountingProviderConflictError (Xero W01) reads the display name for its
  // message; the real registry's names are stable enough to hardcode here.
  accountingProviderDisplayName: (id: string) => (id === 'quickbooks' ? 'QuickBooks' : id === 'xero' ? 'Xero' : id),
  // Capability check for the Xero W01 producer gate: only QuickBooks is a
  // registered provider, as in the real registry today.
  providerSupports: (id: string) => id === 'quickbooks',
}));

/**
 * A single-row fake DB used only by refreshRealmSettings tests: supports the
 * plain select/update `getConnection`/`updateMultiCurrencyEnabled` need, AND
 * the `db.transaction(fn)` -> `tx.select().for('update')` / `tx.update()`
 * shape `updateHomeCurrency` needs — all against the SAME mutable row, so a
 * write made mid-flow (e.g. simulating a token-refresh bump of `updatedAt`)
 * is visible to a subsequent read, matching real Postgres.
 */
function makeAmbientFakeDb(initialRow: Record<string, unknown> | null) {
  const state = { row: initialRow };
  const selectImpl = () => ({
    from: () => ({ where: () => ({ limit: async () => (state.row ? [state.row] : []) }) }),
  });
  const updateImpl = () => ({
    set: (patch: Record<string, unknown>) => ({
      where: () => ({
        returning: async () => {
          if (!state.row) return [];
          state.row = { ...state.row, ...patch };
          return [{ id: state.row.id }];
        },
      }),
    }),
  });
  const tx = {
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ limit: () => ({ for: async () => (state.row ? [state.row] : []) }) }) }),
    })),
    update: vi.fn(updateImpl),
    insert: vi.fn(),
    delete: vi.fn(),
  };
  const db = {
    select: vi.fn(selectImpl),
    update: vi.fn(updateImpl),
    insert: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(async (fn: any) => fn(tx)),
  };
  return { db, state, tx };
}

function ambientConnectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    partnerId: 'p1',
    provider: 'quickbooks',
    realmIdEncrypted: null,
    accessTokenEncrypted: null,
    refreshTokenEncrypted: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    environment: 'production',
    homeCurrency: 'USD',
    multiCurrencyEnabled: null,
    defaultIncomeAccountRef: null,
    defaultTaxCodeRef: null,
    pushMode: 'auto',
    status: 'connected',
    lastError: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    realmIdFingerprint: null,
    pullPayments: true,
    pushPayments: true,
    lastReconcileAt: null,
    cdcCursor: null,
    ...overrides,
  };
}

function makeMockDb(captured: { row?: any; insertValues?: any; updateSet?: any; conflictArg?: any }) {
  const ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  return {
    insert: vi.fn(() => ({
      values: vi.fn((row: any) => {
        captured.insertValues = row;
        captured.row = {
          id: ID,
          createdAt: new Date('2026-06-23T00:00:00Z'),
          updatedAt: row.updatedAt,
          homeCurrency: null,
          defaultIncomeAccountRef: null,
          defaultTaxCodeRef: null,
          lastError: null,
          ...row,
        };
        return {
          onConflictDoUpdate: vi.fn((arg: any) => {
            captured.updateSet = arg?.set;
            captured.conflictArg = arg;
            return { returning: vi.fn(async () => [captured.row]) };
          }),
        };
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => captured.row ? [captured.row] : []),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => [{ id: ID }]),
        })),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => [{ id: ID }]),
      })),
    })),
  };
}

describe('accountingConnectionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbRef.current = null;
  });

  it('encrypts tokens on upsert and returns decrypted on read', async () => {
    const captured: { row?: any } = {};
    const db = makeMockDb(captured);
    const { upsertConnection, getConnection } = await import('./accountingConnectionService');

    await upsertConnection(db, '11111111-1111-1111-1111-111111111111', 'quickbooks', {
      realmId: 'realm-123',
      accessToken: 'at-secret',
      refreshToken: 'rt-secret',
      accessTokenExpiresAt: new Date('2026-06-23T01:00:00Z'),
      refreshTokenExpiresAt: new Date('2026-09-30T00:00:00Z'),
      environment: 'production',
    });

    expect(captured.row?.accessTokenEncrypted).not.toBe('at-secret');
    expect(decryptSecret(captured.row?.accessTokenEncrypted)).toBe('at-secret');
    expect(decryptSecret(captured.row?.refreshTokenEncrypted)).toBe('rt-secret');

    const read = await getConnection(db, '11111111-1111-1111-1111-111111111111', 'quickbooks');
    expect(read?.accessToken).toBe('at-secret');
    expect(read?.refreshToken).toBe('rt-secret');
    expect(read?.realmId).toBe('realm-123');
  }, 20_000); // real encryptSecret KDF is ~0.6s/call; guard against CI-load flakiness

  it('reconnect (token-only, as the OAuth callback does) preserves pushMode', async () => {
    const captured: { row?: any; insertValues?: any; updateSet?: any } = {};
    const db = makeMockDb(captured);
    const { upsertConnection } = await import('./accountingConnectionService');

    // Mirrors the callback payload: tokens + environment + status, but NO pushMode.
    await upsertConnection(db, '11111111-1111-1111-1111-111111111111', 'quickbooks', {
      realmId: 'realm-123',
      accessToken: 'at',
      refreshToken: 'rt',
      accessTokenExpiresAt: new Date('2026-06-23T01:00:00Z'),
      refreshTokenExpiresAt: new Date('2026-09-30T00:00:00Z'),
      environment: 'production',
      status: 'connected',
      connectedBy: null,
    });

    // INSERT defaults pushMode for a brand-new row...
    expect(captured.insertValues.pushMode).toBe('auto');
    // ...but the on-conflict UPDATE set must NOT carry pushMode, so reconnecting
    // an existing 'manual' connection does not silently flip it back to 'auto'.
    expect(captured.updateSet).toBeDefined();
    expect('pushMode' in captured.updateSet).toBe(false);
    // Fields the caller DID pass are present on the update.
    expect(captured.updateSet.environment).toBe('production');
    expect(captured.updateSet.accessTokenEncrypted).toBeDefined();
    expect(decryptSecret(captured.updateSet.accessTokenEncrypted)).toBe('at');
  }, 20_000);

  function makeCasDb(row: Record<string, unknown> | null, updatedRows: Array<{ id: string }> = [{ id: 'x' }]) {
    const setSpy = vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn(async () => updatedRows) })),
    }));
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({ for: vi.fn(async () => (row ? [row] : [])) })),
          })),
        })),
      })),
      insert: vi.fn(),
      update: vi.fn(() => ({ set: setSpy })),
      delete: vi.fn(),
    } as any;
    const db = { ...tx, transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    return { db, tx, setSpy };
  }

  async function casRow(realmId: string | null, updatedAt: Date) {
    const { encryptSecret } = await import('../secretCrypto');
    return {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      partnerId: '11111111-1111-1111-1111-111111111111',
      realmIdEncrypted: realmId === null ? null : encryptSecret(realmId),
      updatedAt,
      homeCurrency: null,
    };
  }

  it('updateHomeCurrency normalizes the code and writes under the row lock', async () => {
    const at = new Date('2026-09-04T00:00:00Z');
    const { db, tx, setSpy } = makeCasDb(await casRow('realm-A', at));
    const { updateHomeCurrency } = await import('./accountingConnectionService');

    await updateHomeCurrency(
      db,
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      '11111111-1111-1111-1111-111111111111',
      { updatedAt: at, realmId: 'realm-A' },
      ' cad ',
    );

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(tx.select).toHaveBeenCalledTimes(1); // the FOR UPDATE lock read
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ homeCurrency: 'CAD' }));
  });

  it('updateHomeCurrency accepts a code Breeze cannot bill in (external fact)', async () => {
    const at = new Date('2026-09-04T00:00:00Z');
    const { db, setSpy } = makeCasDb(await casRow('realm-A', at));
    const { updateHomeCurrency } = await import('./accountingConnectionService');

    await updateHomeCurrency(db, 'c1', 'p1', { updatedAt: at, realmId: 'realm-A' }, 'BHD');

    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ homeCurrency: 'BHD' }));
  });

  it('updateHomeCurrency rejects a malformed external value without touching the db', async () => {
    const { db } = makeCasDb(await casRow('realm-A', new Date()));
    const { updateHomeCurrency } = await import('./accountingConnectionService');

    await expect(updateHomeCurrency(db, 'c1', 'p1', { updatedAt: new Date(), realmId: 'realm-A' }, 'DOLLARS'))
      .rejects.toThrow(/home currency/i);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('updateHomeCurrency ABORTS when the row now belongs to a different realm — even at an IDENTICAL updatedAt', async () => {
    // The realm-generation race: two reconnects inside the same millisecond carry
    // the same application-stamped updatedAt, so a timestamp-only predicate would
    // let realm A's slow Preferences response overwrite realm B's currency.
    const sameMs = new Date('2026-09-04T00:00:00.000Z');
    const { db, setSpy } = makeCasDb(await casRow('realm-B', sameMs));
    const { updateHomeCurrency } = await import('./accountingConnectionService');

    await expect(updateHomeCurrency(db, 'c1', 'p1', { updatedAt: sameMs, realmId: 'realm-A' }, 'USD'))
      .rejects.toThrow(/different realm/i);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('updateHomeCurrency throws on a stale updatedAt (same realm, reconnected since)', async () => {
    const { db, setSpy } = makeCasDb(await casRow('realm-A', new Date('2026-09-04T00:00:05Z')));
    const { updateHomeCurrency } = await import('./accountingConnectionService');

    await expect(updateHomeCurrency(db, 'c1', 'p1', { updatedAt: new Date('2026-09-04T00:00:00Z'), realmId: 'realm-A' }, 'USD'))
      .rejects.toThrow(/matched no accounting_connections row/);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('tags the two lost-CAS aborts with a distinct code, and leaves a zero-row read untagged', async () => {
    // A lost compare-and-set is an EXPECTED race (double connect, concurrent
    // reconnect), so the caller must be able to tell it apart from a genuine
    // failure by code — never by matching on message text. A zero-row read is
    // ambiguous (deleted underneath OR a wrong RLS context), so it stays
    // untagged and keeps error-level reporting.
    const sameMs = new Date('2026-09-04T00:00:00.000Z');
    const mod = await import('./accountingConnectionService');
    const { updateHomeCurrency, isHomeCurrencyCasAbort } = mod;

    const wrongRealm = await updateHomeCurrency(
      makeCasDb(await casRow('realm-B', sameMs)).db, 'c1', 'p1', { updatedAt: sameMs, realmId: 'realm-A' }, 'USD',
    ).catch((err: unknown) => err);
    expect(isHomeCurrencyCasAbort(wrongRealm)).toBe(true);
    expect((wrongRealm as { code: string }).code).toBe('ACCOUNTING_HOME_CURRENCY_CAS_ABORT');

    const staleGeneration = await updateHomeCurrency(
      makeCasDb(await casRow('realm-A', new Date('2026-09-04T00:00:05Z'))).db,
      'c1', 'p1', { updatedAt: sameMs, realmId: 'realm-A' }, 'USD',
    ).catch((err: unknown) => err);
    expect(isHomeCurrencyCasAbort(staleGeneration)).toBe(true);

    const missingRow = await updateHomeCurrency(
      makeCasDb(null).db, 'c1', 'p1', { updatedAt: sameMs, realmId: 'realm-A' }, 'USD',
    ).catch((err: unknown) => err);
    expect(isHomeCurrencyCasAbort(missingRow)).toBe(false);
  });

  it('updateHomeCurrency throws when the lock read returns nothing (deleted row or wrong RLS context)', async () => {
    const { db } = makeCasDb(null);
    const { updateHomeCurrency } = await import('./accountingConnectionService');

    await expect(updateHomeCurrency(db, 'c1', 'p1', { updatedAt: new Date(), realmId: 'realm-A' }, 'USD'))
      .rejects.toThrow(/matched no accounting_connections row/);
  });

  it('mapConnection surfaces multiCurrencyEnabled from the row', async () => {
    const captured: { row?: any } = { row: ambientConnectionRow({ multiCurrencyEnabled: true }) };
    const db = makeMockDb(captured);
    const { getConnection } = await import('./accountingConnectionService');

    const conn = await getConnection(db, 'p1', 'quickbooks');
    expect(conn?.multiCurrencyEnabled).toBe(true);
  });

  it('mapConnection surfaces null multiCurrencyEnabled (unknown) as null, not false', async () => {
    const captured: { row?: any } = { row: ambientConnectionRow({ multiCurrencyEnabled: null }) };
    const db = makeMockDb(captured);
    const { getConnection } = await import('./accountingConnectionService');

    const conn = await getConnection(db, 'p1', 'quickbooks');
    expect(conn?.multiCurrencyEnabled).toBeNull();
  });

  // The multi-currency flag carries the SAME per-realm identity risk as the
  // cached home currency: it is read off one specific realm's settings
  // response, and `refreshRealmSettings` captures its generation before a
  // multi-second QuickBooks round trip. It therefore gets the same
  // compare-and-set, not a plain guarded UPDATE.
  describe('updateMultiCurrencyEnabled', () => {
    const at = new Date('2026-09-03T00:00:00Z');

    it('writes the flag under the row lock at the expected realm + generation', async () => {
      const { db, state } = makeAmbientFakeDb(ambientConnectionRow({
        realmIdEncrypted: encryptSecret('realm-A'), updatedAt: at, multiCurrencyEnabled: null,
      }));
      const { updateMultiCurrencyEnabled } = await import('./accountingConnectionService');

      await updateMultiCurrencyEnabled(db as any, 'c1', 'p1', { updatedAt: at, realmId: 'realm-A' }, true);

      expect(state.row?.multiCurrencyEnabled).toBe(true);
    });

    it('ABORTS when the row now belongs to a different realm — even at an IDENTICAL updatedAt', async () => {
      const { db, state } = makeAmbientFakeDb(ambientConnectionRow({
        realmIdEncrypted: encryptSecret('realm-B'), updatedAt: at, multiCurrencyEnabled: null,
      }));
      const { updateMultiCurrencyEnabled, isHomeCurrencyCasAbort } = await import('./accountingConnectionService');

      const err: unknown = await updateMultiCurrencyEnabled(
        db as any, 'c1', 'p1', { updatedAt: at, realmId: 'realm-A' }, true,
      ).catch((e: unknown) => e);

      expect(isHomeCurrencyCasAbort(err)).toBe(true);
      expect(state.row?.multiCurrencyEnabled).toBeNull(); // the old realm's flag never lands on the new realm
    });

    it('ABORTS on a stale generation (same realm, reconnected since)', async () => {
      const { db, state } = makeAmbientFakeDb(ambientConnectionRow({
        realmIdEncrypted: encryptSecret('realm-A'), updatedAt: new Date('2026-09-04T00:00:00Z'), multiCurrencyEnabled: null,
      }));
      const { updateMultiCurrencyEnabled, isHomeCurrencyCasAbort } = await import('./accountingConnectionService');

      const err: unknown = await updateMultiCurrencyEnabled(
        db as any, 'c1', 'p1', { updatedAt: at, realmId: 'realm-A' }, true,
      ).catch((e: unknown) => e);

      expect(isHomeCurrencyCasAbort(err)).toBe(true);
      expect(state.row?.multiCurrencyEnabled).toBeNull();
    });

    it('throws when the lock read returns nothing (deleted row or wrong RLS context)', async () => {
      const { db } = makeAmbientFakeDb(null);
      const { updateMultiCurrencyEnabled } = await import('./accountingConnectionService');

      await expect(updateMultiCurrencyEnabled(db as any, 'c1', 'p1', { updatedAt: at, realmId: null }, false))
        .rejects.toThrow(/matched no accounting_connections row/);
    });
  });

  describe('refreshRealmSettings', () => {
    it('fetches realm settings and persists both fields', async () => {
      const { db, state } = makeAmbientFakeDb(ambientConnectionRow());
      dbRef.current = db;
      getValidAccessTokenMock.mockResolvedValue('fresh-token');
      fetchRealmSettingsMock.mockResolvedValue({ homeCurrency: 'CAD', multiCurrencyEnabled: true });

      const { refreshRealmSettings } = await import('./accountingConnectionService');
      const result = await refreshRealmSettings('p1', 'quickbooks', runCtx);

      expect(result).toEqual({ homeCurrency: 'CAD', multiCurrencyEnabled: true });
      expect(state.row?.multiCurrencyEnabled).toBe(true);
      expect(state.row?.homeCurrency).toBe('CAD');
      expect(fetchRealmSettingsMock).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'fresh-token' }));
    });

    it('labels its errors with the provider (Xero W02); QuickBooks strings are byte-identical', async () => {
      const { refreshRealmSettings } = await import('./accountingConnectionService');

      dbRef.current = makeAmbientFakeDb(null).db;
      await expect(refreshRealmSettings('p1', 'xero', runCtx))
        .rejects.toMatchObject({ code: 'not_connected', message: 'Xero is not connected for this partner' });
      await expect(refreshRealmSettings('p1', 'quickbooks', runCtx))
        .rejects.toMatchObject({ code: 'not_connected', message: 'QuickBooks is not connected for this partner' });

      dbRef.current = makeAmbientFakeDb(ambientConnectionRow({ provider: 'xero', status: 'reauth_required' })).db;
      await expect(refreshRealmSettings('p1', 'xero', runCtx))
        .rejects.toMatchObject({ code: 'reauth_required', message: 'Xero needs to be reconnected' });
      dbRef.current = makeAmbientFakeDb(ambientConnectionRow({ status: 'reauth_required' })).db;
      await expect(refreshRealmSettings('p1', 'quickbooks', runCtx))
        .rejects.toMatchObject({ code: 'reauth_required', message: 'QuickBooks needs to be reconnected' });

      // A pending_tenant row is "not connected" too, labelled by provider.
      dbRef.current = makeAmbientFakeDb(ambientConnectionRow({ provider: 'xero', status: 'pending_tenant' })).db;
      await expect(refreshRealmSettings('p1', 'xero', runCtx))
        .rejects.toMatchObject({ code: 'not_connected', message: 'Xero is not connected for this partner' });

      // Token refresh reports the grant is dead.
      dbRef.current = makeAmbientFakeDb(ambientConnectionRow({ provider: 'xero' })).db;
      getValidAccessTokenMock.mockRejectedValueOnce(new ReauthRequiredErrorClass());
      await expect(refreshRealmSettings('p1', 'xero', runCtx))
        .rejects.toMatchObject({ code: 'reauth_required', message: 'Xero needs to be reconnected' });
      expect(fetchRealmSettingsMock).not.toHaveBeenCalled();
    });

    it('throws not_connected (404) when the partner has no connection', async () => {
      const { db } = makeAmbientFakeDb(null);
      dbRef.current = db;

      const { refreshRealmSettings } = await import('./accountingConnectionService');
      await expect(refreshRealmSettings('p1', 'quickbooks', runCtx)).rejects.toMatchObject({ code: 'not_connected', status: 404 });
      expect(fetchRealmSettingsMock).not.toHaveBeenCalled();
    });

    it('throws reauth_required (409) when the connection status is reauth_required', async () => {
      const { db } = makeAmbientFakeDb(ambientConnectionRow({ status: 'reauth_required' }));
      dbRef.current = db;

      const { refreshRealmSettings } = await import('./accountingConnectionService');
      await expect(refreshRealmSettings('p1', 'quickbooks', runCtx)).rejects.toMatchObject({ code: 'reauth_required', status: 409 });
      expect(fetchRealmSettingsMock).not.toHaveBeenCalled();
    });

    it('throws reauth_required (409) when the token refresh reports the grant is dead', async () => {
      const { db } = makeAmbientFakeDb(ambientConnectionRow());
      dbRef.current = db;
      getValidAccessTokenMock.mockRejectedValue(new ReauthRequiredErrorClass());

      const { refreshRealmSettings } = await import('./accountingConnectionService');
      await expect(refreshRealmSettings('p1', 'quickbooks', runCtx)).rejects.toMatchObject({ code: 'reauth_required', status: 409 });
      expect(fetchRealmSettingsMock).not.toHaveBeenCalled();
    });

    it('aborts the home-currency write on a lost CAS but still returns the freshly fetched settings', async () => {
      const { db } = makeAmbientFakeDb(ambientConnectionRow({ homeCurrency: 'USD' }));
      dbRef.current = db;
      getValidAccessTokenMock.mockResolvedValue('fresh-token');
      fetchRealmSettingsMock.mockResolvedValue({ homeCurrency: 'CAD', multiCurrencyEnabled: false });

      const { refreshRealmSettings, AccountingHomeCurrencyCasAbortError } = await import('./accountingConnectionService');
      // Force the exact abort updateHomeCurrency itself throws (reusing its own
      // error class/fixture per the task brief), independent of timing games.
      db.transaction = vi.fn(async () => {
        throw new AccountingHomeCurrencyCasAbortError('updateHomeCurrency aborted: lost the compare-and-set');
      });

      const result = await refreshRealmSettings('p1', 'quickbooks', runCtx);

      expect(result).toEqual({ homeCurrency: 'CAD', multiCurrencyEnabled: false });
    });

    it('propagates a GENUINE (non-CAS) home-currency write failure', async () => {
      const { db } = makeAmbientFakeDb(ambientConnectionRow({ homeCurrency: 'USD' }));
      dbRef.current = db;
      getValidAccessTokenMock.mockResolvedValue('fresh-token');
      fetchRealmSettingsMock.mockResolvedValue({ homeCurrency: 'CAD', multiCurrencyEnabled: null });
      db.transaction = vi.fn(async () => {
        throw new Error('deadlock detected');
      });

      const { refreshRealmSettings } = await import('./accountingConnectionService');
      await expect(refreshRealmSettings('p1', 'quickbooks', runCtx)).rejects.toThrow('deadlock detected');
    });

    it('skips the home-currency write (never blanks it) when the realm reports no currency', async () => {
      const { db, state } = makeAmbientFakeDb(ambientConnectionRow({ homeCurrency: 'USD' }));
      dbRef.current = db;
      getValidAccessTokenMock.mockResolvedValue('fresh-token');
      fetchRealmSettingsMock.mockResolvedValue({ homeCurrency: null, multiCurrencyEnabled: true });

      const { refreshRealmSettings } = await import('./accountingConnectionService');
      const result = await refreshRealmSettings('p1', 'quickbooks', runCtx);

      expect(result).toEqual({ homeCurrency: null, multiCurrencyEnabled: true });
      expect(state.row?.homeCurrency).toBe('USD'); // untouched
      expect(state.row?.multiCurrencyEnabled).toBe(true);
    });

    it('skips the multi-currency write (never blanks it) when the realm reports null', async () => {
      const { db, state } = makeAmbientFakeDb(ambientConnectionRow({ homeCurrency: 'USD', multiCurrencyEnabled: true }));
      dbRef.current = db;
      getValidAccessTokenMock.mockResolvedValue('fresh-token');
      fetchRealmSettingsMock.mockResolvedValue({ homeCurrency: 'USD', multiCurrencyEnabled: null });

      const { refreshRealmSettings } = await import('./accountingConnectionService');
      const result = await refreshRealmSettings('p1', 'quickbooks', runCtx);

      expect(result).toEqual({ homeCurrency: 'USD', multiCurrencyEnabled: null });
      expect(state.row?.multiCurrencyEnabled).toBe(true); // untouched
    });

    it('re-reads the connection after a token refresh so the CAS compares against the post-refresh generation', async () => {
      const { db, state } = makeAmbientFakeDb(ambientConnectionRow({ homeCurrency: 'USD' }));
      dbRef.current = db;
      fetchRealmSettingsMock.mockResolvedValue({ homeCurrency: 'CAD', multiCurrencyEnabled: null });
      // getValidAccessToken rotating the token (updateTokens) would bump
      // updatedAt on the row underneath the initial read.
      getValidAccessTokenMock.mockImplementation(async () => {
        if (state.row) state.row = { ...state.row, updatedAt: new Date('2026-09-01T01:00:00Z') };
        return 'rotated-token';
      });

      const { refreshRealmSettings } = await import('./accountingConnectionService');
      const result = await refreshRealmSettings('p1', 'quickbooks', runCtx);

      // If the CAS had compared against the STALE pre-refresh updatedAt, this
      // write would have lost the race and homeCurrency would stay 'USD'.
      expect(state.row?.homeCurrency).toBe('CAD');
      expect(result.homeCurrency).toBe('CAD');
    });
  });

  // Phase D (payment pull-back) — realm fingerprint, pull switch, CDC cursor.
  describe('realm fingerprint', () => {
    it('upsertConnection writes hmacFingerprint(realmId) on connect and reconnect', async () => {
      const captured: { row?: any; insertValues?: any; updateSet?: any } = {};
      const db = makeMockDb(captured);
      const { upsertConnection } = await import('./accountingConnectionService');

      await upsertConnection(db, 'p1', 'quickbooks', { realmId: 'realm-9' });

      expect(captured.insertValues.realmIdFingerprint).toBe(hmacFingerprint('realm-9'));
      expect(captured.updateSet.realmIdFingerprint).toBe(hmacFingerprint('realm-9'));
    });

    it('upsertConnection leaves the fingerprint untouched when realmId is omitted (token-only reconnect)', async () => {
      const captured: { row?: any; insertValues?: any; updateSet?: any } = {};
      const db = makeMockDb(captured);
      const { upsertConnection } = await import('./accountingConnectionService');

      await upsertConnection(db, 'p1', 'quickbooks', { accessToken: 'a' });

      expect('realmIdFingerprint' in captured.updateSet).toBe(false);
    });

    it('upsertConnection nulls the fingerprint when realmId is explicitly null', async () => {
      const captured: { row?: any; insertValues?: any; updateSet?: any } = {};
      const db = makeMockDb(captured);
      const { upsertConnection } = await import('./accountingConnectionService');

      await upsertConnection(db, 'p1', 'quickbooks', { realmId: null });

      expect(captured.updateSet.realmIdFingerprint).toBeNull();
    });

    it('fingerprintKeyGeneration parses the key id and returns null for junk', async () => {
      const { fingerprintKeyGeneration } = await import('./accountingConnectionService');

      expect(fingerprintKeyGeneration('fp1:k2:abcd')).toBe('k2');
      expect(fingerprintKeyGeneration('abcd')).toBeNull();
      expect(fingerprintKeyGeneration(null)).toBeNull();
    });

    it('mapConnection surfaces realmIdFingerprint, pullPayments, lastReconcileAt and cdcCursor', async () => {
      const CURSOR = new Date('2026-09-02T20:10:00.000Z');
      const captured: { row?: any } = {
        row: ambientConnectionRow({
          realmIdFingerprint: 'fp1:legacy:deadbeef',
          pullPayments: true,
          lastReconcileAt: null,
          cdcCursor: CURSOR,
        }),
      };
      const db = makeMockDb(captured);
      const { getConnection } = await import('./accountingConnectionService');

      const conn = await getConnection(db, 'p1', 'quickbooks');

      expect(conn).toMatchObject({
        realmIdFingerprint: 'fp1:legacy:deadbeef',
        pullPayments: true,
        cdcCursor: CURSOR,
        lastReconcileAt: null,
      });
    });
  });

  describe('backfillRealmFingerprints', () => {
    it('#5193: reports a fingerprint collision to Sentry with allowlisted tag keys and keeps scanning other rows', async () => {
      const collisionErr = Object.assign(
        new Error('duplicate key value violates unique constraint "accounting_connections_provider_realm_fp_idx"'),
        { code: '23505', constraint: 'accounting_connections_provider_realm_fp_idx' },
      );
      const rows = [
        { id: 'conn-1', partnerId: 'p1', realmIdEncrypted: encryptSecret('realm-collide'), realmIdFingerprint: null },
        { id: 'conn-2', partnerId: 'p2', realmIdEncrypted: encryptSecret('realm-ok'), realmIdFingerprint: null },
      ];
      let updateCalls = 0;
      dbRef.current = {
        select: () => ({ from: () => ({ where: async () => rows }) }),
        update: () => ({
          set: () => ({
            where: () => ({
              returning: async () => {
                updateCalls++;
                if (updateCalls === 1) throw collisionErr;
                return [{ id: 'conn-2' }];
              },
            }),
          }),
        }),
      };

      const { backfillRealmFingerprints } = await import('./accountingConnectionService');
      const result = await backfillRealmFingerprints();

      // The collision on conn-1 must not abort the sweep: conn-2 still gets
      // fingerprinted (finding E — Postgres would otherwise poison the whole
      // batch's shared transaction with 25P02).
      expect(result).toEqual({ scanned: 2, updated: 1, skipped: 1 });
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
      // `module` and `op` have no allowlisted equivalent and were silently
      // dropped before the #5193 fix; `service` + `accounting_connection_id`
      // are what actually triage which connection collided.
      expect(captureExceptionMock.mock.calls[0]![2]).toMatchObject({
        service: 'accountingConnectionService',
        accounting_connection_id: 'conn-1',
      });
    });
  });

  describe('advanceReconcileCursor', () => {
    const CURSOR = new Date('2026-09-02T20:10:00.000Z');
    const STAMP = new Date('2026-09-02T20:10:01.000Z');

    /** A dedicated db mock exposing the `.set(...)` argument for assertion. */
    function makeReconcileDb(returningRows: Array<{ id: string }> = [{ id: 'c1' }]) {
      const setMock = vi.fn((_patch: Record<string, unknown>) => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => returningRows),
        })),
      }));
      const db = {
        update: vi.fn(() => ({ set: setMock })),
        select: vi.fn(),
        insert: vi.fn(),
        delete: vi.fn(),
      };
      return { db, setMock };
    }

    it('writes cdc_cursor + last_reconcile_at scoped to (id, partnerId)', async () => {
      const { db, setMock } = makeReconcileDb();
      const { advanceReconcileCursor } = await import('./accountingConnectionService');

      await advanceReconcileCursor(db, 'c1', 'p1', 'fp1:k1:abc', CURSOR, STAMP);

      expect(setMock.mock.calls.at(-1)![0]).toEqual({
        cdcCursor: CURSOR,
        lastReconcileAt: STAMP,
        updatedAt: expect.any(Date),
      });
    });
  });

  describe('advanceReconcileCursor: realm compare-and-set (finding C)', () => {
    const CURSOR = new Date('2026-09-02T20:10:00.000Z');
    const STAMP = new Date('2026-09-02T20:10:01.000Z');

    function makeCasDb(returningRows: Array<{ id: string }> = [{ id: 'c1' }]) {
      const whereMock = vi.fn((_cond: SQL) => ({ returning: vi.fn(async () => returningRows) }));
      const db = {
        update: vi.fn(() => ({ set: vi.fn(() => ({ where: whereMock })) })),
        select: vi.fn(), insert: vi.fn(), delete: vi.fn(),
      };
      return { db, whereMock };
    }

    it('binds the expected realm fingerprint into the guarded UPDATE', async () => {
      const { db, whereMock } = makeCasDb();
      const { advanceReconcileCursor } = await import('./accountingConnectionService');

      const advanced = await advanceReconcileCursor(db, 'c1', 'p1', 'fp1:k1:abc', CURSOR, STAMP);

      expect(advanced).toBe(true);
      const { sql, params } = new PgDialect().sqlToQuery(whereMock.mock.calls.at(-1)![0] as SQL);
      expect(sql).toMatch(/"realm_id_fingerprint" = \$\d+/i);
      expect(params).toEqual(['c1', 'p1', 'fp1:k1:abc']);
    });

    it('matches a NULL fingerprint with IS NULL, never `= NULL`', async () => {
      const { db, whereMock } = makeCasDb();
      const { advanceReconcileCursor } = await import('./accountingConnectionService');

      await advanceReconcileCursor(db, 'c1', 'p1', null, CURSOR, STAMP);

      const { sql, params } = new PgDialect().sqlToQuery(whereMock.mock.calls.at(-1)![0] as SQL);
      expect(sql).toMatch(/"realm_id_fingerprint" is null/i);
      expect(params).toEqual(['c1', 'p1']);
    });

    it('returns false instead of throwing when the realm changed under the run', async () => {
      // A reconnect to a DIFFERENT realm landed mid-run. Throwing would fail
      // the job and retry it forever against a connection that has legitimately
      // moved on; the next sweep reconciles the new realm from a null cursor.
      const { db } = makeCasDb([]);
      const { advanceReconcileCursor } = await import('./accountingConnectionService');

      await expect(advanceReconcileCursor(db, 'c1', 'p1', 'fp1:k1:stale', CURSOR, STAMP))
        .resolves.toBe(false);
    });
  });

  describe('stampReconcileRunError (finding H)', () => {
    function makeStampDb() {
      const whereMock = vi.fn((..._args: [SQL]) => ({ returning: vi.fn(async () => [{ id: 'c1' }]) }));
      const setMock = vi.fn((..._args: [Record<string, unknown>]) => ({ where: whereMock }));
      const db = { update: vi.fn(() => ({ set: setMock })), select: vi.fn(), insert: vi.fn(), delete: vi.fn() };
      return { db, setMock, whereMock };
    }

    it('writes the message under the payment-pull prefix, scoped to (id, partnerId)', async () => {
      const { db, setMock, whereMock } = makeStampDb();
      const { stampReconcileRunError } = await import('./accountingConnectionService');

      await stampReconcileRunError(db, 'c1', 'p1', '3 item(s) failed');

      expect(setMock.mock.calls.at(-1)![0]).toMatchObject({
        lastError: 'Payment pull: 3 item(s) failed',
      });
      expect(new PgDialect().sqlToQuery(whereMock.mock.calls.at(-1)![0] as SQL).params).toEqual(['c1', 'p1']);
    });

    it('clears ONLY a payment-pull-prefixed error, never a reauth/connection one', async () => {
      const { db, setMock, whereMock } = makeStampDb();
      const { stampReconcileRunError } = await import('./accountingConnectionService');

      await stampReconcileRunError(db, 'c1', 'p1', null);

      expect(setMock.mock.calls.at(-1)![0]).toMatchObject({ lastError: null });
      const { sql, params } = new PgDialect().sqlToQuery(whereMock.mock.calls.at(-1)![0] as SQL);
      expect(sql).toMatch(/"last_error" like \$\d+/i);
      expect(params).toEqual(['c1', 'p1', 'Payment pull: %']);
    });
  });

  describe('resetConnectionForRealmChange (finding C)', () => {
    function makeResetDb(mappingRows: Array<{ id: string }>) {
      const deleteWhereMock = vi.fn((_cond: SQL) => ({ returning: vi.fn(async () => mappingRows) }));
      const updateSetMock = vi.fn((_patch: Record<string, unknown>) => ({
        where: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 'c1' }]) })),
      }));
      // The owed-delete pre-count (review wave 2, finding 3) runs before the
      // delete; nothing is owed in this fixture.
      const selectMock = vi.fn(() => ({ from: () => ({ where: async () => [] }) }));
      const db = {
        delete: vi.fn(() => ({ where: deleteWhereMock })),
        update: vi.fn(() => ({ set: updateSetMock })),
        select: selectMock, insert: vi.fn(),
      };
      return { db, deleteWhereMock, updateSetMock };
    }

    it('deletes every mapping row for the connection, nulls the CDC watermark and clears the old organisation\'s default refs (review J)', async () => {
      const { db, deleteWhereMock, updateSetMock } = makeResetDb([{ id: 'm1' }, { id: 'm2' }]);
      const { resetConnectionForRealmChange } = await import('./accountingConnectionService');

      const out = await resetConnectionForRealmChange(db, 'c1', 'p1');

      expect(out).toEqual({ mappingsDeleted: 2, owedPaymentDeletes: { count: 0, remoteEntityIds: [] } });
      const del = new PgDialect().sqlToQuery(deleteWhereMock.mock.calls.at(-1)![0] as SQL);
      expect(del.params).toEqual(['c1', 'p1']);
      // Every ref the settings PATCH writes names an account / tax code IN the old
      // organisation (Xero AccountCodes like "200" repeat across orgs, so a kept
      // ref would silently resolve to a different account in the new one).
      expect(updateSetMock.mock.calls.at(-1)![0]).toEqual({
        cdcCursor: null,
        lastReconcileAt: null,
        defaultIncomeAccountRef: null,
        defaultTaxCodeRef: null,
        defaultExemptTaxCodeRef: null,
        defaultPaymentAccountRef: null,
        feeIncomeItemRef: null,
        feeIncomeAccountRef: null,
        updatedAt: expect.any(Date),
      });
    });
  });

  describe('pushPayments switch (Phase D2)', () => {
    it('upsertConnection inserts pushPayments true by default', async () => {
      const captured: { row?: any; insertValues?: any; updateSet?: any } = {};
      const db = makeMockDb(captured);
      const { upsertConnection } = await import('./accountingConnectionService');

      await upsertConnection(db, 'p1', 'quickbooks', { realmId: 'realm-9' });

      expect(captured.insertValues.pushPayments).toBe(true);
    }, 20_000);

    it('upsertConnection leaves pushPayments untouched on a token-only reconnect', async () => {
      const captured: { row?: any; insertValues?: any; updateSet?: any } = {};
      const db = makeMockDb(captured);
      const { upsertConnection } = await import('./accountingConnectionService');

      await upsertConnection(db, 'p1', 'quickbooks', { accessToken: 'a' });

      expect(captured.updateSet).toBeDefined();
      expect('pushPayments' in captured.updateSet).toBe(false);
    }, 20_000);

    it('upsertConnection writes pushPayments when the caller supplies it', async () => {
      const captured: { row?: any; insertValues?: any; updateSet?: any } = {};
      const db = makeMockDb(captured);
      const { upsertConnection } = await import('./accountingConnectionService');

      await upsertConnection(db, 'p1', 'quickbooks', { pushPayments: false });

      expect(captured.updateSet.pushPayments).toBe(false);
    }, 20_000);

    it('upsertConnection stamps the push horizon on INSERT only', async () => {
      // Review wave 2, finding 2. `push_payments_since` is the horizon this
      // connection pushes payments FROM; a token-only reconnect (the OAuth
      // callback) must NOT move it, or the whole history the horizon excludes
      // would be re-opened.
      const captured: { row?: any; insertValues?: any; updateSet?: any } = {};
      const db = makeMockDb(captured);
      const { upsertConnection } = await import('./accountingConnectionService');

      await upsertConnection(db, 'p1', 'quickbooks', { accessToken: 'a' });

      // #7293: stamped from the DATABASE clock (`now()`), the same clock that
      // stamps `invoice_payments.created_at` it is compared against. A Node
      // `new Date()` here let an API clock running even a few ms ahead of
      // Postgres drop the first payment recorded after connecting.
      const since = captured.insertValues.pushPaymentsSince;
      expect(since).not.toBeInstanceOf(Date);
      const compiled = new PgDialect().sqlToQuery(since as SQL);
      expect(compiled.sql.trim().toLowerCase()).toBe('now()');
      expect(compiled.params).toEqual([]);
      expect('pushPaymentsSince' in captured.updateSet).toBe(false);
    }, 20_000);

    it('the branch migration adds the horizon column idempotently and backfills existing rows', () => {
      // The backfill is the half that cannot be unit-tested through the service:
      // every connection that already exists at deploy must be stamped `now()`,
      // or `push_payments` (default true) would push a partner's entire payment
      // history the first time an old invoice is re-pushed.
      const sqlText = readFileSync(
        fileURLToPath(new URL('../../../migrations/2026-10-12-100000-quickbooks-payment-push.sql', import.meta.url)),
        'utf-8',
      );
      expect(sqlText).toContain('ADD COLUMN IF NOT EXISTS push_payments_since timestamptz');
      expect(sqlText).toMatch(/UPDATE accounting_connections\s+SET push_payments_since = now\(\)\s+WHERE push_payments_since IS NULL/);
      // RLS: accounting_connections is FORCE'd and the migration role is not a
      // superuser on managed Postgres, so an unscoped UPDATE matches zero rows
      // in production while CI (superuser) reports success.
      expect(sqlText.indexOf("set_config('breeze.scope', 'system', true)"))
        .toBeLessThan(sqlText.indexOf('SET push_payments_since = now()'));
      // And it must report what it touched, per the migration authoring rules.
      expect(sqlText).toContain('stamped push_payments_since=now() on %');
    });

    it('mapConnection surfaces pushPayments', async () => {
      const captured: { row?: any; insertValues?: any; updateSet?: any } = {};
      const db = makeMockDb(captured);
      const { upsertConnection, getConnection } = await import('./accountingConnectionService');

      await upsertConnection(db, 'p1', 'quickbooks', { realmId: 'realm-9' });
      const conn = await getConnection(db, 'p1', 'quickbooks');

      expect(conn).toMatchObject({ pushPayments: true });
    }, 20_000);
  });

  describe('listReconcilableConnections', () => {
    /** A dedicated db mock exposing the compiled `.where(...)` clause for assertion. */
    function makeSelectWhereDb() {
      const whereMock = vi.fn((_cond: SQL) => Promise.resolve([]));
      const db = {
        select: vi.fn(() => ({ from: vi.fn(() => ({ where: whereMock })) })),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      };
      return { db, whereMock };
    }

    // Xero W01: listReconcilableConnections drops the provider filter — every
    // provider's connected rows are candidates now, and the worker (Task 5)
    // filters by capability instead. Deviation from the pre-W01 test, which
    // asserted a provider = $1 clause that no longer exists.
    it('filters to status connected AND (pull_payments OR push_payments), with no provider filter', async () => {
      const { db, whereMock } = makeSelectWhereDb();
      const { listReconcilableConnections } = await import('./accountingConnectionService');

      await listReconcilableConnections(db);

      const dialect = new PgDialect();
      // Compiling the captured `and(...)` node standalone (outside the full
      // query builder) fully table-qualifies each column — real Postgres
      // output for a query executed through the builder omits the qualifier
      // on a single-table query, but the compiled clause and bound params
      // below are the actual filter Drizzle applies either way.
      const { sql, params } = dialect.sqlToQuery(whereMock.mock.calls.at(-1)![0] as SQL);
      expect(sql).toMatch(/"accounting_connections"\."status" = \$\d+ and \("accounting_connections"\."pull_payments" = \$\d+ or "accounting_connections"\."push_payments" = \$\d+\)/i);
      expect(params).toEqual(['connected', true, true]);
    });
  });
});

describe('owed QuickBooks payment deletes on disconnect / realm change (review wave 2, finding 3)', () => {
  // `accounting_entity_mappings_connection_partner_fk` is ON DELETE CASCADE, so
  // dropping the connection row takes every mapping with it — including rows
  // that still owe QuickBooks a payment DELETE. Breeze created those Payments in
  // the partner's books and has not removed them; the disconnect must still
  // work, but it must not be the last anyone ever hears of them.
  const owedRows = [
    { id: 'map-1', remoteEntityId: '181/145' },
    { id: 'map-2', remoteEntityId: '182/146' },
  ];

  function dbWithOwedDeletes(owed: Array<{ id: string; remoteEntityId: string | null }>) {
    const seen: { where?: unknown } = {};
    return {
      seen,
      db: {
        select: () => ({
          from: () => ({
            where: (cond: unknown) => {
              seen.where = cond;
              return Promise.resolve(owed);
            },
          }),
        }),
        delete: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 'c1' }]) }) }),
        update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 'c1' }]) }) }) }),
      } as never,
    };
  }

  it('deleteConnection reports the owed payment deletes it is about to cascade away', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { db } = dbWithOwedDeletes(owedRows);
      const { deleteConnection } = await import('./accountingConnectionService');

      const result = await deleteConnection(db, 'p1', 'quickbooks');

      expect(result.removed).toBe(true); // the disconnect is NEVER blocked
      expect(result.owedPaymentDeletes).toEqual({ count: 2, remoteEntityIds: ['181/145', '182/146'] });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('owed QuickBooks payment delete'),
        expect.anything(),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('deleteConnection stays quiet when nothing is owed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { db } = dbWithOwedDeletes([]);
      const { deleteConnection } = await import('./accountingConnectionService');

      const result = await deleteConnection(db, 'p1', 'quickbooks');

      expect(result.owedPaymentDeletes).toEqual({ count: 0, remoteEntityIds: [] });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('resetConnectionForRealmChange reports them too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { db } = dbWithOwedDeletes(owedRows);
      const { resetConnectionForRealmChange } = await import('./accountingConnectionService');

      const result = await resetConnectionForRealmChange(db, 'c1', 'p1');

      expect(result.owedPaymentDeletes.count).toBe(2);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('one connection per partner (Xero W01)', () => {
  it('upsertConnection targets partner_id and only updates a SAME-provider row', async () => {
    const captured: { row?: any; insertValues?: any; updateSet?: any; conflictArg?: any } = {};
    const db = makeMockDb(captured); // makeMockDb gains one line in its onConflictDoUpdate: `captured.conflictArg = arg;`
    const { upsertConnection } = await import('./accountingConnectionService');
    const { accountingConnections } = await import('../../db/schema');

    await upsertConnection(db, 'p1', 'quickbooks', { accessToken: 'a' });

    expect(captured.conflictArg.target).toBe(accountingConnections.partnerId);
    const whereSql = new PgDialect().sqlToQuery(captured.conflictArg.setWhere as SQL).sql;
    expect(whereSql).toBe('"accounting_connections"."provider" = excluded.provider');
  });

  it('upsertConnection raises AccountingProviderConflictError when the partner already holds another provider', async () => {
    const existing = { id: 'c-qbo', partnerId: 'p1', provider: 'quickbooks' };
    const db = {
      insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoUpdate: vi.fn(() => ({ returning: vi.fn(async () => []) })) })) })),
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => [existing]) })) })) })),
    };
    const { upsertConnection, AccountingProviderConflictError } = await import('./accountingConnectionService');

    const err = await upsertConnection(db as any, 'p1', 'xero', { accessToken: 'a' }).catch((e) => e);

    expect(err).toBeInstanceOf(AccountingProviderConflictError);
    expect(err).toMatchObject({ code: 'accounting_provider_conflict', status: 409, existingProvider: 'quickbooks', requestedProvider: 'xero' });
    expect(err.message).toBe('Disconnect QuickBooks before connecting Xero');
  });

  it('resolveActiveConnection returns the partner\'s single row whatever its provider', async () => {
    const captured: { row?: any } = { row: { id: 'c1', partnerId: 'p1', provider: 'quickbooks', status: 'connected', pushMode: 'auto', environment: 'production', pullPayments: true, pushPayments: true } };
    const db = makeMockDb(captured);
    const { resolveActiveConnection } = await import('./accountingConnectionService');
    const conn = await resolveActiveConnection(db as any, 'p1');
    expect(conn?.id).toBe('c1');
    expect(conn?.provider).toBe('quickbooks');
  });

  it('resolveActiveConnection returns null when the partner has no row', async () => {
    const db = makeMockDb({});
    const { resolveActiveConnection } = await import('./accountingConnectionService');
    expect(await resolveActiveConnection(db as any, 'p1')).toBeNull();
  });
});

describe('resolveActiveConnectionId (Xero W01 Task 6 fix round 1 — non-decrypting sibling)', () => {
  /** Captures the `select()` projection and the `where` SQL, same idiom as
   *  `getConnectionProviderForMapping`'s `joinDb` helper above — proves the
   *  query shape rather than trusting a row shape the mock could fabricate. */
  function idOnlyDb(rows: Array<Record<string, unknown>>) {
    const captured: { projection?: Record<string, unknown>; where?: SQL } = {};
    const dbc = {
      select: vi.fn((projection: Record<string, unknown>) => {
        captured.projection = projection;
        return { from: () => ({ where: (w: SQL) => { captured.where = w; return { limit: async () => rows }; } }) };
      }),
    };
    return { dbc, captured };
  }

  it('returns the id, selecting ONLY id + provider + status (no realm/token decrypt)', async () => {
    // Fix B refactor: resolveActiveConnectionId now shares the private
    // resolveActiveConnectionRef helper with resolveActiveConnectionFor
    // (below), which also needs `provider`. The contract this test actually
    // guards — no realm/token column, no decrypt — is unchanged.
    const decryptSpy = vi.spyOn(await import('../secretCrypto'), 'decryptSecret');
    const { dbc, captured } = idOnlyDb([{ id: 'conn-1', provider: 'quickbooks' }]);
    const { resolveActiveConnectionId } = await import('./accountingConnectionService');
    const { accountingConnections } = await import('../../db/schema');

    await expect(resolveActiveConnectionId(dbc as any, 'p1')).resolves.toBe('conn-1');

    // Task 15 added `status` (a plain column) for GET /accounting/providers and the connect pre-check.
    expect(captured.projection).toEqual({
      id: accountingConnections.id, provider: accountingConnections.provider, status: accountingConnections.status,
    });
    const where = new PgDialect().sqlToQuery(captured.where!);
    expect(where.sql).toContain('"accounting_connections"."partner_id" = $1');
    expect(where.params).toEqual(['p1', 'pending_tenant']);
    expect(decryptSpy).not.toHaveBeenCalled();
    decryptSpy.mockRestore();
  });

  it('returns null when the partner has no row', async () => {
    const { dbc } = idOnlyDb([]);
    const { resolveActiveConnectionId } = await import('./accountingConnectionService');
    await expect(resolveActiveConnectionId(dbc as any, 'p1')).resolves.toBeNull();
  });
});

describe('getConnectionProviderForMapping (Xero W01 audit provider lookup)', () => {
  function joinDb(rows: Array<Record<string, unknown>>) {
    const captured: { projection?: Record<string, unknown>; where?: SQL; joinOn?: SQL } = {};
    const dbc = {
      select: vi.fn((projection: Record<string, unknown>) => {
        captured.projection = projection;
        return {
          from: () => ({
            innerJoin: (_t: unknown, on: SQL) => {
              captured.joinOn = on;
              return { where: (w: SQL) => { captured.where = w; return { limit: async () => rows }; } };
            },
          }),
        };
      }),
    };
    return { dbc, captured };
  }

  it("returns the mapping's own connection provider, selecting ONLY the provider column (no token decrypt)", async () => {
    const { dbc, captured } = joinDb([{ provider: 'quickbooks' }]);
    const { getConnectionProviderForMapping } = await import('./accountingConnectionService');
    const { accountingConnections } = await import('../../db/schema');

    await expect(getConnectionProviderForMapping(dbc as any, 'm1', 'p1')).resolves.toBe('quickbooks');

    // Only the provider — never the encrypted realm/token columns that
    // getConnectionForMapping's mapConnection decrypts.
    expect(captured.projection).toEqual({ provider: accountingConnections.provider });
    const dialect = new PgDialect();
    const join = dialect.sqlToQuery(captured.joinOn!).sql;
    expect(join).toContain('"accounting_connections"."id" = "accounting_entity_mappings"."integration_id"');
    expect(join).toContain('"accounting_connections"."partner_id" = "accounting_entity_mappings"."partner_id"');
    const where = dialect.sqlToQuery(captured.where!);
    expect(where.sql).toContain('"accounting_entity_mappings"."id" = $1');
    expect(where.sql).toContain('"accounting_entity_mappings"."partner_id" = $2');
    expect(where.params).toEqual(['m1', 'p1']);
  });

  it('returns null when the mapping (or its connection) is gone', async () => {
    const { dbc } = joinDb([]);
    const { getConnectionProviderForMapping } = await import('./accountingConnectionService');
    await expect(getConnectionProviderForMapping(dbc as any, 'm1', 'p1')).resolves.toBeNull();
  });
});

describe('resolveActiveConnectionFor (Xero W01 producer gate)', () => {
  beforeEach(() => {
    partnerAxis.scope = undefined;
    partnerAxis.runOutside.mockClear();
    partnerAxis.withSystem.mockClear();
  });

  it("returns the partner's active connection when its provider has the capability", async () => {
    dbRef.current = makeAmbientFakeDb(ambientConnectionRow()).db;
    const { resolveActiveConnectionFor } = await import('./accountingConnectionService');
    const conn = await resolveActiveConnectionFor('p1', 'invoicePush');
    expect(conn?.id).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(conn?.provider).toBe('quickbooks');
  });

  it('selects ONLY id + provider + status (no realm/token decrypt) — Task 5 minor fix', async () => {
    const { accountingConnections } = await import('../../db/schema');
    const { db } = makeAmbientFakeDb(ambientConnectionRow({
      // Non-null ciphertext-shaped values: if the implementation regressed to
      // `resolveActiveConnection` + `mapConnection`, decryptSecret would be
      // invoked (and likely throw on this garbage) instead of merely being
      // skipped because the fields happened to be null.
      realmIdEncrypted: 'not-real-ciphertext',
      accessTokenEncrypted: 'not-real-ciphertext',
      refreshTokenEncrypted: 'not-real-ciphertext',
    }));
    dbRef.current = db;
    const decryptSpy = vi.spyOn(await import('../secretCrypto'), 'decryptSecret');
    const { resolveActiveConnectionFor } = await import('./accountingConnectionService');

    const conn = await resolveActiveConnectionFor('p1', 'invoicePush');

    expect(conn).toEqual({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', provider: 'quickbooks', status: 'connected' });
    expect(db.select).toHaveBeenCalledWith({
      id: accountingConnections.id, provider: accountingConnections.provider, status: accountingConnections.status,
    });
    expect(decryptSpy).not.toHaveBeenCalled();
    decryptSpy.mockRestore();
  });

  it('returns null when the active provider lacks the capability', async () => {
    dbRef.current = makeAmbientFakeDb(ambientConnectionRow({ provider: 'xero' })).db;
    const { resolveActiveConnectionFor } = await import('./accountingConnectionService');
    await expect(resolveActiveConnectionFor('p1', 'invoicePush')).resolves.toBeNull();
  });

  it('returns null when the partner has no connection', async () => {
    dbRef.current = makeAmbientFakeDb(null).db;
    const { resolveActiveConnectionFor } = await import('./accountingConnectionService');
    await expect(resolveActiveConnectionFor('p1', 'invoicePush')).resolves.toBeNull();
  });

  it('escapes an org-scoped caller into a system read (#2822): an org context sees zero partner-axis rows', async () => {
    partnerAxis.scope = 'organization';
    dbRef.current = makeAmbientFakeDb(ambientConnectionRow()).db;
    const { resolveActiveConnectionFor } = await import('./accountingConnectionService');
    await expect(resolveActiveConnectionFor('p1', 'invoicePush')).resolves.not.toBeNull();
    expect(partnerAxis.runOutside).toHaveBeenCalledOnce();
    expect(partnerAxis.withSystem).toHaveBeenCalledOnce();
  });

  it('does not open a second context when the caller is already system-scoped', async () => {
    partnerAxis.scope = 'system';
    dbRef.current = makeAmbientFakeDb(ambientConnectionRow()).db;
    const { resolveActiveConnectionFor } = await import('./accountingConnectionService');
    await resolveActiveConnectionFor('p1', 'invoicePush');
    expect(partnerAxis.withSystem).not.toHaveBeenCalled();
  });
});

describe('Xero W02 columns', () => {
  it('maps the three new columns, defaulting absent values to null', async () => {
    const { mapConnection } = await import('./accountingConnectionService');

    const mapped = mapConnection(ambientConnectionRow({
      defaultExemptTaxCodeRef: 'EXEMPTOUTPUT',
      defaultPaymentAccountRef: '13918178-849a-4823-9a31-57b7eac713d7',
      providerConnectionRef: 'e1eede29-f875-4a5d-8470-17f6a29a88b1',
    }) as any);
    expect(mapped.defaultExemptTaxCodeRef).toBe('EXEMPTOUTPUT');
    expect(mapped.defaultPaymentAccountRef).toBe('13918178-849a-4823-9a31-57b7eac713d7');
    expect(mapped.providerConnectionRef).toBe('e1eede29-f875-4a5d-8470-17f6a29a88b1');

    const bare = mapConnection(ambientConnectionRow({
      defaultExemptTaxCodeRef: undefined,
      defaultPaymentAccountRef: undefined,
      providerConnectionRef: undefined,
    }) as any);
    expect([bare.defaultExemptTaxCodeRef, bare.defaultPaymentAccountRef, bare.providerConnectionRef]).toEqual([null, null, null]);
  });

  it('upsertConnection writes providerConnectionRef on insert AND on a same-provider reconnect', async () => {
    const captured: { row?: any; insertValues?: any; updateSet?: any } = {};
    const db = makeMockDb(captured);
    const { upsertConnection } = await import('./accountingConnectionService');

    await upsertConnection(db, 'p1', 'xero', { realmId: 't1', providerConnectionRef: 'conn-1' });

    expect(captured.insertValues).toMatchObject({ providerConnectionRef: 'conn-1' });
    expect(captured.updateSet).toMatchObject({ providerConnectionRef: 'conn-1' });
  });

  it('a token-only reconnect (field omitted) leaves providerConnectionRef untouched', async () => {
    const captured: { row?: any; insertValues?: any; updateSet?: any } = {};
    const db = makeMockDb(captured);
    const { upsertConnection } = await import('./accountingConnectionService');

    await upsertConnection(db, 'p1', 'xero', { accessToken: 'a' });

    expect(captured.updateSet).not.toHaveProperty('providerConnectionRef');
    expect(captured.updateSet).not.toHaveProperty('defaultExemptTaxCodeRef');
    expect(captured.updateSet).not.toHaveProperty('defaultPaymentAccountRef');
  });
});

describe('pending_tenant (Xero W02)', () => {
  it('resolveActiveConnection and resolveActiveConnectionRef both exclude pending_tenant via the shared activeConnectionWhere predicate', async () => {
    const whereSpy = vi.fn((_cond: SQL) => ({ limit: async () => [] }));
    const dbc = { select: () => ({ from: () => ({ where: whereSpy }) }) } as any;
    const { resolveActiveConnection, resolveActiveConnectionRef } = await import('./accountingConnectionService');
    await resolveActiveConnection(dbc, 'p1');
    await resolveActiveConnectionRef(dbc, 'p1');
    const rendered = whereSpy.mock.calls.map(([cond]) => new PgDialect().sqlToQuery(cond as SQL));
    expect(rendered).toHaveLength(2);
    for (const q of rendered) {
      expect(q.sql).toContain('"accounting_connections"."status" <>');
      expect(q.params).toContain('pending_tenant');
    }
  });

  it('getPartnerConnectionRef sees every status, pending_tenant included', async () => {
    const whereSpy = vi.fn((_cond: SQL) => ({ limit: async () => [{ id: 'c1', provider: 'xero', status: 'pending_tenant' }] }));
    const dbc = { select: () => ({ from: () => ({ where: whereSpy }) }) } as any;
    const { getPartnerConnectionRef } = await import('./accountingConnectionService');
    await expect(getPartnerConnectionRef(dbc, 'p1')).resolves.toEqual({ id: 'c1', provider: 'xero', status: 'pending_tenant' });
    const q = new PgDialect().sqlToQuery(whereSpy.mock.calls[0]![0] as SQL);
    expect(q.params).not.toContain('pending_tenant');
  });

  it('conflict message tells the user to finish or cancel a pending connection', async () => {
    const { AccountingProviderConflictError } = await import('./accountingConnectionService');
    expect(new AccountingProviderConflictError('xero', 'quickbooks', 'pending_tenant').message)
      .toBe('Finish or cancel the Xero connection before connecting QuickBooks');
    expect(new AccountingProviderConflictError('quickbooks', 'xero').message)
      .toBe('Disconnect QuickBooks before connecting Xero');
  });

  it('upsertConnection raises the pending-aware conflict when a pending_tenant row of another provider exists', async () => {
    const { upsertConnection } = await import('./accountingConnectionService');
    const dbc = {
      insert: () => ({ values: () => ({ onConflictDoUpdate: () => ({ returning: async () => [] }) }) }),
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: 'c1', provider: 'xero', status: 'pending_tenant' }] }) }) }),
      update: vi.fn(), delete: vi.fn(),
    } as any;
    await expect(upsertConnection(dbc, 'p1', 'quickbooks', { realmId: 'r1' })).rejects.toMatchObject({
      code: 'accounting_provider_conflict', message: 'Finish or cancel the Xero connection before connecting QuickBooks',
    });
  });

  it('upsertConnection turns the realm-fingerprint unique violation into AccountingTenantHeldError', async () => {
    const { upsertConnection, AccountingTenantHeldError } = await import('./accountingConnectionService');
    const violation = Object.assign(new Error('dup'), { cause: { code: '23505', constraint_name: 'accounting_connections_provider_realm_fp_idx' } });
    const dbc = {
      insert: () => ({ values: () => ({ onConflictDoUpdate: () => ({ returning: async () => { throw violation; } }) }) }),
      select: vi.fn(), update: vi.fn(), delete: vi.fn(),
    } as any;
    const err = await upsertConnection(dbc, 'p1', 'xero', { realmId: 't1' }).catch((e) => e);
    expect(err).toBeInstanceOf(AccountingTenantHeldError);
    expect(err).toMatchObject({ code: 'accounting_tenant_held', status: 409, message: 'This Xero organisation is connected to another Breeze account' });
  });

  it('upsertConnection rethrows a 23505 on a DIFFERENT unique index untouched — never AccountingTenantHeldError', async () => {
    const { upsertConnection, AccountingTenantHeldError } = await import('./accountingConnectionService');
    const violation = Object.assign(new Error('dup'), { cause: { code: '23505', constraint_name: 'other_idx' } });
    const dbc = {
      insert: () => ({ values: () => ({ onConflictDoUpdate: () => ({ returning: async () => { throw violation; } }) }) }),
      select: vi.fn(), update: vi.fn(), delete: vi.fn(),
    } as any;
    const err = await upsertConnection(dbc, 'p1', 'xero', { realmId: 't1' }).catch((e) => e);
    expect(err).not.toBeInstanceOf(AccountingTenantHeldError);
    expect(err).toBe(violation);
  });

  it('upsertConnection rethrows a non-23505 error untouched — never AccountingTenantHeldError', async () => {
    const { upsertConnection, AccountingTenantHeldError } = await import('./accountingConnectionService');
    const violation = Object.assign(new Error('deadlock detected'), { cause: { code: '40P01' } });
    const dbc = {
      insert: () => ({ values: () => ({ onConflictDoUpdate: () => ({ returning: async () => { throw violation; } }) }) }),
      select: vi.fn(), update: vi.fn(), delete: vi.fn(),
    } as any;
    const err = await upsertConnection(dbc, 'p1', 'xero', { realmId: 't1' }).catch((e) => e);
    expect(err).not.toBeInstanceOf(AccountingTenantHeldError);
    expect(err).toBe(violation);
  });
});

it('round-trips income refs and preserves them on a token-only reconnect',async()=>{
  const captured:{row?:any;insertValues?:any;updateSet?:any}={};
  const dbc=makeMockDb(captured);
  const {upsertConnection,mapConnection}=await import('./accountingConnectionService');
  const result=await upsertConnection(dbc,'11111111-1111-4111-8111-111111111111','quickbooks',{
    feeIncomeItemRef:'fee-item',feeIncomeAccountRef:null});
  expect(result).toMatchObject({feeIncomeItemRef:'fee-item',feeIncomeAccountRef:null});
  expect(captured.insertValues).toMatchObject({feeIncomeItemRef:'fee-item',feeIncomeAccountRef:null});
  expect(captured.updateSet).toMatchObject({feeIncomeItemRef:'fee-item',feeIncomeAccountRef:null});
  await upsertConnection(dbc,'11111111-1111-4111-8111-111111111111','quickbooks',{});
  expect(captured.updateSet).not.toHaveProperty('feeIncomeItemRef');
  expect(captured.updateSet).not.toHaveProperty('feeIncomeAccountRef');
  expect(mapConnection(ambientConnectionRow() as never)).toMatchObject({feeIncomeItemRef:null,feeIncomeAccountRef:null});
});
