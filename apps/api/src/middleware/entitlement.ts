import type { Context, MiddlewareHandler, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ENTITLEMENTS, type EntitlementKey } from '@breeze/shared';
import { EntitlementResolutionError, hasEntitlement } from '../services/entitlements';

/**
 * Gate a route on a partner entitlement (Partner Entitlements W1 §9, #9907).
 * Mount AFTER `authMiddleware`. Fails closed: a caller with no partner
 * (platform/system tokens) is denied without consulting the resolver.
 *
 * Denials are coded bodies via `c.json`, never `HTTPException`: the global
 * onError handler (index.ts) only forwards `err.message` for a caught
 * HTTPException, so a `code` set on the exception would never reach the
 * response body (same rationale as `requireMfa` in auth.ts). Clients branch on
 * `code`: `entitlement_required` (403, upsell) vs `entitlement_check_failed`
 * (503 + Retry-After, transient — the resolver is past its staleness ceiling).
 *
 * No route uses this in W1; Wisp W04 is the first consumer.
 */
export function requireEntitlement(key: EntitlementKey): MiddlewareHandler {
  const label = ENTITLEMENTS[key].label;
  return async (c: Context, next: Next) => {
    const auth = c.get('auth') as { partnerId?: string | null } | undefined;
    if (!auth) {
      throw new HTTPException(401, { message: 'Not authenticated' });
    }

    const partnerId = auth.partnerId ?? null;
    if (!partnerId) {
      return c.json({ code: 'entitlement_required', error: label, featureKey: key }, 403);
    }

    let entitled: boolean;
    try {
      entitled = await hasEntitlement(partnerId, key);
    } catch (err) {
      if (err instanceof EntitlementResolutionError) {
        c.header('Retry-After', '30');
        return c.json(
          { code: 'entitlement_check_failed', error: 'Entitlement check temporarily unavailable', featureKey: key },
          503
        );
      }
      throw err;
    }

    if (!entitled) {
      return c.json({ code: 'entitlement_required', error: label, featureKey: key }, 403);
    }
    await next();
  };
}
