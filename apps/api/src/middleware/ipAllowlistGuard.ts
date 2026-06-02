import type { Context, Next } from 'hono';
import { enforceIpAllowlist } from '../services/ipAllowlist';
import { captureException } from '../services/sentry';

/**
 * Enforces the partner IP allowlist for an already-authenticated request.
 * Assumes c.get('auth') is set. Returns a 403 on deny; otherwise calls next().
 */
export async function ipAllowlistGuard(c: Context, next: Next): Promise<void | Response> {
  const auth = c.get('auth');
  let decision;
  try {
    decision = await enforceIpAllowlist(c, {
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
  if (decision.decision === 'deny') {
    return c.json({ code: 'ip_not_allowed', error: 'Access denied from this IP address' }, 403);
  }
  await next();
}
