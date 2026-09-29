import { and, eq, ne, sql, type SQL } from 'drizzle-orm';
import type { db } from '../../db';
import { devices, organizations } from '../../db/schema';
import {
  isUnassignedPoolOrgType,
  PARKED_DEVICE_ADMISSION_ENROLLMENT,
  PARKED_DEVICE_ADMISSION_GUC,
} from './orgType';
import { lockPartnerHoldingArea } from './holdingAreaLock';
import { PARKED_DEVICES_PER_PARTNER_MAX } from './limits';

/** Anything that can run one SQL statement on the caller's open transaction. */
export interface SqlExecutor {
  execute(query: SQL): Promise<unknown>;
}

/**
 * Declare that the device INSERT that follows, in the SAME transaction, is an
 * enrollment admission into a holding org. The
 * devices_unassigned_pool_insert_guard trigger refuses a holding-org device
 * INSERT without it.
 *
 * Always `is_local = true` (SET LOCAL semantics): the declaration unwinds at
 * COMMIT or ROLLBACK, so it can never outlive the admission and ride a pooled
 * connection into a later, unrelated transaction. Call it only inside a
 * transaction; outside one, a local setting lasts a single statement.
 */
export async function declareParkedDeviceAdmission(tx: SqlExecutor): Promise<void> {
  await tx.execute(
    sql`SELECT set_config(${PARKED_DEVICE_ADMISSION_GUC}, ${PARKED_DEVICE_ADMISSION_ENROLLMENT}, true)`,
  );
}

export type ParkedAdmissionTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The partner already holds PARKED_DEVICES_PER_PARTNER_MAX parked devices. */
export class ParkedCapReachedError extends Error {
  constructor(readonly partnerId: string, readonly parkedCount: number) {
    super(`This partner already has ${parkedCount} devices waiting for assignment (limit ${PARKED_DEVICES_PER_PARTNER_MAX})`);
    this.name = 'ParkedCapReachedError';
  }
}

/**
 * Admission of ONE new parked device, on the caller's open system-context
 * transaction, immediately before its device INSERT:
 *   1. the per-partner holding-area lock (held to commit, so concurrent
 *      admissions, assignments and expiries of this partner are serialised
 *      and the count below cannot go stale before the INSERT commits);
 *   2. `holdingOrgId` must be this partner's holding org;
 *   3. the live count of the holding org's devices that are not
 *      decommissioned, read under the lock — never a cached count;
 *   4. refuse at PARKED_DEVICES_PER_PARTNER_MAX, else declare the admission
 *      (the INSERT guard trigger accepts a holding-org device only after this).
 */
export async function admitParkedEnrollment(
  tx: ParkedAdmissionTx,
  input: { partnerId: string; holdingOrgId: string },
): Promise<{ parkedCount: number }> {
  await lockPartnerHoldingArea(tx, input.partnerId);

  const [org] = await tx
    .select({ partnerId: organizations.partnerId, type: organizations.type })
    .from(organizations)
    .where(eq(organizations.id, input.holdingOrgId))
    .limit(1);
  if (!org || org.partnerId !== input.partnerId || !isUnassignedPoolOrgType(org.type)) {
    throw new Error('parked admission: holding org is not this partner\'s holding org');
  }

  const [row] = await tx
    .select({ count: sql<number>`count(*)` })
    .from(devices)
    .where(and(eq(devices.orgId, input.holdingOrgId), ne(devices.status, 'decommissioned')));
  const parkedCount = Number(row?.count ?? 0);
  if (parkedCount >= PARKED_DEVICES_PER_PARTNER_MAX) {
    throw new ParkedCapReachedError(input.partnerId, parkedCount);
  }

  await declareParkedDeviceAdmission(tx);
  return { parkedCount };
}
