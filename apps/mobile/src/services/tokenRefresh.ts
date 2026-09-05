import * as Sentry from '@sentry/react-native';
import { storeToken } from './auth';
import { commitIfCurrent, currentSessionGeneration } from './sessionGeneration';

/**
 * The one place the mobile app refreshes its access token.
 *
 * A factory rather than a module-level function so this file does not import
 * api.ts (which imports it): api.ts builds the one shared instance from its
 * own `refreshToken`, and the request core and aiChat's SSE stream both use
 * that instance, so there is exactly one in-flight refresh app-wide. Tests of
 * either caller can hand the factory a mocked `refresh` and still exercise
 * this logic for real.
 */
type RefreshFailure = { statusCode?: number; message?: string } | null | undefined;

export function createTokenRefresher(
  refresh: () => Promise<{ token: string }>
): () => Promise<string | null> {
  // Single-flight guard so N concurrent 401s trigger one /auth/refresh, not N.
  // Cleared once the refresh settles; callers that grabbed the promise still
  // receive its result. /auth/refresh rotates the refresh cookie and replaying
  // a rotated token revokes the whole token family.
  let refreshInFlight: Promise<string | null> | null = null;

  /**
   * Refresh the access token and persist it so every reader of the token key
   * picks it up. Returns the new token, or null when refresh failed (expired
   * refresh cookie, offline, /auth/refresh outage) or the session was
   * superseded meanwhile; callers then surface their original 401. Never throws.
   */
  return async function refreshAccessToken(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const generation = currentSessionGeneration();
      try {
        const { token } = await refresh();
        try {
          const committed = await commitIfCurrent(generation, async () => {
            await storeToken(token);
            return token;
          });
          if (committed === undefined) return null;
        } catch (e) {
          // Persisting failed (locked keychain, etc.). The in-memory token is
          // still valid for the retry, so don't turn a usable refresh into a
          // hard failure, but make the cause observable: a phone that cannot
          // persist tokens refreshes on every request.
          Sentry.captureException(e, {
            tags: { area: 'token-refresh' },
            extra: { stage: 'persist' },
          });
          if (generation !== currentSessionGeneration()) return null;
        }
        if (generation !== currentSessionGeneration()) return null;
        return token;
      } catch (e) {
        Sentry.captureMessage('token refresh failed', {
          level: 'warning',
          tags: { area: 'token-refresh' },
          extra: {
            statusCode: (e as RefreshFailure)?.statusCode,
            message: (e as RefreshFailure)?.message ?? String(e),
          },
        });
        return null;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
  };
}
