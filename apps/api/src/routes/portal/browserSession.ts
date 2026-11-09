/**
 * Browser portal sessions and the access policy (portal registration W3 #11380,
 * plan D6; spec §6 invariants 8, 9 and 11).
 *
 * A stored session (Redis JSON or the in-memory map) records the sign-in
 * method that minted it. Every session minted before W3 is a password
 * session, so a payload without `method` parses as `'password'`; a method this
 * release does not know is refused. W3 mints only `'password'`, but the gate
 * already covers all three methods for W4 (entra) and W7 (google).
 *
 * `isBrowserSessionAllowed` is re-checked on every session request, so a
 * policy change (org or inherited partner default) ends a session on its very
 * next request (plan D1: no policy cache).
 */
import {
  PortalAccessPolicyOrgNotFoundError,
  isSignInMethodAllowed,
  resolvePortalAccessPolicy,
  type PortalSignInMethod,
  type ResolvedPortalAccessPolicy,
} from '../../services/portalAccessPolicy';
import { isPasswordEligible } from '../../services/portalAccountState';

export type PortalSessionMethod = PortalSignInMethod;

const PORTAL_SESSION_METHODS: ReadonlySet<string> = new Set<PortalSessionMethod>(['password', 'entra', 'google']);

export interface StoredPortalSession {
  portalUserId: string;
  orgId: string;
  authEpoch: number;
  method: PortalSessionMethod;
}

/** Redis/in-memory payload → session. Missing method → 'password' (pre-W3 sessions). Unknown method or bad shape → null. */
export function parseStoredPortalSession(raw: unknown): StoredPortalSession | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.portalUserId !== 'string' || typeof p.orgId !== 'string') return null;
  const authEpoch = p.authEpoch;
  if (typeof authEpoch !== 'number' || !Number.isSafeInteger(authEpoch) || authEpoch <= 0) return null;

  let method: PortalSessionMethod;
  if (p.method === undefined) {
    method = 'password';
  } else if (typeof p.method === 'string' && PORTAL_SESSION_METHODS.has(p.method)) {
    method = p.method as PortalSessionMethod;
  } else {
    return null;
  }
  return { portalUserId: p.portalUserId, orgId: p.orgId, authEpoch, method };
}

/**
 * The per-request browser gate (inv. 9). Every session needs browser access
 * granted and its own method allowed by the effective policy; a password
 * session also needs a password-eligible account. An unknown method fails
 * closed (`isSignInMethodAllowed`).
 */
export function isBrowserSessionAllowed(
  session: Pick<StoredPortalSession, 'method'>,
  user: { authMethod: string; browserAccess: string },
  policy: Pick<ResolvedPortalAccessPolicy, 'effective'>,
): boolean {
  if (user.browserAccess !== 'granted') return false;
  if (!isSignInMethodAllowed(policy, session.method)) return false;
  return session.method !== 'password' || isPasswordEligible(user);
}

/**
 * Whether the org's effective policy lets anyone use a password at all
 * (login, forgot-password, reset and invite consume). An org the resolver
 * cannot find is refused like `sso_only`, so every caller answers with its
 * ordinary generic failure (inv. 8). Any other error, SQL failures included,
 * propagates (fail closed).
 *
 * The one error caught is thrown in JS after a successful read (or before any
 * read, for a malformed id), so even under a held transaction it poisons
 * nothing and needs no `withDbTransaction`. Today every caller is a public
 * portal auth route or the session middleware's pre-transaction checks, so no
 * context is held and the resolver opens its own system context.
 */
export async function isPasswordSignInAllowedForOrg(orgId: string): Promise<boolean> {
  try {
    return isSignInMethodAllowed(await resolvePortalAccessPolicy(orgId), 'password');
  } catch (error) {
    if (error instanceof PortalAccessPolicyOrgNotFoundError) return false;
    throw error;
  }
}
