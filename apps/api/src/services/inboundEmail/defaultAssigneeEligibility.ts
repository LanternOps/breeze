import { and, eq, ne } from 'drizzle-orm';
import { db } from '../../db';
import { partnerUsers, users } from '../../db/schema';
import { getUserPermissions, hasPermission, PERMISSIONS } from '../permissions';

/**
 * Whether `userId` may be saved as `partnerId`'s default inbound assignee.
 * The partner_id predicates are the tenant boundary (they hold even under a
 * system DB context), not RLS.
 */
export async function isAssignableInboundDefaultUser(userId: string, partnerId: string): Promise<boolean> {
  const [member] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(partnerUsers, and(eq(partnerUsers.userId, users.id), eq(partnerUsers.partnerId, partnerId)))
    .where(and(
      eq(users.id, userId),
      eq(users.partnerId, partnerId),
      eq(users.status, 'active'),
      ne(partnerUsers.orgAccess, 'none'),
    ))
    .limit(1);
  if (!member) return false;
  const perms = await getUserPermissions(userId, { partnerId }, { bypassCache: true });
  return !!perms && hasPermission(perms, PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action);
}
