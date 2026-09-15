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

import { sweepActEnabled } from '../../config/env';
import {
  db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext,
} from '../../db';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { aiAgentSchedules } from '../../db/schema/aiAgentSchedules';
import { effectiveSchedule } from './scheduleService';

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
