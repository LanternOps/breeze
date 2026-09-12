import {
  LANE_HARD_DENIED_CLASSES,
  riskTierRank,
  scanScriptContent,
  type AiAgentPolicySnapshot,
  type AiAgentProtectedResources,
  type RiskTier,
  type ScriptReviewerEvidence,
  type TouchClass,
} from '@breeze/shared';
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import type { ActionIntent } from '../../db/schema/actionIntents';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import type { ScriptProposalReviewRow, ScriptProposalRow } from '../../db/schema/scriptProposals';
import type { AuthContext } from '../../middleware/auth';
import { checkAgentGuardrails, checkToolPermission, touchesProtectedNames } from '../aiGuardrails';
import type { AgentGuardrailPolicy } from '../aiGuardrails';
import { resolveEffectiveAgentSystem } from '../aiAgents/effectivePolicy';
import { readAiKillState } from '../aiKillState';
import { RESTORE_CHECKPOINT_CLASSES } from '../deviceRecovery/restoreCheckpoint';
import { checkScriptMaintenanceSuppression } from '../scriptMaintenanceGate';
import { resolveEffectiveScriptPolicy, type EffectiveScriptPolicy } from '../scriptProposals/policy';
import { latestCompletedReview, loadProposalForRelease } from '../scriptProposals/proposals';
import { captureException } from '../sentry';
import {
  countRecentLaneIntents,
  countRunLaneIntents,
  lockScriptLane,
  readLaneDevice,
  readLaneState,
  type LaneExecutor,
} from './laneQueries';

/**
 * The unattended script lane's creation-transaction autonomy decision
 * (spec §4.6, D8/D9). Sits beside `evaluateTicketAutonomy`
 * (`ticketAutonomy.ts`) in `createActionIntent` and shares its contract:
 * evaluated INSIDE the intent's transaction on the ambient `db`, never
 * throws, and a refusal is a breadcrumb on a row that still proceeds down the
 * ordinary human path — never an error to the caller.
 *
 * WHAT THE REVIEWER IS ALLOWED TO DECIDE. Invariants 3 and 4, and nothing
 * else. Every other gate reads the deterministic classifier, the policy rows,
 * RBAC, or live device state. A model label is not an enforcement boundary
 * (Codex quorum, critical finding → D9).
 *
 * ORDER IS PART OF THE CONTRACT. The FIRST failure is the reason recorded and
 * shown. Do not reorder.
 *
 * INVARIANT 11 (recovery prerequisite) is split across creation and release:
 * creation proves the checkpoint is POSSIBLE (checkpoint-needing classes on a
 * Windows device) and records `checkpointRequired`; the checkpoint itself is
 * TAKEN at release, immediately before dispatch
 * (`ensureLaneCheckpointBeforeRelease`). Taking it here would hold the
 * intent transaction — and the per-org advisory lock every other lane
 * admission for the org queues behind — open for up to three minutes.
 */
export type ScriptReviewerRefusal =
  | 'lane_disabled'
  | 'proposal_not_runnable'
  | 'review_missing'
  | 'risk_above_ceiling'
  | 'verdict_not_approve'
  | 'strict_hits'
  | 'class_not_allowed'
  | 'class_hard_denied'
  | 'protected_resource'
  | 'timeout_too_long'
  | 'scope_not_supervised'
  | 'multi_device'
  | 'checkpoint_unavailable'
  | 'lane_open'
  | 'hourly_cap'
  | 'requester_unauthorized'
  | 'device_unavailable';

export type ScriptReviewerDecision =
  | { granted: true; evidence: ScriptReviewerEvidence }
  | { granted: false; reason: ScriptReviewerRefusal };

export interface ScriptReviewerAgentRun {
  id: string;
  agentId: string;
  /** The run's immutable start-of-run policy snapshot (`ai_agent_runs.policy_snapshot`). */
  policySnapshot: AiAgentPolicySnapshot | null;
}

export interface ScriptReviewerAutonomyArgs {
  /**
   * The executor to read through. Inside `createActionIntent` this is the
   * ambient `db` (AsyncLocalStorage-bound to the creation transaction).
   */
  tx?: LaneExecutor;
  auth: AuthContext;
  intentDraft: {
    orgId: string;
    approvalScope: 'supervised' | 'four_eyes';
    agentRun: ScriptReviewerAgentRun | null;
    arguments: Record<string, unknown>;
  };
  proposal: ScriptProposalRow;
  /** The proposal's LATEST completed model review, loaded by the caller in the same tx. */
  review: ScriptProposalReviewRow | null;
}

export const UNATTENDED_MAX_TIMEOUT_SECONDS = 300;

/** The classifier's extracted names for a proposal. Recomputed from content —
 *  the scanner is deterministic and the proposal is immutable, so this is the
 *  same answer the scan at creation would have given. */
export function proposalTouchedNames(proposal: Pick<ScriptProposalRow, 'content' | 'language'>) {
  return scanScriptContent(proposal.content, proposal.language).touchedNames;
}

/**
 * The agent's own protected resources, off the run's IMMUTABLE policy
 * snapshot. Read from the snapshot rather than re-resolved live because the
 * snapshot is what the run was admitted under; the LIVE policy is re-read at
 * release (`revalidateScriptReviewerEvidence`) where a tightening since
 * creation must revoke.
 */
function readAgentProtectedResources(agentRun: ScriptReviewerAgentRun | null): AiAgentProtectedResources | null {
  return agentRun?.policySnapshot?.effective?.protectedResources ?? null;
}

function requestedDeviceIds(args: Record<string, unknown>): string[] {
  return Array.isArray(args.deviceIds) ? (args.deviceIds as unknown[]).filter((v): v is string => typeof v === 'string') : [];
}

/** Invariants 2–8 over an immutable proposal + review pair and the effective
 *  policy. Shared by the creation decision and the release revalidation so
 *  the two cannot drift on what "still eligible" means. */
function checkProposalInvariants(
  proposal: ScriptProposalRow,
  review: ScriptProposalReviewRow | null,
  effective: EffectiveScriptPolicy,
  opts: { requireUnconsumed: boolean },
): ScriptReviewerRefusal | null {
  // 2 — the proposal itself is runnable and clean.
  if (
    proposal.status !== 'reviewed'
    || (opts.requireUnconsumed && proposal.intentId !== null)
    || proposal.expiresAt.getTime() <= Date.now()
    || proposal.basicHits.length > 0
  ) {
    return 'proposal_not_runnable';
  }

  // 3 — a COMPLETED MODEL review, at or below the effective ceiling.
  if (!review || review.status !== 'completed' || review.reviewerKind !== 'model' || !review.riskTier) {
    return 'review_missing';
  }
  if (riskTierRank(review.riskTier as RiskTier) > riskTierRank(effective.maxUnattendedRiskTier)) {
    return 'risk_above_ceiling';
  }

  // 4 — an unqualified approve. The reviewer's authority stops here.
  if (
    review.goalMatch !== 'yes'
    || review.reversible !== true
    || review.verificationAdequate !== true
    || review.recommendedAction !== 'approve'
  ) {
    return 'verdict_not_approve';
  }

  // 5 — no STRICT hits. A STRICT acknowledgement requires scripts:write +
  // MFA from a human (spec §4.5); there is no human here to give it.
  if (proposal.strictHits.length > 0) return 'strict_hits';

  // 6 — classes non-empty, never hard-denied, inside the effective
  // allowlist. EMPTY refuses: a script the classifier cannot place is a
  // script whose blast radius is unbounded, so it gets a human.
  const classes = proposal.touchClasses as TouchClass[];
  if (classes.length === 0) return 'class_not_allowed';
  if (classes.some((c) => LANE_HARD_DENIED_CLASSES.has(c))) return 'class_hard_denied';
  if (classes.some((c) => !effective.unattendedAllowedClasses.includes(c))) return 'class_not_allowed';

  // 7 — protected resources, checked against the CLASSIFIER's extracted
  // names, not against named input fields: `aiGuardrails.touchesProtected`
  // has never inspected script content, which is exactly why the lane needs
  // a content-derived check. Same matcher, one implementation.
  if (touchesProtectedNames(proposalTouchedNames(proposal), effective.protectedResources)) {
    return 'protected_resource';
  }

  // 8 — the unattended timeout cap. Shorter than the 3600s proposal cap on
  // purpose: an unattended run nobody is watching must not hold a device
  // for an hour.
  if (proposal.timeoutSeconds > UNATTENDED_MAX_TIMEOUT_SECONDS) return 'timeout_too_long';

  return null;
}

/**
 * Invariant 13, agent branch. `checkToolPermission` DENIES the `ai_agent`
 * principal as its first statement, so an agent's authority is structural:
 * snapshot act-mode, LIVE act-mode + allowlist, kill switch clear,
 * structural guardrails, per-run action cap.
 */
async function checkAgentAuthority(
  tx: LaneExecutor,
  orgId: string,
  run: ScriptReviewerAgentRun,
  toolArguments: Record<string, unknown>,
  device: { id: string; siteId: string | null },
  proposalContext: { riskTier: RiskTier; strictHits: string[] },
): Promise<{ ok: true; agent: NonNullable<ScriptReviewerEvidence['agent']> } | { ok: false }> {
  // The run's frozen snapshot must ALREADY have been act-mode. A shadow run
  // cannot acquire act authority by proposing a script.
  const snapshot = run.policySnapshot;
  if (snapshot?.effective?.mode !== 'act') return { ok: false };

  // …AND the LIVE policy must still say so, for the SAME agent identity. A
  // demotion between run start and this call revokes (same rule
  // `evaluateTicketAutonomy` applies).
  const resolved = await resolveEffectiveAgentSystem(orgId, snapshot.kind);
  if (
    !resolved
    || resolved.agentId !== run.agentId
    || resolved.effective.mode !== 'act'
    || !resolved.effective.toolAllowlist.includes('run_script')
  ) {
    return { ok: false };
  }

  const killState = await readAiKillState();
  if (killState.killed) return { ok: false };

  // Structural guardrails (site scope, device binding, protected inputs) on
  // the LIVE policy. Synchronous and RBAC-free by design. The REAL review
  // tier, strict hits and device site are passed — never a fabricated
  // "safe" context — so a future guardrail branch on any of them sees the
  // truth (the tier ceiling itself is enforced by checkProposalInvariants).
  const structural = checkAgentGuardrails('run_script', toolArguments, {
    enabled: resolved.effective.enabled,
    mode: resolved.effective.mode,
    toolAllowlist: resolved.effective.toolAllowlist,
    protectedResources: resolved.effective.protectedResources,
    deviceId: device.id,
    deviceSiteId: device.siteId,
  } as AgentGuardrailPolicy, { proposal: proposalContext });
  if (!structural.allowed) return { ok: false };

  // Per-run action cap, the same limit act-mode execution reserves against
  // (`actRevalidation.ts`). `>=`, matching that code.
  const cap = resolved.effective.limits?.maxActionsPerRun;
  if (typeof cap === 'number' && (await countRunLaneIntents(tx, run.id)) >= cap) {
    return { ok: false };
  }

  return {
    ok: true,
    agent: {
      agentId: run.agentId,
      policyEpoch: (resolved as { policyEpoch?: number }).policyEpoch ?? 0,
      killEpoch: killState.epoch,
    },
  };
}

export async function evaluateScriptReviewerAutonomy(
  args: ScriptReviewerAutonomyArgs,
): Promise<ScriptReviewerDecision> {
  const deny = (reason: ScriptReviewerRefusal): ScriptReviewerDecision => ({ granted: false, reason });
  const { proposal, review, intentDraft } = args;
  const tx: LaneExecutor = args.tx ?? db;

  try {
    const effective = await resolveEffectiveScriptPolicy(intentDraft.orgId, tx);

    // 1 — partner ceiling AND org grant. This IS the policy.
    if (!effective.unattendedEnabled) return deny('lane_disabled');

    // 2–8.
    const proposalRefusal = checkProposalInvariants(proposal, review, effective, { requireUnconsumed: true });
    if (proposalRefusal) return deny(proposalRefusal);
    const classes = proposal.touchClasses as TouchClass[];
    // 7 (agent half) — the agent's OWN protectedResources are unioned in:
    // the lane may tighten an agent's envelope, never widen it (spec §4.1).
    const agentProtected = readAgentProtectedResources(intentDraft.agentRun);
    if (agentProtected && touchesProtectedNames(proposalTouchedNames(proposal), agentProtected)) {
      return deny('protected_resource');
    }

    // 9 — the guardrail's own resolved scope. A proposal that would have
    // needed a second human is never released without the first.
    if (intentDraft.approvalScope !== 'supervised') return deny('scope_not_supervised');

    // 10 — single device (D6). Both the proposal's targets AND the call's
    // requested devices must be exactly one, and the same one: the digest
    // pins deviceIds, so a mismatch here would pin a set the lane never
    // evaluated.
    const requested = requestedDeviceIds(intentDraft.arguments);
    if (proposal.targetDeviceIds.length !== 1 || requested.length !== 1) return deny('multi_device');
    const deviceId = requested[0]!;
    if (deviceId !== proposal.targetDeviceIds[0]) return deny('multi_device');

    // The LOCK comes first, and everything reservation-shaped happens under
    // it: lane state, the hourly count, and (in intentService) the insert.
    await lockScriptLane(tx, intentDraft.orgId);

    // 11 — recovery prerequisite, FEASIBILITY half. Only classes a System
    // Restore point can actually undo need one, and only Windows can take
    // one — which is why `registry` / `services` / `files_system` are
    // lane-ineligible on Linux and macOS in v1 (spec §10). The checkpoint
    // itself is taken at release (`ensureLaneCheckpointBeforeRelease`).
    const checkpointRequired = classes.some((c) => RESTORE_CHECKPOINT_CLASSES.has(c));
    // 14 (device read shared with 11) — the device must be online, in this
    // org, and not inside a maintenance window. Read once here; the
    // maintenance half runs after the cheaper gates below.
    const device = await readLaneDevice(tx, deviceId, intentDraft.orgId);
    if (!device) return deny('device_unavailable');
    if (checkpointRequired && device.osType !== 'windows') return deny('checkpoint_unavailable');

    // 12a — the circuit. Checked at approval AND again at release.
    const lane = await readLaneState(tx, intentDraft.orgId);
    if (lane?.state === 'open') return deny('lane_open');

    // 12b — the hourly reservation. `>=` not `>`: the cap is the number of
    // admissions allowed, so the 11th of a cap-10 hour is refused.
    if ((await countRecentLaneIntents(tx, intentDraft.orgId)) >= effective.maxUnattendedPerHour) {
      return deny('hourly_cap');
    }

    // 13 — requester authority. Two disjoint branches, because the two
    // principals have disjoint authorities: a chat user has RBAC, an agent
    // has a policy. There is no shared path.
    let agentEvidence: ScriptReviewerEvidence['agent'];
    if (intentDraft.agentRun) {
      const authority = await checkAgentAuthority(
        tx,
        intentDraft.orgId,
        intentDraft.agentRun,
        intentDraft.arguments,
        device,
        { riskTier: review!.riskTier as RiskTier, strictHits: proposal.strictHits },
      );
      if (!authority.ok) return deny('requester_unauthorized');
      agentEvidence = authority.agent;
    } else {
      // Chat. The SAME live re-check a supervised human self-approve runs —
      // the lane replaces the click, never the permission behind it.
      const denial = await checkToolPermission('run_script', intentDraft.arguments, args.auth);
      if (denial) return deny('requester_unauthorized');
    }

    // 14 — device state. Fail-closed on an unreadable window, exactly as
    // `scriptDispatch` does: an unverifiable window must not become an open
    // door.
    if (device.status !== 'online') return deny('device_unavailable');
    if ((await checkScriptMaintenanceSuppression(deviceId)).suppressed) return deny('device_unavailable');

    // Every invariant held. The evidence pins EXACTLY what was evaluated —
    // the specific review id (not "the latest", which can change), the
    // content digest, the scanner version, and the policy snapshot — so
    // release can re-prove the same decision against current state rather
    // than re-deriving a new one (spec §4.6 "Decision record").
    //
    // Lifecycle state is deliberately NOT evidence material: it is re-read
    // live at release, and freezing it would make a revoked grant look valid.
    return {
      granted: true,
      evidence: {
        proposalId: proposal.id,
        reviewId: review!.id,
        contentDigest: proposal.contentDigest,
        scannerVersion: proposal.scannerVersion,
        reviewerModel: review!.model ?? '',
        reviewerPromptVersion: review!.reviewerPromptVersion ?? '',
        touchClasses: classes,
        policySnapshot: {
          ceiling: effective.maxUnattendedRiskTier,
          allowedClasses: effective.unattendedAllowedClasses,
          perHour: effective.maxUnattendedPerHour,
        },
        laneReservationAt: new Date().toISOString(),
        checkpointRequired,
        ...(agentEvidence ? { agent: agentEvidence } : {}),
      },
    };
  } catch (err) {
    console.error('[scriptReviewerAutonomy] gate evaluation threw — denying (fail-closed to the human path):', err);
    captureException(err instanceof Error ? err : new Error(String(err)));
    return deny('lane_disabled');
  }
}

/**
 * Re-prove a `script_reviewer` grant against CURRENT state, at release
 * (spec §4.6 "Release").
 *
 * Re-runs invariants 1, 2, 3, 5, 6, 7, 8, 12, 13, 14 — every one whose truth
 * can change while the intent sits in its release lease — and additionally
 * requires the evidence's `reviewId` to still be the proposal's LATEST
 * completed review. Pinning the exact review id is the point: "the latest
 * review still approves" is a different, weaker claim than "the review this
 * decision was made from is still the operative one".
 *
 * Invariant 4 is a frozen property of an immutable review row (re-checked
 * anyway through the shared helper — it is free). 9 and 10 are frozen
 * properties of an immutable proposal. 11's checkpoint is taken by
 * `ensureLaneCheckpointBeforeRelease` immediately before dispatch. The
 * hourly cap is NOT re-run: it was RESERVED at creation under the advisory
 * lock, and re-counting at release would refuse an intent that legitimately
 * holds one of the hour's slots.
 *
 * Never throws: a fault denies, like everywhere else on this path.
 */
export async function revalidateScriptReviewerEvidence(
  intent: ActionIntent,
  database: LaneExecutor = db,
): Promise<{ ok: true } | { ok: false; reason: ScriptReviewerRefusal }> {
  const fail = (reason: ScriptReviewerRefusal) => ({ ok: false as const, reason });
  try {
    // Both release callers (jobs/intentReleaseWorker.ts, the inline chat
    // release in aiAgentSdk.ts) reach this BETWEEN DB contexts: `db` would
    // fall back to the raw GUC-less pool, which RLS filters to zero rows
    // rather than erroring — every read here would answer "not found" and
    // every lane release would fail `lane_disabled`. Same discipline as
    // checkAgentReleaseAuthority (agentReleaseAuthority.ts) and the effect-
    // digest recompute: one short system-scoped context of our own.
    return await runOutsideDbContext(() => withSystemDbAccessContext(() => revalidateInSystemContext(intent, database, fail)));
  } catch (err) {
    console.error('[scriptReviewerAutonomy] release revalidation threw — revoking (fail-closed):', err);
    captureException(err instanceof Error ? err : new Error(String(err)));
    return fail('lane_disabled');
  }
}

async function revalidateInSystemContext(
  intent: ActionIntent,
  database: LaneExecutor,
  fail: (reason: ScriptReviewerRefusal) => { ok: false; reason: ScriptReviewerRefusal },
): Promise<{ ok: true } | { ok: false; reason: ScriptReviewerRefusal }> {
  {
    const evidence = intent.scriptReviewerEvidence as ScriptReviewerEvidence | null;
    if (!evidence?.proposalId || !evidence.reviewId) return fail('lane_disabled');

    const effective = await resolveEffectiveScriptPolicy(intent.orgId, database);
    if (!effective.unattendedEnabled) return fail('lane_disabled'); // 1

    const proposal = await loadProposalForRelease(database, evidence.proposalId, intent.orgId);
    if (
      !proposal
      || proposal.contentDigest !== evidence.contentDigest
      || proposal.intentId !== intent.id
    ) {
      return fail('proposal_not_runnable'); // 2 (the lane's own claim)
    }

    const review = await latestCompletedReview(database, proposal.id);
    if (!review || review.id !== evidence.reviewId) return fail('review_missing'); // 3 + pin

    // 2–8 against CURRENT policy. The proposal is consumed by this intent,
    // so `intentId !== null` is expected.
    const proposalRefusal = checkProposalInvariants(proposal, review, effective, { requireUnconsumed: false });
    if (proposalRefusal) return fail(proposalRefusal);

    const lane = await readLaneState(database, intent.orgId);
    if (lane?.state === 'open') return fail('lane_open'); // 12

    const deviceId = requestedDeviceIds(intent.arguments as Record<string, unknown>)[0];
    if (!deviceId) return fail('device_unavailable');

    // 13 — authority.
    // 14 (device read shared with 13) — read once; the maintenance half runs
    // after the authority check below.
    const device = await readLaneDevice(database, deviceId, intent.orgId);
    if (!device || device.status !== 'online') return fail('device_unavailable');

    if (intent.requestingAgentRunId && evidence.agent) {
      const authority = await checkAgentAuthority(
        database,
        intent.orgId,
        {
          id: intent.requestingAgentRunId,
          agentId: evidence.agent.agentId,
          // The snapshot was act-mode at creation (that is how the grant was
          // made); the LIVE policy is what can have changed since.
          policySnapshot: await readRunSnapshot(database, intent.requestingAgentRunId),
        },
        intent.arguments as Record<string, unknown>,
        device,
        { riskTier: review.riskTier as RiskTier, strictHits: proposal.strictHits },
      );
      if (!authority.ok) return fail('requester_unauthorized');
    } else if (!!intent.requestingAgentRunId !== !!evidence.agent) {
      // The grant writes an agent block iff the intent is agent-origin. Any
      // other pairing is not a shape this code produces — treat as forged.
      return fail('requester_unauthorized');
    }
    // A CHAT-origin intent's user RBAC is re-checked by
    // `revalidateApprovedIntentForRelease`'s own `checkToolPermission` call,
    // which runs for every non-agent intent — duplicating it here would just
    // cost a second round trip.

    if ((await checkScriptMaintenanceSuppression(deviceId)).suppressed) return fail('device_unavailable'); // 14

    return { ok: true };
  }
}

async function readRunSnapshot(tx: LaneExecutor, runId: string): Promise<AiAgentPolicySnapshot | null> {
  const [run] = await tx
    .select({ policySnapshot: aiAgentRuns.policySnapshot })
    .from(aiAgentRuns)
    .where(eq(aiAgentRuns.id, runId))
    .limit(1);
  return (run?.policySnapshot as AiAgentPolicySnapshot | null) ?? null;
}
