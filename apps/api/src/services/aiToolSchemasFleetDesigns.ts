/**
 * Input schema for `manage_fleet_designs` (full-control W16 PR B, #6786). Flat,
 * because the SDK registers `.shape`; the handler refuses another action's fields.
 * `approval` is the route's own schema, so the two cannot drift. `designer/enable`
 * has no action: it creates or turns on an autonomous agent, `manage_ai_agents`
 * territory, and stays on the Fleet Design page. No `z.undefined()` anywhere: it
 * empties the model's tool list.
 */
import { z } from 'zod';
import { fleetDesignApprovalSchema } from '@breeze/shared';

const uuid = z.string().guid();

export const FLEET_DESIGN_ACTIONS = ['run', 'preview', 'applied', 'apply', 'rollback', 'document'] as const;

export const fleetDesignToolSchemas = {
  manage_fleet_designs: z.object({
    action: z.enum(FLEET_DESIGN_ACTIONS),
    orgId: uuid.optional().describe('run: the organization to design for'),
    siteId: uuid.optional().describe('run: limit the design\'s evidence to one site of that organization'),
    reportRunId: uuid.optional().describe('Every action but run: the design (from list_fleet_designs)'),
    approval: fleetDesignApprovalSchema.optional()
      .describe('preview, apply: the item refs being approved. Preview first, and apply with the same refs'),
  }).strict(),
} as const;
