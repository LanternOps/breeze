/**
 * Shared batching primitives for the retention sweepers.
 *
 * WHY THIS EXISTS
 * ---------------
 * A retention job that issues one unbounded `DELETE ... WHERE ts < cutoff`
 * holds a pooled connection — and the row locks it takes — for the entire
 * delete. On a large fleet, or on the first run after a backlog, that is a
 * multi-minute statement on a table the agent write path is concurrently
 * inserting into. `jobs/scheduleRegistry.ts` documents that exact failure mode.
 *
 * ONE TRANSACTION PER BATCH — THE POINT OF THE WHOLE EXERCISE
 * -----------------------------------------------------------
 * Batching alone does NOT fix that. `withDbAccessContext` opens a real Postgres
 * transaction (`db/index.ts`), and it early-returns when a context store is
 * already open — so a loop wrapped in one outer `withSystemDbAccessContext`
 * runs every batch inside a single transaction, holding every lock until the
 * last one commits. That is strictly worse than the unbounded DELETE it
 * replaced: same lock duration, more round trips, xmin pinned longer.
 *
 * So `pruneInCtidBatches` escapes any ambient context and opens a FRESH system
 * context per batch. Each batch commits on its own, releasing its locks and its
 * pooled connection before the next begins. Callers must NOT wrap the loop in a
 * context of their own. This mirrors `softwareRemediationRequestCleanup`, which
 * documents the same LOCK DURATION reasoning.
 *
 * CUTOFFS ARE ISO STRINGS, NOT `Date`
 * -----------------------------------
 * postgres-js does not coerce a JS `Date` in template-literal params — callers
 * pass `date.toISOString()`. That is byte-identical to what Drizzle's own
 * encoder emits: `PgTimestamp.mapToDriverValue` is `value.toISOString()` for
 * both column flavours in use here. Postgres discards the offset coercing to
 * `timestamp without time zone` and honours it for `timestamptz`. Callers
 * against a `timestamptz` column still cast explicitly (`${cutoff}::timestamptz`)
 * to keep the intent readable.
 */

import { SQL, sql } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { extractRowCount } from '../db/rowCount';
import { captureMessage } from '../services/sentry';

/**
 * A table name cannot be a bound parameter, so it is the one value that reaches
 * the statement as raw SQL. Every caller passes a hardcoded literal; this guard
 * makes that contract enforced rather than merely intended.
 */
const BARE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export interface BatchedPruneResult {
  /** Rows removed across every batch this run. */
  deleted: number;
  /** Statements issued. Equals `maxBatches` exactly when the cap was hit. */
  batches: number;
  /**
   * The batch cap stopped the sweep while the final batch was still full, so
   * rows almost certainly remain. A point-in-time inference, not a guarantee:
   * the last batch could have exactly drained the table, which is why the
   * second conjunct exists — a cap reached on a SHORT batch is a clean drain,
   * not a backlog, and must not raise a nightly false alarm.
   */
  hasMore: boolean;
}

/**
 * Read a positive integer knob from the environment, falling back (loudly) on
 * anything unusable. Zero and negatives are misconfiguration, not a request for
 * a zero-sized batch, so they fall back rather than clamp.
 */
export function parsePositiveIntEnv(logPrefix: string, name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`${logPrefix} Invalid ${name}="${raw}", using default ${fallback}`);
    return fallback;
  }
  return parsed;
}

/**
 * Resolve a retention window, falling back on anything that is not a usable
 * positive number rather than clamping it.
 *
 * The distinction is load-bearing in two ways (same rationale as
 * `deviceMetricsRetention.resolveRetentionDays`):
 *
 *  - `parseInt('nonsense', 10)` is NaN, and NaN survives `Math.min`/`Math.max`
 *    untouched — a clamp alone would carry it into the cutoff, where
 *    `new Date(NaN).toISOString()` throws RangeError on every single run.
 *  - `0` and negatives read as "no retention"/misconfiguration. Clamping those
 *    to the 1-day floor would silently prune almost the entire table on the
 *    next run, so they must fall back instead.
 *
 * A value ABOVE `maxDays` is capped rather than rejected, but says so: a
 * self-hosted deployment asking for 1095 days of change log and silently
 * getting 365 loses two years of history on the first run after upgrade, and
 * the only way anyone finds out is this line.
 */
export function resolveRetentionDays(
  raw: string | number | undefined,
  fallback: number,
  maxDays: number,
  logPrefix?: string,
): number {
  // Accepts both flavours on purpose: the env knob arrives as a string and the
  // BullMQ job payload as a number, and both need the identical guard. Routing
  // job data through a stringify/re-parse round trip just to reuse this would
  // be the kind of seam where one path quietly loses the NaN check.
  const parsed = typeof raw === 'number' ? Math.trunc(raw) : Number.parseInt(raw || '', 10);
  const chosen = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  if (logPrefix && chosen > maxDays) {
    console.warn(
      `${logPrefix} Configured retention of ${chosen} days exceeds the ${maxDays}-day cap; using ${maxDays}. ` +
      'Data older than the cap WILL be deleted.',
    );
  }
  return Math.min(maxDays, Math.max(1, chosen));
}

/**
 * Run `fn` in a FRESH system DB access context, escaping any ambient one.
 *
 * The escape is not optional: `withDbAccessContext` early-returns when a
 * context store already exists, so nesting would silently reuse the caller's
 * transaction and defeat per-batch commits.
 */
function inFreshSystemContext<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

/**
 * Delete rows matching `where` from `table` in bounded `ctid` batches, each in
 * its own transaction.
 *
 * Stops on the first short batch (nothing eligible left at select time) or when
 * `maxBatches` statements have run, whichever comes first. Rows inserted
 * concurrently are deliberately left for the next scheduled run rather than
 * chased inside one sweep.
 *
 * Do NOT call this inside a `withSystemDbAccessContext` — it opens its own, per
 * batch. See the module header.
 *
 * @param table Bare, hardcoded table identifier — never user input.
 * @param where Predicate over that table, e.g. ``sql`"timestamp" < ${cutoff}` ``.
 * @param label Context label, surfaced on held-connection warnings.
 */
export async function pruneInCtidBatches(options: {
  table: string;
  where: SQL;
  batchSize: number;
  maxBatches: number;
  label: string;
}): Promise<BatchedPruneResult> {
  const { table, where, batchSize, maxBatches, label } = options;

  if (!BARE_IDENTIFIER.test(table)) {
    throw new Error(`[retentionBatch] Refusing to prune "${table}": table must be a bare SQL identifier`);
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`[retentionBatch] Refusing to prune "${table}": batchSize must be a positive integer, got ${batchSize}`);
  }
  if (!Number.isInteger(maxBatches) || maxBatches < 1) {
    throw new Error(`[retentionBatch] Refusing to prune "${table}": maxBatches must be a positive integer, got ${maxBatches}`);
  }

  const target = sql.raw(table);
  let deleted = 0;
  let batches = 0;
  let lastBatchDeleted = 0;

  while (batches < maxBatches) {
    // One transaction per batch — see the LOCK DURATION note in the header.
    const result = await inFreshSystemContext(label, () => db.execute(sql`
      DELETE FROM ${target}
      WHERE ctid IN (
        SELECT ctid
        FROM ${target}
        WHERE ${where}
        LIMIT ${batchSize}
      )
    `));
    // extractRowCount throws on a null/undefined driver result rather than
    // reading it as "0 rows", which would end the loop early and silently leave
    // old rows behind. (An object carrying neither `count` nor `rowCount` still
    // yields 0 — the guard covers a broken driver, not every broken mock.)
    lastBatchDeleted = extractRowCount(result);
    deleted += lastBatchDeleted;
    batches += 1;
    if (lastBatchDeleted < batchSize) break;
  }

  return {
    deleted,
    batches,
    hasMore: batches >= maxBatches && lastBatchDeleted >= batchSize,
  };
}

/**
 * One Sentry capture per table per hour. `eventLogRetention` calls this INSIDE
 * a per-org loop, so an incident affecting every org would otherwise emit one
 * event per org per nightly run. Mirrors `shouldCaptureHeldContext` in
 * `db/index.ts`. The console line is never throttled — stdout is cheap and the
 * per-org detail is what makes it useful.
 */
const BACKLOG_CAPTURE_WINDOW_MS = 60 * 60 * 1000;
const lastBacklogCapture = new Map<string, number>();

function shouldCaptureBacklog(target: string): boolean {
  const now = Date.now();
  const last = lastBacklogCapture.get(target);
  if (last !== undefined && now - last < BACKLOG_CAPTURE_WINDOW_MS) return false;
  lastBacklogCapture.set(target, now);
  return true;
}

/**
 * Announce a retention backlog on channels someone will actually see.
 *
 * A capped sweep that reports `hasMore` and says nothing is how a table grows
 * unbounded while its retention job reports success every night — so this goes
 * to Sentry as well as stdout, following the `db_context_held_too_long`
 * precedent in `db/index.ts`.
 *
 * This does NOT re-enqueue: the remainder is left for the next scheduled run
 * (the same contract `softwareRemediationRequestCleanup` uses), so a genuinely
 * oversized table drains over several runs instead of one job monopolising a
 * connection. If the warning persists, raise that job's batch-size or
 * max-batches knob.
 *
 * @param target A HARDCODED table name. It becomes the `retentionTarget` Sentry
 *   tag, which is allowlisted only because every caller passes a literal —
 *   never interpolate an id, org, or hostname here.
 * @param detail Optional per-run context (e.g. `org=<uuid>`). Goes to the
 *   console line ONLY, never to Sentry, so unbounded values cannot fork the
 *   issue or leak a tenant id into a tag.
 */
export function warnOnRetentionBacklog(
  logPrefix: string,
  target: string,
  result: BatchedPruneResult,
  detail?: string,
): void {
  if (!result.hasMore) return;
  const scope = detail ? `${target} (${detail})` : target;
  const message =
    `${logPrefix} Hit the ${result.batches}-batch cap on ${scope} with rows still eligible ` +
    `(deleted ${result.deleted} this run); the remainder is left for the next scheduled run. ` +
    'If this repeats, raise the batch-size / max-batches limits for this job.';
  console.warn(message);
  if (!shouldCaptureBacklog(target)) return;
  try {
    captureMessage(message, {
      eventCode: 'retention_backlog_remaining',
      // Only the bounded table name is tagged; `detail` is deliberately absent.
      tags: { retentionTarget: target },
    });
  } catch (err) {
    // Never let the reporter take down the sweep that just succeeded.
    console.warn(`${logPrefix} Failed to report retention backlog to Sentry:`, err);
  }
}

/** Test-only: the capture throttle is module state and must not leak across tests. */
export function __resetBacklogCaptureThrottle(): void {
  lastBacklogCapture.clear();
}
