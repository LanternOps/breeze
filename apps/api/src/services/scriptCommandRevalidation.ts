/**
 * Delivery-time authority re-derivation for queued `script` commands.
 *
 * A `script` command may sit `pending` for up to a week waiting for an
 * offline device to reconnect (`commandOfflinePolicy.ts`). The requester's
 * role, org access and site reach were checked once, at queue time — this
 * rehydrates them from LIVE rows immediately before delivery, so a requester
 * who was demoted (role downgrade, narrowed partner org access, an added
 * site restriction, or removal from one of several orgs) after queueing the
 * command cannot have it delivered on their now-stale authority. Full
 * offboarding already cancels via `requester_inactive` in
 * `commandClaimEligibility.ts`; this covers what that check does not.
 *
 * A row with no requester identity (`createdBy === null`, e.g. an automation-
 * or AI-issued run) has no user authority to rehydrate and is left alone —
 * same scope as the existing `requester_inactive` check just above this one.
 *
 * The requester's membership and role grants are read through
 * `breeze_command_requester_authority` (migration 2026-12-09-100000), NOT
 * through `users` / `getUserPermissions`. On the heartbeat claim this runs on
 * the claim transaction under the AGENT's org-scoped context, which cannot see
 * a partner-level technician's `users` or `partner_users` row: a plain read
 * found no requester and cancelled every technician's queued script, and
 * `getUserPermissions` escalates to a second pooled connection while the claim
 * still holds this one (#1105). The resolver answers on this connection and
 * returns only the facts; the grant / org / site evaluation below is the same
 * app-layer code every request uses.
 */
import { eq, sql } from 'drizzle-orm';
import { devices } from '../db/schema';
import {
  registerCommandRevalidation,
  type ClaimCancelReason,
  type CommandRevalidationReader,
  type CommandRevalidationRow,
} from './commandClaimEligibility';
import { CommandTypes } from './commandTypes';
import {
  canAccessOrg,
  canAccessSite,
  hasPermission,
  PERMISSIONS,
  type Permission,
  type UserPermissions,
} from './permissions';

type AuthorityJson = {
  scope?: unknown;
  roleId?: unknown;
  orgAccess?: unknown;
  allowedOrgIds?: unknown;
  allowedSiteIds?: unknown;
  permissions?: unknown;
};

function listOrUndefined(value: unknown): string[] | undefined {
  if (value === null || value === undefined) return undefined;
  // A non-array value is passed through untouched so canAccessSite's
  // malformed-allowlist handling fails it closed (#6790) instead of it being
  // read as "unrestricted".
  return value as string[];
}

function isGrant(value: unknown): value is Permission {
  return !!value
    && typeof value === 'object'
    && typeof (value as Permission).resource === 'string'
    && typeof (value as Permission).action === 'string';
}

/**
 * Shapes the resolver's JSON into the `UserPermissions` that
 * `getUserPermissions(userId, { orgId, partnerId: users.partner_id })` builds
 * (same axis precedence, grants, org-access and site allowlists). Anything
 * unrecognised returns null, which the caller cancels on.
 */
export function toRequesterPermissions(raw: unknown, orgId: string): UserPermissions | null {
  const value = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  if (!value || typeof value !== 'object') return null;
  const authority = value as AuthorityJson;
  if (typeof authority.roleId !== 'string' || !Array.isArray(authority.permissions)) return null;

  const permissions = authority.permissions
    .filter(isGrant)
    .map((p) => ({ resource: p.resource, action: p.action }));

  if (authority.scope === 'organization') {
    return {
      permissions,
      partnerId: null,
      orgId,
      roleId: authority.roleId,
      scope: 'organization',
      allowedSiteIds: listOrUndefined(authority.allowedSiteIds),
    };
  }

  if (authority.scope === 'partner') {
    const { orgAccess } = authority;
    if (orgAccess !== 'all' && orgAccess !== 'selected' && orgAccess !== 'none') return null;
    return {
      permissions,
      partnerId: null,
      orgId,
      roleId: authority.roleId,
      scope: 'partner',
      orgAccess,
      allowedOrgIds: listOrUndefined(authority.allowedOrgIds),
    };
  }

  return null;
}

/**
 * Savepointed like `resolveRequesterActive` in commandClaimEligibility.ts, so a
 * failure leaves the claim transaction usable and the caller can hold the row.
 */
async function readRequesterAuthority(
  reader: CommandRevalidationReader,
  userId: string,
  orgId: string,
): Promise<unknown> {
  return reader.transaction(async (sp) => {
    const rows = (await sp.execute(
      sql`SELECT public.breeze_command_requester_authority(${userId}::uuid, ${orgId}::uuid) AS authority`,
    )) as unknown as Array<{ authority: unknown }>;
    return rows[0]?.authority ?? null;
  });
}

export async function revalidateScriptCommandAuthority(
  reader: CommandRevalidationReader,
  row: CommandRevalidationRow,
): Promise<ClaimCancelReason | null> {
  if (!row.createdBy) return null;

  const [device] = await reader
    .select({ orgId: devices.orgId, siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.id, row.deviceId))
    .limit(1);
  if (!device) return 'scope_changed';

  const perms = toRequesterPermissions(
    await readRequesterAuthority(reader, row.createdBy, device.orgId),
    device.orgId,
  );
  if (!perms) return 'scope_changed';
  if (!hasPermission(perms, PERMISSIONS.SCRIPTS_EXECUTE.resource, PERMISSIONS.SCRIPTS_EXECUTE.action)) return 'scope_changed';
  if (!canAccessOrg(perms, device.orgId)) return 'scope_changed';
  if (!canAccessSite(perms, device.siteId)) return 'scope_changed';

  return null;
}

registerCommandRevalidation(CommandTypes.SCRIPT, revalidateScriptCommandAuthority);
