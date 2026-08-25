import { useMemo } from 'react';
import { useAuthStore } from '../stores/auth';
import { loginPathWithNext } from './authNext';

export { loginPathWithNext };

export interface JwtClaims {
  scope: 'system' | 'partner' | 'organization' | null;
  orgId: string | null;
  partnerId: string | null;
}

/**
 * Claims plus an explicit "we have actually looked at a token" bit.
 *
 * `resolved: false` means *unknown*, not *denied*: there is no access token in
 * the store yet, so every field is null for a partner and an org user alike.
 * Access tokens are deliberately never persisted (see `partialize` in
 * `stores/auth.ts` — only `user` and `isAuthenticated` survive a reload), so on
 * every cold page load `resolved` starts false and flips once the refresh cookie
 * has been exchanged. Callers that would otherwise destroy state on a denial
 * (clearing a deep-link hash, redirecting) must wait for `resolved` before
 * treating a null scope as a "no".
 *
 * A present-but-undecodable token counts as resolved: we looked, and the answer
 * is "no claims", which fails closed the same way the server would.
 */
export interface ResolvedJwtClaims extends JwtClaims {
  resolved: boolean;
}

const NO_CLAIMS: Readonly<JwtClaims> = { scope: null, orgId: null, partnerId: null };

function decodeClaims(token: string | null | undefined): JwtClaims {
  if (!token) return NO_CLAIMS;
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return {
      scope:
        payload.scope === 'system' || payload.scope === 'partner' || payload.scope === 'organization'
          ? payload.scope
          : null,
      orgId: typeof payload.orgId === 'string' ? payload.orgId : null,
      partnerId: typeof payload.partnerId === 'string' ? payload.partnerId : null,
    };
  } catch {
    return NO_CLAIMS;
  }
}

/**
 * Decode the access-token claims WITHOUT verification. Browser-side only, used
 * to avoid known 403s (partner-only endpoints under org scope) and to pre-fill
 * context — never as an authorization decision; the server re-checks everything.
 * Returns all-null when the token is absent or undecodable; callers must fall
 * through to server behavior in that case.
 *
 * This is a one-shot read of a store that is EMPTY on every cold load. A
 * component that renders a scope-dependent decision — and especially one that
 * writes that decision back to the URL — wants `useJwtClaims()` instead, which
 * re-renders when the token lands and reports whether the scope is known yet.
 */
export function getJwtClaims(): JwtClaims {
  return decodeClaims(useAuthStore.getState().tokens?.accessToken);
}

/**
 * Reactive form of `getJwtClaims()`: subscribes to the access token, so the
 * component re-renders when the token arrives after first paint, and reports
 * `resolved` so a null scope can be told apart from a denied one (#4010).
 */
export function useJwtClaims(): ResolvedJwtClaims {
  const accessToken = useAuthStore((s) => s.tokens?.accessToken ?? null);
  return useMemo(
    () => ({ ...decodeClaims(accessToken), resolved: accessToken !== null }),
    [accessToken],
  );
}
