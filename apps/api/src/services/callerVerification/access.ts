/**
 * Service-side reach checks. Hono middleware enforces permission/MFA; the
 * service independently enforces org and site reach so no route ordering
 * mistake can widen access (spec D12).
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { contacts } from '../../db/schema/contacts';
import type { CallerVerificationActor, BindingRow, CallerVerificationActionScope } from './types';
import { CallerVerificationValidationError as Invalid } from './errors';

export async function reachableContact(actor: CallerVerificationActor, orgId: string, id: string) {
  if (actor.accessibleOrgIds !== null && !actor.accessibleOrgIds.includes(orgId)) {
    throw new Invalid('not_found', 'Contact not found');
  }
  const [row] = await db.select().from(contacts).where(and(eq(contacts.id, id), eq(contacts.orgId, orgId))).limit(1);
  if (!row || (row.siteId !== null && actor.allowedSiteIds !== null && !actor.allowedSiteIds.includes(row.siteId))) {
    throw new Invalid('not_found', 'Contact not found');
  }
  return row;
}

/**
 * D15: who may authorize an action on a target subject.
 *  - `any` scope (a plain "is this you" challenge) needs no cross-subject authority.
 *  - Self-service: requester and target are the same canonical binding.
 *  - `disable_user` may be authorized by an org-level (site-less) contact
 *    holding one of the policy's authorizer roles. Site-level managers never
 *    authorize another account.
 */
export function requesterAuthorized(
  action: CallerVerificationActionScope,
  requester: BindingRow | null,
  target: BindingRow | null,
  contact: { siteId: string | null; roles: string[] },
  roles: string[],
): boolean {
  if (action === 'any') return requester === null || target === null || requester.id === target.id;
  if (!requester || !target || requester.revokedAt || target.revokedAt) return false;
  if (requester.id === target.id) return true;
  return action === 'disable_user' && contact.siteId === null && contact.roles.some((r) => roles.includes(r));
}
