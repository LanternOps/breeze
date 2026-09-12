import { and, eq, sql } from 'drizzle-orm';
import type { AiAgentRunProfile, ScriptReviewerEvidence } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { actionIntents } from '../../db/schema/actionIntents';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { aiScriptLaneState, type AiScriptLaneStateRow } from '../../db/schema/aiScriptLaneState';
import { scriptProposals } from '../../db/schema/scriptProposals';
import { recordRunTerminal } from '../aiAgents/agentCircuit';
import { createAuditLogAsync } from '../auditService';
import { captureException } from '../sentry';
import { createNotification } from '../userNotifications';
import { registerUnattendedVerificationOutcomeHandler, type VerificationOutcome } from './verify';

/** Spec §9: "Lane state opens after 2 consecutive failed or unknown verifications." */
export const LANE_OPEN_THRESHOLD = 2;

export interface UnattendedVerificationOutcome {
  orgId: string;
  proposalId: string;
  intentId: string;
  executionId: string | null;
  outcome: VerificationOutcome;
  origin:
    | { kind: 'chat'; sessionId: string | null; userId: string | null }
    | { kind: 'agent'; runId: string; agentId: string; profile: AiAgentRunProfile };
}

/**
 * The lane's circuit, driven by the verification job (W03 §4.9 → W04 §4.6
 * "After execution").
 *
 * `unknown` counts as a FAILURE. An unattended run whose effect could not be
 * independently confirmed is not a success — the operator rule is that a
 * dispatch result is never evidence of recovery, and a lane that treats
 * "couldn't check" as "fine" would never open at all on a fleet that keeps
 * going offline.
 *
 * The agent circuit is fed IN ADDITION for agent-origin runs, never instead:
 * `ai_agent_circuit_state` is keyed (org_id, agent_id) and a chat session has
 * no agent key, which is why the lane needs its own per-org state at all.
 *
 * Never throws: circuit bookkeeping must not fail the verification job.
 */
export async function onUnattendedVerificationOutcome(o: UnattendedVerificationOutcome): Promise<void> {
  const failed = o.outcome !== 'verified';
  try {
    const { laneRow, justOpened } = await runOutsideDbContext(() =>
      withSystemDbAccessContext(async (): Promise<{ laneRow: AiScriptLaneStateRow | null; justOpened: boolean }> => {
        const now = new Date();
        const [row] = await db
          .insert(aiScriptLaneState)
          .values({
            orgId: o.orgId,
            consecutiveFailedVerifications: failed ? 1 : 0,
            state: 'closed',
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: aiScriptLaneState.orgId,
            set: failed
              ? {
                  consecutiveFailedVerifications: sql`${aiScriptLaneState.consecutiveFailedVerifications} + 1`,
                  updatedAt: now,
                }
              : {
                  // A verified run resets the streak but never CLOSES an open
                  // lane: reset is a human decision (approvals:decide + MFA,
                  // POST /ai/script-lane/reset). An open lane admits nothing,
                  // so a verified outcome here belongs to a run admitted
                  // before it opened.
                  consecutiveFailedVerifications: 0,
                  updatedAt: now,
                },
          })
          .returning();
        if (!row) return { laneRow: null, justOpened: false };

        // Open by CAS on state='closed', so two concurrent failures cannot
        // both claim the open (same shape as agentCircuit.ts).
        if (failed && row.consecutiveFailedVerifications >= LANE_OPEN_THRESHOLD && row.state === 'closed') {
          const reason = `${row.consecutiveFailedVerifications} consecutive failed or unknown verifications (threshold ${LANE_OPEN_THRESHOLD})`;
          const [opened] = await db
            .update(aiScriptLaneState)
            .set({ state: 'open', openedAt: now, openedReason: reason, updatedAt: now })
            .where(and(eq(aiScriptLaneState.orgId, o.orgId), eq(aiScriptLaneState.state, 'closed')))
            .returning();
          return opened ? { laneRow: opened, justOpened: true } : { laneRow: row, justOpened: false };
        }
        return { laneRow: row, justOpened: false };
      }),
    );

    await createAuditLogAsync({
      orgId: o.orgId,
      actorType: 'system',
      actorId: 'ai-script-lane',
      action: failed ? 'ai.script.unattended_failed' : 'ai.script.unattended_verified',
      resourceType: 'script_proposal',
      resourceId: o.proposalId,
      details: {
        intentId: o.intentId,
        executionId: o.executionId,
        outcome: o.outcome,
        origin: o.origin.kind,
        consecutiveFailedVerifications: laneRow?.consecutiveFailedVerifications ?? null,
      },
      result: failed ? 'failure' : 'success',
      initiatedBy: 'ai',
    });

    if (justOpened && laneRow?.openedReason) {
      await createAuditLogAsync({
        orgId: o.orgId,
        actorType: 'system',
        actorId: 'ai-script-lane',
        action: 'ai.script_lane.opened',
        resourceType: 'ai_script_lane_state',
        resourceId: o.orgId,
        details: { reason: laneRow.openedReason, proposalId: o.proposalId, intentId: o.intentId },
        result: 'success',
        initiatedBy: 'ai',
      });
    }

    if (failed && o.origin.kind === 'agent') {
      // Feed the EXISTING agent classifier so an agent whose unattended
      // scripts keep failing trips its own circuit too. `needs_attention` is
      // the verdict classifyTerminal increments on.
      await recordRunTerminal(
        { id: o.origin.runId, orgId: o.orgId, agentId: o.origin.agentId, profile: o.origin.profile },
        'completed',
        null,
        'needs_attention',
      );
    }

    // The per-run outcome already reached the author through W03's
    // postProposalOutcomeToAuthor. What is NEW here is the circuit opening —
    // that is what the session owner is told. Agent recipients learn of it
    // through the agent's own circuit fan-out (recordRunTerminal above).
    if (justOpened && o.origin.kind === 'chat' && o.origin.userId) {
      await createNotification({
        userId: o.origin.userId,
        orgId: o.orgId,
        type: 'approval',
        priority: 'high',
        title: 'Unattended AI script lane paused',
        message:
          `The unattended script lane for this organization was paused after ${LANE_OPEN_THRESHOLD} consecutive ` +
          'failed or unverifiable runs. AI-authored scripts now require a human approval until an approver resets the lane.',
        link: '/settings/ai-script-authoring',
        metadata: { proposalId: o.proposalId, intentId: o.intentId, reason: laneRow?.openedReason ?? null },
        dedupeKey: `ai-script-lane:${o.orgId}:opened:${laneRow?.openedAt?.toISOString() ?? 'now'}`,
      });
    }
  } catch (err) {
    console.error('[laneOutcome] failed to record an unattended verification outcome:', err);
    captureException(err instanceof Error ? err : new Error(String(err)));
    // FAIL SAFE. The circuit only opens through the bookkeeping above; a
    // fault there would otherwise leave the lane admitting runs as if every
    // verification had succeeded. A failed/unknown outcome whose count could
    // not be recorded therefore OPENS the lane outright (best effort — if
    // even this write fails, the fault is already in Sentry). Reset is the
    // usual human decision.
    if (failed) {
      try {
        await runOutsideDbContext(() =>
          withSystemDbAccessContext(() =>
            db
              .insert(aiScriptLaneState)
              .values({ orgId: o.orgId, state: 'open', consecutiveFailedVerifications: 1, openedAt: new Date(), openedReason: 'circuit bookkeeping failed after a failed or unknown verification', updatedAt: new Date() })
              .onConflictDoUpdate({
                target: aiScriptLaneState.orgId,
                set: { state: 'open', openedAt: new Date(), openedReason: 'circuit bookkeeping failed after a failed or unknown verification', updatedAt: new Date() },
              }),
          ),
        );
      } catch (openErr) {
        console.error('[laneOutcome] fail-safe lane open also failed:', openErr);
        captureException(openErr instanceof Error ? openErr : new Error(String(openErr)));
      }
    }
  }
}

/**
 * Resolves the W03 hook's `(proposal, outcome)` into a typed lane outcome by
 * reading the proposal's intent. ONLY a lane run (`decided_via =
 * 'script_reviewer'`) moves the lane circuit: a human-approved run that fails
 * verification is the human's problem, not evidence that the unattended lane
 * is unsafe. Returns null for every non-lane run.
 */
export async function resolveUnattendedOutcome(
  proposal: { id: string; orgId: string },
  outcome: VerificationOutcome,
): Promise<UnattendedVerificationOutcome | null> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [prop] = await db
        .select({ intentId: scriptProposals.intentId, sessionId: scriptProposals.sessionId })
        .from(scriptProposals)
        .where(and(eq(scriptProposals.id, proposal.id), eq(scriptProposals.orgId, proposal.orgId)))
        .limit(1);
      if (!prop?.intentId) return null;
      const [intent] = await db
        .select({
          id: actionIntents.id,
          decidedVia: actionIntents.decidedVia,
          requestedByUserId: actionIntents.requestedByUserId,
          requestingAgentRunId: actionIntents.requestingAgentRunId,
          scriptReviewerEvidence: actionIntents.scriptReviewerEvidence,
        })
        .from(actionIntents)
        .where(and(eq(actionIntents.id, prop.intentId), eq(actionIntents.orgId, proposal.orgId)))
        .limit(1);
      if (!intent || intent.decidedVia !== 'script_reviewer') return null;

      const evidence = intent.scriptReviewerEvidence as ScriptReviewerEvidence | null;
      let origin: UnattendedVerificationOutcome['origin'];
      if (intent.requestingAgentRunId) {
        const [run] = await db
          .select({ agentId: aiAgentRuns.agentId, profile: aiAgentRuns.profile })
          .from(aiAgentRuns)
          .where(eq(aiAgentRuns.id, intent.requestingAgentRunId))
          .limit(1);
        origin = {
          kind: 'agent',
          runId: intent.requestingAgentRunId,
          agentId: evidence?.agent?.agentId ?? run?.agentId ?? '',
          profile: run?.profile ?? 'full',
        };
      } else {
        origin = { kind: 'chat', sessionId: prop.sessionId ?? null, userId: intent.requestedByUserId ?? null };
      }
      return {
        orgId: proposal.orgId,
        proposalId: proposal.id,
        intentId: intent.id,
        executionId: null,
        outcome,
        origin,
      };
    }),
  );
}

/** Registers the lane as the consumer of W03's verification-outcome hook. Called at worker boot. */
export function registerLaneOutcomeHandler(): void {
  registerUnattendedVerificationOutcomeHandler(async (proposal, outcome) => {
    const resolved = await resolveUnattendedOutcome(proposal, outcome);
    if (resolved) await onUnattendedVerificationOutcome(resolved);
  });
}
