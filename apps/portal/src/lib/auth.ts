/**
 * Portal Auth Helpers
 * Authentication utilities for the customer portal
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { buildPortalApiUrl } from './api';

export interface PortalUser {
  id: string;
  email: string;
  name: string;
  organizationId?: string;
  organizationName?: string;
  orgId?: string;
  orgName?: string;
  avatarUrl?: string;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

interface PortalAuthState {
  user: PortalUser | null;
  tokens: Tokens | null;
  isAuthenticated: boolean;
  isLoading: boolean;

  // Actions
  setUser: (user: PortalUser | null) => void;
  setTokens: (tokens: Tokens | null) => void;
  setLoading: (loading: boolean) => void;
  login: (user: PortalUser, tokens: Tokens) => void;
  logout: () => void;
  updateUser: (user: Partial<PortalUser>) => void;
}

export const usePortalAuth = create<PortalAuthState>()(
  persist(
    (set) => ({
      user: null,
      tokens: null,
      isAuthenticated: false,
      isLoading: true,

      setUser: (user) => set({ user, isAuthenticated: !!user }),

      setTokens: (tokens) => set({ tokens }),

      setLoading: (loading) => set({ isLoading: loading }),

      login: (user, tokens) =>
        set({
          user,
          tokens,
          isAuthenticated: true,
          isLoading: false
        }),

      logout: () =>
        set({
          user: null,
          tokens: null,
          isAuthenticated: false
        }),

      updateUser: (updates) =>
        set((state) => ({
          user: state.user ? { ...state.user, ...updates } : null
        }))
    }),
    {
      name: 'portal-auth',
      partialize: (state) => ({
        user: state.user,
        tokens: state.tokens,
        isAuthenticated: state.isAuthenticated
      })
    }
  )
);

/**
 * Portal login - uses a separate endpoint for customer portal users
 */
export async function portalLogin(
  email: string,
  password: string
): Promise<{
  success: boolean;
  user?: PortalUser;
  tokens?: Tokens;
  error?: string;
}> {
  try {
    const orgId = typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('orgId')
      : null;
    const payload = orgId ? { email, password, orgId } : { email, password };

    const response = await fetch(buildPortalApiUrl('/portal/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: data.error || 'Login failed' };
    }

    const mappedUser: PortalUser = {
      id: data.user?.id,
      email: data.user?.email,
      name: data.user?.name ?? '',
      organizationId: data.user?.organizationId ?? data.user?.orgId,
      organizationName: data.user?.organizationName ?? data.user?.orgName ?? 'Organization',
      orgId: data.user?.orgId ?? data.user?.organizationId,
      orgName: data.user?.orgName ?? data.user?.organizationName
    };

    const expiresInSeconds = data.tokens?.expiresInSeconds
      ?? (typeof data.expiresAt === 'string'
        ? Math.max(1, Math.floor((new Date(data.expiresAt).getTime() - Date.now()) / 1000))
        : 86400);

    const tokens: Tokens = data.tokens ?? {
      accessToken: data.accessToken,
      refreshToken: data.accessToken,
      expiresInSeconds
    };

    return {
      success: true,
      user: mappedUser,
      tokens
    };
  } catch {
    return { success: false, error: 'Network error' };
  }
}

/**
 * Portal logout
 */
export async function portalLogout(): Promise<void> {
  const { tokens, logout } = usePortalAuth.getState();

  if (tokens?.accessToken) {
    try {
      await fetch(buildPortalApiUrl('/portal/auth/logout'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokens.accessToken}`
        }
      });
    } catch {
      // Ignore errors, logout anyway
    }
  }

  logout();
}

/**
 * Request password reset
 */
export async function portalForgotPassword(email: string): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const orgId = typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('orgId')
      : null;
    const payload = orgId ? { email, orgId } : { email };

    const response = await fetch(buildPortalApiUrl('/portal/auth/forgot-password'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
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

/**
 * Reset password with token
 */
export async function portalResetPassword(
  token: string,
  password: string
): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const response = await fetch(buildPortalApiUrl('/portal/auth/reset-password'), {
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

/**
 * Check if user is authenticated (client-side)
 */
export function isAuthenticated(): boolean {
  if (typeof window === 'undefined') return false;

  const { isAuthenticated } = usePortalAuth.getState();
  return isAuthenticated;
}

/**
 * Get current user (client-side)
 */
export function getCurrentUser(): PortalUser | null {
  if (typeof window === 'undefined') return null;

  const { user } = usePortalAuth.getState();
  return user;
}

/**
 * Require authentication - redirect to login if not authenticated
 */
export function requireAuth(): void {
  if (typeof window === 'undefined') return;

  const { isAuthenticated } = usePortalAuth.getState();
  if (!isAuthenticated) {
    window.location.href = '/login';
  }
}
