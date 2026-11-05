/**
 * Input schema for `manage_c2c_configs` (full-control W17, #6788): one flat strict
 * `z.object` built from the REST schemas' own field shapes, so the tool and the
 * route cannot disagree on what a valid config is. The handler re-validates the
 * action's fields through the route schema itself. `connectionId` is create-only,
 * as at REST. No `z.undefined()` anywhere: it empties the model's tool list.
 */
import { z } from 'zod';
import { createC2cConfigSchema, updateC2cConfigSchema } from '../routes/c2c/schemas';

export const C2C_CONFIG_ACTIONS = ['list', 'create', 'update', 'delete'] as const;

const uuid = z.string().guid();
const create = createC2cConfigSchema.shape;
const update = updateC2cConfigSchema.shape;

export const c2cConfigToolSchemas = {
  manage_c2c_configs: z.object({
    action: z.enum(C2C_CONFIG_ACTIONS),
    orgId: uuid.optional(),
    configId: uuid.optional(),
    connectionId: create.connectionId.optional(),
    name: update.name,
    backupScope: update.backupScope,
    targetUsers: update.targetUsers,
    storageConfigId: update.storageConfigId,
    schedule: update.schedule,
    retention: update.retention,
    isActive: update.isActive,
    limit: z.number().int().min(1).max(100).optional(),
  }).strict(),
};
