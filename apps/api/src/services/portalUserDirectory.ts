/**
 * Customer-portal login list (full-control W18, #6789): the read behind
 * `GET /organizations/:id/portal-users`, shared by that route and the
 * `list_portal_users` AI tool.
 *
 * `passwordHash` is selected only to derive `effectiveStatus` and never
 * leaves this module: `toListItem` drops it.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { organizations, portalUsers } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { PG_UUID_REGEX } from '../utils/uuid';

type PortalUserListRow = {
  id: string;
  email: string;
  name: string | null;
  passwordHash: string | null;
  status: string;
  receiveNotifications: boolean;
  lastLoginAt: Date | null;
  invitedAt: Date | null;
};

// A portal user is 'active' only once they've actually set a password
// (accepted their invite) AND aren't administratively disabled. Rows
// created by an invite sit in DB status 'invited' with passwordHash
// null — those must read back as 'pending_setup', not 'active'.
export function effectivePortalStatus(row: { status: string; passwordHash: string | null }): 'active' | 'disabled' | 'pending_setup' {
  if (row.status === 'disabled') return 'disabled';
  if (!row.passwordHash) return 'pending_setup';
  return 'active';
}

function toListItem(row: PortalUserListRow) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    effectiveStatus: effectivePortalStatus(row),
    receiveNotifications: row.receiveNotifications,
    lastLoginAt: row.lastLoginAt,
    invitedAt: row.invitedAt
  };
}

export type PortalUserListItem = ReturnType<typeof toListItem>;

/** Every portal login of one organization, newest first. Access is the caller's job. */
export async function listPortalUsersForOrg(orgId: string): Promise<PortalUserListItem[]> {
  const rows = await db.select({
    id: portalUsers.id,
    email: portalUsers.email,
    name: portalUsers.name,
    passwordHash: portalUsers.passwordHash,
    status: portalUsers.status,
    receiveNotifications: portalUsers.receiveNotifications,
    lastLoginAt: portalUsers.lastLoginAt,
    invitedAt: portalUsers.invitedAt
  }).from(portalUsers).where(eq(portalUsers.orgId, orgId)).orderBy(desc(portalUsers.createdAt));
  return rows.map(toListItem);
}

/**
 * `listPortalUsersForOrg` behind the route's `resolveAccessibleOrg`: any
 * non-system caller only within its allowlist, and only a live (non-deleted) org. A
 * malformed id, an inaccessible org and a missing one are the same null.
 * Scope (partner or system) is enforced by the caller.
 */
export async function listPortalUsersForCaller(
  auth: Pick<AuthContext, 'scope' | 'canAccessOrg'>,
  orgId: string,
): Promise<PortalUserListItem[] | null> {
  if (!PG_UUID_REGEX.test(orgId)) return null;
  if (auth.scope !== 'system' && !auth.canAccessOrg(orgId)) return null;
  const [org] = await db.select({ id: organizations.id }).from(organizations)
    .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt))).limit(1);
  if (!org) return null;
  return listPortalUsersForOrg(orgId);
}
