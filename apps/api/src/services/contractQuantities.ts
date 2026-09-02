import { and, eq, ne, count, countDistinct, inArray } from 'drizzle-orm';
import { db } from '../db';
import { devices, organizationUsers, users } from '../db/schema';
import type { DeviceRole } from '@breeze/shared';
import { ContractServiceError } from './contractTypes';

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
  role: string;
  siteId: string | null;
  n: number;
}

/** One snapshot of the org's billable devices grouped by (role, site). Every
 *  device-counted quantity on a contract — and the coverage warning — derives
 *  from this single query, so a device reclassified between two per-line COUNTs
 *  can no longer be billed twice (or not at all) on the same invoice (#3205). */
export async function snapshotContractDevices(orgId: string): Promise<DeviceSnapshotRow[]> {
  const rows = await db
    .select({ role: devices.deviceRole, siteId: devices.siteId, n: count() })
    .from(devices)
    .where(and(...billableDeviceConds(orgId)))
    .groupBy(devices.deviceRole, devices.siteId);
  return rows.map((r) => ({ role: r.role, siteId: r.siteId, n: Number(r.n) }));
}

/** Active-seat count for an org: distinct active users mapped via organization_users. */
export async function countContractSeats(orgId: string): Promise<number> {
  const [row] = await db.select({ n: countDistinct(organizationUsers.userId) })
    .from(organizationUsers)
    .innerJoin(users, eq(users.id, organizationUsers.userId))
    .where(and(eq(organizationUsers.orgId, orgId), eq(users.status, 'active' as never)));
  return Number(row?.n ?? 0);
}
