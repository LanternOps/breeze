import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';

import {
  getTicketPushPrefs,
  TICKET_PUSH_PREFERENCE_DEFAULTS,
  updateTicketPushPrefs,
  type TicketPushPreferences,
  type UpdateTicketPushPreferences,
} from '../services/ticketPushPrefs';

/**
 * W10 (#4336). The technician's ticket push preferences.
 *
 * Saves are optimistic with a rollback: these controls are switches, and a
 * switch that waits on a round-trip before moving reads as broken on a slow
 * link. The cost is that a failed save must put the old value back — leaving
 * the optimistic one on screen would tell the technician they had turned SLA
 * pushes on for every ticket when the server still has `owned`.
 */
export interface NotificationPrefsState {
  prefs: TicketPushPreferences;
  status: 'idle' | 'loading' | 'ready' | 'error';
  saving: boolean;
  /** Snapshot taken on save.pending so save.rejected can restore it. */
  rollback: TicketPushPreferences | null;
  error: string | null;
}

const initialState: NotificationPrefsState = {
  prefs: { ...TICKET_PUSH_PREFERENCE_DEFAULTS },
  status: 'idle',
  saving: false,
  rollback: null,
  error: null,
};

function messageOf(err: unknown, fallback: string): string {
  return (err as { message?: string } | null)?.message ?? fallback;
}

export const loadTicketPushPrefs = createAsyncThunk(
  'notificationPrefs/load',
  async (_: void, { rejectWithValue }) => {
    try {
      return await getTicketPushPrefs();
    } catch (err: unknown) {
      return rejectWithValue(messageOf(err, 'Failed to load notification settings'));
    }
  }
);

export const saveTicketPushPrefs = createAsyncThunk(
  'notificationPrefs/save',
  async (patch: UpdateTicketPushPreferences, { rejectWithValue }) => {
    try {
      return await updateTicketPushPrefs(patch);
    } catch (err: unknown) {
      return rejectWithValue(messageOf(err, 'Failed to save notification settings'));
    }
  }
);

const notificationPrefsSlice = createSlice({
  name: 'notificationPrefs',
  initialState,
  reducers: {
    clearError: (state) => {
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadTicketPushPrefs.pending, (state) => {
        state.status = 'loading';
      })
      .addCase(loadTicketPushPrefs.fulfilled, (state, action) => {
        state.prefs = action.payload;
        state.status = 'ready';
        state.error = null;
      })
      .addCase(loadTicketPushPrefs.rejected, (state, action) => {
        // Deliberately leaves `prefs` alone: a failed refresh must not silently
        // reset the values the technician is currently looking at.
        state.status = 'error';
        state.error = (action.payload as string) ?? action.error.message ?? 'Failed to load';
      })
      .addCase(saveTicketPushPrefs.pending, (state, action) => {
        state.rollback = { ...state.prefs };
        state.prefs = { ...state.prefs, ...action.meta.arg };
        state.saving = true;
        state.error = null;
      })
      .addCase(saveTicketPushPrefs.fulfilled, (state, action) => {
        // Adopt the echo rather than keeping the optimistic value: the server
        // is the authority on what was actually stored.
        state.prefs = action.payload;
        state.saving = false;
        state.rollback = null;
        state.status = 'ready';
      })
      .addCase(saveTicketPushPrefs.rejected, (state, action) => {
        if (state.rollback) state.prefs = state.rollback;
        state.rollback = null;
        state.saving = false;
        state.error = (action.payload as string) ?? action.error.message ?? 'Failed to save';
      });
  },
});

export const { clearError } = notificationPrefsSlice.actions;
export default notificationPrefsSlice.reducer;

export const selectTicketPushPrefs = (state: { notificationPrefs: NotificationPrefsState }) =>
  state.notificationPrefs.prefs;
export const selectTicketPushPrefsSaving = (state: { notificationPrefs: NotificationPrefsState }) =>
  state.notificationPrefs.saving;
export const selectTicketPushPrefsError = (state: { notificationPrefs: NotificationPrefsState }) =>
  state.notificationPrefs.error;
