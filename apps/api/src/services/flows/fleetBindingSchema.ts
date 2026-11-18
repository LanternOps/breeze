/**
 * Tool Catalog W06 (#5221, Decision 5) — the stored shape of a fleet
 * pre-approval binding (`fleet_v1`), stored on the publication beside the W04
 * act-asset bindings. A leaf (zod + shared only) so the flow validator's
 * stored-binding schema and the fleet lane (fleetPreApproval.ts) share it
 * without an import cycle.
 */
import { z } from 'zod';
import { FLEET_MAX_TARGETS } from '@breeze/shared';

export const FLEET_TOOL = 'run_script_on_targets';

const HEX64 = z.string().regex(/^[0-9a-f]{64}$/);

export const fleetBindingV1Schema = z.object({
  stepId: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  lane: z.literal('fleet'),
  kind: z.literal('fleet_v1'),
  publicationId: z.string().uuid(),
  tool: z.literal(FLEET_TOOL),
  owner: z.object({ orgId: z.string().uuid().nullable(), partnerId: z.string().uuid() }).strict(),
  scriptId: z.string().uuid(),
  scriptMaterialSha256: HEX64,
  parametersSha256: HEX64,
  effectiveRunAs: z.enum(['system', 'user']),
  offlinePolicy: z.enum(['queue', 'skip']),
  deliveryDeadlineSec: z.number().int().min(0),
  selector: z.object({
    kind: z.enum(['target', 'conditions', 'trigger_device', 'from_step']),
    canonicalSha256: HEX64,
    dynamicGroupDefinitions: z.record(z.string().uuid(), HEX64),
  }).strict(),
  maxTargets: z.number().int().min(1).max(FLEET_MAX_TARGETS),
}).strict();
export type FleetBindingV1 = z.infer<typeof fleetBindingV1Schema>;
