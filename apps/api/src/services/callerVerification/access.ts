/**
 * Service-side reach checks. Hono middleware enforces permission/MFA; the
 * service independently enforces org and site reach so no route ordering
 * mistake can widen access (spec D12).
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { contacts } from '../../db/schema/contacts';
import { resolveContactResponsibility } from '../contacts/responsibilities';
import { CONTACT_ROLES, type ContactRole } from '../contacts/types';
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
 *  - `disable_user` may be authorized only by a contact holding an explicit
 *    Organization-scoped responsibility named by the policy. Site/Group
 *    responsibilities never authorize another account at organization level.
 */
export async function requesterAuthorized(
  action: CallerVerificationActionScope,
  requester: BindingRow | null,
  target: BindingRow | null,
  orgId: string,
  contactId: string,
  roles: string[],
): Promise<boolean> {
  if (action === 'any') return requester === null || target === null || requester.id === target.id;
  if (!requester || !target || requester.revokedAt || target.revokedAt) return false;
  if (requester.id === target.id) return true;
  if (action !== 'disable_user') return false;

  const allowed = new Set<string>(CONTACT_ROLES);
  for (const role of roles) {
    if (!allowed.has(role)) continue;
    const resolved = await resolveContactResponsibility(db, { orgId, role: role as ContactRole });
    if (resolved.level === 'organization' && resolved.assignments.some((assignment) => assignment.contactId === contactId)) {
      return true;
    }
  }
  return false;
}
