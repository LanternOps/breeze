import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface User {
  id: string;
  email: string;
  name: string;
  mfaEnabled: boolean;
  avatarUrl?: string;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

interface AuthState {
  user: User | null;
  tokens: Tokens | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  mfaPending: boolean;
  mfaTempToken: string | null;

  // Actions
  setUser: (user: User | null) => void;
  setTokens: (tokens: Tokens | null) => void;
  setMfaPending: (pending: boolean, tempToken?: string) => void;
  setLoading: (loading: boolean) => void;
  login: (user: User, tokens: Tokens) => void;
  logout: () => void;
  updateUser: (user: Partial<User>) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      tokens: null,
      isAuthenticated: false,
      isLoading: true,
      mfaPending: false,
      mfaTempToken: null,

      setUser: (user) => set({ user, isAuthenticated: !!user }),

      setTokens: (tokens) => set({ tokens }),

      setMfaPending: (pending, tempToken) => set({
        mfaPending: pending,
        mfaTempToken: tempToken || null
      }),

      setLoading: (loading) => set({ isLoading: loading }),

      login: (user, tokens) => set({
        user,
        tokens,
        isAuthenticated: true,
        isLoading: false,
        mfaPending: false,
        mfaTempToken: null
      }),

      logout: () => set({
        user: null,
        tokens: null,
        isAuthenticated: false,
        mfaPending: false,
        mfaTempToken: null
      }),

      updateUser: (updates) => set((state) => ({
        user: state.user ? { ...state.user, ...updates } : null
      }))
    }),
    {
      name: 'breeze-auth',
      partialize: (state) => ({
        user: state.user,
        tokens: state.tokens,
        isAuthenticated: state.isAuthenticated
      }),
      onRehydrateStorage: () => (state) => {
        // Set isLoading to false after rehydration completes
        if (state) {
          state.setLoading(false);
        }
      }
    }
  )
);

// API helper functions
// In development, point directly to API server. In production, use relative path (proxied).
const API_HOST = import.meta.env.PUBLIC_API_URL || 'http://localhost:3001';

// Helper to build full API URL - converts /api/... to /api/v1/...
function buildApiUrl(path: string): string {
  // Remove leading /api if present and add /api/v1
  const cleanPath = path.startsWith('/api/') ? path.slice(4) : path.startsWith('/api') ? path.slice(4) : path;
  return `${API_HOST}/api/v1${cleanPath}`;
}

export async function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
  const { tokens, logout, setTokens } = useAuthStore.getState();

  const headers = new Headers(options.headers);

  if (tokens?.accessToken) {
    headers.set('Authorization', `Bearer ${tokens.accessToken}`);
  }

  headers.set('Content-Type', 'application/json');

  let response = await fetch(buildApiUrl(url), { ...options, headers });

  // If unauthorized and we have a refresh token, try to refresh
  if (response.status === 401 && tokens?.refreshToken) {
    const refreshResponse = await fetch(buildApiUrl('/auth/refresh'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: tokens.refreshToken })
    });

    if (refreshResponse.ok) {
      const { tokens: newTokens } = await refreshResponse.json();
      setTokens(newTokens);

      // Retry original request with new token
      headers.set('Authorization', `Bearer ${newTokens.accessToken}`);
      response = await fetch(buildApiUrl(url), { ...options, headers });
    } else {
      // Refresh failed, logout
      logout();
    }
  }

  return response;
}

export async function apiLogin(email: string, password: string): Promise<{
  success: boolean;
  mfaRequired?: boolean;
  tempToken?: string;
  user?: User;
  tokens?: Tokens;
  error?: string;
}> {
  try {
    const response = await fetch(buildApiUrl('/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: data.error || 'Login failed' };
    }

    if (data.mfaRequired) {
      return {
        success: true,
        mfaRequired: true,
        tempToken: data.tempToken
      };
    }

    return {
      success: true,
      user: data.user,
      tokens: data.tokens
    };
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export async function apiVerifyMFA(code: string, tempToken: string): Promise<{
  success: boolean;
  user?: User;
  tokens?: Tokens;
  error?: string;
}> {
  try {
    const response = await fetch(buildApiUrl('/auth/mfa/verify'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, tempToken })
    });

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: data.error || 'MFA verification failed' };
    }

    return {
      success: true,
      user: data.user,
      tokens: data.tokens
    };
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export async function apiRegister(email: string, password: string, name: string): Promise<{
  success: boolean;
  user?: User;
  tokens?: Tokens;
  error?: string;
}> {
  try {
    const response = await fetch(buildApiUrl('/auth/register'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name })
    });

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: data.error || 'Registration failed' };
    }

    return {
      success: true,
      user: data.user,
      tokens: data.tokens
    };
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export async function apiLogout(): Promise<void> {
  const { tokens, logout } = useAuthStore.getState();

  if (tokens?.accessToken) {
    try {
      await fetch(buildApiUrl('/auth/logout'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tokens.accessToken}`
        }
      });
    } catch {
      // Ignore errors, logout anyway
    }
  }

  logout();
}

export async function apiForgotPassword(email: string): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const response = await fetch(buildApiUrl('/auth/forgot-password'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: data.error };
    }

    return { success: true };
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export async function apiResetPassword(token: string, password: string): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const response = await fetch(buildApiUrl('/auth/reset-password'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password })
    });

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: data.error };
    }

    return { success: true };
  } catch {
    return { success: false, error: 'Network error' };
  }
}
