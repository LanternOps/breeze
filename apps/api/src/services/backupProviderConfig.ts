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
