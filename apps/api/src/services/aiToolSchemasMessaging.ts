/**
 * Endpoint messaging AI tool input schema (#8742 W02).
 *
 * A plain strict z.object with an `action` enum (not a discriminated union or
 * a refined schema) so `toolActionEnum` can read `.shape.action.options`.
 * Per-action required fields are enforced by the handler through the shared
 * `endpointMessageSendSchema`, the same validator the HTTP route uses. No
 * z.undefined() anywhere: it empties the model's tool list.
 */
import { z } from 'zod';
import { ENDPOINT_MESSAGE_LIMITS, ENDPOINT_MESSAGE_SEVERITIES } from '@breeze/shared';

const uuid = z.string().guid();
const uuidList = z.array(uuid).max(ENDPOINT_MESSAGE_LIMITS.maxDevices);

/** Raw shape, shared with the chat SDK `tool()` declaration (aiAgentSdkTools.ts). */
export const sendEndpointMessageShape = {
    action: z.enum(['send', 'list', 'get']),
    // send
    targets: z.object({
      deviceIds: uuidList.optional(),
      siteIds: uuidList.optional(),
      deviceGroupIds: uuidList.optional(),
      orgId: uuid.optional(),
    }).strict().optional(),
    title: z.string().max(ENDPOINT_MESSAGE_LIMITS.titleMax).optional(),
    body: z.string().max(ENDPOINT_MESSAGE_LIMITS.bodyMax).optional(),
    severity: z.enum(ENDPOINT_MESSAGE_SEVERITIES).optional(),
    requiresAck: z.boolean().optional(),
    expiresInMinutes: z.number().int().min(1).max(ENDPOINT_MESSAGE_LIMITS.maxExpiresInMinutes).nullable().optional(),
    confirmedCount: z.number().int().min(0).optional(),
    // list
    orgId: uuid.optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().max(512).optional(),
    // get
    messageId: uuid.optional(),
} as const;

export const messagingToolSchemas: Record<string, z.ZodType> = {
  send_endpoint_message: z.object(sendEndpointMessageShape).strict(),
};
