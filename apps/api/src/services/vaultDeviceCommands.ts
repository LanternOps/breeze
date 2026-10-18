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
 * A `vault_configure` the helper could not apply is recorded on the vault it
 * named (lastSyncStatus/lastSyncError, the vault row's only error surface).
 *
 * `vault_sync` needs a snapshot id. When the caller names none (the web UI's
 * Sync button never does), the device's newest file-backup snapshot is used.
 */
import { and, desc, eq, isNull, or } from 'drizzle-orm';

import { db } from '../db';
import { backupSnapshots, localVaults } from '../db/schema';
import { redactSecretsFromOutput } from './secretRedaction';

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

export interface ApplyVaultConfigureCommandResultInput {
  deviceId: string;
  command: { payload?: unknown } | null | undefined;
  resultStatus: 'completed' | 'failed' | 'timeout';
  stderr?: string;
  error?: string;
}

/**
 * Called by the command-result transports (commandResultHandlers) after the
 * result is bound to the device's own dispatched command, inside the agent's
 * org-scoped DB context. A successful configure writes nothing; a failed
 * disable (`{enabled:false}`) names no vault, so only the command row keeps it.
 */
export async function applyVaultConfigureCommandResult(input: ApplyVaultConfigureCommandResultInput): Promise<void> {
  if (input.resultStatus === 'completed') return;

  const payload = input.command?.payload && typeof input.command.payload === 'object' && !Array.isArray(input.command.payload)
    ? input.command.payload as Record<string, unknown>
    : {};
  if (payload.enabled !== true || typeof payload.vaultPath !== 'string' || payload.vaultPath === '') {
    console.warn(`[Vault] vault_configure ${input.resultStatus} on device ${input.deviceId} (no vault named in the payload)`);
    return;
  }

  const reason = input.error || input.stderr || (input.resultStatus === 'timeout' ? 'timed out' : 'unknown error');
  const now = new Date();
  await db
    .update(localVaults)
    .set({
      lastSyncStatus: 'failed',
      lastSyncError: redactSecretsFromOutput(`The device could not apply this vault's configuration: ${reason}`),
      updatedAt: now,
    })
    .where(and(
      eq(localVaults.deviceId, input.deviceId),
      eq(localVaults.vaultPath, payload.vaultPath),
      eq(localVaults.isActive, true),
    ));
}
