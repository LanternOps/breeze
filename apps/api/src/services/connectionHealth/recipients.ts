import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { users } from '../../db/schema';
import { resolvePartnerUsersWithPermission } from '../usersWithPermission';
import { permissionFromText } from './store';

async function activeUserIds(ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, [...ids]), eq(users.status, 'active')));
  return rows.map((r) => r.id);
}

/**
 * Spec §4 (W1: customer admins off — partner-scope recipients only, plus the owner).
 * Must be called from system scope (background worker): the admin read escapes to
 * system itself, the owner status lookup relies on the caller's context.
 */
export async function resolveIncidentRecipients(incident: {
  partnerId: string;
  orgId: string | null;
  ownerUserId: string | null;
  repairPermission: string;
}): Promise<{ admins: string[]; owner: string | null }> {
  const admins = await resolvePartnerUsersWithPermission(
    incident.partnerId,
    permissionFromText(incident.repairPermission),
    incident.orgId ? { orgId: incident.orgId } : {},
  );
  const owner =
    incident.ownerUserId && (await activeUserIds([incident.ownerUserId])).length > 0
      ? incident.ownerUserId
      : null;
  return { admins: admins.filter((id) => id !== incident.ownerUserId), owner };
}
