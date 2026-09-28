import { z } from 'zod';

/**
 * Stored shape of a standing arm's frozen authority (M3-D3). A dependency-free
 * leaf: the delivery revalidation that reads it sits in commandDispatch.ts's
 * import closure and must not reach request-side modules.
 */
const uuid = z.uuid();
export const topologyArmActorSchema = z.object({
  user: z.object({ id: uuid, email: z.string().max(320), name: z.string().max(512), isPlatformAdmin: z.boolean() }).strict(),
  principal: z.object({ kind: z.literal('user_session') }).strict(),
  scope: z.enum(['system', 'partner', 'organization']),
  orgId: uuid.nullable(),
  partnerId: uuid.nullable(),
  accessibleOrgIds: z.array(uuid).length(1),
  allowedSiteIds: z.array(uuid).length(1).optional(),
  partnerOrgAccess: z.enum(['all', 'selected', 'none']).nullable().optional(),
  authEpoch: z.number().int(),
  mfaEpoch: z.number().int(),
  mfa: z.boolean(),
}).strict();
export const topologyArmAuthorityRecordSchema = z.object({
  version: z.literal(1),
  actor: topologyArmActorSchema,
  permissionVersion: z.string().min(1).max(256),
}).strict();
export type TopologyArmAuthorityRecord = z.infer<typeof topologyArmAuthorityRecordSchema>;

