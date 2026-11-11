import { z } from 'zod';

/**
 * Portal access policy (portal registration W3 #11380; spec
 * docs/superpowers/specs/portal/2026-11-07-portal-registration-options-design.md §4, §5.3).
 *
 * One row per owner, partner default XOR org override. A NULL field means
 * inherit (org row) or the built-in default (partner row). The API resolver is
 * `resolvePortalAccessPolicy` (apps/api/src/services/portalAccessPolicy.ts).
 */

export const PORTAL_ACCESS_POLICY_FIELDS = [
  'entraEnabled',
  'googleEnabled',
  'passwordMode',
  'selfRegistrationMode',
  'ssoNewPersonMode',
  'ssoSessionMaxHours',
] as const;
export type PortalAccessPolicyField = typeof PORTAL_ACCESS_POLICY_FIELDS[number];

export const PORTAL_PASSWORD_MODES = ['allowed', 'sso_only'] as const;
export const PORTAL_SELF_REGISTRATION_MODES = ['off', 'approval', 'instant'] as const;
export const PORTAL_SSO_NEW_PERSON_MODES = ['invited_only', 'approval', 'instant'] as const;
/** SQL CHECK sso_session_max_hours BETWEEN 1 AND 168. */
export const PORTAL_SSO_SESSION_MAX_HOURS_MIN = 1;
export const PORTAL_SSO_SESSION_MAX_HOURS_MAX = 168;

export interface PortalAccessPolicyValues {
  entraEnabled: boolean;
  googleEnabled: boolean;
  passwordMode: typeof PORTAL_PASSWORD_MODES[number];
  selfRegistrationMode: typeof PORTAL_SELF_REGISTRATION_MODES[number];
  ssoNewPersonMode: typeof PORTAL_SSO_NEW_PERSON_MODES[number];
  ssoSessionMaxHours: number;
}

/** One owner's stored row: every field nullable (null = inherit / built-in default). */
export type PortalAccessPolicyRowValues = { [K in PortalAccessPolicyField]: PortalAccessPolicyValues[K] | null };

/**
 * PATCH body for both owner kinds. Each field is optional (absent = untouched)
 * and nullable (null = clear: inherit on an org row, built-in default on a
 * partner row). Unknown keys are refused.
 */
export const portalAccessPolicyPatchSchema = z.object({
  entraEnabled: z.boolean().nullable(),
  googleEnabled: z.boolean().nullable(),
  passwordMode: z.enum(PORTAL_PASSWORD_MODES).nullable(),
  selfRegistrationMode: z.enum(PORTAL_SELF_REGISTRATION_MODES).nullable(),
  ssoNewPersonMode: z.enum(PORTAL_SSO_NEW_PERSON_MODES).nullable(),
  ssoSessionMaxHours: z.number().int()
    .min(PORTAL_SSO_SESSION_MAX_HOURS_MIN)
    .max(PORTAL_SSO_SESSION_MAX_HOURS_MAX)
    .nullable(),
}).partial().strict() satisfies z.ZodType<Partial<PortalAccessPolicyRowValues>>;
export type PortalAccessPolicyPatch = z.infer<typeof portalAccessPolicyPatchSchema>;

/**
 * What the deployment can run. `entra` is on when the portal Entra app is configured
 * (W4: PORTAL_ENTRA_CLIENT_ID + PORTAL_ENTRA_CLIENT_SECRET); W7 (google) and W6
 * (self-registration) flip their own key.
 */
export interface PortalSignInCapabilities {
  entra: boolean;
  google: boolean;
  selfRegistration: boolean;
}

export type PortalPolicySource = 'org' | 'partner' | 'default';

export interface PortalAccessPolicyView {
  owner: { kind: 'org' | 'partner'; id: string };
  /** This owner's own row (all null when it has no row). */
  values: PortalAccessPolicyRowValues;
  /** What each field resolves to when this owner leaves it blank (capability masking and the sso_only fallback applied). */
  inherited: { [K in PortalAccessPolicyField]: { value: PortalAccessPolicyValues[K]; source: Exclude<PortalPolicySource, 'org'> } };
  /** Org view: the org's effective policy. Partner view: what an org with no override gets. */
  effective: { [K in PortalAccessPolicyField]: { value: PortalAccessPolicyValues[K]; source: PortalPolicySource } };
  /** The picked password mode is sso_only but no SSO method is effectively on, so password stays allowed. */
  passwordModeFallback: boolean;
  capabilities: PortalSignInCapabilities;
  /** Partner view: canManagePartnerWidePolicies. Org view: true (the route's org write gate decides). */
  canEdit: boolean;
  /**
   * Org view: whether the org's Microsoft (Entra) tenant is proven (W4 #11381, spec §5.4).
   * Microsoft is effectively off without it, inherited or not. Partner view: null (proof
   * is a fact about one org; the partner default means "on wherever a tenant is proven").
   */
  entraTenantProven: boolean | null;
}

export const PORTAL_ACCESS_POLICY_ERROR_CODES = {
  METHOD_UNAVAILABLE: 'PORTAL_ACCESS_POLICY_METHOD_UNAVAILABLE',
  SSO_ONLY_NEEDS_SSO: 'PORTAL_ACCESS_POLICY_SSO_ONLY_NEEDS_SSO',
  /** W4: an org override turns Microsoft on before the org's tenant is proven (400). */
  TENANT_NOT_PROVEN: 'PORTAL_ACCESS_POLICY_TENANT_NOT_PROVEN',
  /** W4 D12: an `sso_only` save without the current impact acknowledgement (409). */
  SSO_ONLY_CONFIRM_REQUIRED: 'PORTAL_ACCESS_POLICY_SSO_ONLY_CONFIRM_REQUIRED',
} as const;
export type PortalAccessPolicyErrorCode =
  typeof PORTAL_ACCESS_POLICY_ERROR_CODES[keyof typeof PORTAL_ACCESS_POLICY_ERROR_CODES];

/** POST /organizations/:id/portal-access-requests/decide body (W3 Task 8). Processed sequentially by the route. */
export const decidePortalAccessRequestsSchema = z.object({
  requestIds: z.array(z.string().uuid()).min(1).max(100),
  decision: z.enum(['approve', 'deny']),
}).strict();
export type DecidePortalAccessRequestsInput = z.infer<typeof decidePortalAccessRequestsSchema>;
