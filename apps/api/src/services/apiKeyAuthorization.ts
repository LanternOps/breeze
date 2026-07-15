import { eq } from 'drizzle-orm';
import { getUserPermissions, type UserPermissions } from './permissions';
import { validateApiKeyScopeDelegation } from './apiKeyScopes';
import { db, withSystemDbAccessContext } from '../db';
import { servicePrincipals } from '../db/schema';

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
  | {
      ok: true;
      // Service-principal keys have no human creator to derive permissions
      // from — `permissions` is null for that path (see
      // authorizeServicePrincipalKey below). Human keys always populate it.
      permissions: UserPermissions | null;
      allowedSiteIds: string[] | undefined;
      clampedScopes: string[];
    }
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

/**
 * SR2-15 live authorization for SERVICE-PRINCIPAL API keys.
 *
 * A service-principal key's authority is delegated from an explicit,
 * opt-in `service_principals` row — NOT from a human's live permissions.
 * On every request we reload the principal and:
 *   1. DENY if the principal row is missing or `status !== 'active'`
 *      (the disable-cascade gate).
 *   2. RE-CLAMP the key's stored scopes against the principal's OWN CURRENT
 *      `scopes` ceiling — a plain subset check, never a human permission
 *      lookup. A principal's scopes can be narrowed independently of any
 *      key minted against it, same shape as the human path's permission
 *      reduction re-clamp.
 *
 * `allowedSiteIds` is always `undefined`: service principals are not
 * site-restricted in this PR (they are org-scoped only).
 *
 * FAIL CLOSED: the DB read is wrapped in try/catch and a null/missing row is
 * treated identically to an errored read — both DENY. A contextless or
 * 0-row read that resolves to "authorize" would be a fail-OPEN and must
 * never exist here.
 *
 * `service_principals` is a FORCE-RLS org-scoped (shape-1) table. This
 * function runs in the pre-request auth path (apiKeyAuth middleware /
 * mcpServer's buildAuthFromApiKey), before the request's own RLS context is
 * established, so the read must go through `withSystemDbAccessContext` —
 * mirroring the PR1 creator-status read in `apiKeyAuth.ts` and
 * `getActiveOrgTenant`.
 */
export async function authorizeServicePrincipalKey(input: {
  principalId: string;
  scopes: string[];
}): Promise<ApiKeyAuthorizationResult> {
  let principal: { status: string; scopes: string[] | null } | null;
  try {
    principal = await withSystemDbAccessContext(async () => {
      const [row] = await db
        .select({ status: servicePrincipals.status, scopes: servicePrincipals.scopes })
        .from(servicePrincipals)
        .where(eq(servicePrincipals.id, input.principalId))
        .limit(1);
      return row ?? null;
    });
  } catch {
    // FAIL CLOSED: a DB/RLS error is indistinguishable from "principal gone"
    // and must never be read as "unrestricted".
    return { ok: false, reason: 'no_membership' };
  }

  if (!principal || principal.status !== 'active') {
    return { ok: false, reason: 'no_membership' };
  }

  const principalScopes = new Set(principal.scopes ?? []);
  const exceededScopes = input.scopes.filter((scope) => !principalScopes.has(scope));
  if (exceededScopes.length > 0) {
    return {
      ok: false,
      reason: 'scope_exceeds_current_permissions',
      detail: { exceededScopes, principalScopes: Array.from(principalScopes) },
    };
  }

  return {
    ok: true,
    permissions: null,
    allowedSiteIds: undefined,
    clampedScopes: input.scopes,
  };
}
