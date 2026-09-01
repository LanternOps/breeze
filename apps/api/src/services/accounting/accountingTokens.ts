import { and, eq } from 'drizzle-orm';
import { runOutsideDbContext } from '../../db';
import { accountingConnections } from '../../db/schema';
import { decryptSecret } from '../secretCrypto';
import type { AccountingConnection, DbTransactor } from './accountingConnectionService';
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

export async function getValidAccessToken(db: DbTransactor, connection: AccountingConnection): Promise<string> {
  const now = Date.now();
  const refreshExpiresAt = connection.refreshTokenExpiresAt?.getTime() ?? 0;
  if (!connection.refreshToken || refreshExpiresAt <= now) {
    await markStatus(db, connection.id, connection.partnerId, 'reauth_required', 'QuickBooks refresh token expired');
    throw new ReauthRequiredError();
  }

  const accessExpiresAt = connection.accessTokenExpiresAt?.getTime() ?? 0;
  if (connection.accessToken && accessExpiresAt > now + ACCESS_TOKEN_REFRESH_BUFFER_MS) {
    return connection.accessToken;
  }

  // Per-connection lock (Phase C, Task 4): a refresh is needed, and this
  // connection can now be refreshed concurrently — an on-demand request AND a
  // background accounting-sync worker job can race here. Without a lock, both
  // would refresh; QBO ROTATES the refresh token on every call, so the SECOND
  // refresh silently invalidates the first caller's already-rotated token, and
  // whichever persist wins leaves the loser holding a dead refresh token.
  //
  // `db.transaction` + `SELECT ... FOR UPDATE` serializes refreshers on this
  // row (mirrors accountingConnectionService.updateHomeCurrency's row-lock
  // shape). The double-checked re-read after acquiring the lock returns the
  // WINNER's fresh token to the loser instead of refreshing a second time.
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(accountingConnections)
      .where(and(eq(accountingConnections.id, connection.id), eq(accountingConnections.partnerId, connection.partnerId)))
      .limit(1)
      .for('update');

    if (!row) {
      // Deleted underneath the capture (disconnected) or hidden by RLS —
      // both are "nothing to refresh"; loud rather than a silent hang, same
      // rationale as updateTokens/markStatus/updateHomeCurrency's 0-row-throw.
      throw new Error(`getValidAccessToken matched no accounting_connections row (id=${connection.id}) under lock; it was deleted underneath the capture or the DB context is wrong`);
    }

    // Double-checked: another caller may have already refreshed while we
    // waited for the row lock. Re-derive expiry from the LOCKED row, not the
    // pre-lock `connection` snapshot passed in.
    const lockedAccessExpiresAt = row.accessTokenExpiresAt?.getTime() ?? 0;
    if (row.accessTokenEncrypted && lockedAccessExpiresAt > now + ACCESS_TOKEN_REFRESH_BUFFER_MS) {
      const winnerAccessToken = decryptSecret(row.accessTokenEncrypted);
      // decryptSecret only returns null for a falsy input, which the truthy
      // check above already ruled out — this is a type-narrowing guard, not a
      // realistically reachable branch.
      if (!winnerAccessToken) {
        throw new Error(`getValidAccessToken: locked row's accessTokenEncrypted decrypted to empty (id=${connection.id})`);
      }
      return winnerAccessToken;
    }

    const lockedRefreshToken = row.refreshTokenEncrypted ? decryptSecret(row.refreshTokenEncrypted) : null;
    const lockedRefreshExpiresAt = row.refreshTokenExpiresAt?.getTime() ?? 0;
    if (!lockedRefreshToken || lockedRefreshExpiresAt <= now) {
      await markStatus(tx, connection.id, connection.partnerId, 'reauth_required', 'QuickBooks refresh token expired');
      throw new ReauthRequiredError();
    }

    try {
      const provider = getAccountingProvider(connection.provider);
      // QBO ROTATES the refresh token on every refresh — updateTokens persists the
      // returned refresh_token, not the old one. Dropping that write permanently
      // breaks the connection.
      const tokens = await runOutsideDbContext(() => provider.refresh(lockedRefreshToken));
      await updateTokens(tx, connection.id, connection.partnerId, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      });
      return tokens.accessToken;
    } catch (err) {
      if (err instanceof ReauthRequiredError) throw err;
      if (isInvalidGrant(err)) {
        // Preserve the underlying Intuit error for forensics before we flatten it
        // into the canned reauth status (without it, "why did this flip to
        // reauth_required" is undebuggable).
        console.error('[accounting] QuickBooks refresh returned invalid_grant', {
          connectionId: connection.id,
          partnerId: connection.partnerId,
          error: err instanceof Error ? err.message : String(err),
        });
        await markStatus(tx, connection.id, connection.partnerId, 'reauth_required', 'QuickBooks refresh token is invalid or expired');
        throw new ReauthRequiredError();
      }
      // Transient/unknown failure — propagate so it's retried and surfaced by the
      // global error handler, NOT misclassified as permanent reauth.
      throw err;
    }
  });
}
