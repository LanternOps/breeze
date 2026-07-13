import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import * as Sentry from '@sentry/react-native';

import {
  login as apiLogin,
  logout as apiLogout,
  verifyMfa as apiVerifyMfa,
  type MfaChallenge,
  type MfaCodeMethod,
  type User,
} from '../services/api';
import { storeToken, storeUser, clearAuthData } from '../services/auth';
import {
  advanceSessionGeneration,
  terminateSessionGeneration,
  isCurrentSessionGeneration,
  runAuthSessionTransition,
  runAuthStorageExclusive,
  runAuthStorageForSessionGeneration,
  SessionGenerationStaleError,
} from '../services/sessionGeneration';

async function persistAuthenticatedSession(token: string, user: User): Promise<void> {
  const generation = advanceSessionGeneration();
  await runAuthStorageForSessionGeneration(generation, async () => {
    try {
      if (!isCurrentSessionGeneration(generation)) throw new SessionGenerationStaleError();
      await storeToken(token);
      if (!isCurrentSessionGeneration(generation)) throw new SessionGenerationStaleError();
      await storeUser(user);
      if (!isCurrentSessionGeneration(generation)) throw new SessionGenerationStaleError();
    } catch (error) {
      try {
        await clearAuthData();
      } catch (wipeError) {
        const writeMessage = error instanceof Error ? error.message : 'Credential persistence failed';
        const wipeMessage = wipeError instanceof Error ? wipeError.message : 'credential cleanup failed';
        throw new Error(`${writeMessage}; ${wipeMessage}`);
      }
      throw error;
    }
  });
}

export type PushRegistrationStatus = 'idle' | 'ok' | 'failed' | 'unsupported';

interface AuthState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  error: string | null;
  mfaChallenge: MfaChallenge | null;
  securityNotice: string | null;
  pushRegistration: PushRegistrationStatus;
  pushRegistrationReason: string | null;
}

const initialState: AuthState = {
  user: null,
  token: null,
  isLoading: false,
  error: null,
  mfaChallenge: null,
  securityNotice: null,
  pushRegistration: 'idle',
  pushRegistrationReason: null,
};

export const loginAsync = createAsyncThunk(
  'auth/login',
  async ({ email, password }: { email: string; password: string }, { rejectWithValue }) => {
    try {
      return await runAuthSessionTransition(async () => {
        const result = await apiLogin(email, password);

        if (result.kind === 'mfaRequired') {
          return { mfa: result.challenge };
        }

        await persistAuthenticatedSession(result.token, result.user);

        return { token: result.token, user: result.user };
      });
    } catch (error: unknown) {
      const apiError = error as { message?: string };
      return rejectWithValue(apiError.message || 'Login failed');
    }
  }
);

export const verifyMfaAsync = createAsyncThunk(
  'auth/verifyMfa',
  async ({ code, tempToken, method }: { code: string; tempToken: string; method: MfaCodeMethod }, { rejectWithValue }) => {
    try {
      return await runAuthSessionTransition(async () => {
        const response = await apiVerifyMfa(code, tempToken, method);
        await persistAuthenticatedSession(response.token, response.user);
        return response;
      });
    } catch (error: unknown) {
      const apiError = error as { message?: string };
      return rejectWithValue(apiError.message || 'MFA verification failed');
    }
  }
);

export const logoutAsync = createAsyncThunk(
  'auth/logout',
  async (_, { dispatch, getState, rejectWithValue }) => {
    const capturedBearer = (getState() as { auth: AuthState }).auth.token;
    terminateSessionGeneration();
    dispatch(logout());
    let wipeErrorMessage: string | undefined;
    try {
      await runAuthStorageExclusive(clearAuthData);
    } catch (error: unknown) {
      wipeErrorMessage = (error as { message?: string }).message || 'Secure wipe failed';
    }
    return runAuthSessionTransition(async () => {
      // Best-effort server logout; we tear down local state regardless of its
      // outcome so the user always leaves the authenticated surface.
      let apiErrorMessage: string | undefined;
      try {
        await apiLogout(capturedBearer);
      } catch (error: unknown) {
        apiErrorMessage = (error as { message?: string }).message || 'Logout failed';
        Sentry.captureException(error, { tags: { area: 'auth-logout-api' } });
      }

      if (apiErrorMessage || wipeErrorMessage) {
        return rejectWithValue([apiErrorMessage, wipeErrorMessage].filter(Boolean).join('; '));
      }
    });
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
      state.securityNotice = null;
    },
    requireReauthentication: (state) => {
      state.user = null;
      state.token = null;
      state.isLoading = false;
      state.error = null;
      state.mfaChallenge = null;
      state.securityNotice = 'Your security settings changed. Sign in again to continue.';
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
  requireReauthentication,
  setLoading,
  setPushRegistration,
} = authSlice.actions;
export default authSlice.reducer;
