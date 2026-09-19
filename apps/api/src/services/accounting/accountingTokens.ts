import { and, eq } from 'drizzle-orm';
import { withSystemDbAccessContext } from '../../db';
import { assertNoAmbientDbContext } from './dbContextGuard';
import { accountingConnections } from '../../db/schema';
import { decryptSecret } from '../secretCrypto';
import type { AccountingConnection, DbExecutor, DbTransactor } from './accountingConnectionService';
import { markStatus, updateTokens } from './accountingConnectionService';
import { getAccountingProvider } from './providerRegistry';

// Refresh proactively while the access token still has >5 min of life, so an
// in-flight QBO call can't lose a race against the expiry boundary. Do not
// "simplify" this to `> now` — that reintroduces edge-of-expiry 401s.
const ACCESS_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export class ReauthRequiredError extends Error {
  constructor(message = 'Accounting connection requires reauthorization') {
    super(message);
    this.name = 'ReauthRequiredError';
  }
}

// Only treat an explicit OAuth `invalid_grant` (the refresh token was revoked or
// expired server-side) as permanent reauth. A transient error whose text merely
// contains "invalid_grant" must NOT force-disconnect the partner — it should
// propagate and be retried. So we require either the structured `qboError` field
// or a 400 status carrying it, never a bare message substring.
function isInvalidGrant(err: unknown): boolean {
  const e = err as { status?: number; qboError?: string; message?: string };
  return e.qboError === 'invalid_grant'
    || (e.status === 400 && /invalid_grant/i.test(e.message ?? ''));
}

// A minimal shape of the raw `accounting_connections` row this module reads
// under lock — narrower than the full Drizzle-inferred row, which is fine
// since `DbExecutor`'s chain methods are all loosely `any`-typed anyway.
interface LockedConnectionRow {
  accessTokenEncrypted: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenEncrypted: string | null;
  refreshTokenExpiresAt: Date | null;
}

/** Decrypts the row's refresh token, or null if it has none. Shared by the
 *  peer-rotation checks in both Transaction B and `handleRefreshFailure`. */
function decryptRowRefreshToken(row: LockedConnectionRow): string | null {
  return row.refreshTokenEncrypted ? decryptSecret(row.refreshTokenEncrypted) : null;
}

/** `SELECT ... FOR UPDATE` the connection row inside an already-open
 *  transaction. Throws (loud, not a silent no-op) when nothing matches —
 *  deleted underneath the capture, or the DB context is wrong — same
 *  rationale as `updateTokens`/`markStatus`/`updateHomeCurrency`'s
 *  zero-row-throws elsewhere in this module family. */
async function lockConnectionRow(
  tx: DbExecutor,
  connection: Pick<AccountingConnection, 'id' | 'partnerId'>,
): Promise<LockedConnectionRow> {
  const [row] = await tx
    .select()
    .from(accountingConnections)
    .where(and(eq(accountingConnections.id, connection.id), eq(accountingConnections.partnerId, connection.partnerId)))
    .limit(1)
    .for('update');
  if (!row) {
    throw new Error(`getValidAccessToken matched no accounting_connections row (id=${connection.id}) under lock; it was deleted underneath the capture or the DB context is wrong`);
  }
  return row as LockedConnectionRow;
}

/** The row's access token, decrypted, ONLY when it is outside the refresh
 *  buffer — null otherwise (missing, or itself needs refreshing). Used at
 *  every re-read point below to answer "does this row already have a usable
 *  token right now" without duplicating the buffer-math three times. */
function freshAccessTokenFromRow(row: LockedConnectionRow, now: number): string | null {
  const accessExpiresAt = row.accessTokenExpiresAt?.getTime() ?? 0;
  if (!row.accessTokenEncrypted || accessExpiresAt <= now + ACCESS_TOKEN_REFRESH_BUFFER_MS) return null;
  return decryptSecret(row.accessTokenEncrypted);
}

type RefreshTokens = Awaited<ReturnType<ReturnType<typeof getAccountingProvider>['refresh']>>;

/**
 * `provider.refresh()` failed. `invalid_grant` normally means the refresh
 * token was permanently revoked — but it can ALSO mean we lost a concurrent
 * refresh race: a peer rotated the connection's refresh token between our
 * Transaction A capture and this failed fetch, and QuickBooks is correctly
 * rejecting the now-stale token we tried. Re-check under the lock before
 * concluding it's permanent: only mark `reauth_required` when the row STILL
 * holds the exact refresh token we attempted.
 */
async function handleRefreshFailure(
  db: DbTransactor,
  connection: AccountingConnection,
  attemptedRefreshToken: string,
  err: unknown,
): Promise<string> {
  if (err instanceof ReauthRequiredError) throw err;
  if (!isInvalidGrant(err)) {
    // Transient/unknown failure — propagate so it's retried and surfaced by
    // the global error handler, NOT misclassified as permanent reauth.
    throw err;
  }

  // Its OWN short system transaction, for the same reason A and B below are:
  // entered with no ambient context this is a real transaction that commits on
  // its own, so the `reauth_required` status it writes survives the throw two
  // lines later. Joined onto a caller's context it would be a savepoint and the
  // status would roll back with the caller's transaction.
  return withSystemDbAccessContext(() => db.transaction(async (tx) => {
    const row = await lockConnectionRow(tx, connection);
    const currentRefreshToken = decryptRowRefreshToken(row);

    if (currentRefreshToken !== attemptedRefreshToken) {
      // A peer already rotated past the token we tried — this invalid_grant
      // was us losing the race, not a real revocation. Leave status
      // untouched; hand back the peer's fresh token if it left one. Freshness
      // is judged against a NOW captured HERE, inside the lock — reusing the
      // pre-fetch `now` would judge it against a clock that predates the
      // entire refresh round trip, and could report a token stale that is
      // actually still comfortably within the buffer, or vice versa.
      const peerToken = freshAccessTokenFromRow(row, Date.now());
      if (peerToken) return peerToken;
      // The refresh token changed but the row carries no fresh access token
      // (a peer's rotation still mid-flight, or a state this function did
      // not cause and cannot safely resolve). Propagate the ORIGINAL error
      // rather than manufacturing a reauth_required this branch has no basis
      // for — the safe default is "retry", matching the transient-failure
      // path above.
      throw err;
    }

    // The row still holds the exact token we tried — a genuine revocation.
    // Preserve the underlying Intuit error for forensics before flattening it
    // into the canned reauth status (without it, "why did this flip to
    // reauth_required" is undebuggable).
    console.error('[accounting] QuickBooks refresh returned invalid_grant', {
      connectionId: connection.id,
      partnerId: connection.partnerId,
      error: err instanceof Error ? err.message : String(err),
    });
    await markStatus(tx, connection.id, connection.partnerId, 'reauth_required', 'QuickBooks refresh token is invalid or expired');
    throw new ReauthRequiredError();
  }), 'accountingTokens.refreshFailureRecheck');
}

/**
 * Refresh the connection's access token if needed and return a live one.
 *
 * MUST be entered with NO ambient DB access context (asserted): every DB block
 * below opens its own short `withSystemDbAccessContext` transaction so that the
 * row lock is released — and the token rotation committed — before and after
 * the `provider.refresh()` network call, and so that a `reauth_required` status
 * write survives the `ReauthRequiredError` thrown immediately after it. Joined
 * onto a caller's transaction every one of those blocks degrades to a savepoint:
 * the lock would then genuinely span the fetch (the #1105 hold this module
 * claims to avoid) and the status writes would roll back with the caller.
 */
export async function getValidAccessToken(db: DbTransactor, connection: AccountingConnection): Promise<string> {
  assertNoAmbientDbContext('getValidAccessToken');

  const now = Date.now();
  const refreshExpiresAt = connection.refreshTokenExpiresAt?.getTime() ?? 0;
  if (!connection.refreshToken || refreshExpiresAt <= now) {
    await withSystemDbAccessContext(
      () => markStatus(db, connection.id, connection.partnerId, 'reauth_required', 'QuickBooks refresh token expired'),
      'accountingTokens.markReauth',
    );
    throw new ReauthRequiredError();
  }

  const accessExpiresAt = connection.accessTokenExpiresAt?.getTime() ?? 0;
  if (connection.accessToken && accessExpiresAt > now + ACCESS_TOKEN_REFRESH_BUFFER_MS) {
    return connection.accessToken;
  }

  // Per-connection refresh lock (Phase C, Task 4; fixed in review round 1 —
  // #1105 connection-hold class). A refresh is needed, and this connection
  // can now be refreshed concurrently: an on-demand request AND a background
  // accounting-sync worker job can race here. Without SOME coordination, both
  // would refresh; QBO ROTATES the refresh token on every call, so the SECOND
  // refresh silently invalidates the first caller's already-rotated token,
  // and whichever persist wins leaves the loser holding a dead refresh token.
  //
  // The lock is deliberately NEVER held across `provider.refresh()` (network
  // I/O) — an earlier version of this function did `db.transaction(... FOR
  // UPDATE ... await provider.refresh() ...)`, pinning a pooled Postgres
  // connection AND the row lock for the entire QBO round trip. That is
  // exactly the #1105 connection-hold class this repo has had pool-storm
  // incidents from. Note that `runOutsideDbContext` is NOT what buys the
  // release: it only re-routes the AsyncLocalStorage lookup and cannot commit
  // a transaction the caller already opened, which is why this function
  // asserts it was entered with none (see the doc comment above) and opens
  // each of the two SHORT transactions itself:
  //
  //   A. Lock the row, re-check under the lock (double-checked: a peer may
  //      already have refreshed while we waited for the lock). If still
  //      stale, capture the refresh token and COMMIT — no transaction stays
  //      open while we call QuickBooks.
  //   (fetch — no transaction open)
  //   B. Lock the row again. Peer rotation is detected BY VALUE, not by a
  //      timestamp: if the row's CURRENT refresh token no longer matches the
  //      one we captured in A, a peer already rotated it while we were
  //      mid-fetch — DISCARD our rotation (never overwrite a newer one) and
  //      return the peer's fresh token. A ms-resolution `updated_at` compare
  //      was tried first and rejected in review — two commits landing in the
  //      same millisecond would false-negative it, letting the loser persist
  //      tokens derived from an already-invalidated refresh token and brick
  //      the connection until reauth. Comparing the actual token value has no
  //      such collision window. Otherwise persist ours, same zero-row-throw
  //      `updateTokens` as before.
  const captured = await withSystemDbAccessContext(() => db.transaction(async (tx) => {
    const row = await lockConnectionRow(tx, connection);

    const winnerToken = freshAccessTokenFromRow(row, now);
    if (winnerToken) return { needsRefresh: false as const, accessToken: winnerToken };

    const lockedRefreshToken = decryptRowRefreshToken(row);
    const lockedRefreshExpiresAt = row.refreshTokenExpiresAt?.getTime() ?? 0;
    if (!lockedRefreshToken || lockedRefreshExpiresAt <= now) {
      await markStatus(tx, connection.id, connection.partnerId, 'reauth_required', 'QuickBooks refresh token expired');
      throw new ReauthRequiredError();
    }

    return { needsRefresh: true as const, refreshToken: lockedRefreshToken };
  }), 'accountingTokens.captureRefresh');

  if (!captured.needsRefresh) return captured.accessToken;

  let tokens: RefreshTokens;
  try {
    const provider = getAccountingProvider(connection.provider);
    // QBO ROTATES the refresh token on every refresh — the persist below
    // writes the returned refresh_token, not the old one. Dropping that write
    // permanently breaks the connection. Transaction A has COMMITTED by now and
    // the entry assert guarantees the caller left none open, so this genuinely
    // runs with no connection held.
    tokens = await provider.refresh(captured.refreshToken);
  } catch (err) {
    return handleRefreshFailure(db, connection, captured.refreshToken, err);
  }

  return withSystemDbAccessContext(() => db.transaction(async (tx) => {
    const row = await lockConnectionRow(tx, connection);

    if (decryptRowRefreshToken(row) !== captured.refreshToken) {
      // A peer already committed a rotation while we were fetching — never
      // overwrite a newer one with our now-stale result. Prefer the peer's
      // fresh token when it left one. Freshness is judged against a NOW
      // captured HERE, inside the lock, not the pre-fetch `now` above — that
      // clock predates the entire refresh round trip, and reusing it here
      // could misjudge a token that has since crossed the buffer either way.
      const peerToken = freshAccessTokenFromRow(row, Date.now());
      if (peerToken) return peerToken;
      // The refresh token changed but the row carries no fresh access token
      // yet (an in-flight peer write we raced past, or an unrelated write to
      // this row) — our own freshly-fetched, still-valid rotation is the best
      // available result, so fall through and persist it.
    }

    await updateTokens(tx, connection.id, connection.partnerId, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
    });
    return tokens.accessToken;
  }), 'accountingTokens.persistRefresh');
}
