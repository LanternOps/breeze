/**
 * Server side of the local-vault command contract (#8385).
 *
 * The backup helper holds ONE vault per device: agent.yaml `vault_path`,
 * `vault_retention_count` and `vault_enabled`, set by `vault_configure`
 * (agent cmd/breeze-backup exec_vault.go). The server can list several
 * `local_vaults` rows per device, so it pushes a single one: the device's
 * newest active vault. With no active vault left, the device's vault is
 * disabled.
 *
 * `vault_sync` needs a snapshot id. When the caller names none (the web UI's
 * Sync button never does), the device's newest file-backup snapshot is used.
 */
import { and, desc, eq, isNull, or } from 'drizzle-orm';

import { db } from '../db';
import { backupSnapshots, localVaults } from '../db/schema';

export type VaultConfigurePayload =
  | { vaultPath: string; retentionCount: number; enabled: true }
  | { enabled: false };

export async function buildVaultConfigurePayload(
  deviceId: string,
  orgId: string,
): Promise<VaultConfigurePayload> {
  const [vault] = await db
    .select({ vaultPath: localVaults.vaultPath, retentionCount: localVaults.retentionCount })
    .from(localVaults)
    .where(and(
      eq(localVaults.deviceId, deviceId),
      eq(localVaults.orgId, orgId),
      eq(localVaults.isActive, true),
    ))
    .orderBy(desc(localVaults.createdAt))
    .limit(1);

  if (!vault) return { enabled: false };
  return { vaultPath: vault.vaultPath, retentionCount: vault.retentionCount, enabled: true };
}

export async function resolveLatestVaultSyncSnapshotId(
  deviceId: string,
  orgId: string,
): Promise<string | null> {
  const [snapshot] = await db
    .select({ snapshotId: backupSnapshots.snapshotId })
    .from(backupSnapshots)
    .where(and(
      eq(backupSnapshots.deviceId, deviceId),
      eq(backupSnapshots.orgId, orgId),
      // The vault mirrors file backups (the helper auto-syncs only after
      // backup_run). A NULL type predates the column and is a file backup.
      or(eq(backupSnapshots.backupType, 'file'), isNull(backupSnapshots.backupType)),
    ))
    .orderBy(desc(backupSnapshots.timestamp))
    .limit(1);
  return snapshot?.snapshotId ?? null;
}
