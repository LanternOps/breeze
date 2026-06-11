import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';

import {
  login as apiLogin,
  logout as apiLogout,
  verifyMfa as apiVerifyMfa,
  type MfaChallenge,
  type User,
} from '../services/api';
import { storeToken, storeUser, clearAuthData } from '../services/auth';

export type PushRegistrationStatus = 'idle' | 'ok' | 'failed' | 'unsupported';

interface AuthState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  error: string | null;
  mfaChallenge: MfaChallenge | null;
  pushRegistration: PushRegistrationStatus;
  pushRegistrationReason: string | null;
}

const initialState: AuthState = {
  user: null,
  token: null,
  isLoading: false,
  error: null,
  mfaChallenge: null,
  pushRegistration: 'idle',
  pushRegistrationReason: null,
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
    try {
      await apiLogout();
      await clearAuthData();
    } catch (error: unknown) {
      // Clear local data even if API call fails
      await clearAuthData();
      const apiError = error as { message?: string };
      return rejectWithValue(apiError.message || 'Logout failed');
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
      })
      .addCase(logoutAsync.rejected, (state) => {
        state.user = null;
        state.token = null;
        state.isLoading = false;
        state.error = null;
        state.mfaChallenge = null;
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
} = authSlice.actions;
export default authSlice.reducer;
