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
import type { FlowRunRow } from '../../db/schema/flowRuns';
import { canAccessOrg, getUserPermissions, type UserPermissions } from '../permissions';

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
