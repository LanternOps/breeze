import type { Reducer, UnknownAction } from '@reduxjs/toolkit';

/**
 * Action types emitted on sign-out: the synchronous `logout` reducer (e.g.
 * RootNavigator on a 401) and the `logoutAsync` thunk's fulfilled case.
 */
export const LOGOUT_ACTION_TYPES: ReadonlySet<string> = new Set([
  'auth/logout',
  'auth/logout/fulfilled',
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
