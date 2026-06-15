import { describe, it, expect } from 'vitest';
import { combineReducers } from '@reduxjs/toolkit';

import { withLogoutReset, LOGOUT_ACTION_TYPES } from './resettable';
import aiChatReducer, { addUserMessage } from './aiChatSlice';

/**
 * Regression for the cross-session data leak: on sign-out only the auth slice
 * used to reset, so the previous server/account's AI chat history (and alerts /
 * pending approvals) lingered in memory and surfaced under the next sign-in.
 *
 * Composed here with the real (pure) aiChat reducer — importing the full store
 * would pull expo-secure-store via the auth slice, which the node-only vitest
 * runtime can't parse.
 */
describe('withLogoutReset', () => {
  const reducer = withLogoutReset(combineReducers({ aiChat: aiChatReducer }));

  const seed = () =>
    reducer(
      undefined,
      addUserMessage({ id: 'm1', content: 'secret from previous server', sentAt: '2026-06-15T00:00:00.000Z' }),
    );

  it('clears slice state on the synchronous logout action', () => {
    const populated = seed();
    expect(populated.aiChat.messages).toHaveLength(1);

    const after = reducer(populated, { type: 'auth/logout' });

    expect(after.aiChat.messages).toEqual([]);
    expect(after.aiChat.sessionId).toBeNull();
  });

  it('also resets on the logoutAsync.fulfilled action type', () => {
    const populated = seed();
    expect(populated.aiChat.messages.length).toBeGreaterThan(0);

    const after = reducer(populated, { type: 'auth/logout/fulfilled' });

    expect(after.aiChat.messages).toEqual([]);
  });

  it('leaves state untouched for non-logout actions', () => {
    const populated = seed();

    const after = reducer(populated, { type: 'some/unrelated/action' });

    expect(after.aiChat.messages).toHaveLength(1);
  });

  it('covers exactly the two sign-out action types', () => {
    expect([...LOGOUT_ACTION_TYPES].sort()).toEqual(['auth/logout', 'auth/logout/fulfilled']);
  });
});
