import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import * as Sentry from '@sentry/react-native';

import {
  login as apiLogin,
  logout as apiLogout,
  verifyMfa as apiVerifyMfa,
  type MfaChallenge,
  type MfaEnrollmentRequired,
  type MfaMethod,
  type User,
} from '../services/api';
import { storeToken, storeUser } from '../services/auth';
import { markAppLockUnlocked } from '../services/appLockStore';
import {
  commitIfCurrent,
  currentSessionGeneration,
} from '../services/sessionGeneration';
import { beginSessionInvalidation } from '../services/sessionAuthority';

export type PushRegistrationStatus = 'idle' | 'ok' | 'failed' | 'unsupported';

/**
 * Whether this phone managed to register as a hardware approver.
 * `unsupported` (no biometric hardware / simulator) is a normal resting state;
 * only `failed` is worth telling the user about, because it silently caps every
 * approval from this device at L1.
 */
export type ApproverRegistrationStatus =
  | 'idle'
  | 'registered'
  | 'deferred'
  | 'failed'
  | 'unsupported';

interface AuthState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  error: string | null;
  mfaChallenge: MfaChallenge | null;
  mfaEnrollmentRequired: MfaEnrollmentRequired | null;
  pushRegistration: PushRegistrationStatus;
  pushRegistrationReason: string | null;
  approverRegistration: ApproverRegistrationStatus;
  approverRegistrationReason: string | null;
  /**
   * #2707: single-use approver-register grant minted at login/mfa-verify.
   * Memory-only — RootNavigator reads-and-clears it before attempting
   * registration; it must never be persisted to SecureStore (see
   * services/auth.ts storeToken/storeUser, which stay untouched).
   */
  authenticatorRegisterGrantId: string | null;
}

const initialState: AuthState = {
  user: null,
  token: null,
  isLoading: false,
  error: null,
  mfaChallenge: null,
  mfaEnrollmentRequired: null,
  pushRegistration: 'idle',
  pushRegistrationReason: null,
  approverRegistration: 'idle',
  approverRegistrationReason: null,
  authenticatorRegisterGrantId: null,
};

export const loginAsync = createAsyncThunk(
  'auth/login',
  async ({ email, password }: { email: string; password: string }, { rejectWithValue }) => {
    const generation = currentSessionGeneration();
    try {
      const result = await apiLogin(email, password);

      if (result.kind === 'mfaRequired') {
        const committed = await commitIfCurrent(generation, async () => result.challenge);
        return committed === undefined ? { superseded: true as const } : { mfa: committed };
      }
      if (result.kind === 'mfaEnrollmentRequired') {
        const committed = await commitIfCurrent(generation, async () => result.handoff);
        return committed === undefined ? { superseded: true as const } : { enrollment: committed };
      }

      const committed = await commitIfCurrent(generation, async () => {
        await storeToken(result.token);
        await storeUser(result.user);
        // Last, and awaited: `storeUser` throws, and a login the user was told
        // failed must not leave an "unlocked" stamp behind.
        await markAppLockUnlocked().catch(() => {});
        return true;
      });
      if (committed === undefined) return { superseded: true as const };

      return { token: result.token, user: result.user, registerGrant: result.registerGrant };
    } catch (error: unknown) {
      const apiError = error as { message?: string };
      return rejectWithValue(apiError.message || 'Login failed');
    }
  }
);

export const verifyMfaAsync = createAsyncThunk(
  'auth/verifyMfa',
  async ({ code, tempToken, method }: {
    code: string;
    tempToken: string;
    method: Exclude<MfaMethod, 'passkey'>;
  }, { rejectWithValue }) => {
    const generation = currentSessionGeneration();
    try {
      const response = await apiVerifyMfa(code, tempToken, method);
      const committed = await commitIfCurrent(generation, async () => {
        await storeToken(response.token);
        await storeUser(response.user);
        await markAppLockUnlocked().catch(() => {});
        return true;
      });
      if (committed === undefined) return { superseded: true as const };
      return response;
    } catch (error: unknown) {
      const apiError = error as { message?: string };
      return rejectWithValue(apiError.message || 'MFA verification failed');
    }
  }
);

/**
 * `deliberate: true` ONLY when the technician chose to sign out. An automatic
 * invalidation (a blocked device, a revoked session) must leave the unsent
 * time-entry queue in place — see services/auth.ts.
 */
export const logoutAsync = createAsyncThunk(
  'auth/logout',
  async (
    options: Readonly<{ deliberate?: boolean }> | undefined,
    { rejectWithValue, getState }
  ) => {
    const invalidation = beginSessionInvalidation({
      deliberate: options?.deliberate === true,
    });
    const bearerToken = (getState() as { auth: AuthState }).auth.token;
    // Best-effort server logout; we tear down local state regardless of its
    // outcome so the user always leaves the authenticated surface.
    let apiErrorMessage: string | undefined;
    const networkLogout = apiLogout({
      sessionGenerationAlreadyAdvanced: true,
      localCleanupAlreadyEnqueued: true,
      bearerToken,
    });
    const [networkResult, cleanupResult] = await Promise.allSettled([
      networkLogout,
      invalidation.cleanup,
    ]);
    if (networkResult.status === 'rejected') {
      const error = networkResult.reason;
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
    if (cleanupResult.status === 'rejected') {
      const error = cleanupResult.reason;
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
      state.mfaEnrollmentRequired = null;
    },
    logout: (state) => {
      state.user = null;
      state.token = null;
      state.isLoading = false;
      state.error = null;
      state.mfaChallenge = null;
      state.mfaEnrollmentRequired = null;
      // Approver registration is per-user, not per-device: leaving it set would
      // show the next user on this phone the previous user's banner.
      state.approverRegistration = 'idle';
      state.approverRegistrationReason = null;
      state.authenticatorRegisterGrantId = null;
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
    // #2707: the grant is single-use — RootNavigator takes it (read-and-clear)
    // BEFORE the registration attempt so a re-fired effect can't replay it.
    clearAuthenticatorRegisterGrant: (state) => {
      state.authenticatorRegisterGrantId = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loginAsync.pending, (state) => {
        state.isLoading = true;
        state.error = null;
        state.mfaEnrollmentRequired = null;
      })
      .addCase(loginAsync.fulfilled, (state, action) => {
        state.isLoading = false;
        state.error = null;
        if ('superseded' in action.payload) return;
        if ('mfa' in action.payload && action.payload.mfa) {
          state.mfaChallenge = action.payload.mfa;
          return;
        }
        if ('enrollment' in action.payload && action.payload.enrollment) {
          state.user = null;
          state.token = null;
          state.mfaChallenge = null;
          state.mfaEnrollmentRequired = action.payload.enrollment;
          return;
        }
        if ('token' in action.payload && 'user' in action.payload) {
          state.token = action.payload.token;
          state.user = action.payload.user;
          state.mfaChallenge = null;
          state.mfaEnrollmentRequired = null;
          state.authenticatorRegisterGrantId = action.payload.registerGrant ?? null;
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
        if ('superseded' in action.payload) return;
        state.token = action.payload.token;
        state.user = action.payload.user;
        state.error = null;
        state.mfaChallenge = null;
        state.mfaEnrollmentRequired = null;
        state.authenticatorRegisterGrantId = action.payload.registerGrant ?? null;
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
        state.mfaEnrollmentRequired = null;
        // Reset push status too — leaving the previous account's 'ok'/'failed'
        // behind briefly shows stale copy in Settings after the next sign-in.
        state.pushRegistration = 'idle';
        state.pushRegistrationReason = null;
        state.approverRegistration = 'idle';
        state.approverRegistrationReason = null;
        state.authenticatorRegisterGrantId = null;
      })
      .addCase(logoutAsync.rejected, (state) => {
        state.user = null;
        state.token = null;
        state.isLoading = false;
        state.error = null;
        state.mfaChallenge = null;
        state.mfaEnrollmentRequired = null;
        state.pushRegistration = 'idle';
        state.pushRegistrationReason = null;
        state.approverRegistration = 'idle';
        state.approverRegistrationReason = null;
        state.authenticatorRegisterGrantId = null;
      });
  },
});

const {
  logout: reduceLogout,
  setCredentials,
  clearError,
  clearMfaChallenge,
  setLoading,
  setPushRegistration,
  setApproverRegistration,
  clearAuthenticatorRegisterGrant,
} = authSlice.actions;

export {
  setCredentials,
  clearError,
  clearMfaChallenge,
  setLoading,
  setPushRegistration,
  setApproverRegistration,
  clearAuthenticatorRegisterGrant,
};

export const logout = Object.assign(
  (): ReturnType<typeof reduceLogout> => {
    // Action creation is synchronous, so request/write fencing happens before
    // Redux publishes the signed-out state to the UI.
    //
    // Always INVOLUNTARY: every call site is an automatic invalidation (a
    // 401/403 on cold-start revalidation, an unreadable keychain, a missing
    // token). The unsent time-entry queue therefore survives; `logoutAsync({
    // deliberate: true })` is what the user-facing Sign out buttons dispatch.
    const { cleanup } = beginSessionInvalidation();
    void cleanup.catch(() => undefined); // clearAuthData already reports failures
    return reduceLogout();
  },
  { type: reduceLogout.type, match: reduceLogout.match },
);
export default authSlice.reducer;
