import { describe, expect, it, vi } from 'vitest';
import { decryptSecret } from '../secretCrypto';

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
});
