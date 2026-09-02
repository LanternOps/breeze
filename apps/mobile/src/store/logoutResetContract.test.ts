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


// ── W06 (#3900) ────────────────────────────────────────────────────────────
describe('every slice is wiped on sign-out', () => {
  it('timeSuggestions is registered in combineReducers, so withLogoutReset clears it', async () => {
    // A slice missing from combineReducers leaks the previous account's
    // customer data — org names, device hostnames and ticket subjects all ride
    // along on a suggestion row.
    const { store } = await import('./index');
    expect(store.getState()).toHaveProperty('timeSuggestions');
  });

  it('a populated timeSuggestions slice returns to its initial state on LOGOUT', async () => {
    const { default: reducer, suggestionsLoaded, initialTimeSuggestionsState } =
      await import('./timeSuggestionsSlice');
    const populated = reducer(initialTimeSuggestionsState, suggestionsLoaded({
      enabled: true, date: '2026-08-29', timezone: 'UTC', unloggedCount: 1,
      suggestions: [{
        key: 'a', signals: [], startedAt: 'S', endedAt: 'E', durationMinutes: 45,
        device: { id: 'd1', hostname: 'CUSTOMER-PC' }, org: { id: 'o1', name: 'Acme' },
        quickSupport: null, candidateTicket: null, otherTickets: [],
        suggestedSource: 'remote_session', alreadyLoggedOverlapMinutes: 0,
      }],
    }));
    expect(populated.items).toHaveLength(1);

    const { withLogoutReset } = await import('./resettable');
    const { combineReducers } = await import('@reduxjs/toolkit');
    const root = withLogoutReset(combineReducers({ timeSuggestions: reducer }));
    const after = root({ timeSuggestions: populated }, { type: logout.type });
    expect(after.timeSuggestions).toEqual(initialTimeSuggestionsState);
  });

  // ── W10 (#4336) ──────────────────────────────────────────────────────────
  it('notificationPrefs is registered in combineReducers, so withLogoutReset clears it', async () => {
    // Push preferences are per USER, not per device: leaving the previous
    // account's slaScope in place would show the next technician on this phone
    // a setting that is not theirs, and the Settings sheet would happily PATCH
    // it back to the server under the new account.
    const { store } = await import('./index');
    expect(store.getState()).toHaveProperty('notificationPrefs');
  });

  it('a populated notificationPrefs slice returns to its initial state on LOGOUT', async () => {
    const { default: reducer, loadTicketPushPrefs } = await import('./notificationPrefsSlice');
    const initial = reducer(undefined, { type: '@@init' });
    const populated = reducer(
      initial,
      loadTicketPushPrefs.fulfilled({ assignedEnabled: false, slaScope: 'any' }, 'r', undefined)
    );
    expect(populated.prefs.slaScope).toBe('any');

    const { withLogoutReset } = await import('./resettable');
    const { combineReducers } = await import('@reduxjs/toolkit');
    const root = withLogoutReset(combineReducers({ notificationPrefs: reducer }));
    const after = root({ notificationPrefs: populated }, { type: logout.type });
    expect(after.notificationPrefs).toEqual(initial);
  });
});
