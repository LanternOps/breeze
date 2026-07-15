import { getUserPermissions, type UserPermissions } from './permissions';
import { validateApiKeyScopeDelegation } from './apiKeyScopes';

/**
 * SR2-15 live authorization for HUMAN-delegated API keys.
 *
 * A human key's authority is DELEGATED from its creating user and must never
 * outlive that user's authority. On every request we re-resolve the creator's
 * CURRENT permissions and:
 *   1. DENY if the creator has no live membership/role on the key's tenant
 *      (getUserPermissions returns null when neither the org nor the partner
 *      axis yields a role row) — this is both the off-boarding/membership gate
 *      and the fail-closed rule for a contextless/errored read.
 *   2. RE-CLAMP the key's stored scopes against those live permissions; a scope
 *      the creator no longer holds DENIES (a permission reduction after mint
 *      cannot be out-run by a key minted while the creator was more powerful).
 *
 * We resolve LIVE rather than trusting a mint-time snapshot or an epoch: the
 * design requires catching out-of-band membership/role SQL changes that call no
 * app service, and getUserPermissions is already Redis-version-cached and
 * invalidated by every in-app membership/role mutation, so this is cheap and
 * always correct. See the PR 5 plan Q1.
 *
 * Axis (Q5): BOTH orgId and the org's owning partnerId are offered so a
 * Partner-Admin creator (who has NO organization_users row for the key's org,
 * only a partner_users row) still resolves.
 */
export type ApiKeyAuthorizationResult =
  | { ok: true; permissions: UserPermissions; allowedSiteIds: string[] | undefined; clampedScopes: string[] }
  | { ok: false; reason: 'no_membership' | 'scope_exceeds_current_permissions'; detail?: Record<string, unknown> };

export async function authorizeHumanApiKeyCreator(input: {
  createdBy: string;
  orgId: string;
  partnerId: string | null;
  scopes: string[];
}): Promise<ApiKeyAuthorizationResult> {
  let permissions: UserPermissions | null;
  try {
    permissions = await getUserPermissions(input.createdBy, {
      orgId: input.orgId,
      partnerId: input.partnerId ?? undefined,
    });
  } catch {
    // FAIL CLOSED: a DB/RLS error is indistinguishable from "no access" and
    // must never be read as "unrestricted".
    return { ok: false, reason: 'no_membership' };
  }

  if (!permissions) {
    return { ok: false, reason: 'no_membership' };
  }

  // Re-clamp: the stored scopes must still be fully backed by the creator's
  // CURRENT permissions. validateApiKeyScopeDelegation returns ok:false (403)
  // for any scope whose required permission the creator no longer holds.
  const delegation = validateApiKeyScopeDelegation(input.scopes, permissions);
  if (!delegation.ok) {
    return {
      ok: false,
      reason: 'scope_exceeds_current_permissions',
      detail: { error: delegation.error, ...(delegation.details ?? {}) },
    };
  }

  return {
    ok: true,
    permissions,
    allowedSiteIds: permissions.allowedSiteIds,
    clampedScopes: delegation.scopes,
  };
}
