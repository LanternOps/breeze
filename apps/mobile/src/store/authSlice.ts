import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';

import { login as apiLogin, logout as apiLogout, User } from '../services/api';
import { storeToken, storeUser, clearAuthData } from '../services/auth';

interface AuthState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  error: string | null;
}

const initialState: AuthState = {
  user: null,
  token: null,
  isLoading: false,
  error: null,
};

export const loginAsync = createAsyncThunk(
  'auth/login',
  async ({ email, password }: { email: string; password: string }, { rejectWithValue }) => {
    try {
      const response = await apiLogin(email, password);

      // Store credentials securely
      await storeToken(response.token);
      await storeUser(response.user);

      return response;
    } catch (error: unknown) {
      const apiError = error as { message?: string };
      return rejectWithValue(apiError.message || 'Login failed');
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
    },
    logout: (state) => {
      state.user = null;
      state.token = null;
      state.isLoading = false;
      state.error = null;
    },
    clearError: (state) => {
      state.error = null;
    },
    setLoading: (state, action: PayloadAction<boolean>) => {
      state.isLoading = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      // Login
      .addCase(loginAsync.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(loginAsync.fulfilled, (state, action) => {
        state.isLoading = false;
        state.token = action.payload.token;
        state.user = action.payload.user;
        state.error = null;
      })
      .addCase(loginAsync.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload as string;
      })
      // Logout
      .addCase(logoutAsync.pending, (state) => {
        state.isLoading = true;
      })
      .addCase(logoutAsync.fulfilled, (state) => {
        state.user = null;
        state.token = null;
        state.isLoading = false;
        state.error = null;
      })
      .addCase(logoutAsync.rejected, (state) => {
        // Still clear state even if logout API fails
        state.user = null;
        state.token = null;
        state.isLoading = false;
        state.error = null;
      });
  },
});

export const { setCredentials, logout, clearError, setLoading } = authSlice.actions;
export default authSlice.reducer;
