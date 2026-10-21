/**
 * §5.7 Install-specific state: what the server cached about the OLD OS, which
 * would otherwise steer work at the new install or make the server refuse its
 * first reports. The new install's inventory and scans rebuild all of it.
 *
 * - `device_patches` is cleared, so the new install's inventory drives
 *   `install_patches` (no stale "missing" targets, and no stale `installed`
 *   rows claiming patches the new OS lacks). Nothing references its rows.
 * - `deployment_devices` still `running` go back to `pending` (their command,
 *   if any, was cancelled in §5.2), so the deployment runs again as fresh work.
 * - CIS remediation actions not yet done (`pending_approval`, `queued`,
 *   `in_progress`) are cancelled: they answered findings on the old OS, and
 *   the new install's first scan raises its own findings, which need approval
 *   again.
 * - Peripheral policy delivery state is marked `rejected` with the applied
 *   tuple cleared, so reconciliation resends the current policy (a fresh
 *   revision) instead of coalescing on the old install's applied digest
 *   (F11's fail-open). There is no per-device config-policy applied state on
 *   main to clear.
 * - Agent cursors and acceptance gates keyed to the old install are dropped,
 *   each re-created by the new install's first report:
 *     - `device_software_inventory_state`: its count-collapse gate would reject
 *       a freshly reformatted OS's much smaller inventory;
 *     - `device_time_status`: its sequence cursor would reject the new
 *       install's restarted sequence for up to an hour;
 *     - `device_filesystem_scan_state`: the scan mode, resume frontier and hot
 *       directories of the old OS;
 *     - `onedrive_device_state`: the old install's signed-in UPNs drive
 *       library tagging in config delivery;
 *     - `software_compliance_status`: remediation in flight for the old
 *       install blocks auto-remediation; the worker re-derives the rest.
 * - Interactive sessions the old OS reported as active are closed.
 *
 * Kept as history: inventory projections that every report replaces (disks,
 * network, software inventory, registry and config-file observations), and
 * BitLocker recovery keys — the new install's escrow supersedes them as it
 * does today, and a key older than `incarnation_started_at` belonged to an
 * earlier install.
 */
import { sql } from 'drizzle-orm';
import { db } from '../../../db';
import { INSTALL_BOUNDARY_REASON, rowCount, type BoundaryHandler } from '../types';

export const installStateHandler: BoundaryHandler = {
  id: 'install_state',
  spec: '§5.7',
  tables: [
    'device_patches',
    'deployment_devices',
    'cis_remediation_actions',
    'peripheral_policy_device_states',
    'device_software_inventory_state',
    'device_time_status',
    'device_filesystem_scan_state',
    'onedrive_device_state',
    'software_compliance_status',
    'device_sessions',
  ],
  async run(ctx) {
    const d = ctx.deviceId;
    const reason = INSTALL_BOUNDARY_REASON;

    const patches = rowCount(await db.execute(sql`
      DELETE FROM device_patches WHERE device_id = ${d}::uuid RETURNING id`));

    const deployments = rowCount(await db.execute(sql`
      UPDATE deployment_devices
         SET status = 'pending', started_at = NULL, completed_at = NULL, result = NULL
       WHERE device_id = ${d}::uuid AND status = 'running'
      RETURNING id`));

    const cis = rowCount(await db.execute(sql`
      UPDATE cis_remediation_actions
         SET status = 'cancelled',
             details = coalesce(details, '{}'::jsonb)
               || jsonb_build_object('cancelledReason', ${reason}::text, 'cancelledAt', now())
       WHERE device_id = ${d}::uuid AND status IN ('pending_approval', 'queued', 'in_progress')
      RETURNING id`));

    const peripheral = rowCount(await db.execute(sql`
      UPDATE peripheral_policy_device_states
         SET delivery_status = 'rejected', last_error_code = ${reason},
             applied_phase = NULL, applied_revision = NULL, applied_digest = NULL, updated_at = now()
       WHERE device_id = ${d}::uuid
      RETURNING device_id`));

    const softwareGate = rowCount(await db.execute(sql`
      DELETE FROM device_software_inventory_state WHERE device_id = ${d}::uuid RETURNING device_id`));
    const timeStatus = rowCount(await db.execute(sql`
      DELETE FROM device_time_status WHERE device_id = ${d}::uuid RETURNING device_id`));
    const scanState = rowCount(await db.execute(sql`
      DELETE FROM device_filesystem_scan_state WHERE device_id = ${d}::uuid RETURNING device_id`));
    const onedrive = rowCount(await db.execute(sql`
      DELETE FROM onedrive_device_state WHERE device_id = ${d}::uuid RETURNING device_id`));
    const compliance = rowCount(await db.execute(sql`
      DELETE FROM software_compliance_status WHERE device_id = ${d}::uuid RETURNING id`));

    const sessions = rowCount(await db.execute(sql`
      UPDATE device_sessions
         SET is_active = false, logout_at = now(),
             duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM (now() - login_at)))::int,
             activity_state = 'disconnected', updated_at = now()
       WHERE device_id = ${d}::uuid AND is_active
      RETURNING id`));

    return {
      'device_patches.deleted': patches,
      'deployment_devices.reset': deployments,
      'cis_remediation_actions.cancelled': cis,
      'peripheral_policy_device_states.reset': peripheral,
      'device_software_inventory_state.deleted': softwareGate,
      'device_time_status.deleted': timeStatus,
      'device_filesystem_scan_state.deleted': scanState,
      'onedrive_device_state.deleted': onedrive,
      'software_compliance_status.deleted': compliance,
      'device_sessions.closed': sessions,
    };
  },
};
