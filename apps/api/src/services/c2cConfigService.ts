/**
 * Cloud-to-cloud backup config writes, shared by routes/c2c/configs.ts and the
 * `manage_c2c_configs` AI tool (full-control W17, #6788) so the two cannot drift
 * on which connection or storage config a config may point at.
 *
 * Runs on the caller's ambient db context. Callers resolve and authorize `orgId`;
 * every read and write here is bound to it.
 */
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db, hasDbAccessContext, withDbTransaction } from '../db';
import { backupConfigs, c2cBackupConfigs, c2cBackupItems, c2cBackupJobs, c2cConnections } from '../db/schema';
import type { createC2cConfigSchema, updateC2cConfigSchema } from '../routes/c2c/schemas';
import { isHoldingOrg } from './unassignedPool/protectedOrg';
import { isPgForeignKeyViolation } from '../utils/pgErrors';

export type C2cConfigRow = typeof c2cBackupConfigs.$inferSelect;
export type C2cConfigErrorCode = 'NOT_FOUND' | 'CONNECTION_NOT_FOUND' | 'STORAGE_NOT_FOUND' | 'PROTECTED_ORG' | 'CONFIG_HAS_HISTORY';
export type C2cConfigResult<T> = { ok: true; value: T } | { ok: false; code: C2cConfigErrorCode };

export type CreateC2cConfigInput = z.infer<typeof createC2cConfigSchema>;
export type UpdateC2cConfigInput = z.infer<typeof updateC2cConfigSchema>;

/** What a person is told when a config with history cannot be deleted. */
export const C2C_CONFIG_HAS_HISTORY_MESSAGE =
  'This config has backup history, which depends on it, so it cannot be deleted. Set isActive to false to stop its schedule.';

export function toC2cConfigResponse(row: C2cConfigRow) {
  return {
    id: row.id,
    connectionId: row.connectionId,
    name: row.name,
    backupScope: row.backupScope,
    targetUsers: row.targetUsers as string[],
    storageConfigId: row.storageConfigId,
    schedule: row.schedule as Record<string, unknown> | null,
    retention: row.retention as Record<string, unknown> | null,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function storageConfigBelongsToOrg(storageConfigId: string | null | undefined, orgId: string): Promise<boolean> {
  if (!storageConfigId) return true;
  const [storageConfig] = await db
    .select({ id: backupConfigs.id })
    .from(backupConfigs)
    .where(and(eq(backupConfigs.id, storageConfigId), eq(backupConfigs.orgId, orgId)))
    .limit(1);
  return Boolean(storageConfig);
}

export async function listC2cConfigs(orgId: string): Promise<C2cConfigRow[]> {
  return db.select().from(c2cBackupConfigs).where(eq(c2cBackupConfigs.orgId, orgId));
}

export async function createC2cConfig(orgId: string, input: CreateC2cConfigInput): Promise<C2cConfigResult<C2cConfigRow>> {
  // canAccessOrg is true for system scope: the holding org is never a target.
  if (await isHoldingOrg(orgId)) return { ok: false, code: 'PROTECTED_ORG' };

  const [connection] = await db
    .select({ id: c2cConnections.id })
    .from(c2cConnections)
    .where(and(eq(c2cConnections.id, input.connectionId), eq(c2cConnections.orgId, orgId)))
    .limit(1);
  if (!connection) return { ok: false, code: 'CONNECTION_NOT_FOUND' };
  if (!(await storageConfigBelongsToOrg(input.storageConfigId, orgId))) return { ok: false, code: 'STORAGE_NOT_FOUND' };

  const now = new Date();
  const [row] = await db
    .insert(c2cBackupConfigs)
    .values({
      orgId,
      connectionId: input.connectionId,
      name: input.name,
      backupScope: input.backupScope,
      targetUsers: input.targetUsers ?? [],
      storageConfigId: input.storageConfigId ?? null,
      schedule: input.schedule ?? null,
      retention: input.retention ?? null,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error('Failed to create config');
  return { ok: true, value: row };
}

export async function updateC2cConfig(orgId: string, id: string, input: UpdateC2cConfigInput): Promise<C2cConfigResult<C2cConfigRow>> {
  if (!(await storageConfigBelongsToOrg(input.storageConfigId, orgId))) return { ok: false, code: 'STORAGE_NOT_FOUND' };

  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) updateData.name = input.name;
  if (input.backupScope !== undefined) updateData.backupScope = input.backupScope;
  if (input.targetUsers !== undefined) updateData.targetUsers = input.targetUsers;
  if (input.storageConfigId !== undefined) updateData.storageConfigId = input.storageConfigId;
  if (input.schedule !== undefined) updateData.schedule = input.schedule;
  if (input.retention !== undefined) updateData.retention = input.retention;
  if (input.isActive !== undefined) updateData.isActive = input.isActive;

  const [row] = await db
    .update(c2cBackupConfigs)
    .set(updateData)
    .where(and(eq(c2cBackupConfigs.id, id), eq(c2cBackupConfigs.orgId, orgId)))
    .returning();
  return row ? { ok: true, value: row } : { ok: false, code: 'NOT_FOUND' };
}

/** The two foreign keys that hold a config in place (0079-c2c-backup.sql, inline REFERENCES, no ON DELETE). */
export const C2C_CONFIG_HISTORY_FKS = ['c2c_backup_jobs_config_id_fkey', 'c2c_backup_items_config_id_fkey'] as const;

/**
 * `c2c_backup_jobs.config_id` and `c2c_backup_items.config_id` reference the
 * config with no ON DELETE, so a config with history cannot be deleted and the
 * history is what must survive. The check answers the common case without a
 * failed statement. A job created between the check and the delete raises 23503
 * inside a savepoint (`withDbTransaction`), so the caller's ambient transaction
 * stays usable; any other failure propagates.
 */
export async function deleteC2cConfig(orgId: string, id: string): Promise<C2cConfigResult<C2cConfigRow>> {
  const [job] = await db
    .select({ id: c2cBackupJobs.id })
    .from(c2cBackupJobs)
    .where(and(eq(c2cBackupJobs.configId, id), eq(c2cBackupJobs.orgId, orgId)))
    .limit(1);
  if (job) return { ok: false, code: 'CONFIG_HAS_HISTORY' };
  const [item] = await db
    .select({ id: c2cBackupItems.id })
    .from(c2cBackupItems)
    .where(and(eq(c2cBackupItems.configId, id), eq(c2cBackupItems.orgId, orgId)))
    .limit(1);
  if (item) return { ok: false, code: 'CONFIG_HAS_HISTORY' };

  const remove = () => db
    .delete(c2cBackupConfigs)
    .where(and(eq(c2cBackupConfigs.id, id), eq(c2cBackupConfigs.orgId, orgId)))
    .returning();
  try {
    const [deleted] = await (hasDbAccessContext() ? withDbTransaction(remove) : remove());
    return deleted ? { ok: true, value: deleted } : { ok: false, code: 'NOT_FOUND' };
  } catch (error) {
    if (C2C_CONFIG_HISTORY_FKS.some((fk) => isPgForeignKeyViolation(error, fk))) return { ok: false, code: 'CONFIG_HAS_HISTORY' };
    throw error;
  }
}
