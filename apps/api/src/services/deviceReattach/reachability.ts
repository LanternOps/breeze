/**
 * Which devices a reattach requester may even name (#8318 wave 2-2, review).
 *
 * The request answers every device it may not reach with ONE 404
 * `device_not_found`, byte-identical to a device that does not exist, BEFORE
 * any row lock and before any state-specific refusal (`org_draining`,
 * `target_ineligible`, …). Without this, any partner user could learn that a
 * device of another partner, or of an org outside their reach, exists and in
 * what state, and could take `FOR UPDATE` on its row.
 *
 * Reachable means: the device's org belongs to the requester's partner, and
 *  - a full partner admin (`org_access = 'all'`): any org of the partner,
 *    the holding org and Quick Support orgs included (the state refusals
 *    answer those precisely);
 *  - a technician limited to selected orgs: an org in their LIVE reachable
 *    set (access.ts: active/trial, undeleted, never the holding org). One
 *    exception, so today's answer stays: a PARKED SOURCE passes, and the
 *    access rule then refuses it with 403 `full_admin_required` (§9.3).
 *
 * The request runs this check twice: unlocked, before its transaction (no
 * lock for an unreachable id), and again under the row locks, where it is
 * authoritative (a row can move between the two).
 */
import { eq, inArray } from 'drizzle-orm';
import type { db } from '../../db';
import { devices, organizations } from '../../db/schema';
import { isUnassignedPoolOrgType } from '../unassignedPool/orgType';
import type { ReattachActorAccess } from './access';

export interface ReattachDeviceLocation {
  id: string;
  orgId: string;
  orgPartnerId: string;
  orgType: string | null;
}

/** Pure. False for a missing device, one of another partner, or one outside the requester's reach. */
export function isReattachDeviceReachable(
  actor: ReattachActorAccess | null,
  partnerId: string,
  device: ReattachDeviceLocation | undefined,
  role: 'source' | 'target',
): boolean {
  if (!device || device.orgPartnerId !== partnerId) return false;
  const membership = actor?.membership;
  if (!membership) return false;
  if (membership.orgAccess === 'all') return true;
  if (membership.orgAccess !== 'selected') return false;
  if (role === 'source' && isUnassignedPoolOrgType(device.orgType)) return true;
  return membership.reachableOrgIds.includes(device.orgId);
}

type Exec = Pick<typeof db, 'select'>;

/** Where the devices are, unlocked. Ids that do not exist are simply absent. */
export async function readReattachDeviceLocations(
  exec: Exec,
  deviceIds: readonly string[],
): Promise<Map<string, ReattachDeviceLocation>> {
  const rows = await exec
    .select({ id: devices.id, orgId: devices.orgId, orgPartnerId: organizations.partnerId, orgType: organizations.type })
    .from(devices)
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .where(inArray(devices.id, [...new Set(deviceIds)]));
  return new Map(rows.map((row) => [row.id, row]));
}
