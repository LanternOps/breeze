/**
 * The four per-profile run finalizers, split out of `runLoop.ts` (issue #4451).
 *
 * Each one runs from `executeAgentRun` (runLoop.ts) AFTER the SDK loop has
 * returned and BEFORE the awaiting_approval/completed decision, turns the one
 * outcome its profile is responsible for into durable rows, and returns an
 * `error_code` override the caller applies ONLY on the normal-finish path —
 * see each function's own docstring for the per-profile rules, which this
 * split did not change.
 *
 * Import direction is one-way (`runLoop` → `runFinalizers` → `runLoopTypes`):
 * nothing here imports `runLoop.ts`, so the loop can keep calling into this
 * file without a cycle.
 */
import { and, eq } from 'drizzle-orm';
import { AI_AGENT_LIMIT_DEFAULTS } from '@breeze/shared';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../../db';
// Direct module import, not the schema barrel — see the same note in runService.
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { persistAlertVerdict, type AlertVerdictIntentInfo } from './alertVerdicts';
import { isNarrativeProfile } from './narrativeProfile';
import { NarrativePersistConflictError, persistNarrativeReport } from './narrativeReport';
import { persistSweepFindings } from './sweepFindings';
import { isSweepProfile } from './sweepProfile';
import { persistTicketTriage } from './ticketTriageFindings';
import { isTriageProfile } from './triageProfile';
import { isVerdictProfile } from './verdictProfile';
import type { LoopResult, RunContext } from './runLoopTypes';

/**
 * Same skip-if-already-system shape as `runLoop.inSystemDbContext` (and
 * `runService`'s, and `resolveEffectiveAgentSystem`'s): a bare system wrapper
 * is a no-op inside an ambient request context (so exit first), and
 * re-entering from an already-system context would take a SECOND pooled
 * connection while the first is still held. Kept as a local copy rather than
 * exported from `runLoop.ts` — importing it back would re-introduce the very
 * cycle this split exists to avoid.
 */
function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

/**
 * Phase 2 wave P2-1 (alert verdicts), Task 8 — review round 1 fixes
 * (IMPORTANT 3 + 4). Runs from `executeAgentRun`, BEFORE the
 * awaiting_approval/completed decision and before any of the three
 * `finishRun` call sites — not inside `finishRun` itself (moved there in
 * the original Task 8 pass; the ordering was the bug IMPORTANT 3 found: the
 * status ternary read `intentIds.length` before this ran, so a verdict run
 * that created a pending intent still finished `completed`).
 *
 * Returns an errorCode override. The caller applies it ONLY to the
 * normal-finish `finishRun` call — the `result.failure`/ceiling branches
 * already carry a real, more specific code (`llm_unavailable`,
 * `max_turns_exceeded`, …) that must not be clobbered with the generic
 * `verdict_missing`/`verdict_persist_failed`, and `classifyTerminal`
 * (agentCircuit.ts) still needs that real code to classify a genuine
 * runner failure correctly for the circuit breaker regardless of profile.
 * Returning `null` and letting those two branches ignore it entirely keeps
 * that scoping intact without this function needing to know which branch
 * the caller is about to take.
 */
export async function finalizeVerdict(ctx: RunContext, result: LoopResult): Promise<string | null> {
  if (!isVerdictProfile(ctx.run)) return null;
  const { outcome } = result;

  if (!outcome.alertVerdict) {
    // A verdict run that reached a normal finish without ever calling
    // `submit_alert_verdict` is a runner failure a human needs to see —
    // never a silent `completed` with nothing to show for it. (On the
    // failure/ceiling branches this return value is discarded by the
    // caller, so this only actually takes effect on the normal-finish path
    // — see this function's own docstring.)
    outcome.runVerdict = 'needs_attention';
    return 'verdict_missing';
  }

  // IMPORTANT 4: re-read the run's live status right before writing — the
  // stall reaper (`reapStalledAgentRuns`, runService.ts) or a second
  // executor may have already moved this run out of `running` while the
  // SDK loop was in flight. Skip persistence rather than orphan a live
  // verdict row + a live approval request under a run nobody owns anymore.
  // A tiny window remains between this read and the writes inside
  // `persistAlertVerdict` below — accepted per review ruling.
  const stillRunning = await isRunStillRunning(ctx.run.id, ctx.run.orgId);
  if (!stillRunning) {
    console.warn('[aiAgentRunLoop] skipped verdict persistence — run left `running` before it could be persisted', {
      runId: ctx.run.id,
    });
    return null;
  }

  try {
    const { intentId, suggestionDisposition, suggestionReason } = await persistAlertVerdict(
      {
        id: ctx.run.id,
        orgId: ctx.run.orgId,
        alertId: ctx.run.alertId,
        correlationGroupId: ctx.run.correlationGroupId,
        deviceId: ctx.run.deviceId,
        // Review round 2 (IMPORTANT 1) — the run's OWN effective
        // toolAllowlist, off the already-loaded run row's policySnapshot
        // (never re-queried): `persistAlertVerdict` gates a suggested
        // mutation's intent creation on this SAME authority the release
        // path re-checks (agentReleaseAuthority.ts).
        toolAllowlist: ctx.run.policySnapshot.effective.toolAllowlist,
      },
      outcome.alertVerdict,
      result.agentAuth,
    );
    if (intentId) result.intentIds.push(intentId);
    // Review round 1 (IMPORTANT 2): only recorded when there was a
    // `suggestedAction` to report on at all — see `AlertVerdictIntentInfo`'s
    // own docstring for why this is absent rather than a vacuous
    // `not_created` on every verdict.
    if (outcome.alertVerdict.suggestedAction) {
      const intentInfo: AlertVerdictIntentInfo = { disposition: suggestionDisposition };
      if (suggestionReason) intentInfo.reason = suggestionReason;
      outcome.alertVerdictIntent = intentInfo;
    }
    return null;
  } catch (error) {
    console.error('[aiAgentRunLoop] failed to persist alert verdict', { runId: ctx.run.id, error });
    return 'verdict_persist_failed';
  }
}

/**
 * Phase 2 wave P2-2 (scheduled sweeps), Task A7 — the sweep sibling of
 * `finalizeVerdict` above, called from the SAME place in `executeAgentRun`
 * (before the awaiting_approval/completed decision, outside any ambient DB
 * context — `persistSweepFindings` inherits `createActionIntent`'s
 * no-ambient-context precondition; see `alertVerdicts.ts:208-226`).
 *
 * Returns an errorCode override the caller applies ONLY on the normal-finish
 * path, exactly as it does for `finalizeVerdict`'s. Unlike a verdict run, a
 * sweep run that produced no findings is NOT an error: task 6 already treats
 * `outcome.sweepFindings` as this profile's "produced something" signal, and a
 * sweep that legitimately found nothing to report still completes cleanly.
 *
 * `evidenceDeviceIds` is built from `ctx.sweep.evidence` — the rows the
 * SYSTEM loaded, not anything the model said — and is the control that keeps
 * a crafted proposal from reaching a device this run never looked at. A run
 * whose context carries no sweep block at all (defensive: `ctx.sweep` is
 * populated for every sweep-profile run today) therefore has an EMPTY
 * evidence set, which refuses every proposal — fail closed, never open.
 */
export async function finalizeSweep(ctx: RunContext, result: LoopResult): Promise<string | null> {
  if (!isSweepProfile(ctx.run)) return null;
  const { outcome } = result;

  // Recorded even when there are no findings: "the model only saw a sample"
  // is true of the run regardless of what it chose to report.
  if (ctx.sweep) outcome.sweepEvidenceTruncated = ctx.sweep.evidence.truncated;

  if (!outcome.sweepFindings) return null;

  // Same IMPORTANT-4 re-read as `finalizeVerdict`: the stall reaper
  // (`reapStalledAgentRuns`) or a second executor may have moved this run out
  // of `running` while the SDK loop was in flight. Skip persistence rather
  // than mint live, human-approvable intents under a run nobody owns anymore.
  const stillRunning = await isRunStillRunning(ctx.run.id, ctx.run.orgId);
  if (!stillRunning) {
    console.warn('[aiAgentRunLoop] skipped sweep persistence — run left `running` before it could be persisted', {
      runId: ctx.run.id,
    });
    return null;
  }

  const evidenceDeviceIds = new Set<string>();
  for (const kind of Object.values(ctx.sweep?.evidence.kinds ?? {})) {
    for (const row of kind?.rows ?? []) {
      if (row.deviceId) evidenceDeviceIds.add(row.deviceId);
    }
  }

  try {
    const { proposals, intentIds } = await persistSweepFindings(
      {
        id: ctx.run.id,
        orgId: ctx.run.orgId,
        agentId: ctx.run.agentId,
        // A sweep run is device-less by construction — that is exactly why
        // every intent it mints carries its own explicit device scope.
        deviceId: null,
        scheduleId: ctx.run.scheduleId,
        // The AGENT's effective allowlist off the already-loaded run row —
        // the same authority `agentReleaseAuthority.ts` re-checks at release.
        toolAllowlist: ctx.run.policySnapshot.effective.toolAllowlist,
        // The AGENT's action cap, NOT `sweepLimits`' hard `0` (which governs
        // what the run LOOP may execute, and a sweep executes nothing). `??`
        // tolerates a v1 policy snapshot, which predates the field entirely.
        maxActionsPerRun:
          ctx.run.policySnapshot.effective.limits.maxActionsPerRun
          ?? AI_AGENT_LIMIT_DEFAULTS.maxActionsPerRun,
        evidenceDeviceIds,
      },
      outcome.sweepFindings,
      result.agentAuth,
    );
    if (proposals.length > 0) outcome.sweepProposals = proposals;
    for (const intentId of intentIds) result.intentIds.push(intentId);
    return null;
  } catch (error) {
    console.error('[aiAgentRunLoop] failed to persist sweep findings', { runId: ctx.run.id, error });
    return 'sweep_persist_failed';
  }
}

/**
 * Phase 2 wave P2-3 (weekly org narrative), Task A7 — the narrative sibling of
 * `finalizeVerdict`/`finalizeSweep` above, called from the SAME place in
 * `executeAgentRun` and outside any ambient DB context (`persistNarrativeReport`
 * opens its own system transaction and would take a second pooled connection
 * from inside one).
 *
 * Returns an errorCode override the caller applies ONLY on the normal-finish
 * path, exactly as it does for the two siblings'.
 *
 * A narrative run that produced NOTHING is an error, unlike a sweep that found
 * nothing: a sweep legitimately reports "all clear", but the narrative IS the
 * deliverable — an occurrence that yields no document is a silent hole in a
 * weekly series an MSP forwards to their customer, and `narrative_missing` is
 * what makes that visible on the run row instead of a clean `completed` with
 * nothing behind it.
 *
 * `narrative_no_schedule` is deliberately separate from a persistence failure:
 * the definition's identity IS `(org_id, source_ai_agent_schedule_id)`, so
 * without a schedule there is no row to find-or-create and no idempotency at
 * all — a manually triggered narrative run would mint a fresh definition every
 * time. Refusing is the conservative answer; the narrative still lives on the
 * run's own outcome and renders on the run-detail page.
 */
export async function finalizeNarrative(ctx: RunContext, result: LoopResult): Promise<string | null> {
  if (!isNarrativeProfile(ctx.run)) return null;
  const { outcome } = result;

  if (!outcome.narrative) return 'narrative_missing';
  if (!ctx.narrative?.scheduleId) {
    console.warn('[aiAgentRunLoop] narrative run carries no schedule — not persisting a report definition', {
      runId: ctx.run.id, orgId: ctx.run.orgId,
    });
    return 'narrative_no_schedule';
  }

  // Same IMPORTANT-4 re-read both siblings carry: the stall reaper
  // (`reapStalledAgentRuns`) or a second executor may have moved this run out
  // of `running` while the SDK loop was in flight. Skip rather than publish a
  // customer-facing artifact under a run nobody owns any more. (A tiny window
  // remains between this read and the transaction below — closed properly
  // there, by the `FOR UPDATE` lock plus the `report_run_id IS NULL` CAS.)
  const stillRunning = await isRunStillRunning(ctx.run.id, ctx.run.orgId);
  if (!stillRunning) {
    console.warn('[aiAgentRunLoop] skipped narrative persistence — run left `running` before it could be persisted', {
      runId: ctx.run.id,
    });
    return null;
  }

  try {
    const { reportId, reportRunId } = await persistNarrativeReport({
      run: {
        id: ctx.run.id,
        orgId: ctx.run.orgId,
        agentId: ctx.run.agentId,
        scheduleId: ctx.narrative.scheduleId,
      },
      agent: { id: ctx.agent.id, name: ctx.agent.name },
      occurrenceKey: ctx.narrative.occurrenceKey || null,
      context: ctx.narrative.context,
      outcome: outcome.narrative,
    });
    // TWO ids, never the narrative or the context — see the field's docstring.
    outcome.narrativeReport = { reportId, reportRunId };
    return null;
  } catch (error) {
    if (error instanceof NarrativePersistConflictError) {
      // A race that resolved correctly (another executor linked an artifact,
      // or the run moved) — logged at warn, not error, and given its own code
      // so it is distinguishable from a genuine write failure on the run row.
      console.warn('[aiAgentRunLoop] narrative artifact was not linked to this run', {
        runId: ctx.run.id, reason: (error as Error).message,
      });
      return 'narrative_persist_conflict';
    }
    console.error('[aiAgentRunLoop] failed to persist the narrative report', { runId: ctx.run.id, error });
    return 'narrative_persist_failed';
  }
}

/**
 * Phase 2 wave P2-4 (ticket triage, #4191), Task A8 — the triage sibling of
 * `finalizeVerdict`/`finalizeSweep`/`finalizeNarrative` above, called from
 * the SAME place in `executeAgentRun` and outside any ambient DB context
 * (`persistTicketTriage` inherits `createActionIntent`'s no-ambient-context
 * precondition; see `sweepFindings.ts`/`alertVerdicts.ts` headers).
 *
 * Returns an errorCode override the caller applies ONLY on the
 * normal-finish path, exactly as its three siblings do.
 *
 * A triage run that reached a normal finish without ever calling
 * `submit_ticket_proposal` is treated like a verdict run's missing verdict,
 * not like a sweep's legitimate "found nothing": the prompt tells the model
 * to call its one outcome tool exactly once (`runnerPrompt.ts`), so a run
 * that never did is a runner failure a human needs to see, not a silent
 * `completed`.
 */
export async function finalizeTicketTriage(ctx: RunContext, result: LoopResult): Promise<string | null> {
  if (!isTriageProfile(ctx.run)) return null;
  const { outcome } = result;

  if (!outcome.ticketProposal) return 'ticket_proposal_missing';

  // Defensive, mirroring `finalizeNarrative`'s `ctx.narrative?.scheduleId`
  // check: a `triage`-profile run is admitted with `triggerKind: 'ticket'`
  // and a `ticketId` by construction (wave 6 PR 3), but this is the one
  // place a violated invariant would otherwise NPE deep inside
  // `persistTicketTriage` instead of surfacing a clear error code.
  if (ctx.run.triggerKind !== 'ticket' || !ctx.run.ticketId) {
    console.warn('[aiAgentRunLoop] triage run carries no ticket scope — not persisting its proposal', {
      runId: ctx.run.id, orgId: ctx.run.orgId, triggerKind: ctx.run.triggerKind,
    });
    return 'ticket_triage_scope_missing';
  }

  // Same IMPORTANT-4 re-read every sibling carries: the stall reaper
  // (`reapStalledAgentRuns`) or a second executor may have moved this run
  // out of `running` while the SDK loop was in flight. Skip persistence
  // rather than mint live, human-or-autonomy-decided intents under a run
  // nobody owns anymore.
  const stillRunning = await isRunStillRunning(ctx.run.id, ctx.run.orgId);
  if (!stillRunning) {
    console.warn('[aiAgentRunLoop] skipped ticket-triage persistence — run left `running` before it could be persisted', {
      runId: ctx.run.id,
    });
    return null;
  }

  try {
    const { intentIds, approvedIntentIds, skipped } = await persistTicketTriage(
      {
        id: ctx.run.id,
        orgId: ctx.run.orgId,
        agentId: ctx.run.agentId,
        ticketId: ctx.run.ticketId,
        // The run's IMMUTABLE start-of-run snapshot — gate 2 of the
        // advisory autonomy check (see `ticketTriageFindings.ts`'s header).
        policySnapshot: ctx.run.policySnapshot,
        // The AGENT's action cap — a triage run's ONE deliberate divergence
        // from its siblings' hard-zeroed `maxActionsPerRun` (see
        // `triageLimits`'s docstring): this is a POST-run minting cap, not
        // an in-run tool-call budget. `??` tolerates a pre-v8 snapshot.
        maxActionsPerRun:
          ctx.run.policySnapshot.effective.limits.maxActionsPerRun
          ?? AI_AGENT_LIMIT_DEFAULTS.maxActionsPerRun,
      },
      outcome.ticketProposal,
      result.agentAuth,
    );
    for (const intentId of intentIds) result.intentIds.push(intentId);
    // GROUND TRUTH, not the call-level `autonomous` advisory flag (review
    // fix, round 2): `approvedIntentIds` is built per-intent from each
    // intent's OWN returned status inside `persistTicketTriage` — the live
    // gates can flip between two sequential `createActionIntent` calls in
    // that same invocation, so a uniform "autonomous ⇒ every id is decided"
    // read would wrongly classify a run where one intent lands `approved`
    // and the next lands `pending_approval`. See
    // `classifyIntentAwaitingApproval`'s docstring for how this is used.
    if (approvedIntentIds.length > 0) {
      result.decidedIntentIds = [...(result.decidedIntentIds ?? []), ...approvedIntentIds];
    }
    if (skipped.length > 0) {
      // Issue #4462: previously logged only — never reached `result.outcome`,
      // so `finishRun`'s persisted `outcome` jsonb (and everything derived
      // from it, including the run DTO) never carried it. Same direct-mutate
      // pattern as `outcome.alertVerdictIntent` above.
      outcome.ticketTriageSkipped = skipped;
      console.info('[aiAgentRunLoop] ticket-triage proposal partially skipped', {
        runId: ctx.run.id, skipped,
      });
    }
    return null;
  } catch (error) {
    console.error('[aiAgentRunLoop] failed to persist the ticket-triage proposal', { runId: ctx.run.id, error });
    return 'ticket_triage_persist_failed';
  }
}

/** IMPORTANT 4 helper — see `finalizeVerdict`. System-scoped: this runs from
 *  the background run loop, with no ambient request context. */
async function isRunStillRunning(runId: string, orgId: string): Promise<boolean> {
  return inSystemDbContext(async () => {
    const [row] = await db.select({ status: aiAgentRuns.status }).from(aiAgentRuns)
      .where(and(eq(aiAgentRuns.id, runId), eq(aiAgentRuns.orgId, orgId)))
      .limit(1);
    return row?.status === 'running';
  });
}
