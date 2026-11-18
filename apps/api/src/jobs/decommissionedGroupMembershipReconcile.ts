/**
 * #9933 — one-time, idempotent boot reconcile for devices removed BEFORE
 * dynamic groups started leaving decommissioned devices out.
 *
 * Decommission and restore now enqueue a re-evaluation going forward
 * (services/deviceDecommission.ts, services/deviceLifecycle.ts), but a device
 * that was already removed when that shipped kept its non-pinned dynamic rows
 * until someone next saved the group. This pass finds every decommissioned
 * device that still has a non-pinned row in a dynamic group and enqueues the
 * same `device.created` re-evaluation the decommission path uses. The rule
 * (which rows go, pinned and static rows stay) therefore lives only in
 * groupMembership.ts — this file never deletes a row itself.
 *
 * - The read runs under its OWN system DB context (`runOutsideDbContext` +
 *   `withSystemDbAccessContext`): no auth context at boot, and it must see
 *   every tenant. The enqueue happens after that context closes, so no
 *   connection is held across Redis I/O.
 * - Safe on every boot and every replica: once the jobs run, the query returns
 *   nothing; concurrent replicas coalesce on the per-device job id.
 * - One device failing to enqueue (Redis blip) costs only that device; the next
 *   boot picks it up again.
 */
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
// Direct module import, not the schema barrel.
import { deviceGroupMemberships, deviceGroups, devices } from '../db/schema/devices';
import { scheduleDeviceGroupReevaluation, type DeviceGroupReevaluationRequest } from './deviceGroupJobs';

export interface DecommissionedMembershipReconcileResult {
  scanned: number;
  enqueued: number;
  failed: number;
}

export const DECOMMISSIONED_MEMBERSHIP_RECONCILE_REASON = 'decommissioned_membership_reconcile';

export async function reconcileDecommissionedDynamicMemberships(
  enqueue: (request: DeviceGroupReevaluationRequest) => Promise<unknown> = scheduleDeviceGroupReevaluation,
): Promise<DecommissionedMembershipReconcileResult> {
  const stale = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .selectDistinct({ deviceId: devices.id, orgId: devices.orgId })
    .from(deviceGroupMemberships)
    .innerJoin(devices, eq(devices.id, deviceGroupMemberships.deviceId))
    .innerJoin(deviceGroups, eq(deviceGroups.id, deviceGroupMemberships.groupId))
    .where(and(
      eq(devices.status, 'decommissioned'),
      eq(deviceGroups.type, 'dynamic'),
      eq(deviceGroupMemberships.isPinned, false),
    ))));

  const result: DecommissionedMembershipReconcileResult = { scanned: stale.length, enqueued: 0, failed: 0 };
  for (const row of stale) {
    try {
      await enqueue({
        deviceId: row.deviceId,
        orgId: row.orgId,
        eventType: 'device.created',
        reason: DECOMMISSIONED_MEMBERSHIP_RECONCILE_REASON,
      });
      result.enqueued += 1;
    } catch (error) {
      result.failed += 1;
      console.error('[decommissionedGroupMembershipReconcile] could not enqueue re-evaluation', {
        deviceId: row.deviceId, error,
      });
    }
  }
  return result;
}
