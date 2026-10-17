import { createHash } from 'node:crypto';
import { ERROR_IDS, logOauthDebug, logOauthError, logOauthWarn } from './log';

/**
 * Logger for oidc-provider's `grant.error` event (token endpoint failures).
 *
 * Two problems with logging every failure as a bare error:
 *   1. No attribution. The event carried only `invalid_grant` + detail, so a
 *      client looping on a dead refresh token (one third-party agent sent
 *      ~750/hour for days) could only be identified by hashing client ids
 *      against Redis rate-limit keys. Every line now names the client, the
 *      grant type, a non-reversible hash of the presented token (same
 *      `sha256(raw).slice(0, 16)` shape as OAUTH_REFRESH_TOKEN_REUSE so the
 *      two correlate) and the user agent.
 *   2. Volume. These are client errors and repeat for as long as the client
 *      loops, so each (client, error, detail) emits at most one warn line per
 *      window, carrying the count it suppressed since the previous line.
 *
 * Exceptions: details that indicate a token presented by the wrong party
 * (another client's refresh token, a sender-constrained token without its
 * key) stay at error level and are never throttled. Normal clients do not
 * produce them, and the adapter's reuse detection does not see them because
 * the token row itself is valid.
 *
 * `grant.error` only ever receives exposed 4xx errors; oidc-provider routes
 * 5xx to `server_error` instead, whose listener uses `grantErrorContext` for
 * the same attribution.
 *
 * Throttle state is process-local and bounded; each replica throttles on its
 * own, which is fine for a log budget.
 */

export const GRANT_ERROR_LOG_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_MAX_KEYS = 1000;
// client_id / grant_type come from the request body when client auth fails,
// so they are attacker-controlled; cap them like the user agent.
const MAX_LOGGED_CHARS = 128;

const TOKEN_MISUSE_DETAILS = new Set([
  'client mismatch',
  'failed jkt verification',
  'failed x5t#S256 verification',
]);

type GrantErrorLike = {
  error?: unknown;
  error_detail?: unknown;
};

type ProviderCtxLike = {
  oidc?: {
    client?: { clientId?: unknown } | null;
    params?: Record<string, unknown> | null;
  } | null;
  get?: (name: string) => string | undefined;
};

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function capped(value: unknown): string | null {
  return str(value)?.slice(0, MAX_LOGGED_CHARS) ?? null;
}

function tokenHash(raw: string | null): string | null {
  return raw ? createHash('sha256').update(raw).digest('hex').slice(0, 16) : null;
}

type GrantErrorContext = {
  grant_type: string | null;
  client_id: string | null;
  /** true only when client_id came from the provider's authenticated client; false = raw request-body fallback. */
  client_resolved: boolean;
  token_hash: string | null;
  user_agent: string | null;
};

const EMPTY_CONTEXT: GrantErrorContext = { grant_type: null, client_id: null, client_resolved: false, token_hash: null, user_agent: null };

/**
 * Attribution fields for a token-endpoint failure. Never includes a raw token.
 * Never throws: it runs inside oidc-provider event listeners, where a throw
 * would escape into the provider's error handling.
 */
export function grantErrorContext(ctx: unknown): GrantErrorContext {
  try {
    return readGrantErrorContext(ctx);
  } catch {
    return EMPTY_CONTEXT;
  }
}

function readGrantErrorContext(ctx: unknown): GrantErrorContext {
  const c = (ctx ?? {}) as ProviderCtxLike;
  const params = c.oidc?.params ?? {};
  const grantType = capped(params.grant_type);
  const presented = grantType === 'authorization_code' ? str(params.code) : str(params.refresh_token);
  let userAgent: string | null = null;
  try {
    userAgent = capped(c.get?.('user-agent'));
  } catch {
    userAgent = null;
  }
  const resolvedClientId = capped(c.oidc?.client?.clientId);
  return {
    grant_type: grantType,
    client_id: resolvedClientId ?? capped(params.client_id),
    client_resolved: resolvedClientId !== null,
    token_hash: tokenHash(presented),
    user_agent: userAgent,
  };
}

export function createGrantErrorLogger(opts: {
  now?: () => number;
  windowMs?: number;
  maxKeys?: number;
  /**
   * Called for every `invalid_grant: refresh token not found` from an
   * AUTHENTICATED client, before throttling (so suppressed repeats count too).
   * Feeds the connection-health "still retrying" counter (W4). Unresolved
   * client ids come from the request body and are never reported. Must not
   * block; a throw is swallowed.
   */
  onRefreshTokenNotFound?: (clientId: string) => void;
} = {}) {
  const now = opts.now ?? Date.now;
  const windowMs = opts.windowMs ?? GRANT_ERROR_LOG_WINDOW_MS;
  const maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
  // Insertion-ordered: the first key is the oldest, evicted first.
  const windows = new Map<string, { startedAt: number; suppressed: number }>();

  return function logGrantError(ctx: unknown, err: unknown): void {
    const e = (err ?? {}) as GrantErrorLike;
    const context = {
      error: capped(e.error),
      detail: capped(e.error_detail),
      ...grantErrorContext(ctx),
    };

    if (
      opts.onRefreshTokenNotFound
      && context.client_resolved
      && context.client_id
      && context.grant_type === 'refresh_token'
      && context.error === 'invalid_grant'
      && context.detail === 'refresh token not found'
    ) {
      try {
        opts.onRefreshTokenNotFound(context.client_id);
      } catch {
        // Decoration only; never let it break the provider's error handling.
      }
    }

    if (context.detail && TOKEN_MISUSE_DETAILS.has(context.detail)) {
      logOauthError({
        errorId: ERROR_IDS.OAUTH_PROVIDER_GRANT_ERROR,
        message: 'oidc-provider grant.error (token presented by the wrong party)',
        context,
      });
      return;
    }

    const key = `${context.client_id ?? '-'}|${context.client_resolved ? 1 : 0}|${context.error ?? '-'}|${context.detail ?? '-'}`;
    const at = now();
    const current = windows.get(key);
    if (current && at - current.startedAt < windowMs) {
      current.suppressed += 1;
      logOauthDebug({
        errorId: ERROR_IDS.OAUTH_PROVIDER_GRANT_ERROR,
        message: 'oidc-provider grant.error (suppressed repeat)',
        context,
      });
      return;
    }

    const suppressed = current?.suppressed ?? 0;
    windows.delete(key);
    windows.set(key, { startedAt: at, suppressed: 0 });
    while (windows.size > maxKeys) {
      const oldest = windows.keys().next().value;
      if (oldest === undefined) break;
      windows.delete(oldest);
    }
    logOauthWarn({
      errorId: ERROR_IDS.OAUTH_PROVIDER_GRANT_ERROR,
      message: 'oidc-provider grant.error',
      context: { ...context, suppressed },
    });
  };
}
