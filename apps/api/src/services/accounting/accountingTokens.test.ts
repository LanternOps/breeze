import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '../secretCrypto';

const { mocks, ctx } = vi.hoisted(() => ({
  mocks: {
    updateTokens: vi.fn(),
    markStatus: vi.fn(),
    provider: { refresh: vi.fn() },
  },
  /**
   * A faithful stand-in for the real AsyncLocalStorage context stack: `depth`
   * counts OPEN `withSystemDbAccessContext` blocks and `ambient` simulates a
   * caller (a route handler, a worker) that already opened one. `hasDbAccessContext`
   * is the exact predicate the real `db/index.ts` exports, so the guard under
   * test (`dbContextGuard.ts`, deliberately NOT mocked) runs its real logic.
   */
  ctx: { depth: 0, ambient: false, events: [] as string[] },
}));

vi.mock('../../db', () => ({
  hasDbAccessContext: () => ctx.ambient || ctx.depth > 0,
  withSystemDbAccessContext: async <T>(fn: () => T | Promise<T>, label?: string): Promise<T> => {
    ctx.depth++;
    ctx.events.push(`ctx:enter${label ? `(${label})` : ''}`);
    try {
      return await fn();
    } finally {
      ctx.events.push('ctx:exit');
      ctx.depth--;
    }
  },
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
 * `SELECT ... FOR UPDATE` — ciphertext columns, unlike the already-decrypted
 * `AccountingConnection` shape `connection()` above builds. Uses the REAL
 * `encryptSecret` (the test env's JWT_SECRET fallback key makes this work
 * with no extra setup — see accountingConnectionService.test.ts for the same
 * pattern) so `getValidAccessToken`'s real `decryptSecret` calls round-trip.
 */
function lockedRow(overrides: Record<string, unknown> = {}) {
  return {
    accessTokenEncrypted: encryptSecret('OLD-at'),
    refreshTokenEncrypted: encryptSecret('OLD-rt'),
    accessTokenExpiresAt: new Date(Date.now() + 60_000), // within the refresh buffer
    refreshTokenExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60_000),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

/**
 * A `db` whose `.transaction(fn)` opens a NEW `tx` each call against a SHARED,
 * MUTABLE row — so a test can simulate a concurrent peer's write landing
 * between two `db.transaction` calls (or mid-fetch, by mutating `state.row`
 * from inside a `provider.refresh` mock implementation) and have the NEXT
 * lock read see it, matching real Postgres. Also records an `events` log
 * (`tx1:start`/`tx1:end`/`tx2:start`/...) so a test can assert a transaction
 * fully committed (its callback returned) before any later async work runs —
 * the Critical fix under test: the row lock must never span `provider.refresh()`.
 */
function makeLockableDb(row: Record<string, unknown> | null) {
  const state = { row };
  // Shared with the mocked `withSystemDbAccessContext` above so a single
  // ordered log proves BOTH properties at once: each transaction runs inside
  // its own system context, and neither the context nor the lock spans the
  // provider.refresh() fetch.
  const events = ctx.events;
  let seq = 0;
  const db = {
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
      const id = ++seq;
      events.push(`tx${id}:start`);
      const tx = {
        select: vi.fn(() => ({
          from: () => ({
            where: () => ({
              limit: () => ({
                for: async () => (state.row ? [state.row] : []),
              }),
            }),
          }),
        })),
      };
      const result = await fn(tx);
      events.push(`tx${id}:end`);
      return result;
    }),
  };
  return { db: db as any, state, events };
}

describe('accountingTokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ctx.depth = 0;
    ctx.ambient = false;
    ctx.events.length = 0;
  });

  // ---------------------------------------------------------------------------
  // Review round 3 (#1105 / lost-sync-state class): `withSystemDbAccessContext`
  // JOINS an already-open context and `db.transaction` inside one degrades to a
  // SAVEPOINT, so the "two short transactions" this module documents only exist
  // when it is entered with NO ambient context. That is now enforced, not
  // assumed.
  // ---------------------------------------------------------------------------

  it('refuses to run inside an ambient DB access context (the caller must close it first)', async () => {
    ctx.ambient = true;
    const conn = connection({ accessTokenExpiresAt: new Date(Date.now() + 60_000) });
    const { db } = makeLockableDb(lockedRow());

    const { getValidAccessToken } = await import('./accountingTokens');

    await expect(getValidAccessToken(db, conn)).rejects.toThrow(/no ambient DB access context/i);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(mocks.provider.refresh).not.toHaveBeenCalled();
  });

  it('opens each lock transaction in its OWN system context, and holds neither across provider.refresh', async () => {
    const conn = connection({ accessTokenExpiresAt: new Date(Date.now() + 60_000) });
    const { db, events } = makeLockableDb(lockedRow());

    mocks.provider.refresh.mockImplementation(async () => {
      // The defining assertion: at the moment QuickBooks is called, no system
      // context (and therefore no transaction) is open at all.
      expect(ctx.depth).toBe(0);
      events.push('refresh');
      return {
        realmId: 'realm-1',
        accessToken: 'NEW-at',
        refreshToken: 'NEW-rt',
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
        refreshTokenExpiresAt: new Date(Date.now() + 8640000_000),
      };
    });

    const { getValidAccessToken } = await import('./accountingTokens');
    await getValidAccessToken(db, conn);

    expect(events).toEqual([
      'ctx:enter(accountingTokens.captureRefresh)', 'tx1:start', 'tx1:end', 'ctx:exit',
      'refresh',
      'ctx:enter(accountingTokens.persistRefresh)', 'tx2:start', 'tx2:end', 'ctx:exit',
    ]);
  });

  it('marks reauth_required through its own system context on the fast-fail path', async () => {
    const conn = connection({ refreshTokenExpiresAt: new Date(Date.now() - 1000) });

    const { getValidAccessToken, ReauthRequiredError } = await import('./accountingTokens');

    await expect(getValidAccessToken({} as any, conn)).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(ctx.events).toEqual(['ctx:enter(accountingTokens.markReauth)', 'ctx:exit']);
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

  // ---------------------------------------------------------------------------
  // Per-connection refresh lock (Phase C, Task 4). Fixed in review round 1
  // (#1105 connection-hold class): two SHORT transactions bracket the network
  // call, the row lock is NEVER held across `provider.refresh()`.
  // ---------------------------------------------------------------------------

  it('double-checked locking (Transaction A): returns the fresh token WITHOUT any fetch when another caller already rotated it under the lock', async () => {
    // The pre-lock `connection` snapshot looks like it needs a refresh...
    const conn = connection({ accessTokenExpiresAt: new Date(Date.now() + 60_000) });
    // ...but by the time we win the row lock, a concurrent caller (e.g. the
    // accounting-sync worker) has already refreshed: the LOCKED row's access
    // token is fresh, well outside the buffer.
    const { db } = makeLockableDb(lockedRow({
      accessTokenEncrypted: encryptSecret('WINNER-at'),
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
    }));

    const { getValidAccessToken } = await import('./accountingTokens');
    const token = await getValidAccessToken(db, conn);

    expect(token).toBe('WINNER-at');
    expect(mocks.provider.refresh).not.toHaveBeenCalled();
    expect(mocks.updateTokens).not.toHaveBeenCalled();
    expect(db.transaction).toHaveBeenCalledOnce(); // no need for a second transaction — nothing to fetch
  });

  it('throws when the row lock finds no row (deleted underneath the capture, or wrong DB context)', async () => {
    const { db } = makeLockableDb(null);
    const conn = connection({ accessTokenExpiresAt: new Date(Date.now() + 60_000) });

    const { getValidAccessToken } = await import('./accountingTokens');

    await expect(getValidAccessToken(db, conn)).rejects.toThrow(/matched no accounting_connections row/);
    expect(mocks.provider.refresh).not.toHaveBeenCalled();
    expect(mocks.updateTokens).not.toHaveBeenCalled();
  });

  it('marks reauth_required (under the lock) when the LOCKED row shows the refresh token is now expired', async () => {
    const conn = connection({ accessTokenExpiresAt: new Date(Date.now() + 60_000) });
    const { db } = makeLockableDb(lockedRow({ refreshTokenExpiresAt: new Date(Date.now() - 1000) }));

    const { getValidAccessToken, ReauthRequiredError } = await import('./accountingTokens');

    await expect(getValidAccessToken(db, conn)).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(mocks.provider.refresh).not.toHaveBeenCalled();
    expect(mocks.markStatus).toHaveBeenCalledOnce();
  });

  it('CRITICAL: the row lock is never held across the fetch — Transaction A commits before provider.refresh is called, Transaction B opens only after it resolves', async () => {
    const conn = connection({ accessTokenExpiresAt: new Date(Date.now() + 60_000) });
    const { db, events } = makeLockableDb(lockedRow());

    mocks.provider.refresh.mockImplementation(async (token: string) => {
      events.push('refresh:call');
      expect(token).toBe('OLD-rt');
      // A real network round trip would await here; a microtask tick is
      // enough to prove no transaction is concurrently open around us.
      await Promise.resolve();
      events.push('refresh:resolve');
      return {
        realmId: 'realm-1',
        accessToken: 'NEW-at',
        refreshToken: 'NEW-rt',
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
        refreshTokenExpiresAt: new Date(Date.now() + 8640000_000),
      };
    });

    const { getValidAccessToken } = await import('./accountingTokens');
    const token = await getValidAccessToken(db, conn);

    expect(token).toBe('NEW-at');
    expect(db.transaction).toHaveBeenCalledTimes(2);
    // The defining property under test: tx1 fully committed (its callback
    // RETURNED) before the fetch was even called, and tx2 did not open until
    // the fetch resolved. A regression back to one transaction wrapping the
    // fetch would produce a different event sequence (and a different
    // `db.transaction` call count) than this exact order.
    expect(events).toEqual([
      'ctx:enter(accountingTokens.captureRefresh)', 'tx1:start', 'tx1:end', 'ctx:exit',
      'refresh:call', 'refresh:resolve',
      'ctx:enter(accountingTokens.persistRefresh)', 'tx2:start', 'tx2:end', 'ctx:exit',
    ]);
  });

  it('persists the rotated tokens (Transaction B), writing through the LOCKED tx (not the outer db)', async () => {
    const conn = connection({ accessTokenExpiresAt: new Date(Date.now() + 60_000) });
    const { db } = makeLockableDb(lockedRow());
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
    expect(db.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.provider.refresh).toHaveBeenCalledWith('OLD-rt');
    const [txArg, idArg, partnerIdArg] = mocks.updateTokens.mock.calls[0]!;
    expect(txArg).not.toBe(db); // persisted through a tx handle, not the outer db
    expect(idArg).toBe(conn.id);
    expect(partnerIdArg).toBe(conn.partnerId);
    expect(mocks.updateTokens).toHaveBeenCalledWith(
      txArg,
      conn.id,
      conn.partnerId,
      expect.objectContaining({ refreshToken: 'NEW-rt', accessToken: 'NEW-at' })
    );
  });

  it('LOSER DISCARDS ROTATION (Transaction B): a peer commits a newer rotation mid-fetch — our result is discarded, the peer\'s fresh token wins, and nothing we fetched is persisted', async () => {
    const conn = connection({ accessTokenExpiresAt: new Date(Date.now() + 60_000) });
    const { db, state } = makeLockableDb(lockedRow());

    mocks.provider.refresh.mockImplementation(async () => {
      // Simulate a peer committing its OWN rotation while we are mid-fetch:
      // the row's refresh token (the value Transaction B actually compares)
      // and access token move underneath us.
      state.row = {
        ...(state.row as Record<string, unknown>),
        accessTokenEncrypted: encryptSecret('PEER-at'),
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
        refreshTokenEncrypted: encryptSecret('PEER-rt'),
        updatedAt: new Date('2026-09-01T00:05:00.000Z'),
      };
      return {
        realmId: 'realm-1',
        accessToken: 'OURS-at',
        refreshToken: 'OURS-rt',
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
        refreshTokenExpiresAt: new Date(Date.now() + 8640000_000),
      };
    });

    const { getValidAccessToken } = await import('./accountingTokens');
    const token = await getValidAccessToken(db, conn);

    expect(token).toBe('PEER-at'); // the peer's token, never ours
    expect(mocks.updateTokens).not.toHaveBeenCalled(); // our rotation is discarded, not persisted
  });

  it('LOSER DISCARDS ROTATION even with an IDENTICAL updated_at (regression, review round 2): peer rotation is detected BY VALUE, not by timestamp', async () => {
    // Review round 2 finding: an earlier version of this fix compared
    // `row.updatedAt` (ms resolution) to detect a peer rotation. Two commits
    // landing in the SAME millisecond would false-negative that compare,
    // letting the loser overwrite a newer rotation with tokens derived from
    // an already-invalidated refresh token — bricking the connection until
    // reauth. This test pins the peer's `updatedAt` to the EXACT same
    // millisecond as the row Transaction A captured, so the ONLY way this
    // test can pass is if peer-rotation detection compares the refresh token
    // VALUE, not the timestamp.
    const conn = connection({ accessTokenExpiresAt: new Date(Date.now() + 60_000) });
    const sameInstant = new Date('2026-09-01T00:00:00.000Z');
    const { db, state } = makeLockableDb(lockedRow({ updatedAt: sameInstant }));

    mocks.provider.refresh.mockImplementation(async () => {
      state.row = {
        ...(state.row as Record<string, unknown>),
        accessTokenEncrypted: encryptSecret('PEER-at'),
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
        refreshTokenEncrypted: encryptSecret('PEER-rt'),
        updatedAt: sameInstant, // IDENTICAL to the Transaction A capture, deliberately
      };
      return {
        realmId: 'realm-1',
        accessToken: 'OURS-at',
        refreshToken: 'OURS-rt',
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
        refreshTokenExpiresAt: new Date(Date.now() + 8640000_000),
      };
    });

    const { getValidAccessToken } = await import('./accountingTokens');
    const token = await getValidAccessToken(db, conn);

    expect(token).toBe('PEER-at');
    expect(mocks.updateTokens).not.toHaveBeenCalled();
  });

  it('marks reauth_required when refresh returns an explicit invalid_grant AND the row still holds the token we tried (genuine revocation)', async () => {
    const conn = connection({ accessTokenExpiresAt: new Date(Date.now() + 60_000) });
    const { db } = makeLockableDb(lockedRow()); // row's refreshTokenEncrypted stays 'OLD-rt' throughout
    mocks.provider.refresh.mockRejectedValueOnce({ status: 400, qboError: 'invalid_grant', message: 'invalid_grant' });

    const { getValidAccessToken, ReauthRequiredError } = await import('./accountingTokens');

    await expect(getValidAccessToken(db, conn)).rejects.toBeInstanceOf(ReauthRequiredError);
    const [txArg] = mocks.markStatus.mock.calls[0]!;
    expect(txArg).not.toBe(db);
    expect(mocks.markStatus).toHaveBeenCalledWith(txArg, conn.id, conn.partnerId, 'reauth_required', expect.any(String));
    expect(mocks.updateTokens).not.toHaveBeenCalled();
  });

  it('INVALID_GRANT-BUT-PEER-ROTATED recovery: does NOT mark reauth_required when a peer already rotated past the token we tried — returns the peer\'s fresh token instead', async () => {
    const conn = connection({ accessTokenExpiresAt: new Date(Date.now() + 60_000) });
    const { db, state } = makeLockableDb(lockedRow());

    mocks.provider.refresh.mockImplementation(async () => {
      // A peer rotated the refresh token (and left a fresh access token)
      // between our Transaction A capture and this failed fetch — QBO
      // rejecting OUR now-stale refresh token is expected, not a revocation.
      state.row = {
        ...(state.row as Record<string, unknown>),
        refreshTokenEncrypted: encryptSecret('PEER-rt'),
        accessTokenEncrypted: encryptSecret('PEER-at2'),
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
        updatedAt: new Date('2026-09-01T00:05:00.000Z'),
      };
      throw Object.assign(new Error('invalid_grant'), { status: 400, qboError: 'invalid_grant' });
    });

    const { getValidAccessToken } = await import('./accountingTokens');
    const token = await getValidAccessToken(db, conn);

    expect(token).toBe('PEER-at2');
    expect(mocks.markStatus).not.toHaveBeenCalled();
    expect(mocks.updateTokens).not.toHaveBeenCalled();
  });

  it('rethrows a transient refresh error (does NOT misclassify as reauth) — and takes no recovery lock at all', async () => {
    const conn = connection({ accessTokenExpiresAt: new Date(Date.now() + 60_000) });
    const { db } = makeLockableDb(lockedRow());
    // 503 whose body merely mentions invalid_grant — must NOT force-disconnect.
    const boom = Object.assign(new Error('upstream 503 mentioning invalid_grant'), { status: 503 });
    mocks.provider.refresh.mockRejectedValueOnce(boom);

    const { getValidAccessToken } = await import('./accountingTokens');

    await expect(getValidAccessToken(db, conn)).rejects.toBe(boom);
    expect(mocks.markStatus).not.toHaveBeenCalled();
    expect(mocks.updateTokens).not.toHaveBeenCalled();
    // A non-invalid_grant failure never needs the recovery re-read: only
    // Transaction A (the capture) was opened.
    expect(db.transaction).toHaveBeenCalledOnce();
  });
});
