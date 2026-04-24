/**
 * OAuth-scoped error logger.
 *
 * Project convention: there is no project-wide `logError`/`ERROR_IDS` registry
 * (we checked — none exists). The closest analogue is `captureException` in
 * `services/sentry.ts`, which is wired to Sentry when `SENTRY_DSN` is set.
 *
 * For the OAuth surface we want stable error IDs so on-call can grep both
 * stderr and Sentry by a single token. This wrapper:
 *   1. Writes a single-line JSON record to stderr (visible in `docker logs`)
 *      with `errorId`, `message`, and `context` fields.
 *   2. Forwards to `captureException` so the same errorId surfaces in Sentry
 *      as a tag.
 *
 * Keeping this OAuth-local rather than promoting it to a shared utility for
 * now — the broader project may want to standardise on a single shape later,
 * but inventing a project-wide convention from inside an OAuth fix would be
 * out of scope.
 */
import * as Sentry from '@sentry/node';
import { captureException, isSentryEnabled } from '../services/sentry';

export const ERROR_IDS = {
  OAUTH_GRANT_META_PERSIST_FAILED: 'OAUTH_GRANT_META_PERSIST_FAILED',
  OAUTH_GRANT_META_LOOKUP_FAILED: 'OAUTH_GRANT_META_LOOKUP_FAILED',
  OAUTH_REVOCATION_CACHE_WRITE_FAILED: 'OAUTH_REVOCATION_CACHE_WRITE_FAILED',
  OAUTH_PROVIDER_SERVER_ERROR: 'OAUTH_PROVIDER_SERVER_ERROR',
  OAUTH_PROVIDER_AUTHORIZATION_ERROR: 'OAUTH_PROVIDER_AUTHORIZATION_ERROR',
  OAUTH_PROVIDER_GRANT_ERROR: 'OAUTH_PROVIDER_GRANT_ERROR',
  OAUTH_BRIDGE_RESPONSE_ERROR: 'OAUTH_BRIDGE_RESPONSE_ERROR',
  OAUTH_BRIDGE_CALLBACK_THREW: 'OAUTH_BRIDGE_CALLBACK_THREW',
  OAUTH_INTERACTION_FIND_FAILED: 'OAUTH_INTERACTION_FIND_FAILED',
  OAUTH_REVOCATION_UNVERIFIABLE_JWT: 'OAUTH_REVOCATION_UNVERIFIABLE_JWT',
  OAUTH_REVOCATION_VERIFY_FAILED: 'OAUTH_REVOCATION_VERIFY_FAILED',
  OAUTH_REVOCATION_CLIENT_BINDING: 'OAUTH_REVOCATION_CLIENT_BINDING',
  OAUTH_REVOCATION_CACHE_WRITE: 'OAUTH_REVOCATION_CACHE_WRITE',
  OAUTH_REVOCATION_GRANT_WRITE: 'OAUTH_REVOCATION_GRANT_WRITE',
  OAUTH_REVOCATION_BODY_PARSE: 'OAUTH_REVOCATION_BODY_PARSE',
  OAUTH_SESSION_NOT_FOUND_BY_UID: 'OAUTH_SESSION_NOT_FOUND_BY_UID',
} as const;

export type OAuthErrorId = typeof ERROR_IDS[keyof typeof ERROR_IDS];

export function logOauthError(args: {
  errorId: OAuthErrorId;
  message: string;
  err?: unknown;
  context?: Record<string, unknown>;
}): void {
  const { errorId, message, err, context } = args;
  // stderr line — keep structured but human-greppable.
  // eslint-disable-next-line no-console
  console.error(`[oauth] ${errorId} ${message}`, {
    ...(context ?? {}),
    error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
  });
  if (isSentryEnabled()) {
    const captured = err instanceof Error ? err : new Error(message);
    Sentry.withScope((scope) => {
      scope.setTag('errorId', errorId);
      scope.setTag('component', 'oauth');
      if (context) scope.setContext('oauth', context);
      captureException(captured);
    });
  }
}

export function logOauthDebug(args: {
  errorId: OAuthErrorId;
  message: string;
  context?: Record<string, unknown>;
}): void {
  if (process.env.LOG_LEVEL === 'debug' || process.env.OAUTH_DEBUG === '1') {
    // eslint-disable-next-line no-console
    console.debug(`[oauth] ${args.errorId} ${args.message}`, args.context ?? {});
  }
}
