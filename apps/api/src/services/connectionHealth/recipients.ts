import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { users } from '../../db/schema';
import { resolvePartnerUsersWithPermission, resolveUsersWithPermissionForOrg } from '../usersWithPermission';
import { resolveCustomerAdminsNotified } from './customerDelivery';
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
 * Spec §4. Partner-scope holders of the repair permission (partner-wide
 * incidents: orgAccess = all only), plus the owner. For an org incident whose
 * org resolves `customerAdminsNotified` on (§6, W5), every holder for the org:
 * org members whose org role grants it as well. Partner-wide incidents never
 * reach org members. Must be called from system scope (background worker): the
 * setting and owner reads rely on the caller's context.
 */
export async function resolveIncidentRecipients(incident: {
  partnerId: string;
  orgId: string | null;
  ownerUserId: string | null;
  repairPermission: string;
}): Promise<{ admins: string[]; owner: string | null }> {
  const permission = permissionFromText(incident.repairPermission);
  const admins = incident.orgId && (await resolveCustomerAdminsNotified(incident.orgId))
    ? await resolveUsersWithPermissionForOrg(incident.orgId, permission)
    : await resolvePartnerUsersWithPermission(
        incident.partnerId,
        permission,
        incident.orgId ? { orgId: incident.orgId } : {},
      );
  const owner =
    incident.ownerUserId && (await activeUserIds([incident.ownerUserId])).length > 0
      ? incident.ownerUserId
      : null;
  return { admins: admins.filter((id) => id !== incident.ownerUserId), owner };
}
