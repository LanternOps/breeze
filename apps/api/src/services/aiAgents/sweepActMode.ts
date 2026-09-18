// apps/api/src/services/aiAgents/sweepActMode.ts
/**
 * #4442 W04 — the schedule act-mode brake, in one place.
 *
 * Act mode is armed on a partner BASELINE and can be disarmed by an org
 * OVERRIDE (three-valued, tighten-only — see `effectiveSchedule`). Two moments
 * need the answer and must not drift:
 *
 *  - CREATION (`sweepFindings.ts`): may this occurrence's proposals reach the
 *    policy-decide lane at all?
 *  - RELEASE (`revalidateRelease.ts`): is the schedule STILL armed? Replacing
 *    the creation gate cannot revoke an intent that is already `approved`;
 *    only a release-time re-read can. This is the ordinary brake an operator
 *    reaches for — flipping `act_mode` off must stop work already authorized
 *    but not yet released, exactly as flipping
 *    `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED` off does.
 *
 * Everything unresolved is NOT ARMED: no schedule id, a deleted baseline, a
 * missing run, the sub-flag off. A grant of unattended Tier-3 execution is
 * never inferred from a failed lookup.
 *
 * PRECONDITION: callers must not already hold a non-system DB context —
 * `inSystemDbContext` skips re-entry when the ambient context is already
 * system and otherwise opens its own, matching every other module here.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { parseSweepTriggerKey } from '@breeze/shared';

import { sweepActEnabled } from '../../config/env';
import {
  db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext,
} from '../../db';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { aiAgentSchedules } from '../../db/schema/aiAgentSchedules';
import { effectiveSchedule } from './scheduleMerge';
import { isActEligibleSweepKind, probeSweepSubject } from './sweepSubjectProbe';

/** Same skip-if-already-system shape as the rest of this directory. */
function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

/**
 * The EFFECTIVE (partner baseline ∧ org override) act mode for one schedule.
 *
 * `scheduleId` is the partner BASELINE — the sweeper ticks baselines only
 * (`loadDueBaselines` filters `org_id IS NULL`) and stamps that id onto the
 * run — so the org's override is a second, separate read.
 */
export async function resolveEffectiveScheduleActMode(
  scheduleId: string | null,
  orgId: string,
): Promise<boolean> {
  if (!sweepActEnabled() || !scheduleId) return false;

  return inSystemDbContext(async () => {
    const [baseline] = await db
      .select({ id: aiAgentSchedules.id, actMode: aiAgentSchedules.actMode })
      .from(aiAgentSchedules)
      .where(and(eq(aiAgentSchedules.id, scheduleId), isNull(aiAgentSchedules.orgId)))
      .limit(1);
    // A deleted (or never-partner-owned) baseline is a refusal, not a
    // "no schedule, no objection".
    if (!baseline) return false;

    const [override] = await db
      .select({ id: aiAgentSchedules.id, actMode: aiAgentSchedules.actMode })
      .from(aiAgentSchedules)
      .where(and(
        eq(aiAgentSchedules.orgId, orgId),
        eq(aiAgentSchedules.baselineScheduleId, scheduleId),
      ))
      .limit(1);

    // `effectiveSchedule` owns the truth table — never a second hand-rolled
    // copy of it. `enabled`/`sweepKinds` are inert here: this asks about act
    // mode only, and whether the schedule was enabled for this occurrence was
    // settled by the sweeper before the run existed.
    return effectiveSchedule(
      { enabled: true, sweepKinds: [], actMode: baseline.actMode },
      override ? { enabled: true, sweepKinds: [], actMode: override.actMode } : null,
    ).actMode;
  });
}

/**
 * The RELEASE-time brake for one already-authorized sweep intent. Resolves the
 * intent's run to its schedule and re-applies `resolveEffectiveScheduleActMode`.
 *
 * Scoped by the caller to POLICY-decided sweep intents: a sweep card a HUMAN
 * approved is a human decision, not policy autonomy, and is not subject to
 * this brake.
 */
export async function checkSweepScheduleBrake(
  intent: { requestingAgentRunId: string | null; orgId: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!sweepActEnabled()) {
    return { ok: false, reason: 'sweep act mode is disabled' };
  }
  if (!intent.requestingAgentRunId) {
    return { ok: false, reason: 'sweep intent has no originating run' };
  }

  const runId = intent.requestingAgentRunId;
  const scheduleId = await inSystemDbContext(async () => {
    const [run] = await db
      .select({ scheduleId: aiAgentRuns.scheduleId, orgId: aiAgentRuns.orgId })
      .from(aiAgentRuns)
      .where(eq(aiAgentRuns.id, runId))
      .limit(1);
    // A run that has vanished, or that belongs to another org, cannot vouch
    // for this intent.
    if (!run || run.orgId !== intent.orgId) return null;
    return run.scheduleId;
  });

  if (!scheduleId) return { ok: false, reason: 'sweep schedule is unresolvable' };

  const armed = await resolveEffectiveScheduleActMode(scheduleId, intent.orgId);
  return armed ? { ok: true } : { ok: false, reason: 'sweep act mode is no longer armed for this organization' };
}

/**
 * #4442 W04 — the DECIDE-TIME gate for a sweep-minted intent: freshness plus a
 * LIVE re-evaluation of the condition the finding was about.
 *
 * Lives here rather than inline in `policyDecide.ts` because that file is
 * bound by the "no safety bypass" contract (`verdictProfile.contract.test.ts`):
 * none of the four safety-critical files may special-case a run profile, and
 * the contract is enforced textually, on the source. The evaluation is a
 * property of the INTENT's trigger rather than the run's profile, but keeping
 * the sweep vocabulary out of that file entirely is the cheaper and clearer
 * way to satisfy it — `policyDecide.ts` asks one generic question and acts on
 * the answer.
 *
 * Returns `null` when the intent is not sweep-minted (the caller then takes no
 * new branch at all), or the `DegradeReason` string the caller must degrade
 * with. Never authorizes anything itself.
 */
export type SweepDecideRefusal =
  | 'sweep_intent_stale'
  | 'sweep_condition_cleared'
  | 'sweep_condition_unknown'
  | 'sweep_subject_unresolvable';

/**
 * How old a sweep-minted intent may be and still be auto-executed.
 *
 * 30 minutes, which is <= the schedule's own cadence by construction: the
 * create/update schemas pin sweep crons to a literal minute field
 * (`isHourlyFloorCron`), so a sweep fires at most once an hour and a stale
 * intent can never outlive the next occurrence's fresh view of the same
 * subject. It matches `SWEEP_PROBE_FRESHNESS_MS` (`sweepSubjectProbe.ts`) on
 * purpose: the two windows answer the same question from opposite ends — how
 * old may the INTENT be, and how old may the OBSERVATION be.
 */
export const SWEEP_ACT_TTL_MS = 30 * 60_000;

export async function evaluateSweepDecideGate(intent: {
  triggerKind: string | null;
  triggerKey: string | null;
  scopeDeviceId: string | null;
  orgId: string;
  createdAt: Date;
}): Promise<SweepDecideRefusal | null> {
  if (intent.triggerKind !== 'sweep_finding') return null;

  const subject = parseSweepTriggerKey(intent.triggerKey);
  const kind = subject?.kind;
  // `isActEligibleSweepKind` is the single source of truth for which kinds
  // have a probe at all (W02). A kind with none can never be re-verified, so
  // it is unresolvable here rather than silently skipping the lane.
  if (!subject || kind === undefined || !isActEligibleSweepKind(kind) || !intent.scopeDeviceId) {
    return 'sweep_subject_unresolvable';
  }

  // Freshness anchors on the INTENT and on the probe's own observation window,
  // NOT on run.finished_at: a sweep intent is minted inside `finalizeSweep`,
  // which runs BEFORE `finishRun` writes finished_at, and the decide attempt is
  // reached from createActionIntent's post-commit trigger — so run.finished_at
  // is null at exactly the moment this would read it.
  if (Date.now() - intent.createdAt.getTime() > SWEEP_ACT_TTL_MS) return 'sweep_intent_stale';

  // The probe opens NO DB context of its own (documented precondition), and
  // the caller reaches this from a deliberately CONTEXTLESS stack — without
  // this wrapper the read runs under no RLS context, which is a DENY, and
  // every sweep intent degrades `sweep_condition_unknown`: fail-closed, silent
  // and with the whole lane dead. It is also deliberately OUTSIDE the
  // authorize transaction's advisory lock: this is a read, and holding the
  // per-org lock across it would serialise every org's authorizations behind a
  // network round trip.
  //
  // `probeSweepSubject` never throws — a query failure is captured and graded
  // `unknown` (W02's own contract) — so a transient fault lands on the
  // fail-closed side rather than authorizing.
  const verdict = await inSystemDbContext(() => probeSweepSubject(
    kind,
    intent.orgId,
    intent.scopeDeviceId!,
    subject.subjectKey,
  ));
  // A CLEARED condition writes no evidence row: recovery is not a failed
  // remediation, and crediting one would corrupt the graduation ladder in the
  // opposite direction (spec §3.4).
  if (verdict === 'cleared') return 'sweep_condition_cleared';
  if (verdict !== 'present') return 'sweep_condition_unknown';
  return null;
}
