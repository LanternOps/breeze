import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';

import {
  getWispNudgePrefs,
  updateWispNudgePrefs,
  WISP_NUDGE_PREFERENCE_DEFAULTS,
  type UpdateWispNudgePreferences,
  type WispNudgePreferences,
} from '../services/wispNudgePrefs';

/**
 * Wisp (W06c). The person's Wisp nudge preferences.
 *
 * Mirrors `notificationPrefsSlice`: saves are optimistic with a rollback, and
 * at most one save is outstanding (the `condition` below) so the single
 * `rollback` slot stays truthful.
 */
export interface WispPrefsState {
  prefs: WispNudgePreferences;
  status: 'idle' | 'loading' | 'ready' | 'error';
  saving: boolean;
  /** Snapshot taken on save.pending so save.rejected can restore it. */
  rollback: WispNudgePreferences | null;
  error: string | null;
  /** Which operation produced `error`, so a failed load is not toasted as a failed save. */
  errorKind: 'load' | 'save' | null;
}

function cloneDefaults(): WispNudgePreferences {
  return {
    ...WISP_NUDGE_PREFERENCE_DEFAULTS,
    channels: { ...WISP_NUDGE_PREFERENCE_DEFAULTS.channels },
  };
}

const initialState: WispPrefsState = {
  prefs: cloneDefaults(),
  status: 'idle',
  saving: false,
  rollback: null,
  error: null,
  errorKind: null,
};

function messageOf(err: unknown, fallback: string): string {
  return (err as { message?: string } | null)?.message ?? fallback;
}

export const loadWispNudgePrefs = createAsyncThunk(
  'wispPrefs/load',
  async (_: void, { rejectWithValue }) => {
    try {
      return await getWispNudgePrefs();
    } catch (err: unknown) {
      return rejectWithValue(messageOf(err, 'Failed to load Wisp settings'));
    }
  }
);

export const saveWispNudgePrefs = createAsyncThunk(
  'wispPrefs/save',
  async (patch: UpdateWispNudgePreferences, { rejectWithValue }) => {
    try {
      return await updateWispNudgePrefs(patch);
    } catch (err: unknown) {
      return rejectWithValue(messageOf(err, 'Failed to save Wisp settings'));
    }
  },
  {
    /**
     * One save at a time; a refused save dispatches nothing (no optimistic
     * move, no error), see `saveTicketPushPrefs` for the full rationale.
     */
    condition: (_patch, { getState }) =>
      !(getState() as { wispPrefs: WispPrefsState }).wispPrefs.saving,
  }
);

const wispPrefsSlice = createSlice({
  name: 'wispPrefs',
  initialState,
  reducers: {
    clearWispPrefsError: (state) => {
      state.error = null;
      state.errorKind = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadWispNudgePrefs.pending, (state) => {
        state.status = 'loading';
      })
      .addCase(loadWispNudgePrefs.fulfilled, (state, action) => {
        state.prefs = action.payload;
        state.status = 'ready';
        state.error = null;
        state.errorKind = null;
      })
      .addCase(loadWispNudgePrefs.rejected, (state, action) => {
        // Leaves `prefs` alone: a failed refresh must not reset what the person sees.
        state.status = 'error';
        state.error = (action.payload as string) ?? action.error.message ?? 'Failed to load';
        state.errorKind = 'load';
      })
      .addCase(saveWispNudgePrefs.pending, (state, action) => {
        state.rollback = { ...state.prefs, channels: { ...state.prefs.channels } };
        state.prefs = { ...state.prefs, ...action.meta.arg };
        state.saving = true;
        state.error = null;
        state.errorKind = null;
      })
      .addCase(saveWispNudgePrefs.fulfilled, (state, action) => {
        // Adopt the echo: the server is the authority on what was stored.
        state.prefs = action.payload;
        state.saving = false;
        state.rollback = null;
        state.status = 'ready';
      })
      .addCase(saveWispNudgePrefs.rejected, (state, action) => {
        if (state.rollback) state.prefs = state.rollback;
        state.rollback = null;
        state.saving = false;
        state.error = (action.payload as string) ?? action.error.message ?? 'Failed to save';
        state.errorKind = 'save';
      });
  },
});

export const { clearWispPrefsError } = wispPrefsSlice.actions;
export default wispPrefsSlice.reducer;

export const selectWispNudgePrefs = (state: { wispPrefs: WispPrefsState }) =>
  state.wispPrefs.prefs;
export const selectWispNudgePrefsSaving = (state: { wispPrefs: WispPrefsState }) =>
  state.wispPrefs.saving;
export const selectWispNudgePrefsError = (state: { wispPrefs: WispPrefsState }) =>
  state.wispPrefs.error;
export const selectWispNudgePrefsErrorKind = (state: { wispPrefs: WispPrefsState }) =>
  state.wispPrefs.errorKind;
