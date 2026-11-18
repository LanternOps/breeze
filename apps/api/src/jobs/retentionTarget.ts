/**
 * `runRetentionTarget` — one eligibility predicate, two modes (#4342 W0).
 *
 * REPORT FIRST
 * ------------
 * Every retention target added under #4342 ships report-only. Its job reads a
 * `<NAME>_RETENTION_ENFORCE` flag (`retentionEnforceFromEnv`, default false):
 *
 *  - `report` counts the eligible rows (`countEligibleRows`, bounded at one
 *    enforcing run's capacity), logs a `REPORT-ONLY` line and sets
 *    `breeze_retention_rows_eligible{job_name}`. It never issues a write.
 *  - `enforce` deletes (`pruneInCtidBatches`) or scrubs (`updateInCtidBatches`)
 *    those rows in `ctid` batches, each in its own fresh system transaction.
 *
 * An operator reads the report counts before setting the flag. That evidence is
 * worth something only if it describes the rows enforcement will touch.
 *
 * ONE PREDICATE
 * -------------
 * So a target has exactly one predicate builder, `where(cutoffIso, nowIso)`,
 * and both modes call it here, once per run, with the same arguments, and pass
 * the result on unchanged. A job using this runner never builds its own count
 * query or its own delete predicate. `retentionTarget.test.ts` pins the rendered SQL of the count's
 * `where` to the rendered SQL of the delete's, byte for byte.
 *
 * REPORT-ONLY TARGETS COUNT UNDER A TIMEOUT
 * ----------------------------------------
 * A `reportOnly` target's predicate has no index guarantee (#4342 W6.c), so
 * its count runs under `REPORT_ONLY_COUNT_TIMEOUT_MS`
 * (`countEligibleRowsBounded`). A count that runs past it is cancelled and
 * returned as `mode: 'reportUnavailable'`: logged as "count unavailable (timed
 * out)", published as `breeze_retention_count_unavailable`, and never a
 * failure, so the other targets and the job carry on. Targets that can
 * enforce keep `countEligibleRows`, unchanged.
 *
 * NO AMBIENT CONTEXT
 * ------------------
 * Do not call this inside a DB context. The batch primitives each open a fresh
 * system context per statement (`retentionBatch.ts` header): wrapped in one
 * outer context, every batch would share a single transaction.
 */

import type { SQL } from 'drizzle-orm';

import { recordRetentionRun, type RetentionJobName } from '../services/retentionMetrics';
import { captureException } from '../services/sentry';
import {
  countEligibleRows,
  countEligibleRowsBounded,
  pruneInCtidBatches,
  updateInCtidBatches,
  warnOnRetentionBacklog,
  type BatchedPruneResult,
} from './retentionBatch';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Statement timeout for a `reportOnly` target's count. Long enough for an
 * indexed count capped at one run's capacity, short enough that a predicate
 * walking an index past millions of rows gives its connection back.
 */
export const REPORT_ONLY_COUNT_TIMEOUT_MS = 5_000;

/**
 * What an enforcing run does to an eligible row.
 *
 * `reportOnly` has no enforce path at all: the runner counts, whatever
 * `knobs.enforce` says. A target ships this way when its predicate is still
 * being evaluated against production counts and no `_ENFORCE` switch exists
 * for it yet (#4342 W6.c). Giving it a delete path is a code change, reviewed
 * on its own, not an env flip.
 */
export type RetentionAction = { kind: 'delete' } | { kind: 'scrub'; set: SQL } | { kind: 'reportOnly' };

export interface RetentionTarget {
  /** A `RETENTION_JOB_NAMES` member. One per target: the gauges are `.set()` per name. */
  metricName: RetentionJobName;
  /** Bare, literal table identifier. The predicate refers to it by this bare name. */
  table: string;
  action: RetentionAction;
  /**
   * The ONLY predicate. Report and enforce both call it with the same cutoff and
   * the same run instant (`nowIso` feeds per-row windows such as `expires_at`).
   * For a scrub, it MUST exclude rows already scrubbed (`updateInCtidBatches`).
   */
  where: (cutoffIso: string, nowIso: string) => SQL;
}

export interface RetentionKnobs {
  retentionDays: number;
  batchSize: number;
  maxBatches: number;
  enforce: boolean;
}

export type RetentionTargetResult =
  | { mode: 'report'; table: string; retentionDays: number; eligible: number; eligibleCapped: boolean; durationMs: number }
  /** A `reportOnly` count cancelled at `timeoutMs`: no number, and not a failure. */
  | { mode: 'reportUnavailable'; table: string; retentionDays: number; reason: 'timeout'; timeoutMs: number; durationMs: number }
  | { mode: 'enforce'; table: string; retentionDays: number; affected: number; batches: number; hasMore: boolean; durationMs: number };

export interface RetentionRunOptions {
  logPrefix: string;
  /** DB context label, surfaced on held-connection warnings. */
  label: string;
  /** The variable that turns enforcement on, named in the REPORT-ONLY log line. */
  enforceVar?: string;
  /** Fixed run instant (tests). Defaults to now. */
  now?: Date;
}

export async function runRetentionTarget(
  target: RetentionTarget,
  knobs: RetentionKnobs,
  o: RetentionRunOptions,
): Promise<RetentionTargetResult> {
  const { retentionDays, batchSize, maxBatches, enforce } = knobs;
  // Callers resolve the window through `resolveRetentionDays`, so this never
  // fires in practice. It stops a hand-built knob of 0 or NaN from reaching
  // `toISOString()` (RangeError) or a cutoff of "now" (every row eligible).
  // Both modes check every knob, so report evidence is never produced from
  // knobs an enforcing run would reject.
  for (const [name, value] of [['retentionDays', retentionDays], ['batchSize', batchSize], ['maxBatches', maxBatches]] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`[retentionTarget] Refusing ${target.table}: ${name} must be a positive integer, got ${value}`);
    }
  }

  const startedAt = Date.now();
  const now = o.now ?? new Date(startedAt);
  const cutoffIso = new Date(now.getTime() - retentionDays * DAY_MS).toISOString();
  const nowIso = now.toISOString();
  const where = target.where(cutoffIso, nowIso);

  const reportOnlyTarget = target.action.kind === 'reportOnly';
  if (!enforce || reportOnlyTarget) {
    const countArgs = { table: target.table, where, cap: batchSize * maxBatches, label: o.label };
    const enableHint = reportOnlyTarget
      ? 'report-only target: no enforce switch in this release'
      : o.enforceVar ? `set ${o.enforceVar}=true to delete` : 'set this job\'s _RETENTION_ENFORCE=true to delete';
    const count = reportOnlyTarget
      ? await countEligibleRowsBounded({ ...countArgs, statementTimeoutMs: REPORT_ONLY_COUNT_TIMEOUT_MS })
      : { timedOut: false as const, ...(await countEligibleRows(countArgs)) };
    const durationMs = Date.now() - startedAt;
    if (count.timedOut) {
      console.log(
        `${o.logPrefix} REPORT-ONLY: ${target.table} count unavailable (timed out after ${REPORT_ONLY_COUNT_TIMEOUT_MS} ms; ` +
        `window ${retentionDays} d); ${enableHint}`,
      );
      recordRetentionRun(target.metricName, { countUnavailable: true });
      return {
        mode: 'reportUnavailable',
        table: target.table,
        retentionDays,
        reason: 'timeout',
        timeoutMs: REPORT_ONLY_COUNT_TIMEOUT_MS,
        durationMs,
      };
    }
    const { eligible, capped } = count;
    console.log(
      `${o.logPrefix} REPORT-ONLY: ${eligible}${capped ? '+' : ''} ${target.table} rows eligible ` +
      `(window ${retentionDays} d); ${enableHint}`,
    );
    recordRetentionRun(target.metricName, { rowsEligible: eligible });
    return { mode: 'report', table: target.table, retentionDays, eligible, eligibleCapped: capped, durationMs };
  }

  const action = target.action;
  const result = await enforceRetentionAction(action, { table: target.table, where, batchSize, maxBatches, label: o.label });
  const durationMs = Date.now() - startedAt;

  console.log(
    `${o.logPrefix} ${action.kind === 'scrub' ? 'Scrubbed' : 'Deleted'} ${result.deleted} ${target.table} rows ` +
    `older than ${retentionDays} days (batches=${result.batches}) in ${durationMs}ms`,
  );
  warnOnRetentionBacklog(o.logPrefix, target.table, result);
  recordRetentionRun(target.metricName, { rowsDeleted: result.deleted, incomplete: result.hasMore });

  return {
    mode: 'enforce',
    table: target.table,
    retentionDays,
    affected: result.deleted,
    batches: result.batches,
    hasMore: result.hasMore,
    durationMs,
  };
}

/**
 * The enforcing branch: what an enforcing run does to the eligible rows. Fails
 * closed. Each action kind is handled by name and anything else throws, so no
 * kind reaches a delete by default. `reportOnly` throws too: the early return
 * in `runRetentionTarget` must have counted it, and reaching here means that
 * guard was bypassed. Exported so a test can make exactly that call.
 */
export async function enforceRetentionAction(
  action: RetentionAction,
  batchArgs: { table: string; where: SQL; batchSize: number; maxBatches: number; label: string },
): Promise<BatchedPruneResult> {
  switch (action.kind) {
    case 'delete':
      return pruneInCtidBatches(batchArgs);
    case 'scrub':
      return updateInCtidBatches({ ...batchArgs, set: action.set });
    case 'reportOnly':
      throw new Error(`[retentionTarget] Refusing to enforce ${batchArgs.table}: its action is reportOnly, which only counts`);
    default: {
      const unknown: never = action;
      throw new Error(
        `[retentionTarget] Refusing to enforce ${batchArgs.table}: unknown action kind ${JSON.stringify((unknown as { kind?: unknown }).kind)}`,
      );
    }
  }
}

/**
 * Run targets one after another with a shared run instant. A target that throws
 * is logged, captured, and recorded as `incomplete` on its own metric, and the
 * rest still run: one table's failure must not leave every later table
 * unswept. Returns per-target results in input order.
 *
 * Throws before running anything if two targets share a `metricName`: the
 * gauges are `.set()` per name, so the second would overwrite the first one's
 * report evidence (plan correction 19).
 *
 * The caller decides whether a returned `{ table, error }` fails its job.
 */
export interface RetentionTargetEntry {
  target: RetentionTarget;
  knobs: RetentionKnobs;
  /**
   * The variable that enables THIS target, when targets in one job carry their
   * own flags (W5). Overrides `RetentionRunOptions.enforceVar` in its log line.
   */
  enforceVar?: string;
}

export async function runRetentionTargets(
  targets: ReadonlyArray<RetentionTargetEntry>,
  o: RetentionRunOptions,
): Promise<Array<RetentionTargetResult | { table: string; error: string }>> {
  const seen = new Set<RetentionJobName>();
  for (const { target } of targets) {
    if (seen.has(target.metricName)) {
      throw new Error(`[retentionTarget] Two targets share metricName ${target.metricName}; each target needs its own`);
    }
    seen.add(target.metricName);
  }

  const now = o.now ?? new Date();
  const results: Array<RetentionTargetResult | { table: string; error: string }> = [];
  for (const { target, knobs, enforceVar } of targets) {
    try {
      results.push(await runRetentionTarget(target, knobs, { ...o, now, enforceVar: enforceVar ?? o.enforceVar }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${o.logPrefix} Retention target ${target.table} failed:`, err);
      // Only the bounded literal table name is tagged (allowlisted in sentry.ts).
      captureException(err, undefined, { retentionTarget: target.table });
      // Otherwise the backlog gauge keeps its last value (often 0, "cleared")
      // and an install without Sentry has nothing but a log line.
      recordRetentionRun(target.metricName, { incomplete: true });
      results.push({ table: target.table, error: message });
    }
  }
  return results;
}
