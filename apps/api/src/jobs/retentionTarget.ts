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
  pruneInCtidBatches,
  updateInCtidBatches,
  warnOnRetentionBacklog,
} from './retentionBatch';

const DAY_MS = 24 * 60 * 60 * 1000;

export type RetentionAction = { kind: 'delete' } | { kind: 'scrub'; set: SQL };

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

  if (!enforce) {
    const { eligible, capped } = await countEligibleRows({
      table: target.table,
      where,
      cap: batchSize * maxBatches,
      label: o.label,
    });
    const durationMs = Date.now() - startedAt;
    const enableHint = o.enforceVar ? `set ${o.enforceVar}=true to delete` : 'set this job\'s _RETENTION_ENFORCE=true to delete';
    console.log(
      `${o.logPrefix} REPORT-ONLY: ${eligible}${capped ? '+' : ''} ${target.table} rows eligible ` +
      `(window ${retentionDays} d); ${enableHint}`,
    );
    recordRetentionRun(target.metricName, { rowsEligible: eligible });
    return { mode: 'report', table: target.table, retentionDays, eligible, eligibleCapped: capped, durationMs };
  }

  const batchArgs = { table: target.table, where, batchSize, maxBatches, label: o.label };
  const result = target.action.kind === 'scrub'
    ? await updateInCtidBatches({ ...batchArgs, set: target.action.set })
    : await pruneInCtidBatches(batchArgs);
  const durationMs = Date.now() - startedAt;

  console.log(
    `${o.logPrefix} ${target.action.kind === 'scrub' ? 'Scrubbed' : 'Deleted'} ${result.deleted} ${target.table} rows ` +
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
export async function runRetentionTargets(
  targets: ReadonlyArray<{ target: RetentionTarget; knobs: RetentionKnobs }>,
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
  for (const { target, knobs } of targets) {
    try {
      results.push(await runRetentionTarget(target, knobs, { ...o, now }));
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
