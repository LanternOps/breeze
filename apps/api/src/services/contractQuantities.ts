import { and, eq, ne, count, countDistinct, inArray } from 'drizzle-orm';
import { db } from '../db';
import { devices, organizationUsers, users } from '../db/schema';
import type { DeviceRole } from '@breeze/shared';
import { ContractServiceError } from './contractTypes';
import { resolveEffectiveGroupMembers, type GroupForResolution } from './groupMembership';
import type { GroupMembers } from './contractCoverage';

/** The one set of "is this device billable" predicates. Every device count and
 *  the snapshot below MUST use it — never fork these conditions. */
function billableDeviceConds(orgId: string) {
  return [
    eq(devices.orgId, orgId),
    ne(devices.status, 'decommissioned' as never),
    // Quick Support ephemeral devices: an ad-hoc support session must never
    // bill a customer for a machine that existed for twenty minutes.
    eq(devices.isEphemeral, false),
  ];
}

/** Billable device count for an org, optionally narrowed to a site and/or a set
 *  of device roles (#3205). Excludes decommissioned + ephemeral.
 *  Not on the contract/invoice billing path any more (that uses
 *  `snapshotContractDevices` + `contractCoverage`); current callers are the
 *  AI-agent device-count budget checks (`actionIntents/exposureBudget.ts`,
 *  `aiAgents/actRevalidation.ts`). The optional `roles` filter has no production caller yet.
 *  Must be called inside a db access context (system for the worker, request otherwise). */
export async function countContractDevices(
  orgId: string,
  siteId: string | null,
  roles?: readonly DeviceRole[],
): Promise<number> {
  if (roles !== undefined && roles.length === 0) {
    throw new ContractServiceError('countContractDevices: roles must be non-empty when provided', 500, 'INVALID_STATE');
  }
  const conds = billableDeviceConds(orgId);
  if (siteId) conds.push(eq(devices.siteId, siteId));
  if (roles) conds.push(inArray(devices.deviceRole, [...roles]));
  const [row] = await db.select({ n: count() }).from(devices).where(and(...conds));
  return Number(row?.n ?? 0);
}

export interface DeviceSnapshotRow {
  id: string;
  role: string;
  siteId: string | null;
}

/** One snapshot of the org's billable devices, one row per device. Every
 *  device-counted quantity on a contract — and the coverage warning — derives
 *  from this single query, so a device reclassified between two per-line COUNTs
 *  can no longer be billed twice (or not at all) on the same invoice (#3205).
 *  Per-device (not grouped) since W02: group membership, role and site compose
 *  per device in contractCoverage. */
export async function snapshotContractDevices(orgId: string): Promise<DeviceSnapshotRow[]> {
  return db
    .select({ id: devices.id, role: devices.deviceRole, siteId: devices.siteId })
    .from(devices)
    .where(and(...billableDeviceConds(orgId)));
}

/** The one billable device, as the snapshot sees it — the single-device twin of
 *  snapshotContractDevices, sharing billableDeviceConds so a fourth predicate
 *  added later applies to the device coverage panel automatically (#3205 W06).
 *  null = decommissioned, ephemeral, in another org, or gone. */
export async function billableDeviceById(deviceId: string, orgId: string): Promise<DeviceSnapshotRow | null> {
  const [row] = await db
    .select({ id: devices.id, role: devices.deviceRole, siteId: devices.siteId })
    .from(devices)
    .where(and(...billableDeviceConds(orgId), eq(devices.id, deviceId)))
    .limit(1);
  return row ?? null;
}

/** Members of one group as billing sees them: matched ∪ pinned from the shared
 *  resolver. The intersection with the billable snapshot happens in
 *  contractCoverage (it iterates snapshot rows), so a decommissioned, ephemeral
 *  or moved-out device never counts whatever table or filter produced it.
 *  Throws GroupEvaluationError; the service maps it to GROUP_EVALUATION_FAILED. */
export async function groupMembersForBilling(group: GroupForResolution): Promise<GroupMembers> {
  const { matched, pinned } = await resolveEffectiveGroupMembers(group);
  return { siteId: group.siteId, memberIds: new Set([...matched, ...pinned]) };
}

/** Active-seat count for an org: distinct active users mapped via organization_users. */
export async function countContractSeats(orgId: string): Promise<number> {
  const [row] = await db.select({ n: countDistinct(organizationUsers.userId) })
    .from(organizationUsers)
    .innerJoin(users, eq(users.id, organizationUsers.userId))
    .where(and(eq(organizationUsers.orgId, orgId), eq(users.status, 'active' as never)));
  return Number(row?.n ?? 0);
}
