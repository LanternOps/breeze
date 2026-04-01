import { and, desc, eq } from 'drizzle-orm';

import { db } from '../db';
import { backupSnapshots, localVaults, vaultSnapshotInventory } from '../db/schema';
import { vaultSyncStructuredResultSchema } from './agentCommandResultValidation';

type VaultSyncCommandLike = {
  payload?: unknown;
};

export interface ApplyVaultSyncCommandResultInput {
  deviceId: string;
  command?: VaultSyncCommandLike | null;
  resultStatus: 'completed' | 'failed' | 'timeout';
  stdout?: string;
  stderr?: string;
  error?: string;
}

function parseStructuredStdout(stdout?: string): Record<string, unknown> {
  if (!stdout) return {};
  try {
    return vaultSyncStructuredResultSchema.parse(JSON.parse(stdout));
  } catch (err) {
    console.warn('[VaultSyncPersistence] Failed to parse structured stdout:', err instanceof Error ? err.message : err);
    return {};
  }
}

function parsePayload(command?: VaultSyncCommandLike | null): { vaultId?: string; snapshotId?: string } {
  const payload =
    command?.payload && typeof command.payload === 'object' && !Array.isArray(command.payload)
      ? command.payload as Record<string, unknown>
      : {};
  return {
    vaultId: typeof payload.vaultId === 'string' ? payload.vaultId : undefined,
    snapshotId: typeof payload.snapshotId === 'string' ? payload.snapshotId : undefined,
  };
}

async function resolveVaultRecord(deviceId: string, structured: Record<string, unknown>, payload: { vaultId?: string }): Promise<{ id: string; orgId: string } | null> {
  if (payload.vaultId || structured.vaultId) {
    const [vault] = await db
      .select({ id: localVaults.id, orgId: localVaults.orgId })
      .from(localVaults)
      .where(
        and(
          eq(localVaults.id, payload.vaultId ?? String(structured.vaultId)),
          eq(localVaults.deviceId, deviceId)
        )
      )
      .limit(1);
    return vault ?? null;
  }

  if (structured.vaultPath) {
    const [vault] = await db
      .select({ id: localVaults.id, orgId: localVaults.orgId })
      .from(localVaults)
      .where(
        and(
          eq(localVaults.deviceId, deviceId),
          eq(localVaults.vaultPath, String(structured.vaultPath)),
          eq(localVaults.isActive, true)
        )
      )
      .limit(1);
    if (vault) return vault;
  }

  const vaults = await db
    .select({ id: localVaults.id, orgId: localVaults.orgId })
    .from(localVaults)
    .where(and(eq(localVaults.deviceId, deviceId), eq(localVaults.isActive, true)))
    .limit(2);

  return vaults.length === 1 ? vaults[0]! : null;
}

export async function applyVaultSyncCommandResult(input: ApplyVaultSyncCommandResultInput): Promise<void> {
  const structured = parseStructuredStdout(input.stdout);
  const payload = parsePayload(input.command);
  const snapshotId = typeof structured.snapshotId === 'string' ? structured.snapshotId : payload.snapshotId ?? null;
  const vault = await resolveVaultRecord(input.deviceId, structured, payload);

  if (!vault) {
    console.warn(
      `[VaultSyncPersistence] No matching vault found for device ${input.deviceId}; ` +
      `dropping vault sync result (vaultId=${String(structured.vaultId ?? payload.vaultId ?? 'none')}, ` +
      `vaultPath=${String(structured.vaultPath ?? 'none')})`
    );
    return;
  }

  const completedAt = new Date();
  const status = input.resultStatus === 'completed' ? 'completed' : 'failed';
  const lastSyncError = status === 'completed'
    ? null
    : (typeof structured.error === 'string' ? structured.error : undefined) ??
      input.error ??
      input.stderr ??
      input.stdout ??
      'Vault sync failed';

  await db
    .update(localVaults)
    .set({
      lastSyncAt: completedAt,
      lastSyncStatus: status,
      lastSyncSnapshotId: snapshotId,
      syncSizeBytes: typeof structured.totalBytes === 'number' ? structured.totalBytes : null,
      lastSyncError,
      updatedAt: completedAt,
    })
    .where(eq(localVaults.id, vault.id));

  if (status !== 'completed' || !snapshotId) {
    return;
  }

  const [snapshot] = await db
    .select({
      id: backupSnapshots.id,
      orgId: backupSnapshots.orgId,
      size: backupSnapshots.size,
    })
    .from(backupSnapshots)
    .where(
      and(
        eq(backupSnapshots.snapshotId, snapshotId),
        eq(backupSnapshots.deviceId, input.deviceId)
      )
    )
    .orderBy(desc(backupSnapshots.timestamp))
    .limit(1);

  if (!snapshot) {
    return;
  }

  await db
    .insert(vaultSnapshotInventory)
    .values({
      orgId: snapshot.orgId,
      vaultId: vault.id,
      snapshotDbId: snapshot.id,
      externalSnapshotId: snapshotId,
      syncedAt: completedAt,
      sizeBytes: typeof structured.totalBytes === 'number' ? structured.totalBytes : snapshot.size,
      fileCount: typeof structured.fileCount === 'number' ? structured.fileCount : undefined,
      manifestVerified: typeof structured.manifestVerified === 'boolean' ? structured.manifestVerified : false,
      createdAt: completedAt,
      updatedAt: completedAt,
    })
    .onConflictDoUpdate({
      target: [
        vaultSnapshotInventory.vaultId,
        vaultSnapshotInventory.snapshotDbId,
      ],
      set: {
        externalSnapshotId: snapshotId,
        syncedAt: completedAt,
        sizeBytes: typeof structured.totalBytes === 'number' ? structured.totalBytes : snapshot.size,
        fileCount: typeof structured.fileCount === 'number' ? structured.fileCount : undefined,
        manifestVerified: typeof structured.manifestVerified === 'boolean' ? structured.manifestVerified : false,
        updatedAt: completedAt,
      },
    });
}
