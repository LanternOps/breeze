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
 * It also names the destination that snapshot was written to (#11858): the
 * helper's own store is not where a policy-managed device's backups live.
 */
import { and, desc, eq, isNull, or, type SQL } from 'drizzle-orm';

import { db } from '../db';
import { backupConfigs, backupSnapshots, localVaults } from '../db/schema';
import { backupReadCredentialPayload, type BackupProviderConfigRef } from './backupCommandCredentials';
import { BACKUP_DESTINATION_CONFIG_NOT_FOUND_MESSAGE } from './backupProviderConfig';
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

export const VAULT_SYNC_NO_SNAPSHOT_MESSAGE = 'No backup snapshot to sync yet: run a file backup on this device first';
export const VAULT_SYNC_SNAPSHOT_NOT_FOUND_MESSAGE = 'Backup snapshot not found for this device';

/** The destination a `vault_sync` reads from: a reference, resolved at delivery. */
export type VaultSyncDestination = { provider: string; providerConfigRef: BackupProviderConfigRef };

export type VaultSyncSource =
  | { ok: true; snapshotId: string; destination: VaultSyncDestination | null }
  | { ok: false; status: 400 | 404 | 422; error: string };

/**
 * The snapshot a `vault_sync` copies and where the helper reads it from.
 *
 * The snapshot is the one named, or the device's newest file backup, and must
 * belong to this device in this org. It is read from the destination it was
 * WRITTEN to (the snapshot's `configId`, recorded by the backup job), not the
 * device's current destination, which may have changed since. Restore and
 * verify follow the same rule (services/backupProviderConfig.ts).
 *
 * - Local destination: named by reference (`provider` + `providerConfigRef`).
 *   The delivery refresher resolves the path into the outgoing frame only
 *   (services/backupCommandCredentials.ts).
 * - No recorded destination (written before destinations were recorded): no
 *   destination, so the helper reads its own store, as before.
 * - Storage (S3) destination: no destination either. A storage destination is
 *   never sent to a device for a read, and `vault_sync` is not served through
 *   storage sessions, so the helper keeps reading its own store.
 * - Recorded destination that no longer resolves in this org: refused.
 *
 * Only the destination's `provider` is selected. Selecting `provider_config`
 * would open (decrypt) the sealed config through its column type, and the
 * destination itself is resolved at delivery, so the request path has no use
 * for it.
 */
export async function resolveVaultSyncSource(
  deviceId: string,
  orgId: string,
  requestedSnapshotId?: string | null,
): Promise<VaultSyncSource> {
  const conditions: SQL[] = [eq(backupSnapshots.deviceId, deviceId), eq(backupSnapshots.orgId, orgId)];
  if (requestedSnapshotId) {
    conditions.push(eq(backupSnapshots.snapshotId, requestedSnapshotId));
  } else {
    // The vault mirrors file backups (the helper auto-syncs only after
    // backup_run). A NULL type predates the column and is a file backup.
    conditions.push(or(eq(backupSnapshots.backupType, 'file'), isNull(backupSnapshots.backupType))!);
  }
  const [snapshot] = await db
    .select({ snapshotId: backupSnapshots.snapshotId, configId: backupSnapshots.configId })
    .from(backupSnapshots)
    .where(and(...conditions))
    .orderBy(desc(backupSnapshots.timestamp))
    .limit(1);

  if (!snapshot) {
    return requestedSnapshotId
      ? { ok: false, status: 404, error: VAULT_SYNC_SNAPSHOT_NOT_FOUND_MESSAGE }
      : { ok: false, status: 400, error: VAULT_SYNC_NO_SNAPSHOT_MESSAGE };
  }
  if (!snapshot.configId) {
    return { ok: true, snapshotId: snapshot.snapshotId, destination: null };
  }

  const [config] = await db
    .select({ provider: backupConfigs.provider })
    .from(backupConfigs)
    .where(and(eq(backupConfigs.id, snapshot.configId), eq(backupConfigs.orgId, orgId)))
    .limit(1);
  if (!config) {
    return { ok: false, status: 422, error: BACKUP_DESTINATION_CONFIG_NOT_FOUND_MESSAGE };
  }
  if (config.provider !== 'local') {
    return { ok: true, snapshotId: snapshot.snapshotId, destination: null };
  }
  return {
    ok: true,
    snapshotId: snapshot.snapshotId,
    destination: backupReadCredentialPayload(snapshot.configId, orgId, config.provider),
  };
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
