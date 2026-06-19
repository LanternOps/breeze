import { describe, it, expect, vi } from 'vitest';

// authSlice transitively imports services/auth + services/api, whose only
// RN-specific dependency is expo-secure-store. Mocking it lets this test cross
// the boundary `resettable.ts` deliberately avoids — so we can assert the
// hand-maintained LOGOUT_ACTION_TYPES set stays in lockstep with the action
// types authSlice actually generates. This is the enforced version of the
// "keep this in lockstep with authSlice" comment in resettable.ts.
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
// authSlice now also imports @sentry/react-native (logout telemetry); mock it
// so importing the slice doesn't pull the react-native runtime into the
// node-only vitest environment.
vi.mock('@sentry/react-native', () => ({
  captureException: vi.fn(),
}));

import { LOGOUT_ACTION_TYPES } from './resettable';
import { logout, logoutAsync } from './authSlice';

describe('LOGOUT_ACTION_TYPES <-> authSlice contract', () => {
  it('covers exactly the terminal sign-out action types authSlice emits', () => {
    // Both directions of drift: a rename in authSlice makes membership fail;
    // a stale literal left in resettable makes the equality fail.
    const terminalSignOutTypes = [
      logout.type, // synchronous reducer
      logoutAsync.fulfilled.type, // API logout succeeded
      logoutAsync.rejected.type, // API logout failed, but user/token nulled anyway
    ].sort();

    expect([...LOGOUT_ACTION_TYPES].sort()).toEqual(terminalSignOutTypes);
  });

  it('does NOT reset on logoutAsync.pending (not yet signed out)', () => {
    // pending fires before the session is cleared — resetting here would wipe
    // state mid-logout. Guards against accidentally widening the set.
    expect(LOGOUT_ACTION_TYPES.has(logoutAsync.pending.type)).toBe(false);
  });
});
