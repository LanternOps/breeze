import { runOutsideDbContext } from '../../db';
import type { AccountingConnection, DbExecutor } from './accountingConnectionService';
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

export async function getValidAccessToken(db: DbExecutor, connection: AccountingConnection): Promise<string> {
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

  // NOTE (Phase D follow-up): no per-connection lock yet. Two concurrent callers
  // could both refresh; the second persist wins. Acceptable on the on-demand
  // request path (single caller); add SELECT ... FOR UPDATE when a background
  // sync worker can refresh concurrently.
  try {
    const provider = getAccountingProvider(connection.provider);
    // QBO ROTATES the refresh token on every refresh — updateTokens persists the
    // returned refresh_token, not the old one. Dropping that write permanently
    // breaks the connection.
    const tokens = await runOutsideDbContext(() => provider.refresh(connection.refreshToken!));
    await updateTokens(db, connection.id, connection.partnerId, {
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
      await markStatus(db, connection.id, connection.partnerId, 'reauth_required', 'QuickBooks refresh token is invalid or expired');
      throw new ReauthRequiredError();
    }
    // Transient/unknown failure — propagate so it's retried and surfaced by the
    // global error handler, NOT misclassified as permanent reauth.
    throw err;
  }
}
