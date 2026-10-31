/**
 * What deleting or disabling an Update Ring does to patch work already queued
 * from it (#8909 item 2).
 *
 * Product decision: work that has NOT yet been dispatched to a device is
 * cancelled, with a reason the UI and the audit show; an install already
 * delivered to (or running on) a device is left to finish and its result is
 * recorded normally. Re-enabling the ring does not resurrect anything.
 *
 * Two layers enforce it, and they meet on one row lock:
 *
 *  1. Delete time (this module). In the same transaction that flips the ring to
 *     `enabled = false`, `cancelQueuedRingPatchWork` cancels
 *       - every `scheduled` job from the ring (nothing fanned out yet), with a
 *         skipped summary row per target device carrying the reason, and
 *       - every `install_patches` command of a running job from the ring that
 *         is still `pending` (queued for an offline device, or online but not
 *         yet claimed). The shared cancel path terminalises its
 *         `patch_job_results` rows and counters through the patch finalizer.
 *     A `sent` command has reached the agent and is left alone.
 *  2. Dispatch time (`jobs/patchJobExecutor.ts` `prepareDeviceExecution`). A
 *     device job of a running job re-reads the ring `FOR SHARE`, in the same
 *     transaction that creates the device command, and skips the device with
 *     `ring_unavailable` when the ring is disabled or missing.
 *
 * WHY THE RACE IS CLOSED. The ring row is the serialisation point. The executor
 * holds it FOR SHARE from its ring check until its command is committed; the
 * delete's UPDATE (and the FOR UPDATE below) conflicts with that lock. So
 * either the executor locks first — the delete waits for the command to commit,
 * and the sweep below, a later statement in READ COMMITTED, sees it and cancels
 * it if it is still `pending` — or the delete locks first, and the executor's
 * locking read waits for the delete to commit and then sees `enabled = false`.
 * No ordering lets a command be created against a disabled ring and escape the
 * sweep. Scheduled jobs race only with the orchestrator's claim, which is a CAS
 * on `status = 'scheduled'`; whichever UPDATE commits first wins the row, and a
 * job the claim won fans out into device jobs that hit layer 2.
 *
 * CONTEXT. Runs on the request path, in the caller's transaction. Callers MUST
 * be full-partner administrators (`canManagePartnerWidePolicies`) or system
 * scope — the update-ring write routes are gated so — because RLS narrows
 * `patch_jobs` / `device_commands` to the caller's accessible orgs, and a
 * restricted caller would cancel only part of the ring's work. Anything the
 * sweep cannot see is still stopped at dispatch time by layer 2, except an
 * install already queued for an offline device in an org the caller cannot
 * see; the gate is what rules that out.
 */
import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { deviceCommands, devices, patchJobResults, patchJobs, patchPolicies } from '../db/schema';
import { cancelDeviceCommands } from './commandCancelPropagation';

/** Recorded when the ring is gone at delete/disable time (route-driven). */
export type RingQueuedWorkCancelReason = 'ring_deleted' | 'ring_disabled';

/**
 * Recorded by the executor's dispatch-time check. A delete is a soft delete,
 * so at dispatch time a deleted ring and a disabled ring are the same row
 * state and the reason cannot tell them apart.
 */
export const RING_UNAVAILABLE_SKIP_REASON = 'ring_unavailable';

export type RingQueuedWorkCancellation = {
  /** `scheduled` jobs moved to `cancelled`. */
  cancelledJobIds: string[];
  /** Pending (undelivered) `install_patches` commands cancelled in running jobs. */
  cancelledInstallCount: number;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A job belongs to the ring by its column or by its frozen snapshot. */
function jobFromRing(ringId: string): SQL {
  return or(
    eq(patchJobs.ringId, ringId),
    sql`${patchJobs.patches}->>'ringId' = ${ringId}`,
  )!;
}

function targetDeviceIds(targets: unknown): string[] {
  if (!targets || typeof targets !== 'object' || Array.isArray(targets)) return [];
  const raw = (targets as { deviceIds?: unknown }).deviceIds;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((id): id is string => typeof id === 'string' && UUID_RE.test(id)))];
}

/**
 * Cancel the ring's not-yet-dispatched patch work. Call it in the SAME
 * transaction as the UPDATE that disables the ring, after that UPDATE.
 *
 * Takes the ring row FOR UPDATE first. When the caller has already updated the
 * row this is a no-op re-lock; called on its own it still waits out every
 * in-flight dispatch before sweeping. A ring that is still enabled under the
 * lock (or missing) has nothing to cancel.
 */
export async function cancelQueuedRingPatchWork(
  ringId: string,
  reason: RingQueuedWorkCancelReason,
): Promise<RingQueuedWorkCancellation> {
  const [ring] = await db
    .select({ enabled: patchPolicies.enabled })
    .from(patchPolicies)
    .where(and(eq(patchPolicies.id, ringId), eq(patchPolicies.kind, 'ring')))
    .limit(1)
    .for('update');
  if (!ring || ring.enabled !== false) {
    return { cancelledJobIds: [], cancelledInstallCount: 0 };
  }

  const now = new Date();

  // 1. Scheduled jobs: never claimed, so no device job, command or result row
  //    exists yet. Skipped devices count as completed, as in markDeviceSkipped.
  const cancelledJobs = await db
    .update(patchJobs)
    .set({
      status: 'cancelled',
      completedAt: now,
      devicesCompleted: sql`${patchJobs.devicesCompleted} + ${patchJobs.devicesPending}`,
      devicesPending: 0,
    })
    .where(and(eq(patchJobs.status, 'scheduled'), jobFromRing(ringId)))
    .returning({ id: patchJobs.id, targets: patchJobs.targets });

  // One whole-device summary row per target, so the job detail says why each
  // device never ran. Only devices that still exist: a target removed since the
  // job was created would fail the FK and with it the whole delete.
  const wanted = new Map<string, string[]>();
  for (const job of cancelledJobs) wanted.set(job.id, targetDeviceIds(job.targets));
  const allIds = [...new Set([...wanted.values()].flat())];
  if (allIds.length > 0) {
    const existing = new Set(
      (await db.select({ id: devices.id }).from(devices).where(inArray(devices.id, allIds))).map((d) => d.id),
    );
    const rows = [...wanted.entries()].flatMap(([jobId, ids]) =>
      ids.filter((id) => existing.has(id)).map((deviceId) => ({
        jobId,
        deviceId,
        patchId: null,
        status: 'skipped' as const,
        startedAt: now,
        completedAt: now,
        errorMessage: reason,
        rebootRequired: false,
      })),
    );
    if (rows.length > 0) await db.insert(patchJobResults).values(rows);
  }

  // 2. Running jobs: cancel installs that were persisted but never delivered.
  //    `sent` (and later) commands reached the agent and finish normally.
  //    `cancelDeviceCommands` locks the rows, bounds the UPDATE to them, and
  //    terminalises each one's patch_job_results row and job counters in this
  //    same transaction; a command a heartbeat claim flipped to `sent` in the
  //    meantime no longer matches and is left alone.
  const cancelledInstalls = await cancelDeviceCommands({
    where: and(
      eq(deviceCommands.type, 'install_patches'),
      eq(deviceCommands.status, 'pending'),
      sql`${deviceCommands.payload}->>'patchJobId' IN (
        SELECT ${patchJobs.id}::text FROM ${patchJobs}
        WHERE ${patchJobs.status} = 'running' AND ${jobFromRing(ringId)}
      )`,
    )!,
    result: { reason },
    completedAt: now,
    patchCancelReason: reason,
  });

  return {
    cancelledJobIds: cancelledJobs.map((j) => j.id),
    cancelledInstallCount: cancelledInstalls.length,
  };
}
