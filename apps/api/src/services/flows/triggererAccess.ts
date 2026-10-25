/**
 * Tool catalog W04 (#5219), plan Task A9 — the person who starts a manual run.
 *
 * Running a flow uses its delegation, so the triggerer must be able to do what
 * the flow does (rule 7, checked once in `startManualRun`). A site-limited
 * triggerer may still run it — pre-approvals are then not honoured, so every
 * Tier-3 step parks for a human — but the devices and device groups the run
 * renders must stay inside that person's sites.
 *
 * Where that site check lives (plan A9 left it open): at STEP time, in
 * `revalidateRenderedStep`, against the triggerer's LIVE membership in the run
 * org, re-resolved here from `flow_runs.triggered_by_user_id`. A start-time
 * check cannot see device ids rendered from step outputs or trigger data, and
 * persisting the ceiling on the run would need a new column; re-resolving is
 * never looser than the start-time answer except when an admin widened the
 * person since, which then reflects what they may do now. It fails CLOSED:
 * a tombstoned triggerer (user deleted ⇒ NULL) or one who lost the org gets an
 * EMPTY ceiling, so no device or group reference passes.
 *
 * Schedule and event runs have no triggerer and no ceiling (the delegator's
 * unrestricted scope, Decision 13, governs them).
 */
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { apiKeys } from '../../db/schema/apiKeys';
import type { FlowRunRow } from '../../db/schema/flowRuns';
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

/** True when the triggerer carries no site ceiling (and, for a partner-wide flow, all-orgs partner access). */
export function triggererPermsCleared(perms: UserPermissions, partnerWide: boolean): boolean {
  if (perms.allowedSiteIds !== undefined) return false;
  if (!partnerWide) return true;
  return perms.scope === 'partner' && perms.orgAccess === 'all';
}

const EMPTY: ReadonlySet<string> = new Set();

/**
 * The site ids a run's device references must fall inside, or null for no
 * ceiling. Manual runs only; see the module header for the fail-closed rules.
 */
export async function triggererSiteCeiling(
  run: Pick<FlowRunRow, 'triggerKind' | 'triggeredByUserId' | 'orgId'>,
  partnerId: string,
): Promise<ReadonlySet<string> | null> {
  if (run.triggerKind !== 'manual') return null;
  if (!run.triggeredByUserId) return EMPTY;
  const perms = await triggererPermissions(run.triggeredByUserId, partnerId, run.orgId);
  if (!perms || !canAccessOrg(perms, run.orgId)) return EMPTY;
  return perms.allowedSiteIds === undefined ? null : new Set(perms.allowedSiteIds);
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
 *
 * Step time never widens past this: rule 7 is a START-time check (the
 * delegator's authority governs execution, Decision 7), and the only thing
 * re-derived per step is the site ceiling (`triggererSiteCeiling`), which
 * for a human key IS its creator's (authorizeHumanApiKeyCreator returns
 * `permissions.allowedSiteIds`). API-key runs never honour pre-approvals
 * (Decision 4, `flow_runs_pre_approvals_chk`).
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
  let row: { scopes: string[] | null; principalType: string; createdBy: string; orgId: string; status: string } | undefined;
  try {
    [row] = await runOutsideDbContext(() => withSystemDbAccessContext(
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
  } catch {
    return null;
  }
  if (!row || row.status !== 'active' || row.principalType !== 'human' || row.createdBy !== auth.user?.id || row.orgId !== runOrgId) {
    return null;
  }
  const delegation = validateApiKeyScopeDelegation(row.scopes ?? [], perms);
  if (!delegation.ok) return null;
  const permissions = requiredPermissionsForApiKeyScopes(delegation.scopes)
    .filter((p) => hasPermission(perms, p.resource, p.action));
  return { ...perms, permissions };
}
