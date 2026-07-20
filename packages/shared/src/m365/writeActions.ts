import { z } from 'zod';

const guidSchema = z.string().guid();
// UPN or object id. Forbids quotes/whitespace/backslash so values can be
// spliced into Graph paths/$filter without escaping ambiguity (mirrors
// readActions.ts userIdOrUpnSchema).
const userIdOrUpnSchema = z.string().min(3).max(320).regex(/^[A-Za-z0-9._%+@-]+$/);
const reasonSchema = z.string().min(1).max(500);

export const M365_WRITE_ACTION_IDS = [
  'm365.user.disable',
  'm365.user.reset_password',
] as const;

export type M365WriteActionId = typeof M365_WRITE_ACTION_IDS[number];

export const m365WriteActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('m365.user.disable'),
    userIdentifier: userIdOrUpnSchema,
    reason: reasonSchema,
  }).strict(),
  z.object({
    type: z.literal('m365.user.reset_password'),
    userIdentifier: userIdOrUpnSchema,
    reason: reasonSchema,
  }).strict(),
]);

export type M365WriteAction = z.infer<typeof m365WriteActionSchema>;

export const writeActionRequestSchema = z.object({
  correlationId: guidSchema,
  tenantId: guidSchema,
  // = the immutable action_intents.id; carried for audit correlation and as
  // the natural key for a future executor-side dedup store.
  idempotencyKey: z.string().min(1).max(200),
  action: m365WriteActionSchema,
}).strict();

export type WriteActionRequest = z.infer<typeof writeActionRequestSchema>;

export const writeActionFailureCodeSchema = z.enum([
  'credential_unavailable',
  'application_token_invalid',
  'user_not_found',
  'user_ambiguous',
  'tenant_mismatch',
  'graph_permission_missing',
  'graph_throttled',
  'graph_request_timeout',
  'graph_transport_failed',
  'graph_error',
  'invalid_action',
]);

export type WriteActionFailureCode = z.infer<typeof writeActionFailureCodeSchema>;

export const writeActionResultSchema = z.union([
  z.object({
    success: z.literal(true),
    action: z.literal('m365.user.disable'),
    userId: guidSchema,
  }).strict(),
  z.object({
    success: z.literal(true),
    action: z.literal('m365.user.reset_password'),
    userId: guidSchema,
    temporaryPassword: z.string().min(1).max(256),
    forceChangeNextSignIn: z.literal(true),
  }).strict(),
  z.object({
    success: z.literal(false),
    errorCode: writeActionFailureCodeSchema,
    retryAfterSeconds: z.number().int().min(1).max(300).optional(),
  }).strict(),
]);

export type WriteActionResult = z.infer<typeof writeActionResultSchema>;
