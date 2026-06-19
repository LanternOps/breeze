import * as SecureStore from 'expo-secure-store';
import * as Sentry from '@sentry/react-native';
import type { User } from './api';
import { APPROVAL_CACHE_KEY, clearApprovalCacheOrThrow } from './approvalCache';

const TOKEN_KEY = 'breeze_auth_token';
const USER_KEY = 'breeze_user';
const BIOMETRIC_ENABLED_KEY = 'breeze_biometric_enabled';

/**
 * Store the authentication token securely
 */
export async function storeToken(token: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(TOKEN_KEY, token, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } catch (error) {
    console.error('Error storing token:', error);
    throw new Error('Failed to store authentication token');
  }
}

/**
 * Retrieve the stored authentication token
 */
export async function getStoredToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY);
  } catch (error) {
    console.error('Error retrieving token:', error);
    return null;
  }
}

/**
 * Store user data securely
 */
export async function storeUser(user: User): Promise<void> {
  try {
    await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } catch (error) {
    console.error('Error storing user:', error);
    throw new Error('Failed to store user data');
  }
}

/**
 * Retrieve the stored user data
 */
export async function getStoredUser(): Promise<User | null> {
  try {
    const userData = await SecureStore.getItemAsync(USER_KEY);
    if (userData) {
      return JSON.parse(userData) as User;
    }
    return null;
  } catch (error) {
    console.error('Error retrieving user:', error);
    return null;
  }
}

/**
 * Error thrown when one or more sensitive entries could not be wiped during
 * `clearAuthData`. Carries the list of keys that survived so callers / Sentry
 * can see exactly what leaked.
 *
 * Only ever constructed for a non-empty failure set — the `[string, ...string[]]`
 * parameter type makes `new SecureWipeError([])` a compile error, so an
 * "empty failure" instance is unrepresentable. We branch on `.name` rather than
 * `instanceof` at call sites because subclass `instanceof` is unreliable across
 * RN/Hermes bundles; `.name` is set explicitly here to keep that contract sound.
 */
export class SecureWipeError extends Error {
  readonly failedKeys: readonly string[];

  constructor(failedKeys: readonly [string, ...string[]], cause?: unknown) {
    super(
      `Failed to wipe sensitive SecureStore entries: ${failedKeys.join(', ')}`,
      cause !== undefined ? { cause } : undefined
    );
    this.name = 'SecureWipeError';
    this.failedKeys = [...failedKeys]; // defensive snapshot — not shared with the Sentry payload
  }
}

/**
 * Clear all authentication data.
 *
 * Also clears the persistent approvals cache (`breeze.approvals.cache.v1`).
 * The in-memory Redux reset (store/resettable.ts) drops session state on
 * sign-out, but the approval queue is additionally persisted to SecureStore
 * for offline cold-open. Without clearing it here, the next account signing in
 * on the same device would read the prior session's cached approvals — the
 * same cross-session leak the Redux logout reset in `store/resettable.ts`
 * closes for in-memory state.
 *
 * This is a security teardown, so a *partial* wipe must not be silently
 * swallowed: if a SecureStore delete throws (locked keychain, decrypt failure)
 * the surviving token / cache re-opens the cross-session leak while the user
 * lands on the signed-out screen. We therefore:
 *   - attempt every delete (no short-circuit), via `Promise.allSettled`;
 *   - report any failure to Sentry so it's observable on production builds
 *     where `console.*` goes nowhere a developer sees;
 *   - throw a `SecureWipeError` naming the surviving keys so callers can react
 *     (e.g. retry on next keychain-unlock) instead of assuming a clean wipe.
 */
export async function clearAuthData(): Promise<void> {
  const deletions: Array<{ key: string; run: () => Promise<unknown> }> = [
    { key: TOKEN_KEY, run: () => SecureStore.deleteItemAsync(TOKEN_KEY) },
    { key: USER_KEY, run: () => SecureStore.deleteItemAsync(USER_KEY) },
    { key: APPROVAL_CACHE_KEY, run: () => clearApprovalCacheOrThrow() },
  ];

  const results = await Promise.allSettled(deletions.map((d) => d.run()));

  const failures = results
    .map((result, i) => ({ result, key: deletions[i].key }))
    .filter(
      (entry): entry is { result: PromiseRejectedResult; key: string } =>
        entry.result.status === 'rejected'
    );

  const [firstFailure, ...restFailures] = failures;
  if (firstFailure === undefined) return;

  // Non-empty by construction (firstFailure is defined), so this satisfies the
  // SecureWipeError `[string, ...string[]]` non-empty tuple contract.
  const failedKeys: [string, ...string[]] = [
    firstFailure.key,
    ...restFailures.map((f) => f.key),
  ];
  const error = new SecureWipeError(failedKeys, firstFailure.result.reason);

  // Surface to telemetry — on a production RN build the per-helper console.*
  // logs go nowhere a developer sees, so without this the partial wipe is
  // invisible. Sentry is initialized in App.tsx.
  Sentry.captureException(error, {
    tags: { area: 'auth-teardown' },
    extra: { failedKeys },
  });

  throw error;
}

/**
 * Check if user is authenticated (has valid token)
 */
export async function isAuthenticated(): Promise<boolean> {
  const token = await getStoredToken();
  return !!token;
}

/**
 * Store the biometric preference
 */
export async function setBiometricPreference(enabled: boolean): Promise<void> {
  try {
    await SecureStore.setItemAsync(BIOMETRIC_ENABLED_KEY, enabled ? 'true' : 'false');
  } catch (error) {
    console.error('Error storing biometric preference:', error);
  }
}

/**
 * Get the biometric preference
 */
export async function getBiometricPreference(): Promise<boolean> {
  try {
    const value = await SecureStore.getItemAsync(BIOMETRIC_ENABLED_KEY);
    return value === 'true';
  } catch (error) {
    console.error('Error retrieving biometric preference:', error);
    return false;
  }
}
