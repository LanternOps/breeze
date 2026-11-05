/**
 * Input schemas for the W16 PR A launch tools (full-control W16, #6786):
 * `run_patch_plan` and `create_operator_task`. Each is `.strict()`: the SDK
 * registers `.shape` (not strict on its own), so dispatch (`validateToolInput`)
 * and the handler's `parseInput` are what reject an unknown key, such as a
 * `deviceId` on a patch run or a `recipeKey` on an operator task.
 *
 * `create_operator_task` has no `recipeKey`, no `recipeVersion` and no
 * idempotency key: the recipe is fixed to `service_recovery` at its released
 * version (Decision 4: no identity recipe is reachable), and the key is the
 * approved action intent's id. `serviceName` is the route's own field schema.
 * No `z.undefined()` anywhere: it empties the model's tool list.
 */
import { z } from 'zod';
import { deviceTargetedTaskFieldsSchema } from '@breeze/shared';

const uuid = z.string().guid();

export const aiAgentLaunchToolSchemas = {
  run_patch_plan: z.object({
    orgId: uuid.describe('Organization UUID whose patch agent runs'),
  }).strict(),
  create_operator_task: z.object({
    orgId: uuid.describe('Organization UUID of the device'),
    deviceId: uuid.describe('Device UUID whose service should be running'),
    serviceName: deviceTargetedTaskFieldsSchema.shape.inputs.shape.serviceName
      .describe('Service name as the device reports it (e.g. Spooler)'),
    alertId: uuid.optional()
      .describe('The alert that reported the service down, if any: the task then checks it stays resolved'),
  }).strict(),
} as const;
