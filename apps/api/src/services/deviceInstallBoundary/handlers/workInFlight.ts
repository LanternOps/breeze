/**
 * §5.6 AI and automation work in flight, plus the other runs the old install
 * was executing that the command cancel does not settle on its own.
 * Automations, policies and schedules select their targets when they fire, so
 * they reach the new install as fresh work, not as replays (§5.1).
 *
 * - AI action intents still live (`pending_approval`, `approved`,
 *   `executing`) are detached from the device (`scope_device_id = NULL`, the
 *   one transition the immutability trigger allows), as org move does; the
 *   release path fails closed on a tombstone.
 * - AI Operator tasks still live (queued/running/waiting/paused, and
 *   `stopping`) and their live target rows are detached with reason
 *   `device_reinstalled`; live tasks go to `stopping`, as org move does.
 *   Finished tasks keep their device link as history (org move detaches them
 *   too, because there the device leaves the tenant; here it does not).
 * - AI fix watches still pending or watching are cancelled: a recurrence on
 *   the new OS says nothing about the fix applied to the old one.
 * - Running playbook executions are cancelled.
 * - Standing SNMP telemetry arms that use the device as collector are blocked
 *   (`collector_reinstalled`) and their telemetry sources revoked, as the
 *   arm's own fence does. The arm carries a credential plan made for the old
 *   install; a human re-arms it.
 * - Filesystem cleanup runs that are running or previewed (an executable plan
 *   within its TTL) fail: their path plan was built from the old OS. The enum
 *   has no `cancelled`; `failed` with an error is what every other ending
 *   writes. Runs bound to a cancelled command were already settled by the
 *   command propagation.
 * - Patch rollbacks pending or running are cancelled. Patch job results tied
 *   to an open `install_patches` command were settled by the command
 *   propagation (with the job counters); a result row with no command yet is
 *   dispatched later as fresh work stamped for the new install.
 * - Security scans, sensitive-data scans and restore-point requests in flight
 *   fail, and a local-vault sync in flight fails: nothing else settles them
 *   (no reaper, no propagation branch), and a stranded running scan counts
 *   against the per-device scan cap.
 */
import { sql } from 'drizzle-orm';
import { db } from '../../../db';
import { revokeTopologyTelemetrySources } from '../../topology/collectionAuthority';
import { DEVICE_REINSTALLED_REASON, INSTALL_BOUNDARY_REASON, rowCount, type BoundaryHandler } from '../types';

const LIVE_AI_OPERATOR_TASK_STATES = ['queued', 'running', 'waiting', 'paused', 'stopping'] as const;

function textArray(values: readonly string[]) {
  return sql`${`{${values.join(',')}}`}::text[]`;
}

export const workInFlightHandler: BoundaryHandler = {
  id: 'work_in_flight',
  spec: '§5.6',
  tables: [
    'action_intents',
    'ai_operator_tasks',
    'ai_operator_task_targets',
    'ai_agent_fix_watches',
    'playbook_executions',
    'topology_telemetry_arms',
    'device_filesystem_cleanup_runs',
    'patch_rollbacks',
    'security_scans',
    'sensitive_data_scans',
    'device_restore_point_attempts',
    'local_vaults',
  ],
  async run(ctx) {
    const d = ctx.deviceId;
    const reason = INSTALL_BOUNDARY_REASON;

    const intents = rowCount(await db.execute(sql`
      UPDATE action_intents SET scope_device_id = NULL
       WHERE scope_device_id = ${d}::uuid AND status IN ('pending_approval', 'approved', 'executing')
      RETURNING id`));

    // Targets first (only the live ones of live tasks: a finished target is
    // history), while the task rows still carry the device.
    const targets = rowCount(await db.execute(sql`
      UPDATE ai_operator_task_targets
         SET device_id = NULL,
             detached_at = COALESCE(detached_at, now()),
             detached_reason = COALESCE(detached_reason, ${DEVICE_REINSTALLED_REASON}),
             state = 'detached',
             updated_at = now()
       WHERE device_id = ${d}::uuid
         AND state IN ('pending', 'active')
         AND task_id IN (SELECT id FROM ai_operator_tasks
                          WHERE state = ANY(${textArray(LIVE_AI_OPERATOR_TASK_STATES)}))
      RETURNING id`));
    const tasks = rowCount(await db.execute(sql`
      UPDATE ai_operator_tasks
         SET device_id = NULL,
             target_detached_at = COALESCE(target_detached_at, now()),
             target_detached_reason = COALESCE(target_detached_reason, ${DEVICE_REINSTALLED_REASON}),
             state = CASE WHEN state IN ('queued', 'running', 'waiting', 'paused') THEN 'stopping' ELSE state END,
             updated_at = now()
       WHERE device_id = ${d}::uuid AND state = ANY(${textArray(LIVE_AI_OPERATOR_TASK_STATES)})
      RETURNING id`));

    const fixWatches = rowCount(await db.execute(sql`
      UPDATE ai_agent_fix_watches SET state = 'cancelled', evaluated_at = now()
       WHERE device_id = ${d}::uuid AND state IN ('pending', 'watching')
      RETURNING id`));

    const playbooks = rowCount(await db.execute(sql`
      UPDATE playbook_executions
         SET status = 'cancelled', completed_at = now(), error_message = ${reason}, updated_at = now()
       WHERE device_id = ${d}::uuid AND status IN ('pending', 'running', 'waiting')
      RETURNING id`));

    const arms = (await db.execute(sql`
      UPDATE topology_telemetry_arms
         SET state = 'blocked', blocked_reason = 'collector_reinstalled', next_poll_at = NULL, updated_at = now()
       WHERE collector_device_id = ${d}::uuid AND state = 'armed'
      RETURNING org_id, site_id, authority_key`)) as unknown as Array<{ org_id: string; site_id: string; authority_key: string }>;
    let telemetrySources = 0;
    for (const arm of arms) {
      telemetrySources += await revokeTopologyTelemetrySources(
        { orgId: arm.org_id, siteId: arm.site_id },
        { producerKind: 'snmp', authorityKey: arm.authority_key },
      );
    }

    const cleanupRuns = rowCount(await db.execute(sql`
      UPDATE device_filesystem_cleanup_runs SET status = 'failed', error = ${reason}, updated_at = now()
       WHERE device_id = ${d}::uuid AND status IN ('running', 'previewed')
      RETURNING id`));

    const rollbacks = rowCount(await db.execute(sql`
      UPDATE patch_rollbacks SET status = 'cancelled', completed_at = now(), error_message = ${reason}
       WHERE device_id = ${d}::uuid AND status IN ('pending', 'running')
      RETURNING id`));

    const securityScans = rowCount(await db.execute(sql`
      UPDATE security_scans SET status = 'failed', completed_at = now()
       WHERE device_id = ${d}::uuid AND status IN ('queued', 'running')
      RETURNING id`));

    const sensitiveScans = rowCount(await db.execute(sql`
      UPDATE sensitive_data_scans SET status = 'failed', completed_at = now()
       WHERE device_id = ${d}::uuid AND status IN ('queued', 'running')
      RETURNING id`));

    const restorePoints = rowCount(await db.execute(sql`
      UPDATE device_restore_point_attempts SET status = 'failed', message = ${reason}
       WHERE device_id = ${d}::uuid AND status = 'requested'
      RETURNING id`));

    const vaultSyncs = rowCount(await db.execute(sql`
      UPDATE local_vaults SET last_sync_status = 'failed', last_sync_error = ${reason}, updated_at = now()
       WHERE device_id = ${d}::uuid AND last_sync_status = 'pending'
      RETURNING id`));

    return {
      'action_intents.detached': intents,
      'ai_operator_tasks.detached': tasks,
      'ai_operator_task_targets.detached': targets,
      'ai_agent_fix_watches.cancelled': fixWatches,
      'playbook_executions.cancelled': playbooks,
      'topology_telemetry_arms.blocked': arms.length,
      'topology_collection_sources.revoked': telemetrySources,
      'device_filesystem_cleanup_runs.failed': cleanupRuns,
      'patch_rollbacks.cancelled': rollbacks,
      'security_scans.failed': securityScans,
      'sensitive_data_scans.failed': sensitiveScans,
      'device_restore_point_attempts.failed': restorePoints,
      'local_vaults.sync_failed': vaultSyncs,
    };
  },
};
