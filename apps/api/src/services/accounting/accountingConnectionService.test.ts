import { describe, expect, it, vi, beforeEach } from 'vitest';
import { decryptSecret, encryptSecret } from '../secretCrypto';

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

vi.mock('../../db', () => ({
  db: ambientDb,
  hasDbAccessContext: () => ctx.depth > 0,
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
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
    ...overrides,
  };
}

function makeMockDb(captured: { row?: any; insertValues?: any; updateSet?: any }) {
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
});
