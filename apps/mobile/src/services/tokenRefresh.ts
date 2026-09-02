import * as Sentry from '@sentry/react-native';
import type { ApiError } from './api';
import { refreshToken } from './api';
import { storeToken } from './auth';
import { commitIfCurrent, currentSessionGeneration } from './sessionGeneration';

/**
 * The one place the mobile app refreshes its access token.
 *
 * Lives in its own module rather than in api.ts so that api.ts (the request
 * core, which calls this on a 401) and aiChat.ts (which reopens its SSE stream
 * on a 401) share exactly one in-flight refresh, and so tests of either caller
 * can mock `./api`'s low-level `refreshToken` while exercising this logic for
 * real.
 */
// Single-flight guard so N concurrent 401s trigger one /auth/refresh, not N.
// Cleared once the refresh settles; callers that grabbed the promise still
// receive its result. /auth/refresh rotates the refresh cookie and replaying a
// rotated token revokes the whole token family, which is why this lives here,
// shared by every caller, rather than per service.
let refreshInFlight: Promise<string | null> | null = null;

/**
 * Refresh the access token and persist it so every reader of the token key
 * picks it up. Returns the new token, or null when refresh failed (expired
 * refresh cookie, offline, /auth/refresh outage) or the session was superseded
 * meanwhile; callers then surface their original 401. Never throws.
 */
export async function refreshAccessToken(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const generation = currentSessionGeneration();
      try {
        const { token } = await refreshToken();
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
            statusCode: (e as ApiError)?.statusCode,
            message: (e as ApiError)?.message ?? String(e),
          },
        });
        return null;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}
