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
}

/** One row of `POST …/portal-access-requests/decide`: 'approved' | 'denied' | an error code. */
export interface PortalAccessRequestDecideResult { requestId: string; result: string }

export interface PortalAccessRequestSummary {
  pendingTotal: number;
  orgs: Array<{ orgId: string; orgName: string; pending: number }>;
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
  const entra = (ownValue(view, draft, 'entraEnabled') ?? view.inherited.entraEnabled.value) && view.capabilities.entra;
  const google = (ownValue(view, draft, 'googleEnabled') ?? view.inherited.googleEnabled.value) && view.capabilities.google;
  return entra || google;
}
