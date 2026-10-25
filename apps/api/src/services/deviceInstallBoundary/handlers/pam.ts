/**
 * §5.3 PAM (§13 decision 2). The elevated account lived on the old OS, which
 * is gone: no cleanup is sent to the new install, and nothing the old install
 * was granted stays live.
 *
 * - Every still-live elevation request of the device in its current org
 *   expires, actuated or not, with an `expired` audit row (cause
 *   `device_reinstalled`); their pending approval requests expire with them.
 * - Every actuation of the device's current org and ownership epoch that is
 *   not closed goes to `observed_state = 'failed'` with failure code
 *   `superseded_by_reinstall` (an existing terminal state; the code column is
 *   free text). Two more writes make "no cleanup to the new install" hold:
 *     - `desired_state = 'cleanup'` makes `requestPamCleanup` a no-op, so the
 *       expiry job, a revoke or a policy removal can never turn the row into a
 *       `pam_cleanup_v2` for the new install;
 *     - `generation + 1` makes any outbox job or late result of the old
 *       generation `stale` (the dispatch worker and the result gate both key
 *       on it). `current_command_id` is kept: clearing it would let a
 *       re-enqueued job dispatch again.
 *   An actuation that already failed keeps its own failure code; one recorded
 *   as `legacy_untracked` keeps that state. A `cleaned` actuation is history.
 * - The open PAM commands themselves (`pam_apply_v2`, `pam_cleanup_v2`,
 *   `pam_reconcile_v2`) were cancelled by the command handler.
 *
 * Every write keeps (device_id, org_id, device_epoch), so the PAM epoch guards
 * never fire. Accepted consequence: an actuation failed here never reaches
 * `pam_actuation_is_closed` (that needs endpoint proof of cleanup), so with
 * ownership-epoch transfer on, a later org move of this device stays refused
 * by `devices_pam_open_actuation_move_guard`, as it is today for any failed
 * actuation.
 *
 * Lock order: the PAM lifecycle and result paths take the device row FOR SHARE
 * first, then the request and the actuation (PAM ownership epochs spec §9),
 * which is the boundary's order (device FOR UPDATE, then requests, then
 * actuations). The dispatch worker (jobs/pamActuationWorker.ts) locks an
 * actuation before its command insert takes KEY SHARE on the device, an
 * inversion that already exists against every device-row writer through the
 * FK check; if it ever meets a confirm, Postgres deadlock detection aborts one
 * side, and the confirm that runs the boundary is idempotent and retried.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { approvalRequests } from '../../../db/schema';
import { expireElevationRequestsForReinstall } from '../../pamDeviceMoveGuard';
import { PAM_SUPERSEDED_FAILURE_CODE, rowCount, type BoundaryHandler } from '../types';

export const pamHandler: BoundaryHandler = {
  id: 'pam',
  spec: '§5.3',
  tables: ['elevation_requests', 'pam_actuations'],
  async run(ctx) {
    const expiredRequestIds = await expireElevationRequestsForReinstall(db, {
      orgId: ctx.orgId,
      deviceId: ctx.deviceId,
    });

    let approvals = 0;
    if (expiredRequestIds.length > 0) {
      const expiredApprovals = await db
        .update(approvalRequests)
        .set({ status: 'expired', decidedAt: ctx.at })
        .where(and(eq(approvalRequests.status, 'pending'), inArray(approvalRequests.elevationRequestId, expiredRequestIds)))
        .returning({ id: approvalRequests.id });
      approvals = expiredApprovals.length;
    }

    const actuations = rowCount(await db.execute(sql`
      UPDATE pam_actuations a
         SET observed_state = CASE WHEN a.observed_state = 'legacy_untracked' THEN 'legacy_untracked' ELSE 'failed' END,
             failure_code = CASE
               WHEN a.observed_state IN ('failed', 'legacy_untracked') THEN a.failure_code
               ELSE ${PAM_SUPERSEDED_FAILURE_CODE}
             END,
             desired_state = 'cleanup',
             cleanup_requested_at = COALESCE(a.cleanup_requested_at, now()),
             generation = a.generation + 1,
             updated_at = now()
       WHERE a.device_id = ${ctx.deviceId}::uuid
         AND a.org_id = ${ctx.orgId}::uuid
         AND a.device_epoch = ${ctx.ownershipEpoch}
         AND a.observed_state <> 'cleaned'
         AND NOT (a.desired_state = 'cleanup' AND a.observed_state IN ('failed', 'legacy_untracked'))
      RETURNING a.id`));

    return {
      'elevation_requests.expired': expiredRequestIds.length,
      'approval_requests.expired': approvals,
      'pam_actuations.failed': actuations,
    };
  },
};
