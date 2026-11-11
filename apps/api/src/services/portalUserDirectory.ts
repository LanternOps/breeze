/**
 * Customer-portal login list (full-control W18, #6789): the read behind
 * `GET /organizations/:id/portal-users`, shared by that route and the
 * `list_portal_users` AI tool.
 *
 * `passwordHash` is selected only to derive `effectiveStatus` and never
 * leaves this module: `toListItem` drops it.
 *
 * External identities come from `portal_user_identities` (identities release
 * B, portal registration W3), read in a second statement, never from the
 * legacy `portal_users.entra_*` columns.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { organizations, portalUsers } from '../db/schema';
import type { PortalBrowserAccess, PortalIdentityProvider } from '../db/schema/portal';
import type { AuthContext } from '../middleware/auth';
import { PG_UUID_REGEX } from '../utils/uuid';
import { isPasswordEligible } from './portalAccountState';
import { listIdentityProvidersByUser } from './portalUserIdentities';

type PortalUserListRow = {
  id: string;
  email: string;
  name: string | null;
  passwordHash: string | null;
  status: string;
  receiveNotifications: boolean;
  lastLoginAt: Date | null;
  invitedAt: Date | null;
  contactId: string | null;
  authMethod: string;
  browserAccess: PortalBrowserAccess;
};

/**
 * 'disabled' wins. Otherwise 'pending_setup' only for a password-eligible
 * account that has neither a password nor an external identity — the one
 * kind of account that cannot sign in until it accepts an invite. Rows created
 * by an invite sit in DB status 'invited' with passwordHash null and read
 * 'pending_setup'. An identity is a credential, so an identity-only account
 * (AI for Office JIT login, approved SSO request) reads 'active' (W3).
 */
export function effectivePortalStatus(row: {
  status: string;
  passwordHash: string | null;
  authMethod: string;
  hasExternalIdentity: boolean;
}): 'active' | 'disabled' | 'pending_setup' {
  if (row.status === 'disabled') return 'disabled';
  if (isPasswordEligible(row) && !row.passwordHash && !row.hasExternalIdentity) return 'pending_setup';
  return 'active';
}

function toListItem(row: PortalUserListRow, identityProviders: PortalIdentityProvider[]) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    effectiveStatus: effectivePortalStatus({ ...row, hasExternalIdentity: identityProviders.length > 0 }),
    receiveNotifications: row.receiveNotifications,
    lastLoginAt: row.lastLoginAt,
    invitedAt: row.invitedAt,
    // The Contacts tab joins logins to contacts by `contactId` and counts only
    // password-method logins as portal access (portal registration W1, #11378).
    contactId: row.contactId,
    authMethod: row.authMethod,
    // Portal registration W3: browser portal access (separate from the
    // lifecycle status) and the external sign-in providers linked to the login.
    browserAccess: row.browserAccess,
    identityProviders,
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
    invitedAt: portalUsers.invitedAt,
    contactId: portalUsers.contactId,
    authMethod: portalUsers.authMethod,
    browserAccess: portalUsers.browserAccess
  }).from(portalUsers).where(eq(portalUsers.orgId, orgId)).orderBy(desc(portalUsers.createdAt));
  // Sequential, never Promise.all: the caller may hold one request transaction.
  const providers = await listIdentityProvidersByUser(db, rows.map((r) => r.id));
  return rows.map((row) => toListItem(row, providers.get(row.id) ?? []));
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
