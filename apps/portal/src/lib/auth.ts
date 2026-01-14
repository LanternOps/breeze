/**
 * Portal Auth Helpers
 * Authentication utilities for the customer portal
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface PortalUser {
  id: string;
  email: string;
  name: string;
  organizationId: string;
  organizationName: string;
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

const API_BASE = import.meta.env.PUBLIC_API_URL || '/api';

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
    const response = await fetch(`${API_BASE}/portal/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: data.error || 'Login failed' };
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

/**
 * Portal logout
 */
export async function portalLogout(): Promise<void> {
  const { tokens, logout } = usePortalAuth.getState();

  if (tokens?.accessToken) {
    try {
      await fetch(`${API_BASE}/portal/auth/logout`, {
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
    const response = await fetch(`${API_BASE}/portal/auth/forgot-password`, {
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
    const response = await fetch(`${API_BASE}/portal/auth/reset-password`, {
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
