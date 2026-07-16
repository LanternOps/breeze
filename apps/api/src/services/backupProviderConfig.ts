/**
 * Resolves the storage destination (provider + providerConfig) for a
 * backup_configs row.
 *
 * VERIFY and RESTORE agent commands need to read a snapshot back from the
 * same bucket/share the BACKUP command wrote it to. `backupWorker.ts`
 * already attaches `provider` + `providerConfig` to `backup_run` commands
 * (see processDispatchBackup) — this helper produces the same shape so
 * backup_verify / backup_test_restore / backup_restore commands can carry
 * it too. Deliberately does NOT apply the storage-encryption patch that
 * backupWorker layers onto write commands (resolveBackupStorageEncryptionPlan)
 * — verify/restore only need to READ, and callers here don't have (nor
 * need) an encryption-plan decision to make.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { backupConfigs } from '../db/schema';

export type BackupProviderConfig = {
  provider: string;
  providerConfig: Record<string, unknown>;
};

/**
 * A snapshot / backup job written before destination tracking existed carries
 * a NULL `configId`, so we can't reconstruct the exact bucket/share it was
 * written to. We deliberately do NOT fall back to the device's CURRENT
 * effective config — the snapshot's objects live at the destination used AT
 * WRITE TIME, which may differ from where the device backs up today; reading
 * the current bucket could look in the wrong place. So callers surface a
 * CLEARER error (not a fallback) that distinguishes this legacy case from a
 * genuine misconfiguration (configId set but no config resolves).
 */
export const SNAPSHOT_PREDATES_DESTINATION_TRACKING_MESSAGE =
  'This snapshot predates backup destination tracking: its storage destination was not recorded when it was written, so it cannot be automatically restored or verified. Restore or verify it manually against the original storage destination.';

export const BACKUP_DESTINATION_CONFIG_NOT_FOUND_MESSAGE =
  'Backup destination configuration not found for this snapshot';

export type BackupDestinationErrorReason = 'legacy_snapshot' | 'config_not_found';

/**
 * Builds the operator-facing error for a verify/restore request that could not
 * resolve a provider config. When `configId` is null the snapshot predates
 * destination tracking (auto-restore/verify impossible) — a distinct, non-
 * misleading message; otherwise the referenced config is genuinely missing.
 */
export function resolveBackupDestinationError(
  configId: string | null | undefined
): { reason: BackupDestinationErrorReason; message: string } {
  return configId == null
    ? { reason: 'legacy_snapshot', message: SNAPSHOT_PREDATES_DESTINATION_TRACKING_MESSAGE }
    : { reason: 'config_not_found', message: BACKUP_DESTINATION_CONFIG_NOT_FOUND_MESSAGE };
}

/**
 * Looks up `backup_configs` by id, scoped to `orgId` (tenant-safe — a
 * mismatched org returns null exactly like a missing row). Returns null
 * when no config can be resolved; callers must fail the verify/restore
 * request rather than dispatch a command the agent can't act on.
 */
export async function resolveBackupProviderConfig(
  configId: string,
  orgId: string
): Promise<BackupProviderConfig | null> {
  const [config] = await db
    .select({
      provider: backupConfigs.provider,
      providerConfig: backupConfigs.providerConfig,
    })
    .from(backupConfigs)
    .where(and(eq(backupConfigs.id, configId), eq(backupConfigs.orgId, orgId)))
    .limit(1);

  if (!config) return null;

  return {
    provider: config.provider,
    providerConfig: (config.providerConfig as Record<string, unknown> | null) ?? {},
  };
}
