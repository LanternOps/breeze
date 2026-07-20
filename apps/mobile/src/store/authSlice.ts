import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import * as Sentry from '@sentry/react-native';

import {
  login as apiLogin,
  logout as apiLogout,
  verifyMfa as apiVerifyMfa,
  type MfaChallenge,
  type User,
} from '../services/api';
import { storeToken, storeUser, clearAuthData } from '../services/auth';

export type PushRegistrationStatus = 'idle' | 'ok' | 'failed' | 'unsupported';

/**
 * Whether this phone managed to register as a hardware approver.
 * `unsupported` (no biometric hardware / simulator) is a normal resting state;
 * only `failed` is worth telling the user about, because it silently caps every
 * approval from this device at L1.
 */
export type ApproverRegistrationStatus = 'idle' | 'registered' | 'failed' | 'unsupported';

interface AuthState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  error: string | null;
  mfaChallenge: MfaChallenge | null;
  pushRegistration: PushRegistrationStatus;
  pushRegistrationReason: string | null;
  approverRegistration: ApproverRegistrationStatus;
  approverRegistrationReason: string | null;
}

const initialState: AuthState = {
  user: null,
  token: null,
  isLoading: false,
  error: null,
  mfaChallenge: null,
  pushRegistration: 'idle',
  pushRegistrationReason: null,
  approverRegistration: 'idle',
  approverRegistrationReason: null,
};

export const loginAsync = createAsyncThunk(
  'auth/login',
  async ({ email, password }: { email: string; password: string }, { rejectWithValue }) => {
    try {
      const result = await apiLogin(email, password);

      if (result.kind === 'mfaRequired') {
        return { mfa: result.challenge };
      }

      await storeToken(result.token);
      await storeUser(result.user);

      return { token: result.token, user: result.user };
    } catch (error: unknown) {
      const apiError = error as { message?: string };
      return rejectWithValue(apiError.message || 'Login failed');
    }
  }
);

export const verifyMfaAsync = createAsyncThunk(
  'auth/verifyMfa',
  async ({ code, tempToken }: { code: string; tempToken: string }, { rejectWithValue }) => {
    try {
      const response = await apiVerifyMfa(code, tempToken);
      await storeToken(response.token);
      await storeUser(response.user);
      return response;
    } catch (error: unknown) {
      const apiError = error as { message?: string };
      return rejectWithValue(apiError.message || 'MFA verification failed');
    }
  }
);

export const logoutAsync = createAsyncThunk(
  'auth/logout',
  async (_, { rejectWithValue }) => {
    // Best-effort server logout; we tear down local state regardless of its
    // outcome so the user always leaves the authenticated surface.
    let apiErrorMessage: string | undefined;
    try {
      await apiLogout();
    } catch (error: unknown) {
      apiErrorMessage = (error as { message?: string }).message || 'Logout failed';
      // A failed server-side logout may leave the session token live on the
      // backend — security-relevant, and the rejected reducer discards the
      // message (state.error is reset), so report it to telemetry here.
      Sentry.captureException(error, { tags: { area: 'auth-logout-api' } });
    }

    // Local secure wipe runs exactly once. `clearAuthData` now throws a
    // SecureWipeError (already reported to Sentry) if any sensitive entry
    // survived; surface that as a rejection rather than letting it escape the
    // thunk unhandled — the Redux session reset still happens via the
    // logout/rejected reducers, so the user is signed out either way.
    try {
      await clearAuthData();
    } catch (error: unknown) {
      const wipeMessage = (error as { message?: string }).message || 'Secure wipe failed';
      return rejectWithValue(apiErrorMessage ? `${apiErrorMessage}; ${wipeMessage}` : wipeMessage);
    }

    if (apiErrorMessage) {
      return rejectWithValue(apiErrorMessage);
    }
  }
);

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    setCredentials: (
      state,
      action: PayloadAction<{ token: string; user: User }>
    ) => {
      state.token = action.payload.token;
      state.user = action.payload.user;
      state.isLoading = false;
      state.error = null;
      state.mfaChallenge = null;
    },
    logout: (state) => {
      state.user = null;
      state.token = null;
      state.isLoading = false;
      state.error = null;
      state.mfaChallenge = null;
      // Approver registration is per-user, not per-device: leaving it set would
      // show the next user on this phone the previous user's banner.
      state.approverRegistration = 'idle';
      state.approverRegistrationReason = null;
    },
    clearError: (state) => {
      state.error = null;
    },
    clearMfaChallenge: (state) => {
      state.mfaChallenge = null;
      state.error = null;
    },
    setLoading: (state, action: PayloadAction<boolean>) => {
      state.isLoading = action.payload;
    },
    setPushRegistration: (
      state,
      action: PayloadAction<{ status: PushRegistrationStatus; reason?: string | null }>
    ) => {
      state.pushRegistration = action.payload.status;
      state.pushRegistrationReason = action.payload.reason ?? null;
    },
    setApproverRegistration: (
      state,
      action: PayloadAction<{ status: ApproverRegistrationStatus; reason?: string | null }>
    ) => {
      state.approverRegistration = action.payload.status;
      state.approverRegistrationReason = action.payload.reason ?? null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loginAsync.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(loginAsync.fulfilled, (state, action) => {
        state.isLoading = false;
        state.error = null;
        if ('mfa' in action.payload && action.payload.mfa) {
          state.mfaChallenge = action.payload.mfa;
          return;
        }
        if ('token' in action.payload && 'user' in action.payload) {
          state.token = action.payload.token;
          state.user = action.payload.user;
          state.mfaChallenge = null;
        }
      })
      .addCase(loginAsync.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload as string;
      })
      .addCase(verifyMfaAsync.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(verifyMfaAsync.fulfilled, (state, action) => {
        state.isLoading = false;
        state.token = action.payload.token;
        state.user = action.payload.user;
        state.error = null;
        state.mfaChallenge = null;
      })
      .addCase(verifyMfaAsync.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload as string;
      })
      .addCase(logoutAsync.pending, (state) => {
        state.isLoading = true;
      })
      .addCase(logoutAsync.fulfilled, (state) => {
        state.user = null;
        state.token = null;
        state.isLoading = false;
        state.error = null;
        state.mfaChallenge = null;
        state.approverRegistration = 'idle';
        state.approverRegistrationReason = null;
      })
      .addCase(logoutAsync.rejected, (state) => {
        state.user = null;
        state.token = null;
        state.isLoading = false;
        state.error = null;
        state.mfaChallenge = null;
        state.approverRegistration = 'idle';
        state.approverRegistrationReason = null;
      });
  },
});

export const {
  setCredentials,
  logout,
  clearError,
  clearMfaChallenge,
  setLoading,
  setPushRegistration,
  setApproverRegistration,
} = authSlice.actions;
export default authSlice.reducer;
