import { z } from 'zod';

const guidSchema = z.string().guid();
const timestampSchema = z.string().datetime({ offset: true });

export const completeConsentRequestSchema = z.object({
  correlationId: guidSchema,
  consentAttemptId: guidSchema,
  tenantHint: guidSchema,
  authorizationCode: z.string().min(1).max(8192),
  codeVerifier: z.string().min(43).max(128),
  nonce: z.string().min(1).max(512),
  redirectUri: z.string().url().max(2048),
}).strict();

export const retestRequestSchema = z.object({
  correlationId: guidSchema,
  tenantId: guidSchema,
}).strict();

/**
 * Identity-first consent, phase 1: redeem a v2 OIDC code and verify the
 * administrator's id_token. `expectedTenantId: null` means the sign-in ran at
 * the `organizations` authority (initial connect); a GUID pins redemption and
 * the `tid` equality check to that tenant (reconnect of a bound row, upgrade).
 */
export const verifyConsentIdentityRequestSchema = z.object({
  correlationId: guidSchema,
  consentAttemptId: guidSchema,
  expectedTenantId: guidSchema.nullable(),
  authorizationCode: z.string().min(1).max(8192),
  codeVerifier: z.string().min(43).max(128),
  nonce: z.string().min(1).max(512),
  redirectUri: z.string().url().max(2048),
}).strict();

export const identityFailureCodeSchema = z.enum([
  'admin_role_required',
  'tenant_mismatch',
  'credential_unavailable',
  'identity_token_invalid',
]);

/** Identity proof only: no application-token, probe, grant, or token fields. */
export const verifyConsentIdentityResultSchema = z.union([
  z.object({
    success: z.literal(true),
    tenantId: guidSchema,
    administratorObjectId: guidSchema,
    administratorUsername: z.string().min(1).max(256).nullable(),
    verifiedAt: timestampSchema,
  }).strict(),
  z.object({
    success: z.literal(false),
    errorCode: identityFailureCodeSchema,
  }).strict(),
]);

export const executorFailureCodeSchema = z.enum([
  'admin_role_required',
  'tenant_mismatch',
  'credential_unavailable',
  'identity_token_invalid',
  'application_token_invalid',
  'organization_probe_failed',
]);

export const canonicalAppRoleAssignmentSchema = z.object({
  resourceApplicationId: guidSchema,
  appRoleId: guidSchema,
  value: z.string().min(1).nullable(),
}).strict();

const verifiedResultFields = {
  success: z.literal(true),
  tenantId: guidSchema,
  applicationId: guidSchema,
  organizationDisplayName: z.string().min(1).max(256),
  manifestVersion: z.number().int().positive(),
  verifiedAt: timestampSchema,
} as const;

const completeReconciliationFields = {
  grantReconciliation: z.literal('complete'),
  observedGrants: z.array(canonicalAppRoleAssignmentSchema),
  missingGrants: z.array(canonicalAppRoleAssignmentSchema),
  unexpectedGrants: z.array(canonicalAppRoleAssignmentSchema),
  grantsVerifiedAt: timestampSchema,
} as const;

const unavailableReconciliationFields = {
  grantReconciliation: z.literal('unavailable'),
  errorCode: z.literal('grant_reconciliation_unavailable'),
  observedGrants: z.null(),
  missingGrants: z.null(),
  unexpectedGrants: z.null(),
  grantsVerifiedAt: z.null(),
} as const;

const executorFailureResultSchema = z.object({
  success: z.literal(false),
  errorCode: executorFailureCodeSchema,
}).strict();

const completeConsentVerifiedResultSchema = z.discriminatedUnion('grantReconciliation', [
  z.object({
    ...verifiedResultFields,
    administratorObjectId: guidSchema,
    ...completeReconciliationFields,
  }).strict(),
  z.object({
    ...verifiedResultFields,
    administratorObjectId: guidSchema,
    ...unavailableReconciliationFields,
  }).strict(),
]);

const retestVerifiedResultSchema = z.discriminatedUnion('grantReconciliation', [
  z.object({
    ...verifiedResultFields,
    ...completeReconciliationFields,
  }).strict(),
  z.object({
    ...verifiedResultFields,
    ...unavailableReconciliationFields,
  }).strict(),
]);

export const completeConsentResultSchema = z.union([
  completeConsentVerifiedResultSchema,
  executorFailureResultSchema,
]);

export const retestResultSchema = z.union([
  retestVerifiedResultSchema,
  executorFailureResultSchema,
]);

export type CompleteConsentRequest = z.infer<typeof completeConsentRequestSchema>;
export type RetestRequest = z.infer<typeof retestRequestSchema>;
export type VerifyConsentIdentityRequest = z.infer<typeof verifyConsentIdentityRequestSchema>;
export type VerifyConsentIdentityResult = z.infer<typeof verifyConsentIdentityResultSchema>;
export type IdentityFailureCode = z.infer<typeof identityFailureCodeSchema>;
export type ExecutorFailureCode = z.infer<typeof executorFailureCodeSchema>;
export type CompleteConsentResult = z.infer<typeof completeConsentResultSchema>;
export type RetestResult = z.infer<typeof retestResultSchema>;
