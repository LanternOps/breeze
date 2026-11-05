/**
 * Tool catalog W04 (#5219), plan Task A9 — the person who starts a manual run.
 *
 * Running a flow uses its delegation, so the triggerer must be able to do what
 * the flow does (rule 7, checked once in `startManualRun`, against the
 * permissions the CREDENTIAL may use — `clampToCallerCredential`).
 *
 * Site-limited triggerers are refused at start (`delegation_scope_restricted`
 * in runService.startManualRun): the flow principal is org-wide and W04 has
 * no site model, and a per-step "is this step's reach inside the sites?"
 * check proved unsound (non-device resource ids, nested scope keys, tools
 * whose reach is not only their device args). Nothing about the triggerer is
 * re-read at step time; schedule and event runs have no triggerer (the
 * delegator's unrestricted scope, Decision 13, governs every run).
 */
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { apiKeys } from '../../db/schema/apiKeys';
import type { AuthContext } from '../../middleware/auth';
import { requiredPermissionsForApiKeyScopes, validateApiKeyScopeDelegation } from '../apiKeyScopes';
import { canAccessOrg, getUserPermissions, hasPermission, type UserPermissions } from '../permissions';

/**
 * The triggerer's own permissions where the run executes: org membership in
 * the run org first, then the partner membership (getUserPermissions'
 * precedence). For an org flow the run org IS the owner org; for a
 * partner-wide flow it is the org the run was started in.
 */
export function triggererPermissions(userId: string, partnerId: string, runOrgId: string): Promise<UserPermissions | null> {
  return getUserPermissions(userId, { partnerId, orgId: runOrgId });
}

/**
 * Whether the triggerer may have pre-approvals honoured (with `ui`): no site
 * ceiling (startManualRun has already refused one) and, for a partner-wide
 * flow, all-orgs partner access.
 */
export function triggererPermsCleared(perms: UserPermissions, partnerWide: boolean): boolean {
  if (perms.allowedSiteIds !== undefined) return false;
  if (!partnerWide) return true;
  return perms.scope === 'partner' && perms.orgAccess === 'all';
}

/**
 * The triggerer's permissions as THIS credential may use them (security
 * review, Task A9). A user session acts with the user's own permissions. A
 * human API key acts as its creator but only within its scopes: the platform
 * clamp is `API_KEY_SCOPE_POLICIES` (services/apiKeyScopes.ts) — every
 * scope maps to the permissions it confers, re-validated against the
 * creator's LIVE permissions (`validateApiKeyScopeDelegation`, the same
 * check authorizeHumanApiKeyCreator runs per request). The AuthContext does
 * not carry the key's scopes, so they are re-read from `api_keys` by the
 * principal's key id. The result's permission list is the INTERSECTION:
 * scope-conferred permissions the creator still holds.
 *
 * Returns null — fail closed, the caller treats it as "no permissions" —
 * whenever the clamp cannot be computed: an OAuth grant (its scopes live on
 * the bearer, not in the AuthContext), a partner service principal, a
 * service-principal key (no human creator), a key row that is gone, revoked,
 * of another creator or another org, or scopes the creator no longer backs.
 * A failed api_keys READ is not one of those: it throws.
 *
 * Step time never widens past this: rule 7 is a START-time check (the
 * delegator's authority governs execution, Decision 7) and nothing about the
 * triggerer is re-read per step. A key carries its creator's site ceiling
 * (authorizeHumanApiKeyCreator returns `permissions.allowedSiteIds`), so a
 * site-limited creator's key is refused at start like the creator. API-key
 * runs never honour pre-approvals (Decision 4, `flow_runs_pre_approvals_chk`).
 */
export async function clampToCallerCredential(
  auth: Pick<AuthContext, 'principal' | 'user'>,
  perms: UserPermissions,
  runOrgId: string,
): Promise<UserPermissions | null> {
  const principal = auth.principal;
  if (principal.kind === 'user_session') return perms;
  if (principal.kind !== 'api_key' || !principal.apiKeyId || principal.partnerServicePrincipalId) return null;
  const keyId = principal.apiKeyId;
  // A read failure PROPAGATES (the route answers 500): only a missing,
  // revoked or mismatched row means "this credential holds nothing". Mapping
  // a DB error to null would tell the caller `permission_missing` — a wrong,
  // unlogged answer to an infrastructure fault.
  const [row] = await runOutsideDbContext(() => withSystemDbAccessContext(
    async () => db
      .select({
        scopes: apiKeys.scopes,
        principalType: apiKeys.principalType,
        createdBy: apiKeys.createdBy,
        orgId: apiKeys.orgId,
        status: apiKeys.status,
      })
      .from(apiKeys)
      .where(eq(apiKeys.id, keyId))
      .limit(1),
    'flows.triggererAccess.apiKeyScopes',
  ));
  if (!row || row.status !== 'active' || row.principalType !== 'human' || row.createdBy !== auth.user?.id || row.orgId !== runOrgId) {
    return null;
  }
  const delegation = validateApiKeyScopeDelegation(row.scopes ?? [], perms);
  if (!delegation.ok) return null;
  const permissions = requiredPermissionsForApiKeyScopes(delegation.scopes)
    .filter((p) => hasPermission(perms, p.resource, p.action));
  return { ...perms, permissions };
}
