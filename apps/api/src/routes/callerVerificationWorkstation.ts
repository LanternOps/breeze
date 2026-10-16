/**
 * Caller verification workstation routes (#6354 W02).
 *
 *   GET /orgs/:orgId/caller-verifications/device-suggestions?contactId=
 *     → { data: DeviceSuggestion[] } — online devices in the caller's reach
 *       whose last login matches the contact, each with live helper
 *       readiness (`available`, optional `unavailableReason`).
 *
 * Registered by `routes/callerVerification.ts` on its own router BEFORE the
 * `${cv}/:id` route, with that router's middleware chain (auth → scope →
 * readiness gate → id validation → read permission), so it behaves exactly
 * like its siblings: 401 anonymous, 404 `feature_disabled` while dark, 403
 * without org read. Read-only: no MFA gate.
 */
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AuthContext } from '../middleware/auth';
import { canReachContactSite } from './orgContacts';
import { reachableContact } from '../services/callerVerification/access';
import { deviceSuggestions } from '../services/callerVerification/deviceSuggestions';
import { CallerVerificationValidationError } from '../services/callerVerification/errors';
import type { CallerVerificationActor } from '../services/callerVerification/types';

const querySchema = z.object({ contactId: z.string().uuid() });

export function registerCallerDeviceSuggestionsRoutes(
  router: Hono,
  // `base` is callerVerification.ts's fixed 4-step chain (auth, scope,
  // readiness gate, id check); a fixed-arity tuple keeps Hono's typed overloads.
  deps: {
    base: readonly [MiddlewareHandler, MiddlewareHandler, MiddlewareHandler, MiddlewareHandler];
    read: MiddlewareHandler;
    actor: (c: Context) => CallerVerificationActor;
  },
): void {
  router.get('/orgs/:orgId/caller-verifications/device-suggestions', ...deps.base, deps.read, async (c) => {
    const parsed = querySchema.safeParse({ contactId: c.req.query('contactId') });
    if (!parsed.success) return c.json({ error: 'Invalid identifier' }, 400);
    const orgId = c.req.param('orgId')!;
    const actor = deps.actor(c);
    // Same reach rule as the per-contact routes: org + site of the contact.
    const contact = await reachableContact(actor, orgId, parsed.data.contactId);
    if (!canReachContactSite(c.get('auth') as AuthContext, contact.siteId)) {
      throw new CallerVerificationValidationError('not_found', 'Contact not found');
    }
    return c.json({ data: await deviceSuggestions(actor, orgId, parsed.data.contactId) });
  });
}
