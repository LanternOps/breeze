import { and, asc, eq, ne } from 'drizzle-orm';
import { db } from '../../db';
import { partnerUsers, users } from '../../db/schema';
import { getUserPermissions, hasPermission, PERMISSIONS } from '../permissions';

/**
 * Who may be a partner's default inbound assignee
 * (settings.ticketing.inbound.defaultAssigneeUserId): an ACTIVE user of the
 * partner (users.partner_id) with a partner_users membership in it whose org
 * access is not 'none', and whose partner role grants tickets:read (the
 * permission every ticket assignment requires).
 *
 * The partner_id predicates are the tenant boundary and hold even under a
 * system DB context, not RLS. One contract for the save check and the card's
 * candidate list, so the picker never offers a user the save would refuse.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function activeMembers(partnerId: string) {
  return and(
    eq(users.partnerId, partnerId),
    eq(users.status, 'active'),
    ne(partnerUsers.orgAccess, 'none'),
  );
}

async function hasTicketRead(userId: string, partnerId: string, bypassCache: boolean): Promise<boolean> {
  const perms = await getUserPermissions(userId, { partnerId }, { bypassCache });
  return !!perms && hasPermission(perms, PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action);
}

/** Whether `userId` may be saved as `partnerId`'s default inbound assignee. */
export async function isAssignableInboundDefaultUser(userId: string, partnerId: string): Promise<boolean> {
  if (!UUID_RE.test(userId)) return false;
  const [member] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(partnerUsers, and(eq(partnerUsers.userId, users.id), eq(partnerUsers.partnerId, partnerId)))
    .where(and(eq(users.id, userId), activeMembers(partnerId)))
    .limit(1);
  if (!member) return false;
  return hasTicketRead(userId, partnerId, true);
}

/** Every user `partnerId` may pick as its default inbound assignee (the card's picker). */
export async function listAssignableInboundDefaultUsers(
  partnerId: string,
): Promise<Array<{ id: string; name: string | null; email: string }>> {
  const members = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .innerJoin(partnerUsers, and(eq(partnerUsers.userId, users.id), eq(partnerUsers.partnerId, partnerId)))
    .where(activeMembers(partnerId))
    .orderBy(asc(users.name), asc(users.email));
  const out: Array<{ id: string; name: string | null; email: string }> = [];
  for (const m of members) {
    if (await hasTicketRead(m.id, partnerId, false)) out.push(m);
  }
  return out;
}

/**
 * Validation for the system-scoped partner writes (POST /partners,
 * PATCH /partners/:id), whose `settings` body is free-form. Returns an error
 * message, or null when the value is absent, unchanged, cleared, or assignable.
 * A partner being created has no members yet, so any user is refused there.
 */
export async function defaultAssigneeSettingsError(
  incomingSettings: unknown,
  currentValue: string | null,
  partnerId: string | null,
): Promise<string | null> {
  const asRecord = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const inbound = asRecord(asRecord(incomingSettings).ticketing).inbound;
  const next = asRecord(inbound).defaultAssigneeUserId;
  if (next === undefined || next === null || next === currentValue) return null;
  if (typeof next !== 'string' || !UUID_RE.test(next)) return 'defaultAssigneeUserId must be a user id';
  if (!partnerId || !(await isAssignableInboundDefaultUser(next, partnerId))) {
    return 'defaultAssigneeUserId must be an active member of the partner who can be assigned tickets';
  }
  return null;
}
