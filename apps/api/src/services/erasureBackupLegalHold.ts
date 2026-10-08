/**
 * Every backup legal hold that must stop an org erasure — and, narrowed to one
 * device, a device purge (#7982).
 *
 * A hold can come from three places, and erasure refuses on any of them:
 *   snapshot              backup_snapshots.legal_hold on one of the org's rows
 *   backup_policy         backup_policies.legal_hold on one of the org's
 *                         (legacy) backup policies
 *   configuration_policy  an active configuration policy (org-owned or
 *                         partner-wide) whose backup settings set
 *                         retention.legalHold, resolved as EFFECTIVE for one
 *                         of the org's devices — the same resolution new
 *                         snapshots take their hold from
 *                         (featureConfigResolver.resolveBackupProtectionForDevice,
 *                         used by backupResultPersistence).
 */
import { sql } from 'drizzle-orm';
import * as dbModule from '../db';

export type BackupLegalHoldSource = 'snapshot' | 'backup_policy' | 'configuration_policy';

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/**
 * Policy-level holds (backup_policy, configuration_policy) for the org. Runs
 * in the CALLER's DB context, which must be system scope. With
 * `lockForShare`, every row that could carry such a hold is locked FOR SHARE
 * first, so a concurrent "set hold" cannot commit between this check and the
 * end of the caller's transaction (the mid-cascade recheck uses this).
 *
 * With `deviceId` (device purge, #7982) the same check is narrowed to the
 * holds that govern THAT device's backups, resolved the way its snapshots
 * take their hold (backupResultPersistence):
 *   backup_policy         a held policy one of the device's backup_jobs ran
 *                         under (backup_jobs.policy_id)
 *   configuration_policy  resolveBackupProtectionForDevice for this device only
 * `orgId` must then be the device's org.
 */
export async function findPolicyBackupLegalHoldInContext(
  orgId: string,
  opts: { lockForShare?: boolean; deviceId?: string } = {},
): Promise<BackupLegalHoldSource | null> {
  const deviceId = opts.deviceId ?? null;
  const [org] = rowsOf<{ partner_id: string | null }>(await dbModule.db.execute(sql`
    SELECT partner_id FROM organizations WHERE id = ${orgId}::uuid
  `));
  const partnerId = org?.partner_id ?? null;

  // Every snapshot has a job (backup_snapshots.job_id is NOT NULL, ON DELETE
  // CASCADE), and a legacy policy reaches a snapshot only through its job's
  // policy_id, so in device scope those are the only backup_policies rows
  // whose hold can govern the device's backups.
  const devicePolicyFilter = deviceId
    ? sql`AND id IN (SELECT policy_id FROM backup_jobs WHERE device_id = ${deviceId}::uuid AND policy_id IS NOT NULL)`
    : sql``;

  if (opts.lockForShare) {
    await dbModule.db.execute(sql`SELECT id FROM backup_policies WHERE org_id = ${orgId}::uuid ${devicePolicyFilter} FOR SHARE`);
    await dbModule.db.execute(sql`
      SELECT id FROM config_policy_backup_settings
       WHERE org_id = ${orgId}::uuid ${partnerId ? sql`OR partner_id = ${partnerId}::uuid` : sql``}
       FOR SHARE
    `);
  }

  const [policyHold] = rowsOf<{ id: string }>(await dbModule.db.execute(sql`
    SELECT id FROM backup_policies
     WHERE org_id = ${orgId}::uuid AND legal_hold = true
       ${devicePolicyFilter}
     LIMIT 1
  `));
  if (policyHold) return 'backup_policy';

  // Cheap superset first: is there ANY active org-owned or partner-wide policy
  // whose backup settings set a hold? Almost always no, and then no per-device
  // resolution runs.
  const [candidate] = rowsOf<{ id: string }>(await dbModule.db.execute(sql`
    SELECT fl.id
      FROM config_policy_effective_feature_links fl
      JOIN configuration_policies cp ON cp.id = fl.config_policy_id
      JOIN config_policy_backup_settings s ON s.feature_link_id = fl.id
     WHERE fl.feature_type = 'backup'
       AND cp.status = 'active'
       AND (cp.org_id = ${orgId}::uuid ${partnerId ? sql`OR (cp.org_id IS NULL AND cp.partner_id = ${partnerId}::uuid)` : sql``})
       AND s.retention -> 'legalHold' = 'true'::jsonb
     LIMIT 1
  `));
  if (!candidate) return null;

  // Exact: the hold applies only where the policy is effective for a device
  // (assignment level/target, role/OS filters, hierarchy precedence).
  // Loaded lazily: the resolver pulls in the whole configuration-policy graph,
  // which tenantCascade (imported by many lightweight paths) should not carry.
  const { resolveBackupProtectionForDevice } = await import('./featureConfigResolver');
  const devices = deviceId
    ? [{ id: deviceId }]
    : rowsOf<{ id: string }>(await dbModule.db.execute(sql`
      SELECT id FROM devices WHERE org_id = ${orgId}::uuid
    `));
  for (const device of devices) {
    const resolved = await resolveBackupProtectionForDevice(device.id);
    if (resolved?.legalHold) return 'configuration_policy';
  }
  return null;
}

/** Any active backup legal hold on the org, from any source. Opens its own system context. */
export async function findActiveBackupLegalHold(orgId: string): Promise<BackupLegalHoldSource | null> {
  return dbModule.withSystemDbAccessContext(async () => {
    const [snapshotHold] = rowsOf<{ id: string }>(await dbModule.db.execute(sql`
      SELECT id FROM backup_snapshots WHERE org_id = ${orgId}::uuid AND legal_hold = true LIMIT 1
    `));
    if (snapshotHold) return 'snapshot';
    return findPolicyBackupLegalHoldInContext(orgId);
  }, 'tenantErasure.legalHoldCheck');
}
