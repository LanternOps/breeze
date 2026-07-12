import type { Reducer, UnknownAction } from '@reduxjs/toolkit';

/**
 * Action types emitted on sign-out. Must cover EVERY terminal sign-out state
 * that `authSlice` treats as logged-out, otherwise the non-auth slices leak
 * into the next session on the paths this set misses:
 *   - `auth/logout`            — synchronous reducer (e.g. RootNavigator on a 401)
 *   - `auth/logout/fulfilled`  — `logoutAsync` thunk, API logout succeeded
 *   - `auth/logout/rejected`   — `logoutAsync` thunk, API logout FAILED but the
 *                                rejected reducer still nulls user/token (and
 *                                `clearAuthData()` runs in the catch), so the user
 *                                is signed out — e.g. the `device_blocked` /
 *                                network-failure path dispatched from RootNavigator.
 *
 * Keep this in lockstep with `authSlice`'s logout reducers. These are string
 * literals (not the thunk's generated `.type` constants) on purpose: this module
 * is deliberately RN-free so it can be unit-tested without importing the auth
 * slice, which pulls in expo-secure-store.
 */
export const LOGOUT_ACTION_TYPES: ReadonlySet<string> = new Set([
  'auth/logout',
  'auth/logout/fulfilled',
  'auth/logout/rejected',
  'auth/requireReauthentication',
]);

/**
 * Wraps the app's combined reducer so that ALL slice state is wiped on
 * sign-out. Without this, only the auth slice resets and the previous
 * session's data — AI chat history, alerts, pending approvals — lingers in
 * memory and leaks into the next sign-in (notably when switching
 * servers/accounts, since the app isn't restarted). Passing `undefined` makes
 * every slice re-initialise from its own initialState.
 *
 * Kept in its own RN-free module so it can be unit-tested without importing
 * the real store (whose auth slice pulls in expo-secure-store).
 */
export function withLogoutReset<S>(appReducer: Reducer<S>): Reducer<S> {
  return (state: S | undefined, action: UnknownAction) =>
    appReducer(LOGOUT_ACTION_TYPES.has(action.type) ? undefined : state, action);
}
