import { and, eq, isNull } from 'drizzle-orm';
import { riskWithinMcpUnattendedCeiling, type McpUnattendedProposalCeiling, type RiskTier, type TouchClass } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiScriptPolicies } from '../../db/schema/aiScriptPolicies';
import { organizations } from '../../db/schema/orgs';
import { scriptProposals } from '../../db/schema/scriptProposals';
import type { ScriptReviewerRefusal } from '../actionIntents/scriptReviewerAutonomy';
import {
  countRecentLaneIntents,
  countRecentMcpUnattendedRuns,
  lockScriptLane,
  readLaneState,
  type LaneExecutor,
} from '../actionIntents/laneQueries';
import { resolveEffectiveScriptPolicy } from './policy';
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
  return runOutsideDbContext(() => withSystemDbAccessContext(() => readCeiling(orgId)));
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

/**
 * Why an unattended MCP proposal run was refused. The reviewer lane's
 * refusals (scriptReviewerAutonomy.ts) plus the MCP ceiling's own:
 * `not_reviewed` for a missing proposal and `mcp_ceiling` for a reviewed risk
 * above the partner's MCP ceiling.
 */
export type McpUnattendedRefusal =
  | 'not_reviewed'
  | 'mcp_ceiling'
  | Extract<ScriptReviewerRefusal,
    | 'lane_disabled' | 'proposal_not_runnable' | 'review_missing' | 'risk_above_ceiling'
    | 'verdict_not_approve' | 'strict_hits' | 'class_not_allowed' | 'class_hard_denied'
    | 'protected_resource' | 'timeout_too_long' | 'multi_device' | 'lane_open' | 'hourly_cap'
    | 'checkpoint_unavailable'>;

export interface McpUnattendedDecision {
  refusal: McpUnattendedRefusal | null;
  /** The MCP ceiling the evaluation read; null when it refused before reading it. */
  ceiling: McpUnattendedProposalCeiling | null;
}

/**
 * Whether a principal on MCP_UNATTENDED_TIER3_PRINCIPALS may run this proposal
 * on `deviceIds` with no human approval. It is the reviewer lane's gate
 * (scriptReviewerAutonomy.ts), reused rather than restated, so both unattended
 * roads enforce the same rules, plus the partner's MCP ceiling:
 * - the org has opted in to the unattended lane and its partner allows it
 *   (`unattendedEnabled`);
 * - the lane's proposal invariants hold (`checkProposalInvariants`): reviewed,
 *   unexpired, unconsumed, no BASIC or STRICT hits; a completed model review
 *   at or below the lane's risk ceiling that matches the goal, is reversible,
 *   judges the verification adequate and recommends approve; touch classes
 *   non-empty, never hard-denied and inside the allowlist; no protected
 *   service, path, registry key or device tag touched; the unattended
 *   timeout cap;
 * - no touch class that needs a System Restore point (registry, services,
 *   files_system): the lane takes one before such a run, and this road
 *   cannot, so those proposals keep the approval gate;
 * - the reviewed risk is at or below the partner's MCP ceiling (at most
 *   medium, the lane's own limit);
 * - exactly one device, the proposal's single target;
 * - the lane's circuit is closed and the org's hourly cap is not reached,
 *   counting the lane's admissions and these runs together.
 * Anything else keeps the approval gate. The whole gate is evaluated again
 * under the lane lock in the transaction that claims the proposal
 * (`lockMcpUnattendedLane`); this read is the early refusal.
 */
export async function mcpUnattendedProposalRefusal(
  proposalId: string,
  orgId: string,
  deviceIds: readonly string[],
): Promise<McpUnattendedRefusal | null> {
  return (await mcpUnattendedProposalDecision(proposalId, orgId, deviceIds)).refusal;
}

/**
 * The same evaluation, also returning the MCP ceiling it read (null when it
 * refused before reading one), so the route records in the audit row the
 * exact ceiling that admitted the run rather than a second read.
 */
export async function mcpUnattendedProposalDecision(
  proposalId: string,
  orgId: string,
  deviceIds: readonly string[],
): Promise<McpUnattendedDecision> {
  return runOutsideDbContext(() => withSystemDbAccessContext(() => evaluateRefusal(proposalId, orgId, deviceIds, false)));
}

/**
 * The whole gate again, on the CALLER's transaction: `run_script` calls it in
 * the system transaction that claims the proposal and creates its command.
 * - The lane's per-org advisory lock serializes it with other unattended runs
 *   and lane admissions for the org, so the hourly cap cannot overshoot.
 * - The org and partner script-policy rows are read FOR SHARE, so a policy
 *   save waits for this transaction, and a save committed first is the one
 *   evaluated. Either the tightened policy refuses the command, or the
 *   command existed before the tightening; never a command created after.
 *   The MCP ceiling row gets the same guarantee from
 *   `lockMcpUnattendedProposalCeiling`.
 * Everything else (proposal, review, lane state, hourly count) is re-read.
 */
export async function lockMcpUnattendedLane(
  proposalId: string,
  orgId: string,
  deviceIds: readonly string[],
): Promise<McpUnattendedRefusal | null> {
  await lockScriptLane(db, orgId);
  return (await evaluateRefusal(proposalId, orgId, deviceIds, true)).refusal;
}

/** The gate on the ambient executor; see `mcpUnattendedProposalRefusal`. */
async function evaluateRefusal(
  proposalId: string,
  orgId: string,
  deviceIds: readonly string[],
  lockPolicy: boolean,
): Promise<McpUnattendedDecision> {
  // The policy first, so its share lock is held whatever the outcome below.
  const effective = await resolveEffectiveScriptPolicy(orgId, db, { lockShare: lockPolicy });
  if (!effective.unattendedEnabled) return { refusal: 'lane_disabled', ceiling: null };
  const [proposal] = await db
    .select()
    .from(scriptProposals)
    .where(and(eq(scriptProposals.id, proposalId), eq(scriptProposals.orgId, orgId)))
    .limit(1);
  if (!proposal || !proposal.riskTier) return { refusal: 'not_reviewed', ceiling: null };
  // Consumed by an MCP run. `checkProposalInvariants` checks the intent half.
  if (proposal.mcpUnattendedClaimId !== null) return { refusal: 'proposal_not_runnable', ceiling: null };
  const review = await latestCompletedReview(db, proposalId);
  // Lazy: scriptReviewerAutonomy pulls in aiGuardrails, which reaches back to
  // aiToolsScripts (the run_script handler that imports this module), so a
  // static import makes a cycle that breaks module initialization.
  const { checkProposalInvariants } = await import('../actionIntents/scriptReviewerAutonomy');
  const { RESTORE_CHECKPOINT_CLASSES } = await import('../deviceRecovery/restoreCheckpoint');
  const invariant = checkProposalInvariants(proposal, review, effective, { requireUnconsumed: true });
  if (invariant) return { refusal: invariant as McpUnattendedRefusal, ceiling: null };
  // The lane takes a System Restore point before a registry / services /
  // files_system run, and refuses one it cannot take. This road has no
  // checkpoint step, so such a proposal keeps the approval gate.
  if ((proposal.touchClasses as TouchClass[]).some((c) => RESTORE_CHECKPOINT_CLASSES.has(c))) {
    return { refusal: 'checkpoint_unavailable', ceiling: null };
  }
  const ceiling = await readCeiling(orgId);
  if (!riskWithinMcpUnattendedCeiling(review!.riskTier as RiskTier, ceiling)) {
    return { refusal: 'mcp_ceiling', ceiling };
  }
  const unique = [...new Set(deviceIds)];
  if (proposal.targetDeviceIds.length !== 1 || unique.length !== 1 || unique[0] !== proposal.targetDeviceIds[0]) {
    return { refusal: 'multi_device', ceiling };
  }
  return { refusal: await laneCapacityRefusal(db, orgId, effective.maxUnattendedPerHour), ceiling };
}

/** The partner MCP ceiling on the ambient executor (no lock; the command path takes its own share lock). */
async function readCeiling(orgId: string): Promise<McpUnattendedProposalCeiling> {
  const [row] = await db.select({ ceiling: aiScriptPolicies.mcpUnattendedProposalMaxRisk })
    .from(organizations)
    .innerJoin(aiScriptPolicies, and(
      eq(aiScriptPolicies.partnerId, organizations.partnerId),
      isNull(aiScriptPolicies.orgId),
    ))
    .where(eq(organizations.id, orgId))
    .limit(1);
  return row?.ceiling ?? 'none';
}

async function laneCapacityRefusal(
  tx: LaneExecutor,
  orgId: string,
  perHour: number,
): Promise<McpUnattendedRefusal | null> {
  if ((await readLaneState(tx, orgId))?.state === 'open') return 'lane_open';
  const used = (await countRecentLaneIntents(tx, orgId)) + (await countRecentMcpUnattendedRuns(tx, orgId));
  if (used >= perHour) return 'hourly_cap';
  return null;
}
