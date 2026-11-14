/**
 * Web-side portal access shapes (portal registration W3, #11380).
 *
 * The policy types and constants (`PortalAccessPolicyView`,
 * `PORTAL_ACCESS_POLICY_FIELDS`, …) come from `@breeze/shared`
 * (`packages/shared/src/validators/portalAccessPolicy.ts`). This file holds what
 * only the web needs: the unsaved-draft helpers, a shape check on the policy
 * view, and the access-request response shapes, which the API defines in
 * `apps/api/src/services/portalAccessRequests.ts` and does not share.
 */
import type {
  PortalAccessPolicyField,
  PortalAccessPolicyRowValues,
  PortalAccessPolicyValues,
  PortalAccessPolicyView,
} from '@breeze/shared';

/** Unsaved edits: only fields whose value differs from `view.values`. */
export type PortalAccessPolicyDraft = Partial<PortalAccessPolicyRowValues>;

/** Matches `PortalAccessRequestSource` / `PortalAccessRequestStatus` in the API schema. */
export type PortalAccessRequestSource = 'self' | 'entra' | 'google' | 'addin_user';
export type PortalAccessRequestStatus = 'pending' | 'approved' | 'denied' | 'expired';

/** One row of an org's access-request list (`listPortalAccessRequests` in the API). */
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
  /**
   * W6 D11 (#11383): for a `self` request, whether the address's domain is
   * still verified for this org (approve refuses with
   * PORTAL_ACCESS_REQUEST_DOMAIN_NOT_VERIFIED when it is not). W7 (#11384):
   * for a `google` request, whether its Workspace domain (`googleHostedDomain`)
   * is (approve refuses with PORTAL_ACCESS_REQUEST_GOOGLE_DOMAIN_NOT_VERIFIED).
   * Null for every other source.
   */
  domainVerified: boolean | null;
  /** W7 D8: the Google Workspace domain (`hd`) a `google` request asserted; null for every other source. */
  googleHostedDomain: string | null;
}

/** One row of `POST …/portal-access-requests/decide`: 'approved' | 'denied' | an error code. */
export interface PortalAccessRequestDecideResult { requestId: string; result: string }

export interface PortalAccessRequestSummary {
  pendingTotal: number;
  orgs: Array<{ orgId: string; orgName: string; pending: number }>;
}

/**
 * `GET …/portal-entra-tenant` (portal registration W4 #11381, D6/OD3): the
 * org's Microsoft tenant proof. Matches `PortalEntraTenantStatus` in
 * `apps/api/src/services/portalEntraTenantProof.ts` plus the route's
 * `consentUrl` (set only for a proven tenant).
 */
export type PortalEntraProofVia = 'm365_connection' | 'proof_run';
export interface PortalEntraTenantView {
  tenantId: string | null;
  state: 'none' | 'unproven' | 'proven';
  provenAt: string | null;
  provenVia: PortalEntraProofVia | null;
  connectionTenantId: string | null;
  consentUrl: string | null;
  /**
   * #11582: the org lost a proven tenant while Microsoft sign-in was on, so its
   * portal fell back to password. Null once the tenant is proven again or an
   * admin dismissed it. Absent from servers older than #11582.
   */
  passwordFallback?: PortalPasswordFallbackNotice | null;
}

export type PortalPasswordFallbackCause =
  | 'tenant_removed'
  | 'ai_for_office_mapping_removed'
  | 'ai_for_office_mapping_changed'
  | 'tenant_displaced';

/** `GET …/portal-entra-tenant` → `passwordFallback` (API `services/portalPasswordFallback.ts`). */
export interface PortalPasswordFallbackNotice {
  /** When the fallback took effect (ISO). */
  since: string;
  tenantId: string | null;
  /** Null when the server could not name the cause. */
  cause: PortalPasswordFallbackCause | null;
}

export function isPortalPasswordFallbackNotice(value: unknown): value is PortalPasswordFallbackNotice {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.since === 'string'
    && (v.tenantId === null || typeof v.tenantId === 'string')
    && (v.cause === null || typeof v.cause === 'string');
}

export function isPortalEntraTenantView(value: unknown): value is PortalEntraTenantView {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (v.state === 'none' || v.state === 'unproven' || v.state === 'proven')
    && (v.tenantId === null || typeof v.tenantId === 'string')
    && (v.connectionTenantId === null || typeof v.connectionTenantId === 'string');
}

/** The view's notice, or null; a malformed one is ignored (the notice is advisory) rather than failing the view. */
export function passwordFallbackOf(view: PortalEntraTenantView): PortalPasswordFallbackNotice | null {
  if (view.state === 'proven' || view.passwordFallback == null) return null;
  if (isPortalPasswordFallbackNotice(view.passwordFallback)) return view.passwordFallback;
  console.warn('[portalAccess] ignoring a malformed passwordFallback notice');
  return null;
}

/** `POST …/portal-entra-tenant/proof-links`. */
export interface PortalEntraProofLink { url: string; expiresAt: string; expectedTenantId: string }

/** One org a save would flip to effective `sso_only` (`SsoOnlyOrgImpact` in the API, D12). */
export interface SsoOnlyOrgImpact { orgId: string; orgName: string; passwordsToClear: number; strandedTotal: number }
/** The 409 `SSO_ONLY_CONFIRM_REQUIRED` body's `impact`: the PATCH must carry `?acknowledge=<impactDigest>`. */
export interface SsoOnlyImpact { flips: SsoOnlyOrgImpact[]; impactDigest: string }
/** `GET …/portal-access-policy/stranded`: accounts with no identity that `sso_only` leaves unable to sign in. */
export interface StrandedPortalAccount { portalUserId: string; email: string; name: string | null; status: 'active' | 'invited' }
export interface StrandedPortalAccounts { items: StrandedPortalAccount[]; total: number }

export function isSsoOnlyImpact(value: unknown): value is SsoOnlyImpact {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.impactDigest === 'string' && v.impactDigest.length > 0 && Array.isArray(v.flips)
    && v.flips.every((f) => !!f && typeof f === 'object'
      && typeof (f as SsoOnlyOrgImpact).orgId === 'string'
      && typeof (f as SsoOnlyOrgImpact).passwordsToClear === 'number'
      && typeof (f as SsoOnlyOrgImpact).strandedTotal === 'number');
}

export function isStrandedPortalAccounts(value: unknown): value is StrandedPortalAccounts {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.total === 'number' && Array.isArray(v.items)
    && v.items.every((i) => !!i && typeof i === 'object' && typeof (i as StrandedPortalAccount).portalUserId === 'string');
}

/**
 * A shape check on a policy view from the API, so a malformed 200 body lands in
 * the caller's load-error state instead of crashing the panel that renders it.
 */
export function isPortalAccessPolicyView(value: unknown): value is PortalAccessPolicyView {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const isObject = (x: unknown) => !!x && typeof x === 'object';
  return isObject(v.owner) && isObject(v.values) && isObject(v.inherited) && isObject(v.effective)
    && isObject(v.capabilities) && typeof v.canEdit === 'boolean' && typeof v.passwordModeFallback === 'boolean';
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
  const { microsoft, google } = effectiveSsoProviders(view, draft);
  return microsoft || google;
}

/** Which SSO providers are on, or which the deployment can run. */
export interface SsoProviders { microsoft: boolean; google: boolean }

/**
 * Which provider names a piece of SSO copy uses (W7 #11384). Copy never names
 * Google unless Google is in the set, so a deployment without the Google
 * capability (`capabilities.google`) never shows the word.
 */
export type SsoProviderSet = 'microsoft' | 'google' | 'both';

/** Only Google → 'google', both → 'both', otherwise (including neither) the Microsoft wording. */
export function ssoProviderSet({ microsoft, google }: SsoProviders): SsoProviderSet {
  if (google) return microsoft ? 'both' : 'google';
  return 'microsoft';
}

/** The wording for what the deployment can run (form labels, hints, the fallback notice). */
export function capabilityProviderSet(capabilities: PortalAccessPolicyView['capabilities']): SsoProviderSet {
  return ssoProviderSet({ microsoft: capabilities.entra, google: capabilities.google });
}

/**
 * Which SSO methods the policy, with the draft applied, has on: the own value
 * or the inherited one, masked by what the deployment can run and by the org's
 * evidence. Mirrors the server's write check for `passwordMode: 'sso_only'`.
 */
export function effectiveSsoProviders(view: PortalAccessPolicyView, draft: PortalAccessPolicyDraft): SsoProviders {
  // W4 D2: Microsoft counts only where the org's tenant is proven. A partner
  // view carries `null` (the default applies wherever a tenant is proven).
  const microsoft = (ownValue(view, draft, 'entraEnabled') ?? view.inherited.entraEnabled.value) && view.capabilities.entra
    && view.entraTenantProven !== false;
  // W7 D6: Google counts only where the org has a verified domain. A partner
  // view carries `null` (the default applies wherever a domain is verified).
  const google = (ownValue(view, draft, 'googleEnabled') ?? view.inherited.googleEnabled.value) && view.capabilities.google
    && view.verifiedDomainCount !== 0;
  return { microsoft: !!microsoft, google: !!google };
}

/**
 * The wording for the `sso_only` dialog, the stranded list and its invites:
 * the providers that are on, or, with none on, what the deployment can run.
 */
export function effectiveProviderSet(view: PortalAccessPolicyView, draft: PortalAccessPolicyDraft): SsoProviderSet {
  const providers = effectiveSsoProviders(view, draft);
  return providers.microsoft || providers.google ? ssoProviderSet(providers) : capabilityProviderSet(view.capabilities);
}
