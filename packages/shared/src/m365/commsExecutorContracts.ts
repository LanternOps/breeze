/**
 * Wire contracts between the Breeze API and the M365 communications executor
 * (design §9). Lives beside — not inside — commsActions.ts because the send
 * request embeds the effect envelope, and commsEffect.ts already imports from
 * commsActions.ts; a back-import would be circular.
 *
 * NOTE: there is deliberately NO `effectDigest`/`planDigest` field in any
 * request here. The digests the executor verifies arrive as signed JWT claims
 * and nowhere else. A body field would let an implementer compare the envelope
 * against a digest computed from that same envelope — a self-consistency check
 * that always passes while proving nothing (design §5.2). If one is ever added
 * it must be asserted *equal to* the claim, never read instead of it.
 */
import { z } from 'zod';
import { m365CommsInlineActionSchema, m365CommsFailureCodeSchema } from './commsActions';
import { commsSendEffectSchema } from './commsEffect';

const guidSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  'must be a canonical lowercase GUID',
);

const baseRequestFields = {
  correlationId: guidSchema,
  connectionId: guidSchema,
  tenantId: guidSchema,
  /** Pinned at consent; the executor asserts MSAL's account `oid` against it. */
  expectedUserObjectId: guidSchema,
  /** Must match the token-cache row's stamped generation, checked twice for sends (design §5.2). */
  consentGeneration: z.number().int().min(0),
  cacheGeneration: z.number().int().min(0).optional(),
  /** = the immutable `action_intents.id`, for audit correlation and future dedup. */
  idempotencyKey: z.string().min(1).max(200).optional(),
} as const;

export const m365CommsReadRequestSchema = z.object({
  ...baseRequestFields,
  action: m365CommsInlineActionSchema,
}).strict();
export type M365CommsReadRequest = z.infer<typeof m365CommsReadRequestSchema>;

/**
 * A send carries the stored effect envelope verbatim — never tool-input shape.
 * The envelope's own binding fields must agree with the outer request's; a
 * disagreement means the API assembled the request from something other than
 * the intent, and the executor must never see it as merely "invalid input"
 * downstream of credential access, so it is refused at the schema.
 */
export const m365CommsSendRequestSchema = z.object({
  ...baseRequestFields,
  envelope: commsSendEffectSchema,
}).strict().superRefine((request, ctx) => {
  const mismatches: Array<[string, unknown, unknown]> = [
    ['connectionId', request.envelope.connectionId, request.connectionId],
    ['tenantId', request.envelope.tenantId, request.tenantId],
    ['senderObjectId', request.envelope.senderObjectId, request.expectedUserObjectId],
    ['consentGeneration', request.envelope.consentGeneration, request.consentGeneration],
  ];
  for (const [field, inEnvelope, inRequest] of mismatches) {
    if (inEnvelope !== inRequest) {
      ctx.addIssue({ code: 'custom', message: `envelope.${field} must equal the request binding` });
    }
  }
});
export type M365CommsSendRequest = z.infer<typeof m365CommsSendRequestSchema>;

export const m365CommsRequestSchema = z.union([
  m365CommsReadRequestSchema,
  m365CommsSendRequestSchema,
]);
export type M365CommsRequest = z.infer<typeof m365CommsRequestSchema>;

const cacheMetaFields = {
  /** The store's cache_version after this call — the API writes it back to `credential_version`. */
  usedCacheGeneration: z.number().int().min(0).optional(),
  /** True when this call redeemed the refresh token (MSAL rotated the cache). */
  rotated: z.boolean().optional(),
} as const;

const commsExecutorFailureSchema = z.object({
  success: z.literal(false),
  errorCode: m365CommsFailureCodeSchema,
  retryAfterSeconds: z.number().int().min(1).max(300).optional(),
}).strict();

export const m365CommsResultSchema = z.union([
  z.object({
    success: z.literal(true),
    kind: z.literal('collection'),
    items: z.array(z.record(z.string(), z.unknown())),
    truncated: z.boolean(),
    ...cacheMetaFields,
  }).strict(),
  z.object({
    success: z.literal(true),
    kind: z.literal('resource'),
    resource: z.record(z.string(), z.unknown()),
    truncated: z.boolean().optional(),
    ...cacheMetaFields,
  }).strict(),
  z.object({
    success: z.literal(true),
    kind: z.literal('sent'),
    /** Graph's sendMail returns 202 with no body; there is nothing to project. */
    sentAt: z.string().min(1).max(64),
    ...cacheMetaFields,
  }).strict(),
  commsExecutorFailureSchema,
]);
export type M365CommsResult = z.infer<typeof m365CommsResultSchema>;

// ---------------------------------------------------------------------------
// Delegated consent completion (design §4.2) — the app-only contract in
// executorContracts.ts does not fit the user axis (admin object id, app-role
// reconciliation), hence a parallel contract rather than a reuse.
// ---------------------------------------------------------------------------

export const commsCompleteConsentRequestSchema = z.object({
  correlationId: guidSchema,
  connectionId: guidSchema,
  consentAttemptId: guidSchema,
  /** The consent_generation this attempt will claim if promoted (current + 1). */
  claimedConsentGeneration: z.number().int().min(1),
  authorizationCode: z.string().min(1).max(8192),
  codeVerifier: z.string().min(43).max(128),
  nonce: z.string().min(1).max(512),
  redirectUri: z.string().url().max(2048),
  /**
   * Null on first consent (the tenant is learned from the ID token). Set on
   * reconnect: a different returned `tid` is refused with `tenant_mismatch`
   * BEFORE anything is persisted — reconnect must not be a mailbox-substitution
   * primitive (design §4.2 step 4).
   */
  expectedTenantId: guidSchema.nullable(),
}).strict();
export type CommsCompleteConsentRequest = z.infer<typeof commsCompleteConsentRequestSchema>;

export const commsCompleteConsentResultSchema = z.union([
  z.object({
    success: z.literal(true),
    tenantId: guidSchema,
    userObjectId: guidSchema,
    userPrincipalName: z.string().min(1).max(320),
    mail: z.string().min(1).max(320).nullable(),
    grantedScopes: z.array(z.string().min(1).max(200)).max(50),
    /** The cache row's cache_version — becomes `m365_connections.credential_version`. */
    cacheGeneration: z.number().int().min(0),
    verifiedAt: z.string().datetime({ offset: true }),
  }).strict(),
  commsExecutorFailureSchema,
]);
export type CommsCompleteConsentResult = z.infer<typeof commsCompleteConsentResultSchema>;

export const commsRetestRequestSchema = z.object({
  correlationId: guidSchema,
  connectionId: guidSchema,
  tenantId: guidSchema,
  expectedUserObjectId: guidSchema,
  consentGeneration: z.number().int().min(0),
}).strict();
export type CommsRetestRequest = z.infer<typeof commsRetestRequestSchema>;

export const commsRetestResultSchema = z.union([
  z.object({
    success: z.literal(true),
    userPrincipalName: z.string().min(1).max(320),
    usedCacheGeneration: z.number().int().min(0),
    verifiedAt: z.string().datetime({ offset: true }),
  }).strict(),
  commsExecutorFailureSchema,
]);
export type CommsRetestResult = z.infer<typeof commsRetestResultSchema>;

export const commsRevokeConnectionRequestSchema = z.object({
  correlationId: guidSchema,
  connectionId: guidSchema,
  /**
   * When set: tombstone only if the row belongs to this attempt — the
   * consent-supersede cleanup (design §4.1 step 3). Null: unconditional revoke.
   */
  consentAttemptId: guidSchema.nullable(),
}).strict();
export type CommsRevokeConnectionRequest = z.infer<typeof commsRevokeConnectionRequestSchema>;

export const commsRevokeConnectionResultSchema = z.union([
  z.object({ success: z.literal(true), tombstoned: z.boolean() }).strict(),
  commsExecutorFailureSchema,
]);
export type CommsRevokeConnectionResult = z.infer<typeof commsRevokeConnectionResultSchema>;
