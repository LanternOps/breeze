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
 */
import { eq } from 'drizzle-orm';
import { devices, users } from '../db/schema';
import {
  registerCommandRevalidation,
  type ClaimCancelReason,
  type CommandRevalidationReader,
  type CommandRevalidationRow,
} from './commandClaimEligibility';
import { CommandTypes } from './commandTypes';
import { canAccessOrg, canAccessSite, getUserPermissions, hasPermission, PERMISSIONS } from './permissions';

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

  const [requester] = await reader
    .select({ partnerId: users.partnerId })
    .from(users)
    .where(eq(users.id, row.createdBy))
    .limit(1);
  if (!requester) return 'scope_changed';

  const perms = await getUserPermissions(row.createdBy, { orgId: device.orgId, partnerId: requester.partnerId });
  if (!perms) return 'scope_changed';
  if (!hasPermission(perms, PERMISSIONS.SCRIPTS_EXECUTE.resource, PERMISSIONS.SCRIPTS_EXECUTE.action)) return 'scope_changed';
  if (!canAccessOrg(perms, device.orgId)) return 'scope_changed';
  if (!canAccessSite(perms, device.siteId)) return 'scope_changed';

  return null;
}

registerCommandRevalidation(CommandTypes.SCRIPT, revalidateScriptCommandAuthority);
