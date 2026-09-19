/**
 * Typed criterion evaluation for AI Operator tasks (#5205 W06), spec §8.1,
 * baseline §2.7, contradictions C9/C10/C11.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE: a dispatch result is never
 * evidence of recovery. Not the intent's `completed` status, not the device
 * command's exit code, not the model's prose. The agent's own restart-success
 * report is not proof the service runs — only Windows waits for `Running`
 * (`services_windows.go:132`) and macOS discards the stop error
 * (`services_darwin.go:128-130`), which is contradiction C10. So half (a) of
 * the criterion is always an INDEPENDENT `list_services` read.
 *
 * The criterion has two halves on two different clocks, and BOTH are required
 * (baseline §2.7):
 *
 *  (a) the service is running, per a fresh independent read; and
 *  (b) the triggering alert cleared AND stayed cleared — the fix watch
 *      reaching `held_qualified`.
 *
 * Three C-numbered hazards are handled here explicitly:
 *
 *  C9 — no freshness bound exists in the codebase. `VERIFY_READ_TIMEOUT_MS`
 *       (8 s) is a read DEADLINE and `FIX_HOLD_MINUTES` (60) is a recurrence
 *       HOLD; neither is a staleness window. The criterion therefore carries
 *       its own explicit `freshnessSeconds` (default 120) and this module
 *       refuses to credit an observation older than it.
 *  C10 — see above: never the dispatch result.
 *  C11 — `isFixWatchEligible` requires `modeAtStart === 'act'`, so it never
 *       fires for a SUPERVISED task run, and `watchReleasedIntent` credits an
 *       intent `verified` on the spot when its run has no `alertId`. Neither
 *       is used as a task verdict here. The task's own gate is: a watch is
 *       consulted only when the criterion names an `alertId`, and NOTHING is
 *       ever credited `verified_resolved` without half (a) actually passing.
 *
 * `inconclusive` can never produce `completed + verified_resolved` (spec §13
 * acceptance scenario 7). That is structural, not a convention: the only code
 * path that returns the `verified_resolved` outcome requires `result ===
 * 'passed'`, and every early return that is not a proven pass returns
 * `inconclusive` or `failed`.
 */

import { and, eq } from 'drizzle-orm';
import {
  db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext,
} from '../../db';
import { aiAgentFixWatches } from '../../db/schema/aiAgentFixWatches';
import { devices } from '../../db/schema/devices';
import { verifyServiceRunningForTask } from '../aiAgents/actVerify';
import type { TaskCriterion, TaskVerificationResult } from '@breeze/shared';
import type { AiOperatorTaskOutcome } from '../../db/schema/aiOperatorTasks';

export interface CriterionEvaluation {
  result: TaskVerificationResult;
  /** Short, human-readable. Never raw tool output. */
  detail: string;
  /** When the evidence behind `result` was observed. */
  observedAt: Date;
  /**
   * The task outcome this evaluation authorizes, or `null` when the task must
   * keep waiting / retry. ONLY ever `verified_resolved` on a genuine pass.
   */
  outcome: AiOperatorTaskOutcome | null;
  /**
   * True when the evaluation is not final because half (b) is still running
   * its hold — the coordinator should re-arm a `verification_window` wait
   * rather than admit another reasoning attempt.
   */
  awaitingWindow: boolean;
}

/**
 * Half (a) only, exposed so the recipe can take a pre-action baseline.
 *
 * THE ORG CHECK IS NOT DECORATION. `verifyServiceRunningForTask` ends up in
 * `executeCommandWithSystemPrecheck`, whose `precheckCommandExecution`
 * (`commandQueue.ts`) resolves the device with `WHERE devices.id = $1` and NO
 * org predicate, under a SYSTEM scope that bypasses RLS.
 *
 * Since #5264 that precheck ALSO enforces the org itself — `args.orgId` now
 * travels all the way down as the mandatory `expectedOrgId` — so this is no
 * longer the only thing standing between a moved device and a cross-tenant
 * dispatch. It is kept because it is the only place that can answer
 * "inconclusive" with a caller-meaningful reason instead of a generic
 * dispatch failure, and because a pre-flight refusal never reaches the
 * device_commands path at all.
 *
 * For a short-lived act-mode run that is academic — the device id came from
 * the run's own org moments earlier. For a DURABLE TASK it is not: a task can
 * sit `waiting` for days (that is the entire point of this wave), and a
 * device can be moved to another organization in the meantime. Without the
 * check below, verification would then dispatch a live `list_services`
 * command to a device in a DIFFERENT tenant, attributed to the original org's
 * frozen agent principal — an active cross-tenant command dispatch, not
 * merely a stale read.
 *
 * So the device's membership is re-validated under the task's OWN org RLS
 * context first, exactly as `deviceCommandEvidence.readDeviceCommandEvidence`
 * does for the observe step. A device that has left the org yields
 * `inconclusive` — never `failed`, because nothing was actually learned about
 * the service, and `failed` would authorize another restart attempt.
 */
export async function readServiceRunning(args: {
  orgId: string;
  deviceId: string;
  serviceName: string;
  agentUserId: string;
}): Promise<{ verdict: 'passed' | 'failed' | 'inconclusive'; detail: string; observedAt: Date }> {
  const owned = await runOutsideDbContext(() =>
    withDbAccessContext(
      { scope: 'organization', orgId: args.orgId, accessibleOrgIds: [args.orgId] },
      async () => {
        const [row] = await db
          .select({ id: devices.id })
          .from(devices)
          .where(and(eq(devices.id, args.deviceId), eq(devices.orgId, args.orgId)))
          .limit(1);
        return row ?? null;
      },
    ));

  if (!owned) {
    return {
      verdict: 'inconclusive',
      detail: 'the target device is no longer in this organization',
      observedAt: new Date(),
    };
  }

  const outcome = await verifyServiceRunningForTask(
    { serviceName: args.serviceName },
    { deviceId: args.deviceId, orgId: args.orgId },
    args.agentUserId,
  );
  return {
    verdict: outcome.verification === 'skipped' ? 'inconclusive' : outcome.verification,
    detail: outcome.detail ?? (outcome.verification === 'passed' ? 'service is running' : 'service state read'),
    observedAt: new Date(),
  };
}

/**
 * Evaluate the full criterion.
 *
 * `agentUserId` is the ai_agent principal's user id — attribution only, the
 * same value the tool dispatch itself used. This function never fabricates a
 * human identity and never runs tool code as system (spec §7.1).
 */
export async function evaluateCriterion(args: {
  orgId: string;
  criterion: TaskCriterion;
  agentUserId: string;
  /** The intent whose fix watch grades half (b). Null when nothing dispatched. */
  intentId: string | null;
  now?: Date;
}): Promise<CriterionEvaluation> {
  const now = args.now ?? new Date();
  const { criterion } = args;

  // ---- half (a): independent service-state read -------------------------
  const serviceRead = await readServiceRunning({
    orgId: args.orgId,
    deviceId: criterion.deviceId,
    serviceName: criterion.serviceName,
    agentUserId: args.agentUserId,
  });

  // C9's freshness bound, applied to the read we just took. It is normally
  // trivially satisfied (the read happened milliseconds ago) — it exists so
  // that a slow/queued device round-trip that only lands after the window
  // cannot be credited. Offline or stale telemetry is `inconclusive`, never
  // `healthy` (spec §8.1).
  const ageSeconds = Math.max(0, (now.getTime() - serviceRead.observedAt.getTime()) / 1000);
  if (ageSeconds > criterion.freshnessSeconds) {
    return {
      result: 'inconclusive',
      detail: `service state evidence is ${Math.round(ageSeconds)}s old, past the ${criterion.freshnessSeconds}s freshness bound`,
      observedAt: serviceRead.observedAt,
      outcome: null,
      awaitingWindow: false,
    };
  }

  if (serviceRead.verdict === 'inconclusive') {
    return {
      result: 'inconclusive',
      detail: `service state could not be read: ${serviceRead.detail}`,
      observedAt: serviceRead.observedAt,
      outcome: null,
      awaitingWindow: false,
    };
  }

  if (serviceRead.verdict === 'failed') {
    // A REAL negative: the read completed and the service is not running.
    // This is the branch that authorizes one more reasoning attempt.
    return {
      result: 'failed',
      detail: serviceRead.detail,
      observedAt: serviceRead.observedAt,
      outcome: null,
      awaitingWindow: false,
    };
  }

  // ---- half (b): the recurrence signal ----------------------------------

  if (criterion.alertId === null) {
    // No triggering alert means there is NO recurrence signal at all — only
    // half (a) plus the configured hold. Spec §8.1: never credit `verified`
    // for a run with no `alertId` unless the recipe explicitly declares that
    // acceptable. Otherwise the honest label is `investigation_complete`,
    // which §6.1 defines as "not counted as a fix".
    return {
      result: 'passed',
      detail: `${serviceRead.detail}; no triggering alert, so no recurrence signal was observed`,
      observedAt: serviceRead.observedAt,
      outcome: criterion.resolvableWithoutAlert ? 'verified_resolved' : 'investigation_complete',
      awaitingWindow: false,
    };
  }

  if (!args.intentId) {
    // Half (a) passed but nothing was dispatched under this task, so no watch
    // exists and none ever will. The service may simply never have been down.
    return {
      result: 'inconclusive',
      detail: 'service is running but no operation was dispatched, so recovery cannot be attributed',
      observedAt: serviceRead.observedAt,
      outcome: null,
      awaitingWindow: false,
    };
  }

  const watch = await readFixWatchState(args.orgId, args.intentId);

  if (!watch) {
    // The release path opens the watch inside the terminal CAS transaction
    // (`watchReleasedIntent`), so its absence right after a dispatch is a
    // timing artefact, not a verdict. Wait, do not conclude.
    return {
      result: 'inconclusive',
      detail: 'no fix watch has been opened for this operation yet',
      observedAt: serviceRead.observedAt,
      outcome: null,
      awaitingWindow: true,
    };
  }

  switch (watch.state) {
    case 'held_qualified':
      // BOTH halves. This is the ONLY path to `verified_resolved`.
      return {
        result: 'passed',
        detail: `${serviceRead.detail}; triggering alert resolved and held with no recurrence`,
        observedAt: serviceRead.observedAt,
        outcome: 'verified_resolved',
        awaitingWindow: false,
      };
    case 'recurred':
      // Spec §8.1: "a recurrence while a task is still watching invalidates
      // its pending verification". The service reads healthy at this instant
      // and the alert came back anyway — that is a failure, not a pass.
      return {
        result: 'failed',
        detail: 'the triggering alert recurred during the hold window',
        observedAt: serviceRead.observedAt,
        outcome: null,
        awaitingWindow: false,
      };
    case 'pending':
    case 'watching':
      // Still holding. Not a verdict yet.
      return {
        result: 'inconclusive',
        detail: `service is running; alert watch is '${watch.state}' and has not completed its hold`,
        observedAt: serviceRead.observedAt,
        outcome: null,
        awaitingWindow: true,
      };
    case 'cancelled':
      // The alert was DISMISSED by a human. `fixWatch.ts` cancels the watch
      // for exactly this reason: a dismissal is not recovery (spec §8.1,
      // "alert dismissal alone is insufficient"). Do not upgrade it into one.
      return {
        result: 'inconclusive',
        detail: 'the triggering alert was dismissed by a human, which is not evidence of recovery',
        observedAt: serviceRead.observedAt,
        outcome: null,
        awaitingWindow: false,
      };
    case 'inconclusive':
    default:
      return {
        result: 'inconclusive',
        detail: `alert watch ended '${watch.state}' without a recurrence verdict`,
        observedAt: serviceRead.observedAt,
        outcome: null,
        awaitingWindow: false,
      };
  }
}

/**
 * Read the intent-anchored fix watch's state. System-scoped because the
 * coordinator reads across orgs by design and the row is keyed by BOTH
 * `intent_id` and `org_id`, which is the tenancy predicate.
 */
async function readFixWatchState(
  orgId: string,
  intentId: string,
): Promise<{ state: string; dueAt: Date | null } | null> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [row] = await db
        .select({ state: aiAgentFixWatches.state, dueAt: aiAgentFixWatches.dueAt })
        .from(aiAgentFixWatches)
        .where(and(eq(aiAgentFixWatches.intentId, intentId), eq(aiAgentFixWatches.orgId, orgId)))
        .limit(1);
      return row ? { state: row.state as string, dueAt: row.dueAt ?? null } : null;
    }));
}
