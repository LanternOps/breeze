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
        user: state.user
      }),
      onRehydrateStorage: () => (state) => {
        // Set isLoading to false after rehydration completes
        if (state) {
          state.setUser(state.user);
          state.setLoading(false);
        }
      }
    }
  )
);

// API helper functions
// In development, set PUBLIC_API_URL=http://localhost:3001. In production behind a
// reverse proxy (Caddy), leave it empty so requests use relative paths (/api/v1/...).
const API_HOST = import.meta.env.PUBLIC_API_URL || '';
const CSRF_HEADER_NAME = 'x-breeze-csrf';
const CSRF_HEADER_VALUE = '1';

// Helper to build full API URL - converts /path to /api/v1/path
function buildApiUrl(path: string): string {
  // If already a full URL, return as-is
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }

  // Ensure path starts with /
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  // Remove only the exact "/api" prefix boundary to avoid "/api/v1/api/..."
  // while preserving legitimate paths like "/api-keys".
  const cleanPath = normalizedPath === '/api'
    ? ''
    : normalizedPath.startsWith('/api/')
      ? normalizedPath.slice(4)
      : normalizedPath;

  return `${API_HOST}/api/v1${cleanPath}`;
}

async function requestTokenRefresh(): Promise<Tokens | null> {
  const refreshResponse = await fetch(buildApiUrl('/auth/refresh'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE
    },
    credentials: 'include',
    body: JSON.stringify({})
  });

  if (!refreshResponse.ok) {
    return null;
  }

  const { tokens } = await refreshResponse.json() as { tokens?: Tokens };
  return tokens?.accessToken ? tokens : null;
}

let tokenRefreshInFlight: Promise<Tokens | null> | null = null;

async function requestTokenRefreshShared(): Promise<Tokens | null> {
  if (tokenRefreshInFlight) {
    return tokenRefreshInFlight;
  }

  tokenRefreshInFlight = requestTokenRefresh().finally(() => {
    tokenRefreshInFlight = null;
  });

  return tokenRefreshInFlight;
}

export async function restoreAccessTokenFromCookie(): Promise<boolean> {
  try {
    const tokens = await requestTokenRefreshShared();
    if (!tokens) return false;
    useAuthStore.getState().setTokens(tokens);
    return true;
  } catch {
    return false;
  }
}

export async function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
  const { tokens: initialTokens, isAuthenticated, logout, setTokens } = useAuthStore.getState();
  let tokens = initialTokens;
  const previousAccessToken = tokens?.accessToken ?? null;

  // During app bootstrap we can have a persisted authenticated user but no in-memory access token yet.
  // Recover from refresh cookie first to avoid firing unauthenticated API calls.
  if (!tokens?.accessToken && isAuthenticated) {
    const restoredTokens = await requestTokenRefreshShared();
    if (restoredTokens) {
      setTokens(restoredTokens);
      tokens = restoredTokens;
    }
  }

  const headers = new Headers(options.headers);

  if (tokens?.accessToken) {
    headers.set('Authorization', `Bearer ${tokens.accessToken}`);
  }

  headers.set('Content-Type', 'application/json');

  let response = await fetch(buildApiUrl(url), { ...options, headers, credentials: 'include' });

  // If unauthorized, attempt cookie-backed refresh once
  if (response.status === 401) {
    const newTokens = await requestTokenRefreshShared();
    if (newTokens) {
      setTokens(newTokens);

      // Retry original request with new token
      headers.set('Authorization', `Bearer ${newTokens.accessToken}`);
      response = await fetch(buildApiUrl(url), { ...options, headers, credentials: 'include' });
    } else {
      // If another in-flight request already refreshed state, retry once with latest token.
      const latestToken = useAuthStore.getState().tokens?.accessToken;
      if (latestToken && latestToken !== previousAccessToken) {
        headers.set('Authorization', `Bearer ${latestToken}`);
        response = await fetch(buildApiUrl(url), { ...options, headers, credentials: 'include' });
      } else {
        // Refresh failed and no newer token exists; logout.
        logout();
      }
    }
  }

  return response;
}

export type MfaMethod = 'totp' | 'sms';

export async function apiLogin(email: string, password: string): Promise<{
  success: boolean;
  mfaRequired?: boolean;
  tempToken?: string;
  mfaMethod?: MfaMethod;
  phoneLast4?: string;
  user?: User;
  tokens?: Tokens;
  error?: string;
}> {
  try {
    const response = await fetch(buildApiUrl('/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
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
        tempToken: data.tempToken,
        mfaMethod: data.mfaMethod || 'totp',
        phoneLast4: data.phoneLast4
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

export async function apiVerifyMFA(code: string, tempToken: string, method?: MfaMethod): Promise<{
  success: boolean;
  user?: User;
  tokens?: Tokens;
  error?: string;
}> {
  try {
    const response = await fetch(buildApiUrl('/auth/mfa/verify'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ code, tempToken, method })
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

export interface Partner {
  id: string;
  name: string;
  slug: string;
}

export async function apiRegister(
  email: string,
  password: string,
  name: string
): Promise<{
  success: boolean;
  user?: User;
  tokens?: Tokens;
  error?: string;
}> {
  try {
    const response = await fetch(buildApiUrl('/auth/register'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
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

export async function apiRegisterPartner(
  companyName: string,
  email: string,
  password: string,
  name: string
): Promise<{
  success: boolean;
  user?: User;
  partner?: Partner;
  tokens?: Tokens;
  error?: string;
}> {
  try {
    const response = await fetch(buildApiUrl('/auth/register-partner'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ companyName, email, password, name, acceptTerms: true })
    });

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: data.error || 'Registration failed' };
    }

    return {
      success: true,
      user: data.user,
      partner: data.partner,
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
        },
        credentials: 'include'
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
      credentials: 'include',
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
      credentials: 'include',
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

export async function apiSendSmsMfaCode(tempToken: string): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const response = await fetch(buildApiUrl('/auth/mfa/sms/send'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tempToken })
    });

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: data.error || 'Failed to send SMS code' };
    }

    return { success: true };
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export async function apiVerifyPhone(phoneNumber: string): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const response = await fetchWithAuth('/auth/phone/verify', {
      method: 'POST',
      body: JSON.stringify({ phoneNumber })
    });

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: data.error || 'Failed to send verification code' };
    }

    return { success: true };
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export async function apiConfirmPhone(phoneNumber: string, code: string): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const response = await fetchWithAuth('/auth/phone/confirm', {
      method: 'POST',
      body: JSON.stringify({ phoneNumber, code })
    });

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: data.error || 'Failed to verify phone' };
    }

    return { success: true };
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export async function apiEnableSmsMfa(): Promise<{
  success: boolean;
  recoveryCodes?: string[];
  error?: string;
}> {
  try {
    const response = await fetchWithAuth('/auth/mfa/sms/enable', {
      method: 'POST'
    });

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: data.error || 'Failed to enable SMS MFA' };
    }

    return { success: true, recoveryCodes: data.recoveryCodes };
  } catch {
    return { success: false, error: 'Network error' };
  }
}
