import { useAuthStore } from '../stores/auth';

export interface JwtClaims {
  scope: 'system' | 'partner' | 'organization' | null;
  orgId: string | null;
  partnerId: string | null;
}

const NO_CLAIMS: Readonly<JwtClaims> = { scope: null, orgId: null, partnerId: null };

/**
 * Decode the access-token claims WITHOUT verification. Browser-side only, used
 * to avoid known 403s (partner-only endpoints under org scope) and to pre-fill
 * context — never as an authorization decision; the server re-checks everything.
 * Returns all-null when the token is absent or undecodable; callers must fall
 * through to server behavior in that case.
 */
export function getJwtClaims(): JwtClaims {
  const token = useAuthStore.getState().tokens?.accessToken;
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

/** Login URL that round-trips the current location through LoginPage's ?next= handling. */
export function loginPathWithNext(): string {
  if (typeof window === 'undefined') return '/login';
  const here = window.location.pathname + window.location.search + window.location.hash;
  return here && here !== '/' ? `/login?next=${encodeURIComponent(here)}` : '/login';
}
