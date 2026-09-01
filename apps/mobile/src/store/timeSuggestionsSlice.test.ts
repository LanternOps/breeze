import { describe, it, expect, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(), setItemAsync: vi.fn(), deleteItemAsync: vi.fn(),
}));
vi.mock('@sentry/react-native', () => ({
  captureException: vi.fn(), captureMessage: vi.fn(),
}));

import reducer, {
  initialTimeSuggestionsState,
  suggestionsLoaded,
  suggestionsFailed,
  suggestionsLoading,
  suggestionDismissed,
  suggestionRestored,
  suggestionConfirmed,
  suggestionSettled,
  suggestionsDisabled,
  dateChanged,
  selectSuggestions,
  selectUnloggedCount,
  selectSuggestionsEnabled,
  selectPendingKeys,
  type TimeSuggestionsState,
} from './timeSuggestionsSlice';
import type { TimeSuggestion } from '../services/timeSuggestions';

function suggestion(key: string, overrides: Partial<TimeSuggestion> = {}): TimeSuggestion {
  return {
    key,
    signals: [{ kind: 'remote_session', id: `${key}-sig`, type: 'terminal', startedAt: 'S', endedAt: 'E', precision: 'exact' }],
    startedAt: '2026-08-29T10:00:00.000Z',
    endedAt: '2026-08-29T10:45:00.000Z',
    durationMinutes: 45,
    device: null, org: null, quickSupport: null, candidateTicket: null, otherTickets: [],
    suggestedSource: 'remote_session',
    alreadyLoggedOverlapMinutes: 0,
    ...overrides,
  };
}

const loaded = (...keys: string[]): TimeSuggestionsState =>
  reducer(
    initialTimeSuggestionsState,
    suggestionsLoaded({ enabled: true, date: '2026-08-29', timezone: 'UTC', suggestions: keys.map((k) => suggestion(k)), unloggedCount: keys.length }),
  );

describe('fetch lifecycle', () => {
  it('stores items and enabled from the payload', () => {
    const state = loaded('a', 'b');
    expect(state.enabled).toBe(true);
    expect(state.items.map((i) => i.key)).toEqual(['a', 'b']);
    expect(state.unloggedCount).toBe(2);
    expect(state.status).toBe('ready');
    expect(state.lastFetchedAt).not.toBeNull();
  });

  it('enabled:false empties items so the entry points hide themselves (F10)', () => {
    const state = reducer(loaded('a', 'b'), suggestionsLoaded({
      enabled: false, date: '2026-08-29', timezone: 'UTC', suggestions: [suggestion('a')], unloggedCount: 1,
    }));
    // The server should not send rows with enabled:false, but if it ever does,
    // rendering them would offer an action the API will 403. Trust `enabled`.
    expect(state.enabled).toBe(false);
    expect(state.items).toEqual([]);
    expect(state.unloggedCount).toBe(0);
  });

  it('suggestionsDisabled (a 403 on drain, F10) empties the day without a refetch', () => {
    const state = reducer(loaded('a'), suggestionsDisabled());
    expect(state.enabled).toBe(false);
    expect(state.items).toEqual([]);
    expect(state.pendingKeys).toEqual([]);
  });

  it('records an error without discarding what is already on screen', () => {
    const state = reducer(loaded('a'), suggestionsFailed('offline'));
    expect(state.status).toBe('error');
    expect(state.error).toBe('offline');
    expect(state.items.map((i) => i.key)).toEqual(['a']);
  });

  it('loading clears a previous error but keeps the current items', () => {
    const state = reducer(reducer(loaded('a'), suggestionsFailed('offline')), suggestionsLoading());
    expect(state.status).toBe('loading');
    expect(state.error).toBeNull();
    expect(state.items).toHaveLength(1);
  });

  it('changing the date clears items so yesterday never renders under today', () => {
    const state = reducer(loaded('a'), dateChanged('2026-08-30'));
    expect(state.date).toBe('2026-08-30');
    expect(state.items).toEqual([]);
    expect(state.unloggedCount).toBe(0);
  });
});

describe('dismiss / undo', () => {
  it('removes the row optimistically and restores it when the thunk rejects', () => {
    const before = loaded('a', 'b');
    const dismissed = reducer(before, suggestionDismissed('a'));
    expect(dismissed.items.map((i) => i.key)).toEqual(['b']);
    expect(dismissed.unloggedCount).toBe(1);

    const restored = reducer(dismissed, suggestionRestored({ suggestion: suggestion('a'), index: 0 }));
    expect(restored.items.map((i) => i.key)).toEqual(['a', 'b']);
    expect(restored.unloggedCount).toBe(2);
  });

  it('restores the row at its ORIGINAL index, not the end of the list', () => {
    const before = loaded('a', 'b', 'c');
    const dismissed = reducer(before, suggestionDismissed('b'));
    const restored = reducer(dismissed, suggestionRestored({ suggestion: suggestion('b'), index: 1 }));
    expect(restored.items.map((i) => i.key)).toEqual(['a', 'b', 'c']);
  });

  it('dismissing a key that is not present is a no-op, not a negative count', () => {
    const state = reducer(loaded('a'), suggestionDismissed('nope'));
    expect(state.items).toHaveLength(1);
    expect(state.unloggedCount).toBe(1);
  });

  it('a restore never duplicates a row that is already back', () => {
    const dismissed = reducer(loaded('a', 'b'), suggestionDismissed('a'));
    const once = reducer(dismissed, suggestionRestored({ suggestion: suggestion('a'), index: 0 }));
    const twice = reducer(once, suggestionRestored({ suggestion: suggestion('a'), index: 0 }));
    expect(twice.items.map((i) => i.key)).toEqual(['a', 'b']);
  });
});

describe('confirm', () => {
  it('removes the row and marks the key pending until the queue drains', () => {
    const state = reducer(loaded('a', 'b'), suggestionConfirmed('a'));
    expect(state.items.map((i) => i.key)).toEqual(['b']);
    expect(state.pendingKeys).toEqual(['a']);
    expect(state.unloggedCount).toBe(1);
  });

  it('a replayed confirm (200) resolves the pending key without adding a second entry', () => {
    const confirmed = reducer(loaded('a'), suggestionConfirmed('a'));
    const settled = reducer(confirmed, suggestionSettled('a'));
    expect(settled.pendingKeys).toEqual([]);
    // The row is NOT re-added: the time is logged either way, and re-offering
    // it is exactly how the same window gets billed twice.
    expect(settled.items).toEqual([]);
  });

  it('settling a key twice is idempotent', () => {
    const confirmed = reducer(loaded('a'), suggestionConfirmed('a'));
    const once = reducer(confirmed, suggestionSettled('a'));
    expect(reducer(once, suggestionSettled('a')).pendingKeys).toEqual([]);
  });

  it('confirming the same key twice queues one pending key, not two', () => {
    const once = reducer(loaded('a'), suggestionConfirmed('a'));
    expect(reducer(once, suggestionConfirmed('a')).pendingKeys).toEqual(['a']);
  });

  it('a fetch that arrives while a confirm is pending does not re-offer the pending row', () => {
    // The server has not seen the queued confirm yet (the phone is offline), so
    // its list still contains the window. Re-adding it would let the technician
    // confirm the same minutes a second time.
    const confirmed = reducer(loaded('a', 'b'), suggestionConfirmed('a'));
    const refetched = reducer(confirmed, suggestionsLoaded({
      enabled: true, date: '2026-08-29', timezone: 'UTC',
      suggestions: [suggestion('a'), suggestion('b')], unloggedCount: 2,
    }));
    expect(refetched.items.map((i) => i.key)).toEqual(['b']);
    expect(refetched.pendingKeys).toEqual(['a']);
  });
});

describe('selectors', () => {
  const state = { timeSuggestions: loaded('a', 'b') };
  it('selectSuggestions returns the items', () => {
    expect(selectSuggestions(state).map((i) => i.key)).toEqual(['a', 'b']);
  });
  it('selectUnloggedCount returns the count', () => {
    expect(selectUnloggedCount(state)).toBe(2);
  });
  it('selectSuggestionsEnabled returns the flag', () => {
    expect(selectSuggestionsEnabled(state)).toBe(true);
  });
  it('selectPendingKeys returns the pending set', () => {
    expect(selectPendingKeys({ timeSuggestions: reducer(loaded('a'), suggestionConfirmed('a')) })).toEqual(['a']);
  });
});
