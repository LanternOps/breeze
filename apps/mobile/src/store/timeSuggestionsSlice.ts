import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import type { ListSuggestionsResult, TimeSuggestion } from '../services/timeSuggestions';

/**
 * W06 (#3900). Auto-suggested time entries for one day.
 *
 * The invariant this slice exists to hold: a window the technician has already
 * acted on is never re-offered. Confirms leave the phone through the offline
 * queue, so the server's list can still contain a window whose confirm is
 * queued locally — `pendingKeys` is what stops that row coming back and being
 * billed twice.
 */

export type SuggestionsStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface TimeSuggestionsState {
  /** The partner's sessionSuggestions setting, as the server last reported it. */
  enabled: boolean;
  date: string | null;
  items: TimeSuggestion[];
  unloggedCount: number;
  status: SuggestionsStatus;
  /** Keys whose confirm is queued but not yet acknowledged by the server. */
  pendingKeys: string[];
  lastFetchedAt: string | null;
  error: string | null;
}

export const initialTimeSuggestionsState: TimeSuggestionsState = {
  enabled: false,
  date: null,
  items: [],
  unloggedCount: 0,
  status: 'idle',
  pendingKeys: [],
  lastFetchedAt: null,
  error: null,
};

const timeSuggestionsSlice = createSlice({
  name: 'timeSuggestions',
  initialState: initialTimeSuggestionsState,
  reducers: {
    suggestionsLoading(state) {
      state.status = 'loading';
      state.error = null;
    },

    suggestionsLoaded(state, action: PayloadAction<ListSuggestionsResult>) {
      const { enabled, date, suggestions, unloggedCount } = action.payload;
      state.status = 'ready';
      state.error = null;
      state.enabled = enabled;
      state.date = date;
      state.lastFetchedAt = new Date().toISOString();

      if (!enabled) {
        // Rendering rows while the flag is off would offer an action the API
        // answers with 403. `enabled` is the authority, not the array.
        state.items = [];
        state.unloggedCount = 0;
        state.pendingKeys = [];
        return;
      }

      // Drop anything whose confirm is already queued: the server has not seen
      // that write yet, so its list still contains the window.
      const pending = new Set(state.pendingKeys);
      const visible = suggestions.filter((item) => !pending.has(item.key));
      state.items = visible;
      state.unloggedCount = unloggedCount - (suggestions.length - visible.length);
    },

    suggestionsFailed(state, action: PayloadAction<string>) {
      // Deliberately keeps `items`: a failed refresh should not blank a list the
      // technician is reading.
      state.status = 'error';
      state.error = action.payload;
    },

    /** F10: a 403 on drain means the partner turned the feature off. */
    suggestionsDisabled(state) {
      state.enabled = false;
      state.items = [];
      state.unloggedCount = 0;
      state.pendingKeys = [];
    },

    dateChanged(state, action: PayloadAction<string>) {
      if (state.date === action.payload) return;
      state.date = action.payload;
      state.items = [];
      state.unloggedCount = 0;
      state.status = 'idle';
    },

    suggestionDismissed(state, action: PayloadAction<string>) {
      const index = state.items.findIndex((item) => item.key === action.payload);
      if (index === -1) return;
      state.items.splice(index, 1);
      state.unloggedCount = Math.max(0, state.unloggedCount - 1);
    },

    /** Undo for a dismiss the server rejected — restored where it was. */
    suggestionRestored(state, action: PayloadAction<{ suggestion: TimeSuggestion; index: number }>) {
      const { suggestion, index } = action.payload;
      if (state.items.some((item) => item.key === suggestion.key)) return;
      state.items.splice(Math.max(0, Math.min(index, state.items.length)), 0, suggestion);
      state.unloggedCount += 1;
    },

    suggestionConfirmed(state, action: PayloadAction<string>) {
      const key = action.payload;
      const index = state.items.findIndex((item) => item.key === key);
      if (index !== -1) {
        state.items.splice(index, 1);
        state.unloggedCount = Math.max(0, state.unloggedCount - 1);
      }
      if (!state.pendingKeys.includes(key)) state.pendingKeys.push(key);
    },

    /**
     * The server acknowledged the confirm — 201 (fresh) or 200 (the ledger
     * already held it). Both are settled; neither re-offers the row.
     */
    suggestionSettled(state, action: PayloadAction<string>) {
      state.pendingKeys = state.pendingKeys.filter((key) => key !== action.payload);
    },
  },
});

export const {
  suggestionsLoading,
  suggestionsLoaded,
  suggestionsFailed,
  suggestionsDisabled,
  dateChanged,
  suggestionDismissed,
  suggestionRestored,
  suggestionConfirmed,
  suggestionSettled,
} = timeSuggestionsSlice.actions;

export default timeSuggestionsSlice.reducer;

type RootLike = { timeSuggestions: TimeSuggestionsState };

export const selectSuggestions = (state: RootLike): TimeSuggestion[] => state.timeSuggestions.items;
export const selectUnloggedCount = (state: RootLike): number => state.timeSuggestions.unloggedCount;
export const selectSuggestionsEnabled = (state: RootLike): boolean => state.timeSuggestions.enabled;
export const selectPendingKeys = (state: RootLike): string[] => state.timeSuggestions.pendingKeys;
export const selectSuggestionsStatus = (state: RootLike): SuggestionsStatus => state.timeSuggestions.status;
export const selectSuggestionsError = (state: RootLike): string | null => state.timeSuggestions.error;
