import type { AuthContext } from '../../middleware/auth';
import { hasSatisfiedMfa } from '../../middleware/auth';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { getUserPermissions, hasPermission, PERMISSIONS } from '../permissions';

export type StrictAckOutcome =
  | { ok: true; acknowledged: string[] }
  | { ok: false; error: 'strict_acknowledgement_not_permitted'; requirement: 'scripts:write' | 'mfa' }
  | { ok: false; error: 'strict_acknowledgement_incomplete'; missing: string[] };

/**
 * Spec §4.5. Acknowledging a STRICT danger pattern on an approval card carries the
 * LIBRARY's requirement — `scripts:write` + the JWT `mfa` claim — because
 * acknowledging is the same act as acknowledging on a saved script
 * (scriptSecurityAcknowledgement.ts, routes/scripts.ts POST). The supervised
 * self-decide path re-checks only the tool permission (decideApprovalRequest.ts),
 * which is strictly weaker, so this runs IN ADDITION to it, never instead of it.
 * The #5601 step-up grant is deliberately NOT consulted: it has no
 * acknowledgement operation.
 *
 * Resolution is `(submitted ∩ strictHits)`. There is no "existing" set on a
 * proposal (it is immutable and single-use), so the carry-forward half of the
 * library rule does not apply. An approval that leaves a strict hit
 * unacknowledged is refused rather than silently partial: the agent would refuse
 * the run anyway, and a card that said "Approved" would be lying.
 *
 * MFA is checked before permissions so a refused decision never costs a DB read.
 */
export async function resolveStrictAcknowledgement(args: {
  auth: AuthContext;
  proposal: { strictHits: string[]; orgId: string };
  submitted: string[];
}): Promise<StrictAckOutcome> {
  const strictHits = args.proposal.strictHits ?? [];
  if (strictHits.length === 0) return { ok: true, acknowledged: [] };

  if (!hasSatisfiedMfa(args.auth)) {
    return { ok: false, error: 'strict_acknowledgement_not_permitted', requirement: 'mfa' };
  }
  const perms = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      getUserPermissions(args.auth.user.id, {
        partnerId: args.auth.partnerId ?? undefined,
        // The PROPOSAL's org: a partner approver deciding for org B must hold
        // scripts:write THERE, not in whatever org their token defaults to.
        orgId: args.proposal.orgId,
      }),
    ),
  );
  const canWrite =
    !!perms && hasPermission(perms, PERMISSIONS.SCRIPTS_WRITE.resource, PERMISSIONS.SCRIPTS_WRITE.action);
  if (!canWrite) {
    return { ok: false, error: 'strict_acknowledgement_not_permitted', requirement: 'scripts:write' };
  }

  const submitted = new Set(args.submitted.map((s) => s.trim()).filter(Boolean));
  const acknowledged = strictHits.filter((hit) => submitted.has(hit));
  const missing = strictHits.filter((hit) => !submitted.has(hit));
  if (missing.length > 0) return { ok: false, error: 'strict_acknowledgement_incomplete', missing };
  return { ok: true, acknowledged };
}
