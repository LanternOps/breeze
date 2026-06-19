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
 * Remove the stored authentication token
 */
export async function removeToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch (error) {
    console.error('Error removing token:', error);
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
 * Remove the stored user data
 */
export async function removeUser(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(USER_KEY);
  } catch (error) {
    console.error('Error removing user:', error);
  }
}

/**
 * Error thrown when one or more sensitive entries could not be wiped during
 * `clearAuthData`. Carries the list of keys that survived so callers / Sentry
 * can see exactly what leaked.
 */
export class SecureWipeError extends Error {
  readonly failedKeys: string[];

  constructor(failedKeys: string[], cause?: unknown) {
    super(`Failed to wipe sensitive SecureStore entries: ${failedKeys.join(', ')}`);
    this.name = 'SecureWipeError';
    this.failedKeys = failedKeys;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
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

  if (failures.length === 0) return;

  const failedKeys = failures.map((f) => f.key);
  const firstReason = failures[0].result.reason;
  const error = new SecureWipeError(failedKeys, firstReason);

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
