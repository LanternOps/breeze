/**
 * Wisp W05b Task 6 — `finalizeAssessment`, the post-run step that turns an
 * `assessment`-profile run's captured outcome-tool calls into durable effects
 * (W05 plan Task 6 + Task 15; Wisp design §7.2–7.4). A sibling of
 * `runFinalizers.ts` (already > 600 lines) and re-exported from there; called
 * from the same row of `executeAgentRun` as `finalizeTicketTriage`, outside
 * any ambient DB context (`createActionIntent`'s precondition).
 *
 * Order (plan-fixed), each step and each item independently try/caught so a
 * failure never loses another step's work (a failed nudge must not lose a
 * raised concern):
 *   1. record_concern  → upsertConcern (≤ ASSESSMENT_MAX_RAISES_PER_RUN, else `raise_cap`),
 *                        carrying the normalised `pattern` the same-org
 *                        rollup groups by (#11426)
 *   2. update_concern  → updateConcern / resolveConcern
 *   3. nudge           → notifyUser to the grantor (W06: in-app via deliverInApp,
 *                        push, quiet hours, prefs; it counts the nudge itself),
 *                        unless the recipient state says not to
 *   4. propose_action  → createActionIntent (Tier 2/3 only, capped)
 *   5. request_specialist — left in the outcome untouched (W07)
 *   then the readiness note (Task 15; re-evaluated every run, #11429), the
 *   `last_assessed_run_id` touch of every non-readiness concern the run
 *   read, and the best-effort partner rollup.
 *
 * Authority: every concern id in the outcome is MODEL-SUPPLIED. Steps 2–4
 * re-read the concern under the grant's live ceiling (`getConcernForCeiling`,
 * existence-neutral) and refuse anything not in `run.orgId` under the run's
 * partner (`concern_not_in_org`). The live ceiling is resolved first, always:
 * a grant that went inactive while the run was in flight (`grant_inactive`),
 * a run org that left the ceiling or is now site-restricted
 * (`grant_org_out_of_ceiling`), or a ceiling that could not be read
 * (`ceiling_read_failed`, which also returns `assessment_partially_applied`)
 * writes nothing — no model call, no readiness concern, no touch. Only the
 * rollup still runs; it resolves its own ceiling and fails closed. Nothing
 * here publishes an event.
 */
import { and, eq } from 'drizzle-orm';
import {
  AI_AGENT_LIMIT_DEFAULTS,
  CONCERN_PATTERN_EVIDENCE_KEY,
  CONCERN_SUMMARY_MAX,
  normalizeConcernPattern,
  type AssessmentOutcome,
  type Concern,
  type NudgeInput,
  type ProposeActionInput,
  type RaiseConcernInput,
  type UpdateConcernInput,
} from '@breeze/shared';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { createActionIntent } from '../actionIntents/intentService';
import { checkGuardrails } from '../aiGuardrails';
import { AGENT_COORDINATOR_CARRIER_TOOLS, HUMAN_ONLY_TOOLS } from '../aiToolExposure';
import { captureException } from '../sentry';
import { assessableOrgIds } from '../wisp/assessableOrgs';
import { rollupPartnerPicture } from '../wisp/assessment';
import {
  ConcernSubjectHeldError,
  getConcernForCeiling,
  resolveConcern,
  setConcernPattern,
  updateConcern,
  upsertConcern,
} from '../wisp/concerns';
import {
  CeilingViolationError,
  GrantInactiveError,
  assertWithinCeiling,
  resolveGrantCeiling,
  type GrantCeiling,
} from '../wisp/grantAuthority';
import { mobileDeepLink } from '../wisp/nudgeLinks';
import { notifyUser } from '../wisp/notifyUser';
import { renderReadinessSummary, type ReadinessCheck } from '../wisp/readiness';
import { evaluateStandingInstructions, standingConflictDescription } from '../wisp/standingInstructionGate';
import { isAssessmentProfile } from './assessmentProfile';
import type { AssessmentRunContext, LoopResult, RunContext } from './runLoopTypes';

/** record_concern calls applied per run; the rest are skipped with `raise_cap`. */
export const ASSESSMENT_MAX_RAISES_PER_RUN = 10;

/** The evidence key `propose_action({ concernId })` owns; never model-writable. */
const APPROVAL_INTENT_KEY = 'approvalIntentId';

const EMPTY_OUTCOME: AssessmentOutcome = {
  concernsRaised: [], concernsUpdated: [], nudges: [], proposedActions: [], specialistRequests: [],
};

/** Same skip-if-already-system shape as runFinalizers.ts's local copy (kept local to avoid an import cycle). */
function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

/** The stall reaper or a second executor may have moved the run on; never write under a run nobody owns. */
async function isRunStillRunning(runId: string, orgId: string): Promise<boolean> {
  return inSystemDbContext(async () => {
    const [row] = await db.select({ status: aiAgentRuns.status }).from(aiAgentRuns)
      .where(and(eq(aiAgentRuns.id, runId), eq(aiAgentRuns.orgId, orgId)))
      .limit(1);
    return row?.status === 'running';
  });
}

/**
 * Model evidence minus the server-owned keys: the approval card
 * `propose_action` mints, and the rollup pattern (#11426), which only the
 * `pattern` field sets, normalised.
 */
function withoutApprovalKey(evidence: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!evidence) return {};
  const { [APPROVAL_INTENT_KEY]: _dropped, [CONCERN_PATTERN_EVIDENCE_KEY]: _pattern, ...rest } = evidence;
  return rest;
}

function isFuture(iso: string | null | undefined, now: Date): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t > now.getTime();
}

type Applier = {
  ctx: RunContext;
  a: AssessmentRunContext;
  grantId: string;
  result: LoopResult;
  ceiling: GrantCeiling;
  skipped: string[];
  item: (step: string, fn: () => Promise<void>) => Promise<void>;
  /** Concerns already stamped with this run id by an update — the final touch skips them. */
  touched: Set<string>;
  now: Date;
};

/** A model-named concern, re-read under the ceiling and pinned to the run's org + partner; null = refuse. */
async function ownConcern(ap: Applier, concernId: string): Promise<Concern | null> {
  const c = await getConcernForCeiling(ap.ceiling, concernId);
  if (!c || c.orgId !== ap.ctx.run.orgId || c.partnerId !== ap.ctx.orgPartnerId) return null;
  return c;
}

async function applyRaises(ap: Applier, raises: RaiseConcernInput[]): Promise<void> {
  const { run } = ap.ctx;
  for (const [index, raise] of raises.entries()) {
    if (index >= ASSESSMENT_MAX_RAISES_PER_RUN) {
      ap.skipped.push('raise_cap');
      continue;
    }
    // An org subject names the org itself; it can only be the run's org.
    if (raise.subject.kind === 'org' && raise.subject.id !== run.orgId) {
      ap.skipped.push('raise_subject_not_in_org');
      continue;
    }
    const pattern = normalizeConcernPattern(raise.pattern);
    await ap.item('record_concern', async () => {
      const { id, created } = await upsertConcern({
        partnerId: ap.ctx.orgPartnerId,
        orgId: run.orgId,
        subject: raise.subject,
        summary: raise.summary,
        severity: raise.severity,
        evidence: withoutApprovalKey(raise.evidence),
        raisedByGrantId: ap.grantId,
        lastAssessedRunId: run.id,
        ...(pattern ? { pattern } : {}),
      });
      // A re-raise hands back the live concern untouched; the pattern is the
      // one thing it may gain, so a concern raised before #11426 (or before
      // the model named the pattern) joins its siblings' rollup.
      if (!created && pattern) await setConcernPattern(id, pattern);
    });
  }
}

async function applyUpdates(ap: Applier, updates: UpdateConcernInput[]): Promise<void> {
  for (const update of updates) {
    await ap.item('update_concern', async () => {
      const c = await ownConcern(ap, update.concernId);
      if (!c) {
        ap.skipped.push('concern_not_in_org');
        return;
      }
      const patch: Parameters<typeof updateConcern>[1] = {};
      if (update.summary !== undefined) patch.summary = update.summary;
      if (update.severity !== undefined) patch.severity = update.severity;
      if (update.evidence !== undefined) {
        // updateConcern REPLACES evidence: keep the approval card the concern
        // already points at and its rollup pattern (#11426), and never let the
        // model forge either.
        const pattern = c.evidence?.[CONCERN_PATTERN_EVIDENCE_KEY];
        patch.evidence = {
          ...withoutApprovalKey(update.evidence),
          ...(typeof pattern === 'string' ? { [CONCERN_PATTERN_EVIDENCE_KEY]: pattern } : {}),
          ...(c.approvalIntentId ? { [APPROVAL_INTENT_KEY]: c.approvalIntentId } : {}),
        };
      }
      if (Object.keys(patch).length > 0) {
        await updateConcern(c.id, { ...patch, lastAssessedRunId: ap.ctx.run.id });
        ap.touched.add(c.id);
      }
      if (update.status === 'resolved' && update.outcome !== undefined) {
        await resolveConcern(c.id, { grantId: ap.grantId }, update.outcome);
      }
    });
  }
}

async function applyNudges(ap: Applier, nudges: NudgeInput[]): Promise<void> {
  for (const nudge of nudges) {
    await ap.item('nudge', async () => {
      const c = await ownConcern(ap, nudge.concernId);
      if (!c) {
        ap.skipped.push('concern_not_in_org');
        return;
      }
      const r = c.recipient;
      if (c.status !== 'open' && c.status !== 'snoozed') {
        ap.skipped.push('nudge_concern_closed');
        return;
      }
      if (r?.dismissedAt) {
        ap.skipped.push('nudge_dismissed');
        return;
      }
      if (isFuture(r?.snoozedUntil, ap.now)) {
        ap.skipped.push('nudge_snoozed');
        return;
      }
      if (isFuture(r?.nextEligibleNudgeAt, ap.now)) {
        ap.skipped.push('nudge_backoff');
        return;
      }
      if (r?.digestOnly) {
        ap.skipped.push('nudge_digest_only');
        return;
      }
      // A model-supplied card id is trusted only when it is the concern's own
      // card or one this run minted; otherwise the concern's card (or none).
      const approvalIntentId = nudge.approvalIntentId
        && (nudge.approvalIntentId === c.approvalIntentId || ap.result.intentIds.includes(nudge.approvalIntentId))
        ? nudge.approvalIntentId
        : c.approvalIntentId;
      // W06 Task 4: one delivery primitive. notifyUser re-checks the backoff
      // under its own read, writes the in-app row (dedupe key per backoff
      // window), pushes, and counts the nudge (recordNudge) itself.
      const res = await notifyUser({
        userId: ap.a.grantorUserId,
        category: 'wisp_nudge',
        kind: 'concern',
        title: 'Wisp: ' + c.summary.slice(0, 80),
        body: nudge.nextStep,
        deepLink: mobileDeepLink(ap.a.threadId, c.id),
        concernId: c.id,
        approvalIntentId,
        threadId: ap.a.threadId,
        grantId: ap.grantId,
      });
      if (!res.inApp && res.pushed === 0 && res.suppressed === 'backoff') ap.skipped.push('nudge_backoff');
    });
  }
}

async function applyProposals(ap: Applier, proposals: ProposeActionInput[]): Promise<void> {
  const { run } = ap.ctx;
  let attempted = 0;
  for (const proposal of proposals) {
    await ap.item('propose_action', async () => {
      if (attempted >= AI_AGENT_LIMIT_DEFAULTS.maxActionsPerRun) {
        ap.skipped.push('propose_cap');
        return;
      }
      let c: Concern | null = null;
      if (proposal.concernId) {
        c = await ownConcern(ap, proposal.concernId);
        if (!c) {
          ap.skipped.push('concern_not_in_org');
          return;
        }
      }
      // Effective tier (base tier + the action-level escalation of
      // multiplexed tools): an assessment proposes Tier 2/3 only.
      const { tier } = checkGuardrails(proposal.toolName, proposal.input);
      if (tier <= 1) {
        ap.skipped.push('propose_tier1_refused');
        return;
      }
      // Human-only tools are never proposable — in particular the Wisp
      // approval carrier, which only the coordinator mints (W07).
      if (tier >= 4 || HUMAN_ONLY_TOOLS.has(proposal.toolName) || AGENT_COORDINATOR_CARRIER_TOOLS.has(proposal.toolName)) {
        ap.skipped.push('propose_tool_blocked');
        return;
      }
      // Tool-level ceiling term up front (never-delegable / outside the
      // grant's allowlist); org, site and permission terms are re-checked at
      // release by agentReleaseAuthority.
      try {
        assertWithinCeiling(ap.ceiling, { toolName: proposal.toolName });
      } catch (error) {
        if (error instanceof CeilingViolationError) {
          ap.skipped.push('propose_outside_ceiling');
          return;
        }
        throw error;
      }
      // #10428 W06: the grantor's standing instructions. A confirmed exact
      // deny drops the proposal; any other match rides on the card's reason.
      // A check that cannot run drops it too (fails closed).
      let standingText: string | null = null;
      try {
        const standing = await evaluateStandingInstructions({
          ceiling: ap.ceiling,
          toolName: proposal.toolName,
          input: proposal.input,
          auth: ap.result.agentAuth,
        });
        if (standing.action === 'refuse') {
          ap.skipped.push('propose_standing_instruction');
          return;
        }
        if (standing.action === 'warn') standingText = standing.text;
      } catch (error) {
        console.error('[assessmentFinalizer] standing-instruction check failed; proposal dropped', { runId: run.id, toolName: proposal.toolName, error });
        captureException(error instanceof Error ? error : new Error(String(error)));
        ap.skipped.push('propose_standing_instruction_unverified');
        return;
      }
      attempted += 1;
      const reason = `Proposed by Wisp assessment ${run.id}: ${proposal.reason}`;
      const intent = await createActionIntent(ap.result.agentAuth, {
        toolName: proposal.toolName,
        input: proposal.input,
        source: 'ai_agent',
        orgId: run.orgId,
        reason: standingText ? standingConflictDescription(standingText, reason) : reason,
      });
      if (intent.status === 'pending_approval') {
        ap.result.intentIds.push(intent.id);
      } else if (intent.status === 'approved') {
        // Policy-decided at creation: counted, but nobody waits on it.
        // Unreachable for assessments today — runService admits every
        // assessment run with `modeAtStart: 'shadow'`, so intentService never
        // treats its intents as policy-decidable. Kept so a future change to
        // that downgrade cannot leave an approved intent uncounted.
        ap.result.intentIds.push(intent.id);
        ap.result.decidedIntentIds = [...(ap.result.decidedIntentIds ?? []), intent.id];
      } else {
        ap.skipped.push('propose_intent_not_pending');
        return;
      }
      if (c) {
        await updateConcern(c.id, { evidence: { ...c.evidence, [APPROVAL_INTENT_KEY]: intent.id } });
      }
    });
  }
}

/** The outcome on a readiness note closed because every check became serviceable (#11429). */
const READINESS_SERVICEABLE_OUTCOME = 'all_checks_serviceable';

type ReadinessEvidence = { checks: ReadinessCheck[]; missingIntegrations: string[] };

/**
 * Whether the live note already says what this run would write. Compared by
 * value, never as raw JSON: jsonb does not keep the key order it was written
 * in. A stored shape this code did not write reads as changed.
 */
function readinessNoteUnchanged(live: Concern, summary: string, next: ReadinessEvidence): boolean {
  if (live.summary !== summary.trim()) return false;
  const stored = live.evidence.readiness as Partial<ReadinessEvidence> | undefined;
  if (!stored || !Array.isArray(stored.checks) || !Array.isArray(stored.missingIntegrations)) return false;
  const key = (r: ReadinessEvidence) => JSON.stringify([
    r.checks.map((c) => [c?.watchKind ?? null, c?.serviceable ?? null, c?.reason ?? null]),
    r.missingIntegrations,
  ]);
  return key(stored as ReadinessEvidence) === key(next);
}

/**
 * Task 15 — the "what I can / cannot watch here" concern, one per org
 * (signature-keyed). Its subject is `readiness`, never `org` (#10386): the org
 * slot belongs to real org-level concerns.
 *
 * #11429: re-evaluated on every run, not only onboarding. Every check
 * serviceable closes the live note; otherwise a later run refreshes it only
 * when its gaps changed (a write bumps `updated_at`, which the brief and the
 * no-changes probe read) and never re-creates one: only a first look (an
 * onboarding run, or an on-demand run with no earlier assessment) creates
 * it, so a note the user dismissed stays dismissed. No inventory for
 * the org this run (`readiness: null`) leaves the note as it is. A later run
 * acts on the live note it read (`openConcerns`), the same snapshot the touch
 * loop uses.
 */
async function applyReadiness(ctx: RunContext, a: AssessmentRunContext, grantId: string, skipped: string[]): Promise<void> {
  const readiness = a.readiness;
  if (!readiness) return;
  const { run } = ctx;
  const signature = `readiness:${run.orgId}`;
  const live = a.openConcerns.find((c) =>
    c.signature === signature && c.orgId === run.orgId && c.partnerId === ctx.orgPartnerId);

  if (readiness.checks.every((c) => c.serviceable)) {
    if (!live) return;
    // Stamp first: the close then reads as this run's own write, which the
    // next tick's no-changes probe does not count as news. A resolve that
    // fails after the stamp marks the run partially applied, which the probe
    // does not anchor on, so the next run retries it.
    await updateConcern(live.id, { lastAssessedRunId: run.id });
    // No grant: system bookkeeping, no concern_outcome memory block.
    await resolveConcern(live.id, {}, READINESS_SERVICEABLE_OUTCOME);
    return;
  }

  const summary = renderReadinessSummary(readiness).slice(0, CONCERN_SUMMARY_MAX);
  const next: ReadinessEvidence = { checks: readiness.checks, missingIntegrations: readiness.missingIntegrations };
  // Only a first look creates the note: an onboarding run, or an on-demand run
  // (#10406) for an org this grant has never assessed — one asked for before
  // any assessment, or one that took over a queued onboarding job (wake.ts).
  const createsNote = a.reason.kind === 'onboarding' || (a.reason.kind === 'on_demand' && a.noEarlierAssessment);
  if (!createsNote) {
    if (!live || readinessNoteUnchanged(live, summary, next)) return;
    // updateConcern replaces evidence: keep what else the note carries (its approval card).
    await updateConcern(live.id, { summary, evidence: { ...live.evidence, readiness: next }, lastAssessedRunId: run.id });
    return;
  }

  const evidence = { readiness: next };
  let upserted: { id: string; created: boolean };
  try {
    upserted = await upsertConcern({
      partnerId: ctx.orgPartnerId,
      orgId: run.orgId,
      subject: { kind: 'readiness', id: run.orgId },
      severity: 'info',
      signature: `readiness:${run.orgId}`,
      summary,
      evidence,
      raisedByGrantId: grantId,
      lastAssessedRunId: run.id,
    });
  } catch (error) {
    // The other readiness note (no effective agent) still holds the slot:
    // leave it; it is not this note to refresh.
    if (error instanceof ConcernSubjectHeldError) {
      skipped.push('readiness_slot_held');
      return;
    }
    throw error;
  }
  // A re-run (or a later onboarding) refreshes the live one instead of duplicating it.
  if (!upserted.created) await updateConcern(upserted.id, { summary, evidence, lastAssessedRunId: run.id });
}

/**
 * Returns `null` on a clean apply (skips are not failures — they are recorded
 * in `outcome.assessmentSkipped`), or `assessment_partially_applied` when at
 * least one step threw. Like every sibling, the caller applies it only on the
 * normal-finish path; an assessment is circuit-neutral either way.
 */
export async function finalizeAssessment(ctx: RunContext, result: LoopResult): Promise<string | null> {
  if (!isAssessmentProfile(ctx.run)) return null;
  const { run } = ctx;
  const a = ctx.assessment;
  const grantId = run.grantId;
  if (!a || !grantId || !run.grantRevisionId) {
    // Unreachable through executeAgentRun (a null context skips the run before
    // the model); defensive, like finalizeTicketTriage's scope check.
    console.warn('[aiAgentRunLoop] assessment run reached finalize without its grant context', { runId: run.id });
    return 'assessment_context_missing';
  }
  if (!(await isRunStillRunning(run.id, run.orgId))) {
    console.warn('[aiAgentRunLoop] skipped assessment finalize — run left `running` first', { runId: run.id });
    return null;
  }

  const outcome = result.outcome;
  const calls = outcome.assessment ?? EMPTY_OUTCOME;
  const skipped: string[] = [];
  let failed = false;
  const item = async (step: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (error) {
      failed = true;
      console.error('[aiAgentRunLoop] assessment finalize step failed', { runId: run.id, step, error });
      captureException(error, undefined, { service: 'aiAgents', operation: `finalizeAssessment.${step}`, runId: run.id });
    }
  };

  const modelCalls = calls.concernsRaised.length + calls.concernsUpdated.length
    + calls.nudges.length + calls.proposedActions.length;
  const touched = new Set<string>();

  // The grant's live ceiling gates EVERY write below — model calls, the
  // readiness concern and the touch — so it is resolved even when the model
  // called nothing. `blocked` names why nothing may be written: the grant went
  // inactive (or paused) mid-run, the run's org left the ceiling (or is now
  // reached only through a site restriction — the assessableOrgIds rule
  // admission applied), or the ceiling could not be read at all.
  let ceiling: GrantCeiling | null = null;
  let blocked: 'grant_inactive' | 'grant_org_out_of_ceiling' | 'ceiling_read_failed' | null = null;
  try {
    ceiling = await resolveGrantCeiling(grantId, run.grantRevisionId);
    if (!assessableOrgIds(ceiling).has(run.orgId)) blocked = 'grant_org_out_of_ceiling';
  } catch (error) {
    if (error instanceof GrantInactiveError) {
      blocked = 'grant_inactive';
    } else {
      // Not the grant's state: we do not know whether the run may write, so
      // nothing is written and the run reports dropped work.
      blocked = 'ceiling_read_failed';
      failed = true;
      console.error('[aiAgentRunLoop] assessment ceiling read failed', { runId: run.id, grantId, error });
      captureException(error, undefined, { service: 'aiAgents', operation: 'finalizeAssessment.ceiling', runId: run.id });
    }
  }

  if (blocked !== null || !ceiling) {
    // One entry per model call; a failed read is recorded even with none, so
    // the skipped bookkeeping is visible on the run.
    const n = blocked === 'ceiling_read_failed' ? Math.max(modelCalls, 1) : modelCalls;
    for (let i = 0; i < n; i += 1) skipped.push(blocked ?? 'grant_inactive');
  } else {
    if (modelCalls > 0) {
      const ap: Applier = { ctx, a, grantId, result, ceiling, skipped, item, touched, now: new Date() };
      await applyRaises(ap, calls.concernsRaised);
      await applyUpdates(ap, calls.concernsUpdated);
      // Proposals BEFORE nudges (deliberate departure from the plan's step
      // order): a nudge about a concern this run also proposed an action for
      // must carry the card it just minted (spec §7.4 "the nudge carries the
      // approval card id"); the other order could never link them.
      await applyProposals(ap, calls.proposedActions);
      await applyNudges(ap, calls.nudges);
      // (5) request_specialist: left in `outcome.assessment.specialistRequests` for W07.
    }

    await item('readiness', () => applyReadiness(ctx, a, grantId, skipped));

    for (const c of a.openConcerns) {
      // #11429: readiness-subject notes are written by their owners only (the
      // onboarding note by applyReadiness, the no-agent note by admission); a
      // touch here would bump updated_at every run with nothing new to say.
      if (c.orgId !== run.orgId || touched.has(c.id) || c.subject.kind === 'readiness') continue;
      await item('touch', () => updateConcern(c.id, { lastAssessedRunId: run.id }));
    }
  }

  try {
    await rollupPartnerPicture(grantId);
  } catch (error) {
    // Best-effort: the next assessment (or chat turn) rebuilds the picture.
    console.warn('[aiAgentRunLoop] partner rollup failed after assessment (non-fatal)', { runId: run.id, grantId, error });
  }

  if (skipped.length > 0) {
    outcome.assessmentSkipped = [...(outcome.assessmentSkipped ?? []), ...skipped];
    console.info('[aiAgentRunLoop] assessment outcome partially skipped', { runId: run.id, skipped });
  }
  return failed ? 'assessment_partially_applied' : null;
}
