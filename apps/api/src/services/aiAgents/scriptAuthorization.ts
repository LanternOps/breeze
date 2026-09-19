/**
 * #5065 — write-time validation of `actAssets.scriptIds`, the closed set of
 * scripts an act-mode agent may run UNATTENDED through `run_script`.
 *
 * The rule (advisor quorum, 2026-09-06 — option B): the partner-wide
 * baseline's list is the authorization CEILING; an organization row may
 * select any subset of it ("organizations can only tighten"), never a
 * script the baseline does not list. This mirrors `effectivePolicy.ts`,
 * which already runs the org agent under `intersect(partner, org)`, and
 * `remediationActResolver.ts`, which refuses a script outside the effective
 * list at dispatch. Unlike `supervisedActionKeys` (#5049) there is no
 * four-eyes grant executor here: a partner edit authorizes a script
 * immediately, so grant-only org writes would add ceremony without adding
 * a second pair of eyes.
 *
 * Checks, applied to the ids a write ADDS (removals are always allowed, and
 * an id that later stops resolving is stored-but-inert — the run loop
 * re-validates live and fails closed):
 * - `run_script_not_allowed`: the row's own tool allowlist does not admit
 *   `run_script` (never auto-added — that would silently widen a separate
 *   control), or, for an org row, the partner ceiling's allowlist does not.
 * - `not_found`: no live, non-deleted script the OWNER can see — for an org
 *   row: the org's own script, a same-partner partner-wide script, or a
 *   system script; for a partner row: a partner-wide script of that partner
 *   or a system script (a partner baseline never binds to one org's private
 *   script). Same visibility the `run_script` tool applies at call time.
 * - `not_in_partner_baseline`: org row, a live baseline exists for the kind,
 *   and it does not list the script.
 *
 * Bound to the ROW's owner, never the ambient organization switcher.
 */
import { and, inArray, isNull } from 'drizzle-orm';
import type { AiAgentKind } from '@breeze/shared';
import { db } from '../../db';
import { scripts } from '../../db/schema';
import { loadPartnerBaselineCeiling, resolveOrgPartnerId } from './effectivePolicy';
import { isToolAllowlisted } from './toolAllowlist';

/** Structural twin of `agentService.ts`'s `AgentOwner` (not imported: that module imports this one). */
export interface ScriptAuthorizationOwner {
  orgId: string | null;
  partnerId: string | null;
}

export type ScriptIdRejectReason = 'not_found' | 'not_in_partner_baseline' | 'run_script_not_allowed';

export interface RejectedScriptId {
  id: string;
  reason: ScriptIdRejectReason;
}

export class InvalidScriptIdsError extends Error {
  readonly code = 'invalid_script_ids';

  constructor(public rejected: RejectedScriptId[]) {
    super(`invalid_script_ids: ${rejected.map((entry) => `${entry.id} (${entry.reason})`).join(', ')}`);
    this.name = 'InvalidScriptIdsError';
  }
}

export interface ScriptAuthorizationWrite {
  /** The row's currently stored `actAssets.scriptIds` (`[]` on create). */
  existing: readonly string[];
  /** The value this write sets; `undefined` when the write does not touch it. */
  next: readonly string[] | undefined;
  /** The `toolAllowlist` the row will have AFTER this write. */
  toolAllowlist: readonly string[];
}

const RUN_SCRIPT = 'run_script';

export async function assertScriptIdsAuthorizable(
  owner: ScriptAuthorizationOwner,
  kind: AiAgentKind,
  write: ScriptAuthorizationWrite,
): Promise<void> {
  if (write.next === undefined) return;
  const added = [...new Set(write.next)].filter((id) => !write.existing.includes(id));
  if (added.length === 0) return;

  if (!isToolAllowlisted(write.toolAllowlist, RUN_SCRIPT, null)) {
    throw new InvalidScriptIdsError(added.map((id) => ({ id, reason: 'run_script_not_allowed' as const })));
  }

  // An org row's partner comes from the organization, not the owner tuple
  // (org-owned rows carry `partnerId: null`). `organizations.partner_id` is
  // NOT NULL, so a null resolution means the org row itself is not visible
  // here — the caller already passed canAccessOrg, so that is an invariant
  // violation. Fail CLOSED: falling through to "no ceiling" would silently
  // drop both partner-baseline checks and admit the id on visibility alone
  // (#5089 review).
  let partnerId = owner.partnerId;
  if (owner.orgId !== null) {
    partnerId = await resolveOrgPartnerId(owner.orgId);
    if (partnerId === null) {
      throw new Error(`scriptAuthorization: organization ${owner.orgId} is not visible to this context`);
    }
  }

  const rows = await db
    .select({ id: scripts.id, orgId: scripts.orgId, partnerId: scripts.partnerId, isSystem: scripts.isSystem })
    .from(scripts)
    .where(and(inArray(scripts.id, added), isNull(scripts.deletedAt)));
  // `partnerId` already equals `owner.partnerId` whenever `owner.orgId` is
  // null (only the org branch above reassigns it), so the partner-wide-script
  // check below is the same comparison for both an org row and a partner row.
  const visible = new Set(
    rows
      .filter((row) => {
        if (row.isSystem) return true;
        if (owner.orgId !== null && row.orgId === owner.orgId) return true;
        return row.orgId === null && row.partnerId !== null && row.partnerId === partnerId;
      })
      .map((row) => row.id),
  );

  const ceiling = owner.orgId !== null ? await loadPartnerBaselineCeiling(partnerId, kind) : null;
  const ceilingAdmitsRunScript = ceiling === null || isToolAllowlisted(ceiling.toolAllowlist, RUN_SCRIPT, null);

  const rejected: RejectedScriptId[] = [];
  for (const id of added) {
    if (!visible.has(id)) rejected.push({ id, reason: 'not_found' });
    else if (!ceilingAdmitsRunScript) rejected.push({ id, reason: 'run_script_not_allowed' });
    else if (ceiling !== null && !ceiling.scriptIds.includes(id)) rejected.push({ id, reason: 'not_in_partner_baseline' });
  }
  if (rejected.length > 0) throw new InvalidScriptIdsError(rejected);
}
