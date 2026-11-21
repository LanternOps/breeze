import { ne, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { devices, organizations } from '../../db/schema';
import { UNASSIGNED_POOL_ORG_TYPE } from './orgType';

/**
 * Selector predicates that keep devices parked in a holding org
 * (`organizations.type = 'unassigned_pool'`) out of every scheduled job,
 * worker, fan-out and AI device lookup.
 *
 * EXECUTION predicates. Never use them to decide visibility, and never replace
 * them with a hidden-org-type list: Quick Support devices are hidden from
 * listings but remain remote-capable and selectable by their own flows.
 *
 * `src/__tests__/parkedFanout.contract.test.ts` requires every module that
 * selects target devices in the background to reference one of these (or
 * `UNASSIGNED_POOL_ORG_TYPE` next to an organizations join), or to be
 * classified there with a reason.
 *
 * Visibility note: the subquery reads `organizations` in the caller's context.
 * That is exact wherever the device row itself is visible, because both tables
 * gate on the same `breeze_has_org_access(org id)` — a caller that can read a
 * device can read its org. Use `isParkedDevice` (definer-rights) instead when
 * the question is about a device id the caller may not be able to see.
 */

/**
 * `NOT EXISTS (a holding org with this id)` for any org-id column: an aliased
 * devices table, a denormalized child table's `org_id`, `sites.org_id`, or a
 * raw fragment (`sql.raw('d.org_id')`) for hand-written SQL.
 */
export function notInHoldingOrgCondition(orgIdColumn: AnyColumn | SQL): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM organizations parked_org WHERE parked_org.id = ${orgIdColumn} AND parked_org.type = 'unassigned_pool')`;
}

/** Devices whose org is not a holding org. Defaults to `devices.org_id`. */
export function notParkedDeviceCondition(orgIdColumn: AnyColumn | SQL = devices.orgId): SQL {
  return notInHoldingOrgCondition(orgIdColumn);
}

/** The org-join form, for queries that already join or enumerate `organizations`. */
export function notHoldingOrgCondition(): SQL {
  return ne(organizations.type, UNASSIGNED_POOL_ORG_TYPE);
}
