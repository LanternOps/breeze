import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '../secretCrypto';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    updateTokens: vi.fn(),
    markStatus: vi.fn(),
    provider: { refresh: vi.fn() },
  },
}));

vi.mock('../../db', () => ({
  runOutsideDbContext: <T>(fn: () => T) => fn(),
}));

vi.mock('./accountingConnectionService', () => ({
  updateTokens: mocks.updateTokens,
  markStatus: mocks.markStatus,
}));

vi.mock('./providerRegistry', () => ({
  getAccountingProvider: vi.fn(() => mocks.provider),
}));

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    partnerId: '11111111-1111-1111-1111-111111111111',
    provider: 'quickbooks',
    realmId: 'realm-1',
    accessToken: 'OLD-at',
    refreshToken: 'OLD-rt',
    accessTokenExpiresAt: new Date(Date.now() + 30 * 60_000),
    refreshTokenExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60_000),
    environment: 'production',
    homeCurrency: null,
    defaultIncomeAccountRef: null,
    defaultTaxCodeRef: null,
    pushMode: 'auto',
    status: 'connected',
    createdAt: new Date(),
    updatedAt: new Date(),
    lastError: null,
    ...overrides,
  } as any;
}

/**
 * The raw `accounting_connections` row `getValidAccessToken` reads under
 * `SELECT ... FOR UPDATE`, once the refresh lock is entered — ciphertext
 * columns, unlike the already-decrypted `AccountingConnection` shape
 * `connection()` above builds. Uses the REAL `encryptSecret` (the test env's
 * JWT_SECRET fallback key makes this work with no extra setup — see
 * accountingConnectionService.test.ts for the same pattern) so
 * `getValidAccessToken`'s real `decryptSecret` call round-trips.
 */
function lockedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    partnerId: '11111111-1111-1111-1111-111111111111',
    accessTokenEncrypted: encryptSecret('OLD-at'),
    refreshTokenEncrypted: encryptSecret('OLD-rt'),
    accessTokenExpiresAt: new Date(Date.now() + 60_000), // within the refresh buffer
    refreshTokenExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60_000),
    ...overrides,
  };
}

/** A `db` whose `.transaction(fn)` hands `fn` a `tx` that resolves the given
 *  row (or no row) under `.select().from().where().limit().for('update')`. */
function dbWithLockedRow(row: Record<string, unknown> | null) {
  const tx = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            for: async () => (row ? [row] : []),
          }),
        }),
      }),
    })),
  };
  return { transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)) } as any;
}

describe('accountingTokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the existing access token when it is outside the refresh buffer', async () => {
    const { getValidAccessToken } = await import('./accountingTokens');

    // No lock is taken on this fast path — a bare object with no `.transaction`
    // proves it (a lock attempt would throw "not a function").
    const token = await getValidAccessToken({} as any, connection());

    expect(token).toBe('OLD-at');
    expect(mocks.provider.refresh).not.toHaveBeenCalled();
    expect(mocks.updateTokens).not.toHaveBeenCalled();
  });

  it('persists the rotated refresh token on refresh, writing through the LOCKED tx (not the outer db)', async () => {
    const db = dbWithLockedRow(lockedRow());
    const conn = connection({ accessTokenExpiresAt: new Date(Date.now() + 60_000) });
    mocks.provider.refresh.mockResolvedValueOnce({
      realmId: 'realm-1',
      accessToken: 'NEW-at',
      refreshToken: 'NEW-rt',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      refreshTokenExpiresAt: new Date(Date.now() + 8640000_000),
    });

    const { getValidAccessToken } = await import('./accountingTokens');
    const token = await getValidAccessToken(db, conn);

    expect(token).toBe('NEW-at');
    expect(db.transaction).toHaveBeenCalledOnce();
    // The refresh call uses the LOCKED row's refresh token, not the stale
    // pre-lock `connection.refreshToken` snapshot — they happen to match here
    // (nobody raced us), but the call must be sourced from the locked read.
    expect(mocks.provider.refresh).toHaveBeenCalledWith('OLD-rt');
    const [txArg, idArg, partnerIdArg] = mocks.updateTokens.mock.calls[0]!;
    expect(txArg).not.toBe(db); // persisted through the tx handle, not the outer db
    expect(idArg).toBe(conn.id);
    expect(partnerIdArg).toBe(conn.partnerId);
    expect(mocks.updateTokens).toHaveBeenCalledWith(
      txArg,
      conn.id,
      conn.partnerId,
      expect.objectContaining({ refreshToken: 'NEW-rt', accessToken: 'NEW-at' })
    );
  });

  it('marks reauth_required when the refresh token is expired', async () => {
    const conn = connection({
      refreshTokenExpiresAt: new Date(Date.now() - 1000),
    });

    const { getValidAccessToken, ReauthRequiredError } = await import('./accountingTokens');

    // Fast-fail path (before any lock is taken) — bare object again proves no lock attempted.
    await expect(getValidAccessToken({} as any, conn)).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(mocks.markStatus).toHaveBeenCalledWith(
      {},
      conn.id,
      conn.partnerId,
      'reauth_required',
      expect.any(String)
    );
    expect(mocks.provider.refresh).not.toHaveBeenCalled();
  });

  it('marks reauth_required when refresh returns an explicit invalid_grant', async () => {
    const db = dbWithLockedRow(lockedRow());
    const conn = connection({ accessTokenExpiresAt: new Date(Date.now() + 60_000) });
    mocks.provider.refresh.mockRejectedValueOnce({ status: 400, qboError: 'invalid_grant', message: 'invalid_grant' });

    const { getValidAccessToken, ReauthRequiredError } = await import('./accountingTokens');

    await expect(getValidAccessToken(db, conn)).rejects.toBeInstanceOf(ReauthRequiredError);
    const [txArg] = mocks.markStatus.mock.calls[0]!;
    expect(txArg).not.toBe(db);
    expect(mocks.markStatus).toHaveBeenCalledWith(txArg, conn.id, conn.partnerId, 'reauth_required', expect.any(String));
    expect(mocks.updateTokens).not.toHaveBeenCalled();
  });

  it('rethrows a transient refresh error (does NOT misclassify as reauth)', async () => {
    const db = dbWithLockedRow(lockedRow());
    const conn = connection({ accessTokenExpiresAt: new Date(Date.now() + 60_000) });
    // 503 whose body merely mentions invalid_grant — must NOT force-disconnect.
    const boom = Object.assign(new Error('upstream 503 mentioning invalid_grant'), { status: 503 });
    mocks.provider.refresh.mockRejectedValueOnce(boom);

    const { getValidAccessToken } = await import('./accountingTokens');

    await expect(getValidAccessToken(db, conn)).rejects.toBe(boom);
    expect(mocks.markStatus).not.toHaveBeenCalled();
    expect(mocks.updateTokens).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Per-connection refresh lock (Phase C, Task 4): db.transaction + SELECT ...
  // FOR UPDATE, with a double-checked re-read of the locked row's expiry.
  // ---------------------------------------------------------------------------

  it('double-checked locking: returns the fresh token WITHOUT a second refresh when another caller already rotated it under the lock', async () => {
    // The pre-lock `connection` snapshot looks like it needs a refresh...
    const conn = connection({ accessTokenExpiresAt: new Date(Date.now() + 60_000) });
    // ...but by the time we win the row lock, a concurrent caller (e.g. the
    // accounting-sync worker) has already refreshed: the LOCKED row's access
    // token is fresh, well outside the buffer.
    const db = dbWithLockedRow(lockedRow({
      accessTokenEncrypted: encryptSecret('WINNER-at'),
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
    }));

    const { getValidAccessToken } = await import('./accountingTokens');
    const token = await getValidAccessToken(db, conn);

    expect(token).toBe('WINNER-at');
    expect(mocks.provider.refresh).not.toHaveBeenCalled();
    expect(mocks.updateTokens).not.toHaveBeenCalled();
    expect(db.transaction).toHaveBeenCalledOnce();
  });

  it('throws when the row lock finds no row (deleted underneath the capture, or wrong DB context)', async () => {
    const db = dbWithLockedRow(null);
    const conn = connection({ accessTokenExpiresAt: new Date(Date.now() + 60_000) });

    const { getValidAccessToken } = await import('./accountingTokens');

    await expect(getValidAccessToken(db, conn)).rejects.toThrow(/matched no accounting_connections row/);
    expect(mocks.provider.refresh).not.toHaveBeenCalled();
    expect(mocks.updateTokens).not.toHaveBeenCalled();
  });

  it('marks reauth_required (under the lock) when the LOCKED row shows the refresh token is now expired', async () => {
    const conn = connection({ accessTokenExpiresAt: new Date(Date.now() + 60_000) });
    const db = dbWithLockedRow(lockedRow({ refreshTokenExpiresAt: new Date(Date.now() - 1000) }));

    const { getValidAccessToken, ReauthRequiredError } = await import('./accountingTokens');

    await expect(getValidAccessToken(db, conn)).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(mocks.provider.refresh).not.toHaveBeenCalled();
    expect(mocks.markStatus).toHaveBeenCalledOnce();
  });
});
