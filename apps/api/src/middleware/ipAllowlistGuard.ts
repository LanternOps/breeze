import type { Context, Next } from 'hono';
import { enforceIpAllowlist, IP_NOT_ALLOWED_BODY, isBlocked } from '../services/ipAllowlist';
import { captureException } from '../services/sentry';

/** Caller identity the allowlist decision is made against. */
export interface IpAllowlistIdentity {
  partnerId: string | null;
  isPlatformAdmin: boolean;
  actorId: string | null;
  actorEmail: string | null;
}

/**
 * Enforces the partner IP allowlist for an already-authenticated request.
 * Defaults to the identity on c.get('auth'). Returns a 403 on deny; otherwise
 * calls next(). Agent routes are exempt because agent authentication never
 * passes through authMiddleware; partner-scoped API-key/MCP callers enforce
 * this separately.
 *
 * `identity` lets a non-`auth` principal (e.g. the Office add-in technician
 * session, which deliberately sets `officeAddinAuth` instead of `auth` so its
 * opaque token can never satisfy authMiddleware-gated routes) be evaluated
 * against its own partner. Without it, `enforceIpAllowlist` sees a null
 * partnerId, returns `skip: no_partner`, and the partner's allowlist is
 * silently bypassed on that whole route family.
 */
export async function ipAllowlistGuard(
  c: Context,
  next: Next,
  identity?: IpAllowlistIdentity
): Promise<void | Response> {
  const auth = c.get('auth');
  let decision;
  try {
    decision = await enforceIpAllowlist(c, identity ?? {
      partnerId: auth?.partnerId ?? null,
      isPlatformAdmin: auth?.user?.isPlatformAdmin === true,
      actorId: auth?.user?.id ?? null,
      actorEmail: auth?.user?.email ?? null,
    });
  } catch (err) {
    console.error('[ipAllowlistGuard] IP allowlist check failed:', err);
    captureException(err, c);
    return c.json({ code: 'ip_check_failed', error: 'Access temporarily unavailable' }, 503);
  }
  if (isBlocked(decision)) {
    return c.json(IP_NOT_ALLOWED_BODY, 403);
  }
  await next();
}
