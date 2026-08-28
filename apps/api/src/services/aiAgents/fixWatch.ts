/**
 * Wave 6.2a (#3828) — scheduling "did the fix hold" watches.
 *
 * This module is PURE up to `scheduleFixWatches`, which is the only function
 * that touches the DB. The selection rules live in `selectFixWatches` so they
 * can be unit-tested against fixtures with no database at all.
 *
 * Two lanes per watched target (see the plan doc, "Why only one postcondition
 * kind"):
 *
 *   - `alert_recurrence` — op-agnostic and I/O-free at check time. It is the
 *     ONLY lane that says anything about `run_script` or `execute_playbook`,
 *     whose verifications (an exit code, a step roll-up) have nothing to
 *     re-read, and it still resolves while the device is offline.
 *   - `postcondition` — re-runs the op's own read-back. `service_running` is
 *     the only kind v1 watches: `process_absent` is not in the act manifest,
 *     and re-checking a killed process BY NAME would be a broader claim than
 *     the postcondition rather than a weaker one (legitimate respawn, multiple
 *     instances, unrelated binaries sharing a name); `disk_usage_improved`'s
 *     verification reads the cleanup command's own status and never performs a
 *     disk read, so there is no baseline to compare against.
 *
 * ONE WATCH PER TARGET, per lane. A run that restarts two services produces
 * two recurrence watches, not one — so a regression is attributed to the exact
 * circuit that earned it rather than smeared across everything the run did.
 */
import { and, eq } from 'drizzle-orm';
import type { ActTarget } from './actManifest';
import type { ActVerificationVerdict } from '@breeze/shared';
import {
  AI_AGENT_FIX_WATCH_CONTRACT_VERSION,
  aiAgentFixWatches,
  type AiAgentFixWatchKind,
} from '../../db/schema/aiAgentFixWatches';
import { alerts } from '../../db/schema/alerts';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../../db';

function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

/**
 * A service that was restarted and then died again usually does so quickly, so
 * the postcondition re-check is deliberately near-term — a long window would
 * mostly measure "did anything else touch this service since".
 *
 * Sized against the sweeper's hourly cadence (`ai-fix-watch-sweep`), not
 * against an imagined continuous checker: a window shorter than the sweep
 * interval would claim a precision the schedule cannot deliver.
 */
export const POSTCONDITION_WINDOW_MS = 30 * 60 * 1000;

/**
 * Recurrence needs long enough for the originating alert rule to evaluate
 * again at least once. Four hours comfortably clears every built-in cadence
 * without letting an unrelated later incident read as a regression.
 */
export const ALERT_RECURRENCE_WINDOW_MS = 4 * 60 * 60 * 1000;

/** Manifest op keys whose `verifySpec` can be honestly re-read later. */
const WATCHABLE_POSTCONDITION_KINDS: ReadonlySet<string> = new Set(['service_running']);

export interface FixWatchRunInput {
  id: string;
  orgId: string;
  agentId: string;
  deviceId: string | null;
  alertId: string | null;
  alertRuleId: string | null;
  alertConfigItemName: string | null;
  finishedAt: Date;
}

/** One act execution the run performed, as the post-tool-use hook recorded it. */
export interface FixWatchActRecord {
  opKey: string;
  verifySpecKind: string | null;
  verification: ActVerificationVerdict | undefined;
  /** Structured, from the act pin — NOT reconstructed from the display summary. */
  target: ActTarget;
}

export interface PlannedFixWatch {
  watchKind: AiAgentFixWatchKind;
  contractVersion: number;
  opKey: string;
  targetFingerprint: string;
  verifySpecKind: string | null;
  target: ActTarget;
  alertId: string | null;
  alertRuleId: string | null;
  alertConfigItemName: string | null;
  baselineAt: Date;
  dueAt: Date;
}

/**
 * Canonical, stable identity of WHAT was remediated — the key the circuit
 * ledger is partitioned on. Deliberately not `actTargetSummary`, which is a
 * display string ("3 path(s)") and would collapse unrelated targets onto one
 * circuit.
 */
export function actTargetFingerprint(target: ActTarget): string {
  switch (target.kind) {
    case 'service':
      // Windows service names are case-insensitive; two casings are one service
      // and must therefore be one circuit.
      return `service:${target.serviceName.toLowerCase()}`;
    case 'disk_cleanup':
      // Order-insensitive: the same set of paths cleaned in a different order
      // is the same remediation.
      return `disk_cleanup:${[...target.paths].sort().join('|')}`;
    case 'process':
      return `process:${target.processName.toLowerCase()}`;
    case 'script':
      return `script:${target.scriptId}`;
    case 'playbook':
      return `playbook:${target.playbookId}`;
    case 'suggestion':
      return `suggestion:${target.suggestionId}`;
    default: {
      const exhaustive: never = target;
      return JSON.stringify(exhaustive);
    }
  }
}

/**
 * Pure. Decides which watches a finished run earns.
 *
 * Only a `passed` immediate verification is watched. A `failed` one already
 * raised its own attention alert and already counts against the circuit — "did
 * it hold" is not the open question there. An `inconclusive` or `skipped` one
 * never established that anything worked in the first place, so there is no
 * "held" for a later check to confirm or refute.
 */
export function selectFixWatches(
  run: FixWatchRunInput,
  acts: readonly FixWatchActRecord[],
): PlannedFixWatch[] {
  if (!run.deviceId) return [];

  const planned: PlannedFixWatch[] = [];
  const seen = new Set<string>();

  for (const act of acts) {
    if (act.verification !== 'passed') continue;

    const targetFingerprint = actTargetFingerprint(act.target);
    const base = {
      contractVersion: AI_AGENT_FIX_WATCH_CONTRACT_VERSION,
      opKey: act.opKey,
      targetFingerprint,
      verifySpecKind: act.verifySpecKind,
      target: act.target,
      baselineAt: run.finishedAt,
    };

    const push = (watchKind: AiAgentFixWatchKind, windowMs: number, withAlert: boolean) => {
      // (run_id, watch_kind, target_fingerprint) is UNIQUE — the same target
      // acted on twice in one run is one target, not a constraint violation.
      const dedupeKey = `${watchKind}:${targetFingerprint}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      planned.push({
        ...base,
        watchKind,
        dueAt: new Date(run.finishedAt.getTime() + windowMs),
        alertId: withAlert ? run.alertId : null,
        alertRuleId: withAlert ? run.alertRuleId : null,
        alertConfigItemName: withAlert ? run.alertConfigItemName : null,
      });
    };

    // Recurrence needs an originating alert identity to ask its question
    // against; a manually-triggered run has none.
    if (run.alertId) push('alert_recurrence', ALERT_RECURRENCE_WINDOW_MS, true);
    if (act.verifySpecKind && WATCHABLE_POSTCONDITION_KINDS.has(act.verifySpecKind)) {
      push('postcondition', POSTCONDITION_WINDOW_MS, false);
    }
  }

  return planned;
}

/**
 * Loads the originating alert's IDENTITY (not just its id) so a later check
 * can ask "did an alert like this one come back" even after the original row
 * has been resolved or deleted.
 */
export async function loadAlertIdentity(alertId: string): Promise<{
  alertRuleId: string | null;
  alertConfigItemName: string | null;
} | null> {
  const [row] = await db
    .select({ ruleId: alerts.ruleId, configItemName: alerts.configItemName })
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);
  if (!row) return null;
  return { alertRuleId: row.ruleId ?? null, alertConfigItemName: row.configItemName ?? null };
}

export interface ScheduleFixWatchesResult {
  planned: number;
  inserted: number;
}

/**
 * Records the planned watches. Idempotent via the (run_id, watch_kind,
 * target_fingerprint) unique constraint, so a retried `finishRun` is safe.
 *
 * Returns a count rather than throwing on a partial write: the CALLER decides
 * what a shortfall means. That matters — an action must not read as cleanly
 * remediated when the watch that was supposed to confirm it could not be
 * recorded, so `finishRun` logs the discrepancy loudly rather than swallowing
 * it into a clean verdict.
 */
export async function scheduleFixWatches(
  run: FixWatchRunInput,
  acts: readonly FixWatchActRecord[],
): Promise<ScheduleFixWatchesResult> {
  const planned = selectFixWatches(run, acts);
  if (planned.length === 0) return { planned: 0, inserted: 0 };

  const rows = planned.map((w) => ({
    orgId: run.orgId,
    deviceId: run.deviceId!,
    agentId: run.agentId,
    runId: run.id,
    watchKind: w.watchKind,
    contractVersion: w.contractVersion,
    opKey: w.opKey,
    targetFingerprint: w.targetFingerprint,
    verifySpecKind: w.verifySpecKind,
    target: w.target as unknown as Record<string, unknown>,
    alertId: w.alertId,
    alertRuleId: w.alertRuleId,
    alertConfigItemName: w.alertConfigItemName,
    baselineAt: w.baselineAt,
    dueAt: w.dueAt,
  }));

  const inserted = await inSystemDbContext(async () => {
    const written = await db
      .insert(aiAgentFixWatches)
      .values(rows)
      .onConflictDoNothing({
        target: [
          aiAgentFixWatches.runId,
          aiAgentFixWatches.watchKind,
          aiAgentFixWatches.targetFingerprint,
        ],
      })
      .returning({ id: aiAgentFixWatches.id });
    return written.length;
  });

  return { planned: planned.length, inserted };
}

/**
 * Cancels every still-open watch for a run. Used when a run is superseded or
 * its device is decommissioned — a watch nobody will act on should not sit
 * `pending` forever, and must never be scored as a regression.
 */
export async function cancelFixWatchesForRun(runId: string, reason: string): Promise<number> {
  return inSystemDbContext(async () => {
    const cancelled = await db
      .update(aiAgentFixWatches)
      .set({ status: 'cancelled', detail: reason, updatedAt: new Date() })
      .where(and(
        eq(aiAgentFixWatches.runId, runId),
        eq(aiAgentFixWatches.status, 'pending'),
      ))
      .returning({ id: aiAgentFixWatches.id });
    return cancelled.length;
  });
}
