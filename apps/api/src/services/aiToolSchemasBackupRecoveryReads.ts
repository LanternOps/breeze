/**
 * Input schemas for the W17 recovery reads (full-control W17, #6788):
 * `list_bmr_recoveries` and `get_backup_health`. Plain strict `z.object`s so the
 * chat SDK `tool()` declarations can take `.shape` directly. Arrays stand in for
 * the health route's CSV query strings. No `z.undefined()` anywhere: it empties
 * the model's tool list.
 */
import { EXTERNAL_BACKUP_STATUSES } from '@breeze/shared';
import { z } from 'zod';

export const BMR_RECOVERY_ACTIONS = ['list', 'get'] as const;
export const BACKUP_HEALTH_SOURCES = ['breeze', 'provider'] as const;
export const BACKUP_HEALTH_LEVELS = ['healthy', 'warning', 'critical', 'unknown'] as const;

const uuid = z.string().guid();

export const backupRecoveryReadToolSchemas = {
  list_bmr_recoveries: z.object({
    action: z.enum(BMR_RECOVERY_ACTIONS),
    orgId: uuid.optional(),
    deviceId: uuid.optional(),
    recoveryId: uuid.optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }).strict(),

  get_backup_health: z.object({
    orgId: uuid.optional(),
    source: z.array(z.enum(BACKUP_HEALTH_SOURCES)).max(2).optional(),
    health: z.array(z.enum(BACKUP_HEALTH_LEVELS)).max(4).optional(),
    status: z.array(z.enum(EXTERNAL_BACKUP_STATUSES)).max(EXTERNAL_BACKUP_STATUSES.length).optional(),
    withBackup: z.boolean().optional(),
    search: z.string().trim().max(200).optional(),
    cursor: z.string().max(4096).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).strict(),
};
