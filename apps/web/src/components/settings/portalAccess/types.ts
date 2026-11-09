/**
 * Portal access policy and access-request shapes (portal registration W3,
 * #11380), as the web reads them from the W03a routes.
 *
 * These mirror the interface section of the W3 plan
 * (`docs/superpowers/plans/portal/2026-11-08-portal-registration-options-w03-access-policy.md`,
 * Tasks 3 and 7), which W03a implements in
 * `packages/shared/src/validators/portalAccessPolicy.ts` and
 * `apps/api/src/services/portalAccessRequests.ts`. Keep them identical; switch
 * to the `@breeze/shared` exports once W03a is on main.
 */

export const PORTAL_ACCESS_POLICY_FIELDS = [
  'entraEnabled',
  'googleEnabled',
  'passwordMode',
  'selfRegistrationMode',
  'ssoNewPersonMode',
  'ssoSessionMaxHours',
] as const;
export type PortalAccessPolicyField = (typeof PORTAL_ACCESS_POLICY_FIELDS)[number];

export type PortalPasswordMode = 'allowed' | 'sso_only';
export type PortalSelfRegistrationMode = 'off' | 'approval' | 'instant';
export type PortalSsoNewPersonMode = 'invited_only' | 'approval' | 'instant';

export interface PortalAccessPolicyValues {
  entraEnabled: boolean;
  googleEnabled: boolean;
  passwordMode: PortalPasswordMode;
  selfRegistrationMode: PortalSelfRegistrationMode;
  ssoNewPersonMode: PortalSsoNewPersonMode;
  ssoSessionMaxHours: number;
}

/** One owner's own row; null = inherit (org) / Breeze default (partner). */
export type PortalAccessPolicyRowValues = { [K in PortalAccessPolicyField]: PortalAccessPolicyValues[K] | null };

export interface PortalSignInCapabilities { entra: boolean; google: boolean; selfRegistration: boolean }
export type PortalPolicySource = 'org' | 'partner' | 'default';

export interface PortalAccessPolicyView {
  owner: { kind: 'org' | 'partner'; id: string };
  values: PortalAccessPolicyRowValues;
  /** What a blank field resolves to. */
  inherited: { [K in PortalAccessPolicyField]: { value: PortalAccessPolicyValues[K]; source: Exclude<PortalPolicySource, 'org'> } };
  effective: { [K in PortalAccessPolicyField]: { value: PortalAccessPolicyValues[K]; source: PortalPolicySource } };
  passwordModeFallback: boolean;
  capabilities: PortalSignInCapabilities;
  /** Partner view: full partner access. Org view: true. */
  canEdit: boolean;
}

export const PORTAL_ACCESS_POLICY_ERROR_CODES = {
  METHOD_UNAVAILABLE: 'PORTAL_ACCESS_POLICY_METHOD_UNAVAILABLE',
  SSO_ONLY_NEEDS_SSO: 'PORTAL_ACCESS_POLICY_SSO_ONLY_NEEDS_SSO',
} as const;
export type PortalAccessPolicyErrorCode =
  (typeof PORTAL_ACCESS_POLICY_ERROR_CODES)[keyof typeof PORTAL_ACCESS_POLICY_ERROR_CODES];

/** Unsaved edits: only fields whose value differs from `view.values`. */
export type PortalAccessPolicyDraft = Partial<PortalAccessPolicyRowValues>;

export type PortalAccessRequestSource = 'self' | 'entra' | 'google' | 'addin_user';
export type PortalAccessRequestStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface PortalAccessRequestListItem {
  id: string;
  email: string;
  name: string | null;
  source: PortalAccessRequestSource;
  status: PortalAccessRequestStatus;
  requestedAt: string;
  lastRequestedAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: { id: string; name: string | null } | null;
  portalUserId: string | null;
  accountExists: boolean;
}

export type PortalAccessRequestErrorCode =
  | 'PORTAL_ACCESS_REQUEST_NOT_FOUND'
  | 'PORTAL_ACCESS_REQUEST_NOT_PENDING'
  | 'PORTAL_ACCESS_REQUEST_ACCOUNT_EXISTS'
  | 'PORTAL_ACCESS_REQUEST_IDENTITY_LINKED';

/** One row of `POST …/portal-access-requests/decide`: 'approved' | 'denied' | an error code. */
export interface PortalAccessRequestDecideResult { requestId: string; result: string }

export interface PortalAccessRequestSummary {
  pendingTotal: number;
  orgs: Array<{ orgId: string; orgName: string; pending: number }>;
}

/** The value a field shows: the draft edit, else the owner's own row value. */
export function ownValue<K extends PortalAccessPolicyField>(
  view: PortalAccessPolicyView,
  draft: PortalAccessPolicyDraft,
  field: K,
): PortalAccessPolicyValues[K] | null {
  return field in draft ? (draft[field] as PortalAccessPolicyValues[K] | null) : view.values[field];
}

/**
 * Sets one field in the draft. An edit back to the saved value drops the key,
 * so the draft only ever holds real changes (and an empty draft is clean).
 */
export function withDraftField<K extends PortalAccessPolicyField>(
  view: PortalAccessPolicyView,
  draft: PortalAccessPolicyDraft,
  field: K,
  value: PortalAccessPolicyValues[K] | null,
): PortalAccessPolicyDraft {
  const next: PortalAccessPolicyDraft = { ...draft };
  if (value === view.values[field]) delete next[field];
  else (next as Record<PortalAccessPolicyField, unknown>)[field] = value;
  return next;
}

/**
 * Whether the policy, with the draft applied, has an SSO method on: the own
 * value or the inherited one, masked by what the deployment can run. Mirrors
 * the server's write check for `passwordMode: 'sso_only'`.
 */
export function draftHasSsoMethod(view: PortalAccessPolicyView, draft: PortalAccessPolicyDraft): boolean {
  const entra = (ownValue(view, draft, 'entraEnabled') ?? view.inherited.entraEnabled.value) && view.capabilities.entra;
  const google = (ownValue(view, draft, 'googleEnabled') ?? view.inherited.googleEnabled.value) && view.capabilities.google;
  return entra || google;
}
