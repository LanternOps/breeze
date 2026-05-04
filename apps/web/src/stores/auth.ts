import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface UserPreferences {
  theme?: 'light' | 'dark' | 'system';
}

export interface User {
  id: string;
  email: string;
  name: string;
  mfaEnabled: boolean;
  avatarUrl?: string;
  requiresSetup?: boolean;
  preferences?: UserPreferences;
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

type PersistedAuthState = Pick<AuthState, 'user' | 'isAuthenticated'>;

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
      version: 2,
      partialize: (state): PersistedAuthState => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
      migrate: (persistedState): PersistedAuthState => {
        const nextState = (persistedState ?? {}) as Partial<PersistedAuthState> & { tokens?: unknown };
        // Access tokens stay in memory only. Refresh cookies restore them after reload.
        delete nextState.tokens;
        return {
          user: nextState.user ?? null,
          isAuthenticated:
            typeof nextState.isAuthenticated === 'boolean'
              ? nextState.isAuthenticated
              : nextState.user != null,
        };
      },
      onRehydrateStorage: () => (state) => {
        // Set isLoading to false after rehydration completes.
        // When rehydration fails, state is null — fall back to the raw store API
        // so isLoading is always cleared and the app never hangs on "Loading...".
        if (state) {
          state.setUser(state.user);
          state.setLoading(false);
        } else {
          useAuthStore.getState().setLoading(false);
        }
      }
    }
  )
);

// Org-context injection — orgStore registers a provider to avoid circular imports
let _getOrgId: (() => string | null) | null = null;
export function registerOrgIdProvider(fn: () => string | null) {
  _getOrgId = fn;
}

// API helper functions
// In development, set PUBLIC_API_URL=http://localhost:3001. In production behind a
// reverse proxy (Caddy), leave it empty so requests use relative paths (/api/v1/...).
const API_HOST = import.meta.env.PUBLIC_API_URL || '';
const CSRF_HEADER_NAME = 'x-breeze-csrf';
const CSRF_COOKIE_NAME = 'breeze_csrf_token';

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') {
    return null;
  }

  const target = `${name}=`;
  const parts = document.cookie.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.startsWith(target)) {
      const value = trimmed.slice(target.length);
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }

  return null;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

function resolveApiHost(): string {
  if (!API_HOST) {
    return '';
  }

  if (typeof window === 'undefined') {
    return API_HOST;
  }

  try {
    const parsed = new URL(API_HOST, window.location.origin);
    const windowHostname = window.location.hostname;

    // Keep localhost dev sessions same-site even when PUBLIC_API_URL points to
    // a different host (for example a LAN/Tailscale IP).
    if (isLoopbackHostname(windowHostname) && parsed.hostname !== windowHostname) {
      parsed.hostname = windowHostname;
      return parsed.origin;
    }

    if (isLoopbackHostname(parsed.hostname) && parsed.hostname !== window.location.hostname) {
      parsed.hostname = window.location.hostname;
    }
    return parsed.origin;
  } catch {
    return API_HOST;
  }
}

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

  const apiHost = resolveApiHost();
  return `${apiHost}/api/v1${cleanPath}`;
}

async function requestTokenRefresh(): Promise<Tokens | null> {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const csrfToken = readCookie(CSRF_COOKIE_NAME);
  if (csrfToken) {
    headers.set(CSRF_HEADER_NAME, csrfToken);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  let refreshResponse: Response;
  try {
    refreshResponse = await fetch(buildApiUrl('/auth/refresh'), {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({}),
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }

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

export async function fetchWithAuth(rawUrl: string, options: RequestInit = {}): Promise<Response> {
  // Auto-inject orgId from the org store so partner/system users always scope API calls
  let url = rawUrl;
  const orgId = _getOrgId?.();
  if (orgId && !url.includes('orgId=')) {
    const separator = url.includes('?') ? '&' : '?';
    url = `${url}${separator}orgId=${orgId}`;
  }

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

  // Use caller-provided signal or create a 30-second timeout to prevent indefinite hangs
  const externalSignal = options.signal;
  const controller = !externalSignal ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), 30_000) : null;
  const signal = externalSignal ?? controller!.signal;

  let response: Response;
  try {
    response = await fetch(buildApiUrl(url), { ...options, headers, credentials: 'include', signal });
  } catch (err) {
    if (timeout) clearTimeout(timeout);
    throw err;
  }
  if (timeout) clearTimeout(timeout);

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

  // If the partner is inactive, redirect to the account inactive page.
  // This catches any API call that hits the server-side partner guard.
  if (response.status === 403) {
    try {
      const cloned = response.clone();
      const body = await cloned.json();
      if (body?.code === 'PARTNER_INACTIVE') {
        const path = window.location.pathname;
        if (!path.startsWith('/account/') && !path.startsWith('/login')) {
          window.location.href = '/account/inactive';
        }
      }
    } catch {
      // Not JSON or parse failed — treat as normal 403
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
  requiresSetup?: boolean;
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

    const user = data.user ? { ...data.user, requiresSetup: !!data.requiresSetup } : data.user;

    return {
      success: true,
      user,
      tokens: data.tokens,
      requiresSetup: !!data.requiresSetup
    };
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export async function apiVerifyMFA(code: string, tempToken: string, method?: MfaMethod): Promise<{
  success: boolean;
  user?: User;
  tokens?: Tokens;
  requiresSetup?: boolean;
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

    const user = data.user ? { ...data.user, requiresSetup: !!data.requiresSetup } : data.user;

    return {
      success: true,
      user,
      tokens: data.tokens,
      requiresSetup: !!data.requiresSetup
    };
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export interface Partner {
  id: string;
  name: string;
  slug: string;
  status?: string;
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
  redirectUrl?: string;
  message?: string;
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
      tokens: data.tokens,
      redirectUrl: data.redirectUrl,
      message: data.message,
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

  // Clear all persisted store data to prevent stale state on next login
  try {
    localStorage.removeItem('breeze-auth');
    localStorage.removeItem('breeze-org');
    localStorage.removeItem('breeze-ai-chat');
  } catch {
    // localStorage may be unavailable
  }
}

function applyThemePreference(theme: string | undefined): void {
  if (!theme || typeof document === 'undefined') return;

  const resolved = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;

  if (resolved === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
  localStorage.setItem('theme', theme);
}

export async function fetchAndApplyPreferences(): Promise<void> {
  try {
    const response = await fetchWithAuth('/users/me');
    if (!response.ok) return;

    const data = await response.json();
    if (data.preferences) {
      useAuthStore.getState().updateUser({ preferences: data.preferences });
      applyThemePreference(data.preferences.theme);
    }
  } catch {
    // Non-critical — localStorage still has the cached theme
  }
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
      referrerPolicy: 'no-referrer',
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

export async function apiVerifyPhone(phoneNumber: string, currentPassword: string): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const response = await fetchWithAuth('/auth/phone/verify', {
      method: 'POST',
      body: JSON.stringify({ phoneNumber, currentPassword })
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

export async function apiConfirmPhone(phoneNumber: string, code: string, currentPassword: string): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const response = await fetchWithAuth('/auth/phone/confirm', {
      method: 'POST',
      body: JSON.stringify({ phoneNumber, code, currentPassword })
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

export async function apiEnableSmsMfa(currentPassword: string): Promise<{
  success: boolean;
  recoveryCodes?: string[];
  error?: string;
}> {
  try {
    const response = await fetchWithAuth('/auth/mfa/sms/enable', {
      method: 'POST',
      body: JSON.stringify({ currentPassword })
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

export async function apiPreviewInvite(token: string): Promise<{
  success: boolean;
  email?: string;
  name?: string;
  orgName?: string;
  partnerName?: string;
  error?: string;
}> {
  try {
    const response = await fetch(buildApiUrl('/auth/invite/preview'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      referrerPolicy: 'no-referrer',
      body: JSON.stringify({ token }),
    });

    if (!response.ok) {
      return { success: false, error: `Preview unavailable (${response.status})` };
    }

    const data = await response.json();
    return {
      success: true,
      email: data.email,
      name: data.name,
      orgName: data.orgName,
      partnerName: data.partnerName,
    };
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export async function apiAcceptInvite(token: string, password: string): Promise<{
  success: boolean;
  user?: User;
  tokens?: Tokens;
  error?: string;
}> {
  try {
    const response = await fetch(buildApiUrl('/auth/accept-invite'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      referrerPolicy: 'no-referrer',
      body: JSON.stringify({ token, password })
    });

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: data.error || 'Failed to accept invite' };
    }

    return { success: true, user: data.user, tokens: data.tokens };
  } catch (err) {
    console.error('[apiAcceptInvite] Request failed:', err);
    return { success: false, error: 'Network error' };
  }
}
