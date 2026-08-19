import * as SecureStore from 'expo-secure-store';

/**
 * Double-submit CSRF token handling for the native client.
 *
 * The server issues a random CSRF token as a NON-HttpOnly cookie
 * (`breeze_csrf_token`) alongside the HttpOnly refresh cookie, and expects the
 * same value echoed in the `x-breeze-csrf` header. `validateCookieCsrfRequest`
 * only accepts the literal `1` when the CSRF cookie is ABSENT — a compatibility
 * path for clients with no cookie access.
 *
 * React Native's networking layer keeps its own cookie store, so once login has
 * happened the cookie IS sent back. A client that keeps sending `1` then fails
 * the `safeCompareTokens` branch and every refresh is rejected, which ends the
 * session as soon as the access token expires.
 *
 * The cookie is deliberately not HttpOnly, so the correct fix is to read it
 * from the login response and echo the real value. This module owns that token.
 */

/** Canonical SecureStore key. Exported so the sign-out wipe reports the real
  * key it failed on rather than a copy that can drift. */
export const CSRF_TOKEN_KEY = 'breeze_csrf_token';
export const CSRF_COOKIE_NAME = 'breeze_csrf_token';
/** Sent only until a real token is known (the server's no-cookie path). */
export const CSRF_BOOTSTRAP_VALUE = '1';

let cached: string | null = null;

/**
 * What a `set-cookie` header says about our CSRF cookie.
 *
 * `cleared` matters as much as `set`: sign-out and rejected refreshes emit an
 * empty `Max-Age=0` cookie. Treating that as "no information" would leave a
 * stored token alive after the cookie jar dropped it, and the client would then
 * send a real-looking token with no cookie — which the server rejects, because
 * its no-cookie path accepts only the bootstrap literal. That would swap one
 * login loop for another.
 */
export type CsrfCookieSignal =
  | { kind: 'set'; token: string }
  | { kind: 'cleared' }
  | { kind: 'absent' };

/**
 * Read our cookie out of a `set-cookie` header.
 *
 * Several cookies can arrive folded into one value, so every occurrence is
 * scanned and the LAST wins — a clear followed by a re-set in one header must
 * resolve to the new token, not the clear.
 */
export function readCsrfCookie(setCookieHeader: string | null | undefined): CsrfCookieSignal {
  if (!setCookieHeader) return { kind: 'absent' };
  const pattern = new RegExp(`(?:^|[,;]\\s*)${CSRF_COOKIE_NAME}=([^;,\\s]*)`, 'g');
  let last: string | null = null;
  let seen = false;
  for (const match of setCookieHeader.matchAll(pattern)) {
    seen = true;
    last = match[1] ?? '';
  }
  if (!seen) return { kind: 'absent' };
  if (!last) return { kind: 'cleared' };
  try {
    return { kind: 'set', token: decodeURIComponent(last) };
  } catch {
    return { kind: 'set', token: last };
  }
}

/** Back-compat helper: the token, or null for cleared/absent. */
export function parseCsrfCookie(setCookieHeader: string | null | undefined): string | null {
  const signal = readCsrfCookie(setCookieHeader);
  return signal.kind === 'set' ? signal.token : null;
}

// Serialises SecureStore writes. Two responses can rotate the token
// concurrently; without this the writes can land out of order and persist an
// older token than the one the cookie jar holds.
let writeChain: Promise<unknown> = Promise.resolve();

function queueWrite(run: () => Promise<unknown>): Promise<void> {
  writeChain = writeChain.then(run, run);
  return writeChain.then(
    () => undefined,
    () => undefined
  );
}

/** Apply what a response said about the cookie. */
export async function applyCsrfSignal(signal: CsrfCookieSignal): Promise<void> {
  if (signal.kind === 'absent') return;
  if (signal.kind === 'cleared') {
    await forgetCsrfToken();
    return;
  }
  cached = signal.token;
  await queueWrite(() =>
    SecureStore.setItemAsync(CSRF_TOKEN_KEY, signal.token, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    })
  );
}

/** Persist a token. No-op for null. */
export async function rememberCsrfToken(token: string | null): Promise<void> {
  if (!token) return;
  await applyCsrfSignal({ kind: 'set', token });
}

/**
 * Drop the token so the next request falls back to the bootstrap literal.
 *
 * Used when the cookie is cleared, and when the server rejects our token —
 * the stored value can outlive its cookie (SecureStore survives an iOS
 * reinstall; the cookie jar does not), and bootstrapping is the only way back.
 */
export async function forgetCsrfToken(): Promise<void> {
  cached = null;
  await queueWrite(() => SecureStore.deleteItemAsync(CSRF_TOKEN_KEY));
}

/**
 * The value to send in `x-breeze-csrf`. Falls back to the bootstrap literal so
 * a first-run request (no cookie yet, no stored token) still takes the server's
 * no-cookie path rather than failing closed.
 */
export async function getCsrfHeaderValue(): Promise<string> {
  if (cached) return cached;
  try {
    const stored = await SecureStore.getItemAsync(CSRF_TOKEN_KEY);
    if (stored) {
      cached = stored;
      return stored;
    }
  } catch {
    // fall through to bootstrap
  }
  return CSRF_BOOTSTRAP_VALUE;
}

/**
 * Clear on sign-out so the next account does not inherit a stale token.
 *
 * Deliberately does NOT swallow the deletion failure: `clearAuthData` reports
 * surviving sensitive keys through `SecureWipeError`, and a silent catch here
 * would make a failed wipe look successful.
 */
export async function clearCsrfToken(): Promise<void> {
  cached = null;
  await SecureStore.deleteItemAsync(CSRF_TOKEN_KEY);
}

/** Test seam. */
export function __resetCsrfCacheForTests(): void {
  cached = null;
}
