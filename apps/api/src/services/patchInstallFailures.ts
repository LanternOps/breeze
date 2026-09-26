import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { devicePatches, devices, patchJobResults, OUTSTANDING_DEVICE_PATCH_STATUSES } from '../db/schema';

/**
 * The deployment axis of a patch, as opposed to its approval axis (#4223).
 *
 * Approval (`patch_approvals`, plus ring auto-approval evaluated in memory at
 * dispatch) says whether a patch MAY be installed. It says nothing about what
 * happened when an install was attempted. When a scheduled job fails on the
 * device — the Windows agent's battery preflight, low disk, a WUA error — the
 * only record is `patch_job_results.error_message`, so both patch views kept
 * rendering "Pending approval" and hid the reason.
 */
export type PatchInstallFailure = {
  /** Devices whose MOST RECENT attempt at this patch failed and still need it. */
  deviceCount: number;
  /** Reason from the most recent of those failures (may be null if the agent sent none). */
  error: string | null;
  /** ISO timestamp of the most recent of those failures. */
  failedAt: string;
};

type Scope = { orgId?: string; deviceId?: string };

/**
 * For each patch id, the devices whose LATEST `patch_job_results` row for that
 * patch is `failed`, restricted to devices that still have the patch
 * outstanding (`device_patches.status = 'pending'`).
 *
 * "Latest" is per (device, patch): a newer attempt of any status — a retry
 * that is queued/running, a success, or a superseded/skipped row — replaces an
 * older failure, so a stale failure never outlives a newer attempt. Installed
 * patches are excluded by the outstanding join, so a failure that the agent
 * later fixed out of band (manual install, next scan) also disappears.
 *
 * Runs in the caller's request DB context: `patch_job_results` is device-join
 * RLS, so partner/org visibility is enforced by the database; `orgId` /
 * `deviceId` only narrow further.
 */
export async function loadPatchInstallFailures(
  patchIds: readonly string[],
  scope: Scope = {},
): Promise<Map<string, PatchInstallFailure>> {
  const result = new Map<string, PatchInstallFailure>();
  if (patchIds.length === 0) return result;

  const conditions: SQL[] = [inArray(patchJobResults.patchId, [...patchIds])];
  if (scope.deviceId) conditions.push(eq(patchJobResults.deviceId, scope.deviceId));
  if (scope.orgId) conditions.push(eq(devices.orgId, scope.orgId));

  const attemptedAt = sql<Date>`coalesce(${patchJobResults.completedAt}, ${patchJobResults.createdAt})`.as('attempted_at');

  const latest = db
    .selectDistinctOn([patchJobResults.deviceId, patchJobResults.patchId], {
      patchId: patchJobResults.patchId,
      status: patchJobResults.status,
      errorMessage: patchJobResults.errorMessage,
      attemptedAt,
    })
    .from(patchJobResults)
    .innerJoin(devices, eq(devices.id, patchJobResults.deviceId))
    .innerJoin(
      devicePatches,
      and(
        eq(devicePatches.deviceId, patchJobResults.deviceId),
        eq(devicePatches.patchId, patchJobResults.patchId),
        inArray(devicePatches.status, [...OUTSTANDING_DEVICE_PATCH_STATUSES]),
      ),
    )
    .where(and(...conditions))
    .orderBy(
      patchJobResults.deviceId,
      patchJobResults.patchId,
      desc(patchJobResults.createdAt),
      desc(patchJobResults.id),
    )
    .as('latest');

  const rows = await db
    .select({
      patchId: latest.patchId,
      deviceCount: sql<number>`count(*)::int`,
      error: sql<string | null>`(array_agg(${latest.errorMessage} ORDER BY ${latest.attemptedAt} DESC))[1]`,
      // Map through the column so the naive `timestamp` is read as UTC by
      // Drizzle, independent of the session TimeZone (a ::timestamptz cast
      // would apply whatever TimeZone the pooled connection carries).
      failedAt: sql<Date>`max(${latest.attemptedAt})`.mapWith(patchJobResults.createdAt),
    })
    .from(latest)
    .where(eq(latest.status, 'failed'))
    .groupBy(latest.patchId);

  for (const row of rows) {
    if (!row.patchId) continue;
    result.set(row.patchId, {
      deviceCount: Number(row.deviceCount),
      error: row.error,
      failedAt: row.failedAt.toISOString(),
    });
  }
  return result;
}
