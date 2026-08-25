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
 * The outcome of *attempting* to read the claims — deliberately a union, not
 * `JwtClaims & { resolved: boolean }`, so that `.claims` (and therefore `.scope`)
 * is unreachable until the caller has narrowed on `status`.
 *
 * `'unresolved'` means *unknown*, not *denied*: there is no access token in the
 * store yet, so a partner and an org user are indistinguishable. Access tokens
 * are deliberately never persisted (see `partialize` and `migrate` in
 * `stores/auth.ts` — only `user` and `isAuthenticated` survive a reload), so
 * every cold page load starts here and flips once the refresh cookie has been
 * exchanged. That window is not always brief: while `/auth/refresh` is rate
 * limited (#3696) the session is perfectly valid and yet tokenless for up to 90
 * seconds.
 *
 * Conflating `'unresolved'` with a denial is exactly what #4010 was, and a flat
 * `scope: null` invites precisely that — which is why the shape forces the
 * check. Code that merely HIDES ui on a denial can narrow and fail closed in one
 * line; code that DESTROYS state on a denial (clearing a deep-link hash,
 * redirecting, resetting a form) must act only on a genuine `'resolved'` denial.
 *
 * A present-but-undecodable token is `'resolved'` with all-null claims: we
 * looked, and the answer is "no claims". Note this is a client-side UX decision
 * only — it denies the partner-gated UI just as a real org token would, and is
 * NOT a replay of the server, which rejects an undecodable token outright with
 * a 401 rather than degrading the page.
 */
export type JwtClaimsState =
  | { status: 'unresolved' }
  | { status: 'resolved'; claims: JwtClaims };

// Both are shared singletons handed straight back to callers, so freeze them for
// real rather than relying on `Readonly<>`, which erases at runtime.
const NO_CLAIMS: Readonly<JwtClaims> = Object.freeze({ scope: null, orgId: null, partnerId: null });

const UNRESOLVED: Readonly<JwtClaimsState> = Object.freeze({ status: 'unresolved' as const });

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
 * component re-renders when it arrives after first paint, and returns a state
 * that keeps "no token yet" distinguishable from "token says no" (#4010).
 *
 * Prefer this over `getJwtClaims()` in any component. The one-shot read is only
 * correct where a stale answer cannot outlive the call (an event handler, a
 * request builder); captured into render state or a `[]`-dep memo it freezes the
 * empty-store answer for the life of the mount.
 */
export function useJwtClaims(): JwtClaimsState {
  const accessToken = useAuthStore((s) => s.tokens?.accessToken ?? null);
  return useMemo<JwtClaimsState>(
    () => (accessToken === null ? UNRESOLVED : { status: 'resolved', claims: decodeClaims(accessToken) }),
    [accessToken],
  );
}
