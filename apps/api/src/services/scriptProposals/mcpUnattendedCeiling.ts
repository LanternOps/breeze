import { and, eq, isNull } from 'drizzle-orm';
import { riskWithinMcpUnattendedCeiling, type McpUnattendedProposalCeiling } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiScriptPolicies } from '../../db/schema/aiScriptPolicies';
import { organizations } from '../../db/schema/orgs';
import { scriptProposals } from '../../db/schema/scriptProposals';
import { latestCompletedReview } from './proposals';

/**
 * The MCP unattended proposal ceiling that governs a proposal in `orgId`: the
 * `mcp_unattended_proposal_max_risk` of the partner ceiling row of the partner
 * that owns the org. 'none' when the org has no partner or the partner never
 * saved a ceiling, so an unset ceiling keeps every MCP proposal run gated.
 *
 * Read in a detached system context, like the proposal guardrail row: the MCP
 * route calls it before any request transaction exists, and the caller has
 * already proven it can reach `orgId` (`loadProposalGuardrailContextInReach`).
 */
export async function loadMcpUnattendedProposalCeiling(orgId: string): Promise<McpUnattendedProposalCeiling> {
  const [row] = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.select({ ceiling: aiScriptPolicies.mcpUnattendedProposalMaxRisk })
      .from(organizations)
      .innerJoin(aiScriptPolicies, and(
        eq(aiScriptPolicies.partnerId, organizations.partnerId),
        isNull(aiScriptPolicies.orgId),
      ))
      .where(eq(organizations.id, orgId))
      .limit(1)));
  return row?.ceiling ?? 'none';
}

/**
 * The same ceiling, read on the CALLER's transaction with a FOR SHARE lock on
 * the partner ceiling row. `run_script` calls it inside the system transaction
 * that creates the device command, so a concurrent ceiling save (an UPDATE of
 * that row) waits until the command is committed, and a save that commits first
 * is seen here. Either the lowered ceiling refuses the command, or the command
 * existed before the ceiling was lowered; never a command created after.
 */
export async function lockMcpUnattendedProposalCeiling(orgId: string): Promise<McpUnattendedProposalCeiling> {
  const [row] = await db.select({ ceiling: aiScriptPolicies.mcpUnattendedProposalMaxRisk })
    .from(organizations)
    .innerJoin(aiScriptPolicies, and(
      eq(aiScriptPolicies.partnerId, organizations.partnerId),
      isNull(aiScriptPolicies.orgId),
    ))
    .where(eq(organizations.id, orgId))
    .limit(1)
    .for('share', { of: aiScriptPolicies });
  return row?.ceiling ?? 'none';
}

export type McpUnattendedRefusal =
  | 'not_reviewed' | 'strict_hits' | 'review_missing' | 'verdict_not_approve' | 'risk_above_ceiling';

/**
 * Whether a principal on MCP_UNATTENDED_TIER3_PRINCIPALS may run this proposal
 * with no human approval. The ceiling bounds the reviewed RISK; it never
 * overrides the reviewer. So, besides a risk at or below the ceiling, the
 * proposal must be `reviewed` with no STRICT scanner hits (those need a human
 * acknowledgement), and its latest completed model review must match the
 * goal, judge its verification adequate and recommend `approve`. Anything
 * else keeps the approval gate.
 *
 * Unlike the reviewer lane (scriptReviewerAutonomy.ts), `reversible` is NOT
 * required. That lane is capped at medium risk; this ceiling lets an operator
 * accept up to critical, and the reviewer's irreversibility judgement is
 * already folded into the reviewed risk tier the ceiling bounds. Requiring
 * reversibility here would make any ceiling above medium unreachable.
 */
export async function mcpUnattendedProposalRefusal(
  proposalId: string,
  orgId: string,
): Promise<McpUnattendedRefusal | null> {
  const loaded = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [proposal] = await db
      .select({
        status: scriptProposals.status,
        riskTier: scriptProposals.riskTier,
        strictHits: scriptProposals.strictHits,
      })
      .from(scriptProposals)
      .where(and(eq(scriptProposals.id, proposalId), eq(scriptProposals.orgId, orgId)))
      .limit(1);
    const review = proposal ? await latestCompletedReview(db, proposalId) : null;
    return { proposal, review };
  }));
  const { proposal, review } = loaded;
  if (!proposal || proposal.status !== 'reviewed' || !proposal.riskTier) return 'not_reviewed';
  if ((proposal.strictHits ?? []).length > 0) return 'strict_hits';
  if (!review) return 'review_missing';
  if (review.goalMatch !== 'yes' || review.verificationAdequate !== true || review.recommendedAction !== 'approve') {
    return 'verdict_not_approve';
  }
  if (!riskWithinMcpUnattendedCeiling(proposal.riskTier, await loadMcpUnattendedProposalCeiling(orgId))) {
    return 'risk_above_ceiling';
  }
  return null;
}
