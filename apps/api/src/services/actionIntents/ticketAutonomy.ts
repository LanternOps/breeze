import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { readAiKillState } from '../aiKillState';
import { resolveEffectiveAgentSystem } from '../aiAgents/effectivePolicy';
import { captureException } from '../sentry';

/**
 * P2-4 Task A3 (#4191) — the creation-transaction ticket-autonomy gate (spec
 * §4.4 amendment). Evaluated inside `createActionIntent`'s single
 * system-scoped transaction, AFTER tier/approvalScope are computed and
 * BEFORE any approver fan-out / notification write — a post-create decider
 * would race the `human_required` fan-out this function exists to skip
 * entirely.
 *
 * Deliberately dependency-free of `policyDecide.ts` and `aiGuardrails.ts`:
 * this is a SIBLING decision path to policy-decide (Tier-3 supervised
 * unattended authorization), not a variant of it — a Tier-2 ticket-triage
 * write never goes through `attemptPolicyDecision`. It imports
 * `readAiKillState` directly, the SAME kill-switch helper
 * `checkAgentReleaseAuthority`/`attemptPolicyDecision` consult (never
 * `policyDecide.ts` itself, which would be a decision-path cross-import).
 *
 * Honored ONLY when every one of five independent gates holds (all fail
 * closed — a load error, a missing row, or an ambiguous read denies, never
 * grants):
 *
 *   1. autonomy was actually requested, by an `ai_agent` principal with a run.
 *   2. the run — RE-READ here, inside the transaction, never the caller's
 *      pre-transaction copy — is `triggerKind: 'ticket'` and its immutable
 *      start-of-run `policySnapshot.effective` already had `mode: 'act'` and
 *      `triggers.ticketAutonomousWrites: true`.
 *   3. the LIVE effective policy for the run's agent+org (a fresh read, not
 *      the frozen snapshot — the operator may have flipped either gate off
 *      since the run started) ALSO has `mode: 'act'` and
 *      `triggers.ticketAutonomousWrites: true`, for the SAME agent identity
 *      the run belongs to (mirrors `agentReleaseAuthority.ts`'s
 *      `resolved.agentId !== run.agentId` ⇒ deny — the org's baseline agent
 *      for this kind may have changed since the run started).
 *   4. the kill switch is not engaged.
 *   5. the intent carries an explicit ticket scope (`{ ticketId }`) — this
 *      gate never applies to a device-scoped or unscoped intent.
 *
 * A denial is never thrown: the caller stamps the typed reason onto the
 * intent's `result` column as a `autonomyDenied` breadcrumb and proceeds
 * down the ordinary `human_required` path.
 *
 * Review fix (#4191): gates 2-4 do real I/O (a DB select, a live-policy
 * resolve that can itself throw `HTTPException` on a missing org, a kill-
 * state read) INSIDE `createActionIntent`'s single creation transaction —
 * an uncaught throw here does not degrade to `human_required`, it propagates
 * out of that transaction, rolls the WHOLE intent insert back, and surfaces
 * to the caller as `ActionIntentError('fanout_failed')`: no intent is
 * created at all. That is strictly worse than "no human ever reviewed this"
 * for what is, on any of these three reads, an ordinary infra fault — so
 * every fallible gate from here on is wrapped and ANY exception denies with
 * `gate_evaluation_failed` rather than escaping. Gates 1 and 5 above are
 * pure/synchronous and stay outside the try — they cannot throw.
 */
export type TicketAutonomyDenialReason =
  | 'not_requested'
  | 'not_agent_run'
  | 'scope_not_ticket'
  | 'run_not_ticket_triggered'
  | 'run_snapshot_not_authorized'
  | 'live_policy_not_authorized'
  | 'kill_switch_engaged'
  | 'gate_evaluation_failed';

export type TicketAutonomyDecision =
  | { granted: true }
  | { granted: false; reason: TicketAutonomyDenialReason };

export interface EvaluateTicketAutonomyArgs {
  /** `input.autonomy?.kind` verbatim — `undefined` when autonomy wasn't requested at all. */
  requestedAutonomyKind: 'ticket_autonomy' | undefined;
  /** `auth.principal.kind` — autonomy is honored ONLY for the `ai_agent` principal. */
  principalKind: string;
  /** `agentRun?.id` — the run this intent is being proposed by, if any. */
  agentRunId: string | null;
  orgId: string;
  /** The intent's proposed scope (already validated as a canonical UUID by the caller). */
  scope: { deviceId: string } | { ticketId: string } | undefined;
}

export async function evaluateTicketAutonomy(
  args: EvaluateTicketAutonomyArgs,
): Promise<TicketAutonomyDecision> {
  const deny = (reason: TicketAutonomyDenialReason): TicketAutonomyDecision => ({ granted: false, reason });

  // Gate 1 (short-circuits before ANY DB work — the common case, every
  // ordinary intent creation, must not pay for this module at all).
  if (args.requestedAutonomyKind !== 'ticket_autonomy') return deny('not_requested');
  if (args.principalKind !== 'ai_agent' || !args.agentRunId) return deny('not_agent_run');

  // Gate 5.
  if (!args.scope || !('ticketId' in args.scope)) return deny('scope_not_ticket');

  // Gates 2-4: every fallible read from here on is wrapped (see the header
  // comment's "Review fix" paragraph) — this function must NEVER let an
  // exception escape into `createActionIntent`'s transaction.
  try {
    // Gate 2 — re-read the run row IN-TRANSACTION. The ambient `db` already
    // runs inside `createActionIntent`'s system-scoped transaction (see that
    // module's header comment on why the whole creation is one transaction),
    // so this is the SAME connection/snapshot as the intent insert about to
    // follow — no separate context needed here.
    const [run] = await db
      .select({
        id: aiAgentRuns.id,
        agentId: aiAgentRuns.agentId,
        orgId: aiAgentRuns.orgId,
        triggerKind: aiAgentRuns.triggerKind,
        policySnapshot: aiAgentRuns.policySnapshot,
      })
      .from(aiAgentRuns)
      .where(eq(aiAgentRuns.id, args.agentRunId))
      .limit(1);
    if (!run || run.orgId !== args.orgId) return deny('not_agent_run');
    if (run.triggerKind !== 'ticket') return deny('run_not_ticket_triggered');

    const snapshotEffective = run.policySnapshot?.effective;
    if (
      snapshotEffective?.mode !== 'act'
      || snapshotEffective?.triggers?.ticketAutonomousWrites !== true
    ) {
      return deny('run_snapshot_not_authorized');
    }

    // Gate 3 — the live policy. `resolveEffectiveAgentSystem` is already
    // system-scoped and, per its own doc comment, reads straight through (no
    // second pooled connection) when the ambient context is already 'system'
    // — exactly the case here. It can also THROW (`HTTPException` on a
    // missing organization row) rather than return null — caught below.
    const resolved = await resolveEffectiveAgentSystem(args.orgId, run.policySnapshot.kind);
    if (
      !resolved
      || resolved.agentId !== run.agentId
      || resolved.effective.mode !== 'act'
      || resolved.effective.triggers?.ticketAutonomousWrites !== true
    ) {
      return deny('live_policy_not_authorized');
    }

    // Gate 4.
    const killState = await readAiKillState();
    if (killState.killed) return deny('kill_switch_engaged');

    return { granted: true };
  } catch (err) {
    console.error('[ticketAutonomy] gate evaluation threw — denying (fail-closed to human_required):', err);
    captureException(err instanceof Error ? err : new Error(String(err)));
    return deny('gate_evaluation_failed');
  }
}
