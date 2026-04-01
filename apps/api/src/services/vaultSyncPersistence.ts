import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../db';
import { backupSnapshots, localVaults, vaultSnapshotInventory } from '../db/schema';

const vaultSyncResultSchema = z.object({
  vaultId: z.string().uuid().optional(),
  snapshotId: z.string().min(1).optional(),
  vaultPath: z.string().min(1).optional(),
  fileCount: z.number().int().nonnegative().optional(),
  totalBytes: z.number().int().nonnegative().optional(),
  manifestVerified: z.boolean().optional(),
  auto: z.boolean().optional(),
  error: z.string().optional(),
});

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

function parseStructuredStdout(stdout?: string): z.infer<typeof vaultSyncResultSchema> {
  if (!stdout) return {};
  try {
    return vaultSyncResultSchema.parse(JSON.parse(stdout));
  } catch {
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

async function resolveVaultRecord(deviceId: string, structured: z.infer<typeof vaultSyncResultSchema>, payload: { vaultId?: string }): Promise<{ id: string; orgId: string } | null> {
  if (payload.vaultId || structured.vaultId) {
    const [vault] = await db
      .select({ id: localVaults.id, orgId: localVaults.orgId })
      .from(localVaults)
      .where(
        and(
          eq(localVaults.id, payload.vaultId ?? structured.vaultId!),
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
          eq(localVaults.vaultPath, structured.vaultPath),
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
  const snapshotId = structured.snapshotId ?? payload.snapshotId ?? null;
  const vault = await resolveVaultRecord(input.deviceId, structured, payload);

  if (!vault) {
    console.warn(
      `[VaultSyncPersistence] No matching vault found for device ${input.deviceId}; ` +
      `dropping vault sync result (vaultId=${structured.vaultId ?? payload.vaultId ?? 'none'}, ` +
      `vaultPath=${structured.vaultPath ?? 'none'})`
    );
    return;
  }

  const completedAt = new Date();
  const status = input.resultStatus === 'completed' ? 'completed' : 'failed';
  const lastSyncError = status === 'completed'
    ? null
    : structured.error ?? input.error ?? input.stderr ?? input.stdout ?? 'Vault sync failed';

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
      fileCount: structured.fileCount,
      manifestVerified: structured.manifestVerified ?? false,
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
        fileCount: structured.fileCount,
        manifestVerified: structured.manifestVerified ?? false,
        updatedAt: completedAt,
      },
    });
}
