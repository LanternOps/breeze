/**
 * Input schemas for the W17 verification tools (full-control W17, #6788):
 * `manage_backup_verification` and `get_vss_status`. Plain strict `z.object`s so
 * `toolActionEnum` can read `.shape.action.options` and the chat SDK `tool()`
 * declarations can take `.shape` directly. Per-action required fields are
 * enforced in the handler. No `z.undefined()` anywhere: it empties the model's
 * tool list.
 */
import { z } from 'zod';

// The vocabularies live here (a light module) so the schema graph never pulls in the db-bound handlers.
export const BACKUP_VERIFICATION_ACTIONS = ['health', 'list', 'readiness', 'run'] as const;
export const BACKUP_VERIFICATION_TYPES = ['integrity', 'test_restore'] as const;
export const BACKUP_VERIFICATION_STATUSES = ['pending', 'running', 'passed', 'failed', 'partial'] as const;

const uuid = z.string().guid();

export const backupVerificationToolSchemas = {
  manage_backup_verification: z.object({
    action: z.enum(BACKUP_VERIFICATION_ACTIONS),
    orgId: uuid.optional(),
    deviceId: uuid.optional(),
    backupJobId: uuid.optional(),
    snapshotId: uuid.optional(),
    verificationType: z.enum(BACKUP_VERIFICATION_TYPES).optional(),
    status: z.enum(BACKUP_VERIFICATION_STATUSES).optional(),
    from: z.string().max(64).optional(),
    to: z.string().max(64).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).strict(),

  get_vss_status: z.object({
    deviceId: uuid,
  }).strict(),
};
