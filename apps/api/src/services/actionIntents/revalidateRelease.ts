import type { ActionIntent } from '../../db/schema/actionIntents';
import type { AuthContext } from '../../middleware/auth';
import { getToolTier } from '../aiTools';
import { checkToolPermission } from '../aiGuardrails';
import { getActiveOrgTenant } from '../tenantStatus';
import { buildAuthContextForIntent } from './actorContext';

/**
 * Shared release-time revalidation for an approved action intent (spec
 * docs/superpowers/specs/ai-mcp/2026-07-18-action-intents-approval-layer-design.md
 * §5 step 2). Extracted so the TWO release paths — the durable
 * `jobs/intentReleaseWorker.ts` and the inline chat path in
 * `services/aiAgentSdk.ts` — run the IDENTICAL fail-closed checks. Previously
 * only the worker revalidated; the inline path executed the still-live chat
 * session's tool under the ORIGINAL `session.auth` the moment it won the
 * `approved -> executing` CAS, so a requester demoted, deactivated, or stripped
 * of org access during the approval wait still had their action executed if the
 * live session won the race against the worker.
 *
 * Returns the freshly-rebuilt actor `auth` on success. Callers decide how to
 * EXECUTE: the worker executes under this rebuilt context; the inline chat path
 * executes under its live `session.auth` (which alone carries the session-aware
 * M365/Google connection context) — but only AFTER this returns ok, i.e. only
 * once the requester's CURRENT authorization has been re-proven. The rebuilt
 * `auth` and `session.auth` describe the same user + org (accessibleOrgIds ===
 * [intent.orgId] === session.orgId), so they are interchangeable for tenant
 * scope; the difference is only that this one reflects live DB state.
 *
 * Every failure carries the same `errorCode` the worker has always CASed
 * `executing -> failed` with, so audit/metrics semantics are unchanged.
 */
export type IntentReleaseRevalidation =
  | { ok: true; auth: AuthContext }
  | { ok: false; errorCode: string; details?: Record<string, unknown> };

export async function revalidateApprovedIntentForRelease(
  intent: ActionIntent,
  winningApproval: { boundArgumentDigest: string | null } | null,
): Promise<IntentReleaseRevalidation> {
  // (a) The winning approval row must still exist and must have approved the
  // SAME content the intent currently carries (action_intents content is
  // DB-immutable; this is defense-in-depth).
  if (!winningApproval || winningApproval.boundArgumentDigest !== intent.argumentDigest) {
    return { ok: false, errorCode: 'digest_mismatch' };
  }

  // (b) The tool must still exist and must not have been reclassified to a
  // HIGHER tier since the intent was created (lower/equal only tightens what
  // the approval covered).
  const currentTier = getToolTier(intent.actionName);
  if (currentTier === undefined || currentTier > intent.riskTier) {
    return {
      ok: false,
      errorCode: 'tier_escalated',
      details: { currentTier: currentTier ?? null, intentRiskTier: intent.riskTier },
    };
  }

  // (c) The actor must still be valid: rebuild the AuthContext from scratch,
  // re-checking the user is active and still has access to intent.orgId.
  const auth = await buildAuthContextForIntent(intent);
  if (!auth) {
    return { ok: false, errorCode: 'actor_invalid' };
  }

  // (d) The org (and its owning partner) must still be active.
  const activeOrg = await getActiveOrgTenant(intent.orgId);
  if (!activeOrg) {
    return { ok: false, errorCode: 'org_inactive' };
  }

  // (e) The actor must STILL hold the specific RBAC permission the tool
  // requires, checked against the rebuilt `auth` from (c) — not the caller's
  // original, now possibly stale, permission check.
  const permissionDenial = await checkToolPermission(intent.actionName, intent.arguments, auth);
  if (permissionDenial) {
    return { ok: false, errorCode: 'rbac_denied', details: { reason: permissionDenial } };
  }

  return { ok: true, auth };
}
