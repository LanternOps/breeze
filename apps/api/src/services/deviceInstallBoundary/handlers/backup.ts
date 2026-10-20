/**
 * §5.4 Backup and recovery (§13 decision 3). Snapshots, recovery keys and the
 * backup configuration are history and configuration; everything in flight
 * for the old install, and every credential that could still start a
 * recovery, ends here.
 *
 * - Recovery: active/authenticated `recovery_tokens` are revoked and their
 *   recovery and boot media artifacts expired (what the token revoke route
 *   does); in-flight `bare_metal_recoveries` that recover this device or run
 *   on it as the rebuild host fail with reason `superseded_by_reattach` (the
 *   table has no cancelled state; operator cancel also writes `failed`).
 * - In-flight work: pending/running `backup_jobs` and `restore_jobs` are
 *   cancelled, pending/running `backup_verifications` fail. Ending a backup job
 *   revokes its write sessions by trigger; every still-open
 *   `backup_storage_sessions` row of the device is then revoked as well
 *   (defence in depth: a session also needs agent credentials).
 * - The MSSQL chain marked active is closed (`backup_chains`). File and
 *   system-image backups have no chain row: their incremental base is the
 *   newest eligible snapshot, and `stampDispatchPinAndIdentity`
 *   (jobs/backupWorker.ts) ignores snapshots taken before
 *   `incarnation_started_at`, so the next run is a full one.
 * - `backup_restore_authorizations` cannot be updated (immutable by trigger)
 *   and have no "used" flag; each is bound to exactly one command, recovery
 *   token or recovery, and those bindings were just cancelled or revoked. The
 *   one authorization the bindings do not kill is a command id reserved
 *   before its command row was queued; those are deleted (their audit event
 *   stays).
 * - Restoring a snapshot taken before `incarnation_started_at` loses the
 *   producer-only free pass (services/backupRestoreGate.ts) — a read-side
 *   rule, not a write here.
 * - The `backup*ProtocolVersion` columns are reset by the device row handler.
 */
import { sql } from 'drizzle-orm';
import { db } from '../../../db';
import { BARE_METAL_RECOVERY_TERMINAL } from '../../../db/schema/bareMetalRecoveries';
import { INSTALL_BOUNDARY_REASON, rowCount, type BoundaryHandler } from '../types';

export const backupRecoveryHandler: BoundaryHandler = {
  id: 'backup_recovery',
  spec: '§5.4',
  tables: [
    'recovery_tokens',
    'bare_metal_recoveries',
    'backup_jobs',
    'restore_jobs',
    'backup_verifications',
    'backup_storage_sessions',
    'backup_chains',
    'backup_restore_authorizations',
  ],
  async run(ctx) {
    const d = ctx.deviceId;
    const reason = INSTALL_BOUNDARY_REASON;

    const [recovery] = (await db.execute(sql`
      WITH revoked AS (
        UPDATE recovery_tokens SET status = 'revoked'
         WHERE device_id = ${d}::uuid AND status IN ('active', 'authenticated')
        RETURNING id
      ), media AS (
        UPDATE recovery_media_artifacts SET status = 'expired'
         WHERE token_id IN (SELECT id FROM revoked)
        RETURNING id
      ), boot AS (
        UPDATE recovery_boot_media_artifacts SET status = 'expired'
         WHERE token_id IN (SELECT id FROM revoked)
        RETURNING id
      )
      SELECT (SELECT count(*) FROM revoked)::int AS tokens,
             (SELECT count(*) FROM media)::int AS media,
             (SELECT count(*) FROM boot)::int AS boot`)) as unknown as Array<{ tokens: number; media: number; boot: number }>;

    const recoveries = rowCount(await db.execute(sql`
      UPDATE bare_metal_recoveries
         SET status = 'failed', failure_reason = ${reason}, updated_at = now()
       WHERE (device_id = ${d}::uuid OR executing_device_id = ${d}::uuid)
         AND status <> ALL(${`{${[...BARE_METAL_RECOVERY_TERMINAL].join(',')}}`}::text[])
      RETURNING id`));

    const backupJobs = rowCount(await db.execute(sql`
      UPDATE backup_jobs
         SET status = 'cancelled', completed_at = now(), updated_at = now(), error_log = ${reason}
       WHERE device_id = ${d}::uuid AND status IN ('pending', 'running')
      RETURNING id`));

    const restoreJobs = rowCount(await db.execute(sql`
      UPDATE restore_jobs
         SET status = 'cancelled', completed_at = now(), updated_at = now(),
             target_config = coalesce(target_config, '{}'::jsonb) || jsonb_build_object(
               'error', ${reason}::text,
               'result', jsonb_build_object('status', 'cancelled', 'error', ${reason}::text))
       WHERE device_id = ${d}::uuid AND status IN ('pending', 'running')
      RETURNING id`));

    const verifications = rowCount(await db.execute(sql`
      UPDATE backup_verifications
         SET status = 'failed', completed_at = now(),
             details = coalesce(details, '{}'::jsonb) || jsonb_build_object('reason', ${reason}::text)
       WHERE device_id = ${d}::uuid AND status IN ('pending', 'running')
      RETURNING id`));

    const sessions = rowCount(await db.execute(sql`
      UPDATE backup_storage_sessions
         SET revoked_at = now(), revoked_reason = ${reason}
       WHERE device_id = ${d}::uuid AND revoked_at IS NULL
      RETURNING id`));

    const chains = rowCount(await db.execute(sql`
      UPDATE backup_chains SET is_active = false, updated_at = now()
       WHERE device_id = ${d}::uuid AND is_active
      RETURNING id`));

    const authorizations = rowCount(await db.execute(sql`
      DELETE FROM backup_restore_authorizations a
       WHERE a.device_id = ${d}::uuid
         AND a.command_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM device_commands c WHERE c.id = a.command_id)
      RETURNING a.id`));

    return {
      'recovery_tokens.revoked': recovery?.tokens ?? 0,
      'recovery_media_artifacts.expired': (recovery?.media ?? 0) + (recovery?.boot ?? 0),
      'bare_metal_recoveries.failed': recoveries,
      'backup_jobs.cancelled': backupJobs,
      'restore_jobs.cancelled': restoreJobs,
      'backup_verifications.failed': verifications,
      'backup_storage_sessions.revoked': sessions,
      'backup_chains.closed': chains,
      'backup_restore_authorizations.deleted': authorizations,
    };
  },
};
