import { and, eq, inArray } from 'drizzle-orm';
import { PERMISSION_GRANTS, riskTierRank, type RiskTier, type TouchClass } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { devices } from '../../db/schema/devices';
import type { ScriptProposalRow } from '../../db/schema/scriptProposals';
import { withAuthDbAccessContext, type AuthContext } from '../../middleware/auth';
import { resolveIntentApprovers } from '../actionIntents/intentApprovers';
import { resolveDevicePolicyForGate } from '../aiDevicePathPolicy';
import { findProfilePathInScript } from '../aiScriptProfilePathScan';
import { resolveStrictAcknowledgement } from '../approvals/strictAcknowledgement';
import type { AuditEventInput } from '../auditEvents';
import { assertApprovalAssurance, StepUpRequiredError } from '../authenticatorAssurance';
import { deliverDeferredDispatch } from '../scriptDeferredDelivery';
import { dispatchScriptToDevice } from '../scriptDispatch';
import { captureException } from '../sentry';
import { proposalDispatchSnapshot } from './dispatchSnapshot';
import { transitionProposal } from './proposals';
import { loadProposalRequesterUserId, loadProposalRow } from './queries';
import { deterministicRiskFloor, higherRiskTier } from './reviewer';

/**
 * #10954: a human signs off on a proposal whose AI review FAILED (the reviewer
 * never reached a verdict), so the proposal is not a dead end. Product decision
 * on the issue: a human with run permission may run it or save it to the
 * library, the failure is shown next to the control, and the audit log records
 * the override under that person.
 *
 * What this is not: a way past a verdict. `review_failed` means no verdict
 * exists. A `reviewed` proposal the reviewer rejected keeps the normal path,
 * and `scan_rejected` (a BASIC scan hit) is never overridable.
 *
 * What it must not weaken, each checked here or at the route:
 *  - human session only (`requireInteractiveSession`): an MCP key or OAuth grant
 *    carries its owner's `user.id`, so identity cannot answer this;
 *  - approvals:decide plus scripts:execute in the PROPOSAL's org, MFA, and every
 *    target device in the caller's scope (`viewer.canOverrideRun`);
 *  - the STRICT acknowledgement ceremony, unchanged;
 *  - four-eyes: there is no reviewed tier, so the deterministic floor stands in
 *    for it, and at high or above a requester may only sign their own proposal
 *    as the sole eligible approver, as the normal decide does;
 *  - an enforcing partner's step-up floor. This surface has no passkey ceremony,
 *    so such a partner's floor refuses rather than being skipped;
 *  - the AI data policy on user-profile paths, which `run_script` applies to
 *    every AI-authored script.
 *
 * Nothing makes the proposal `reviewed` and no `riskTier` is invented: a
 * proposal that was never reviewed stays unreachable for `run_script`
 * (`assertProposalRunnable`, the guardrail) and for the unattended lane. The
 * human's run goes straight to the device; the AI cannot pick it up afterwards.
 */

/** The `details.override` value on every audit row this path writes. Grep for it. */
export const REVIEW_OVERRIDE_MARKER = 'approved_without_passing_ai_review';

/** Carried on the execution row and its `ai.script.executed` audit row. */
export const REVIEW_OVERRIDE_SUMMARY = 'Approved by a person without a passing AI review.';

export type ReviewOverrideDecision = 'run' | 'save_to_library';

export function reviewOverrideNote(failureReason: string | null | undefined): string {
  return `${REVIEW_OVERRIDE_SUMMARY} Review failure: ${failureReason ?? 'unknown'}`.slice(0, 2000);
}

/** The one audit row shape for an override, so the marker cannot drift between the two decisions. */
export function reviewOverrideAuditEvent(args: {
  auth: Pick<AuthContext, 'user'>;
  proposal: Pick<ScriptProposalRow, 'id' | 'orgId' | 'contentDigest' | 'decisionNote' | 'targetDeviceIds' | 'strictHits' | 'touchClasses'>;
  decision: ReviewOverrideDecision;
  acknowledgedPatterns: string[];
  details?: Record<string, unknown>;
  result?: AuditEventInput['result'];
  errorMessage?: string;
}): AuditEventInput {
  const { auth, proposal } = args;
  return {
    action: 'script.proposal.review_override',
    orgId: proposal.orgId,
    actorType: 'user',
    actorId: auth.user.id,
    actorEmail: auth.user.email,
    initiatedBy: 'manual',
    resourceType: 'script_proposal',
    resourceId: proposal.id,
    result: args.result ?? 'success',
    errorMessage: args.errorMessage,
    details: {
      override: REVIEW_OVERRIDE_MARKER,
      decision: args.decision,
      reviewFailure: proposal.decisionNote ?? null,
      contentDigest: proposal.contentDigest,
      targetDeviceIds: proposal.targetDeviceIds,
      acknowledgedPatterns: args.acknowledgedPatterns,
      deterministicRiskFloor: deterministicRiskFloor({
        strictHits: proposal.strictHits ?? [],
        touchClasses: (proposal.touchClasses ?? []) as TouchClass[],
      }),
      ...args.details,
    },
  };
}

export type ReviewOverrideRefusal = {
  ok: false;
  status: 403 | 409 | 422;
  body: { error: string } & Record<string, unknown>;
};

export type ReviewOverrideDeviceResult =
  | { deviceId: string; ok: true; executionId: string | null | undefined; commandId: string | null | undefined }
  | { deviceId: string; ok: false; error: string };

export type ReviewOverrideRunResult =
  | { ok: true; status: 'executed'; results: ReviewOverrideDeviceResult[] }
  | ReviewOverrideRefusal;

/**
 * The four-eyes half of the normal decide (`decideApprovalRequest`), applied to
 * the only risk signal a proposal with no verdict has. Requester, not decider:
 * another human signing is already the second pair of eyes.
 *
 * A proposal filed over MCP has no derivable requester (no session, no intent),
 * so this cannot fire for it and the permission gate alone applies.
 */
async function assertNotSelfApprovingHighRisk(
  auth: AuthContext,
  proposal: ScriptProposalRow,
  floor: RiskTier,
): Promise<ReviewOverrideRefusal | null> {
  if (riskTierRank(floor) < riskTierRank('high')) return null;
  const requesterId = await loadProposalRequesterUserId(proposal);
  if (requesterId !== auth.user.id) return null;
  const alsoRequire = (proposal.strictHits?.length ?? 0) > 0 ? PERMISSION_GRANTS.SCRIPTS_WRITE : undefined;
  const eligible = await runOutsideDbContext(() => resolveIntentApprovers(proposal.orgId, { alsoRequire }));
  if (eligible.includes(auth.user.id) && eligible.every((id) => id === auth.user.id)) return null;
  return { ok: false, status: 403, body: { error: 'not_sole_approver' } };
}

async function loadTargetDevices(proposal: ScriptProposalRow) {
  return runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.select().from(devices).where(and(
      inArray(devices.id, proposal.targetDeviceIds),
      eq(devices.orgId, proposal.orgId),
    ))));
}

async function assertProfilePathPolicy(
  auth: AuthContext,
  proposal: ScriptProposalRow,
  targets: Array<{ orgId: string }>,
): Promise<ReviewOverrideRefusal | null> {
  const profileHit = findProfilePathInScript(proposal.content);
  if (!profileHit) return null;
  const policy = await withAuthDbAccessContext(auth, () => resolveDevicePolicyForGate(targets));
  if (policy.deviceFileReadLevel === 'any_with_approval') return null;
  return {
    ok: false,
    status: 422,
    body: {
      error: 'policy_denied',
      message: `This script reads a user profile path (${profileHit}), which the AI data policy refuses.`,
      policy: { level: policy.deviceFileReadLevel, source: policy.source.deviceFileReadLevel },
    },
  };
}

/** Run a `review_failed` proposal on its target devices, signed by the caller. */
export async function runReviewFailedOverride(args: {
  auth: AuthContext;
  proposal: ScriptProposalRow;
  submittedAcknowledgements: string[];
  /** Rejects when the row did not land: an unaudited override must not run. */
  writeStrictAudit: (event: AuditEventInput) => Promise<void>;
  writeAudit: (event: AuditEventInput) => Promise<void>;
}): Promise<ReviewOverrideRunResult> {
  const { auth, proposal, writeStrictAudit, writeAudit } = args;

  if (proposal.expiresAt.getTime() <= Date.now()) {
    return { ok: false, status: 409, body: { error: 'proposal_expired' } };
  }
  // Unreachable by construction (a BASIC hit lands in `scan_rejected`), and
  // cheap to keep true: a BASIC hit is never a human's to wave through.
  if ((proposal.basicHits?.length ?? 0) > 0) {
    return { ok: false, status: 409, body: { error: 'proposal_scan_rejected' } };
  }

  const floor = deterministicRiskFloor({
    strictHits: proposal.strictHits ?? [],
    touchClasses: (proposal.touchClasses ?? []) as TouchClass[],
  });
  const selfApproval = await assertNotSelfApprovingHighRisk(auth, proposal, floor);
  if (selfApproval) return selfApproval;

  // With no verdict the tier is unknown, and an unknown tier is medium at the
  // least (elevationRiskTierToName's rule), never silently low.
  try {
    await assertApprovalAssurance({
      approvalId: proposal.id,
      userId: auth.user.id,
      riskTier: higherRiskTier(floor, 'medium'),
      proof: null,
      partnerId: auth.partnerId ?? null,
      decision: 'approved',
    });
  } catch (err) {
    if (err instanceof StepUpRequiredError) {
      return { ok: false, status: 403, body: { error: 'step_up_required', requiredLevel: err.requiredLevel } };
    }
    throw err;
  }

  const acknowledgement = await resolveStrictAcknowledgement({
    auth,
    proposal: { strictHits: proposal.strictHits ?? [], orgId: proposal.orgId },
    submitted: args.submittedAcknowledgements,
  });
  if (!acknowledgement.ok) {
    const { ok: _ok, ...body } = acknowledgement;
    return { ok: false, status: 422, body };
  }

  const targets = await loadTargetDevices(proposal);
  const policyRefusal = await assertProfilePathPolicy(auth, proposal, targets);
  if (policyRefusal) return policyRefusal;

  const acknowledgedPatterns = acknowledgement.acknowledged;
  const claimed = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.transaction((tx) => transitionProposal(tx, proposal.id, ['review_failed'], 'approved', {
      decidedBy: auth.user.id,
      decidedAt: new Date(),
      decisionNote: reviewOverrideNote(proposal.decisionNote),
      acknowledgedPatterns,
    }))));
  if (!claimed) return { ok: false, status: 409, body: { error: 'proposal_not_review_failed' } };

  // Puts the proposal back so the human can try again: nothing ran, and an
  // `approved` row with no run would be a new dead end. Never throws, so it can
  // never replace the error that made it necessary; false means the proposal is
  // still `approved` (reported, because nothing else will move it).
  const restore = async (): Promise<boolean> => {
    try {
      const restored = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
        db.transaction((tx) => transitionProposal(tx, proposal.id, ['approved'], 'review_failed', {
          decidedBy: null,
          decidedAt: null,
          decisionNote: proposal.decisionNote,
          acknowledgedPatterns: [],
        }))));
      if (restored) return true;
      captureException(new Error('review override restore lost its CAS'), undefined, {
        area: 'script_proposal_review_override_restore', proposalId: proposal.id,
      });
      return false;
    } catch (err) {
      console.error('[scriptProposals] review override could not put the proposal back', { proposalId: proposal.id, error: err });
      captureException(err, undefined, { area: 'script_proposal_review_override_restore', proposalId: proposal.id });
      return false;
    }
  };

  // Awaited before anything is sent: the audit row is the point of this path.
  try {
    await writeStrictAudit(reviewOverrideAuditEvent({ auth, proposal, decision: 'run', acknowledgedPatterns }));
  } catch (err) {
    await restore();
    throw err;
  }

  // From here to the first delivery nothing has run, so any throw puts the
  // proposal back. After it, something has: dispatchToTargets never throws.
  let results: ReviewOverrideDeviceResult[];
  try {
    // Reloaded so the dispatch carries the acknowledgements just stored: the
    // agent refuses a STRICT match its payload does not acknowledge.
    const claimedRow = await loadProposalRow(proposal.id);
    if (!claimedRow || claimedRow.status !== 'approved') {
      // Moved by someone else since the claim; theirs to finish, not ours to undo.
      return { ok: false, status: 409, body: { error: 'proposal_not_review_failed' } };
    }
    results = await dispatchToTargets(auth, claimedRow, targets);
  } catch (err) {
    await restore();
    throw err;
  }

  if (!results.some((r) => r.ok)) {
    const restored = await restore();
    await writeAudit(reviewOverrideAuditEvent({
      auth, proposal, decision: 'run', acknowledgedPatterns,
      result: 'failure', errorMessage: 'No target device accepted the script', details: { results, restored },
    }));
    return { ok: false, status: 409, body: { error: 'no_device_dispatched', results, restored } };
  }
  return { ok: true, status: 'executed', results };
}

async function dispatchToTargets(
  auth: AuthContext,
  proposal: ScriptProposalRow,
  targets: Array<typeof devices.$inferSelect>,
): Promise<ReviewOverrideDeviceResult[]> {
  const snapshot = proposalDispatchSnapshot(proposal, proposal.targetDeviceIds);
  const byId = new Map(targets.map((d) => [d.id, d]));
  const results: ReviewOverrideDeviceResult[] = [];
  let markedExecuted = false;
  // `executed` is what verification (and so the library) waits on. Separate
  // from the delivery so a failure here never reports a run as not run, and
  // retried on the next delivered device.
  const markExecuted = async () => {
    try {
      const moved = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
        db.transaction((tx) => transitionProposal(tx, proposal.id, ['approved'], 'executed', {}))));
      markedExecuted = true;
      if (!moved) {
        // Someone moved the proposal while it was being sent. The run stands.
        captureException(new Error('review override run finished on a proposal that left approved'), undefined, {
          area: 'script_proposal_review_override_state', proposalId: proposal.id,
        });
      }
    } catch (err) {
      console.error('[scriptProposals] review override could not mark the proposal executed', { proposalId: proposal.id, error: err });
      captureException(err, undefined, { area: 'script_proposal_review_override_state', proposalId: proposal.id });
    }
  };
  for (const deviceId of proposal.targetDeviceIds) {
    const device = byId.get(deviceId);
    if (!device) {
      results.push({ deviceId, ok: false, error: 'Device not found or access denied' });
      continue;
    }
    try {
      const created = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
        dispatchScriptToDevice({
          device,
          source: { kind: 'proposal', proposal, snapshot },
          triggerType: 'manual',
          triggeredBy: auth.user.id,
          createdBy: auth.user.id,
          runAs: proposal.runAs,
          timeoutSeconds: proposal.timeoutSeconds,
          offlinePolicy: { kind: 'reject' },
          provenance: {
            approvedBy: auth.user.id,
            approvalMethod: 'direct_ui',
            reviewRiskTier: null,
            reviewSummary: REVIEW_OVERRIDE_SUMMARY,
          },
          deferDelivery: true,
        })));
      const dispatch = await deliverDeferredDispatch(created, { deviceId, tool: 'script_proposal_review_override' });
      if (!dispatch.ok) {
        results.push({ deviceId, ok: false, error: dispatch.error });
        continue;
      }
      results.push({ deviceId, ok: true, executionId: dispatch.executionId, commandId: dispatch.commandId });
    } catch (err) {
      console.error('[scriptProposals] review override dispatch failed', { proposalId: proposal.id, deviceId, error: err });
      captureException(err);
      results.push({ deviceId, ok: false, error: err instanceof Error ? err.message : 'Execution failed' });
      continue;
    }
    if (!markedExecuted) await markExecuted();
  }
  return results;
}
