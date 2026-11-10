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
 * to keep the intent readable. Against a `timestamp WITHOUT time zone` column
 * holding UTC wall time, compare with `utcWallTime(cutoff)` so the comparison
 * does not depend on the connection's `TimeZone`.
 *
 * REPORT FIRST
 * ------------
 * A new retention target ships counting, not deleting (#4342): its
 * `<NAME>_RETENTION_ENFORCE` flag defaults to false, so the job publishes how
 * many rows it WOULD remove and an operator reads that before turning deletion
 * on. `countEligibleRows` is that count. It is capped at `cap + 1` rows
 * (`SELECT count(*) FROM (SELECT 1 … LIMIT cap + 1)`), so a multi-year backlog
 * never turns a nightly report into a full-table count; the caller passes the
 * same `batchSize * maxBatches` an enforce run could remove, so "capped" means
 * "one enforce run would not drain this". `retentionEnforceFromEnv`
 * reads the flag, and only an explicit `true`/`1` enforces.
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
 * `(${iso}::timestamptz AT TIME ZONE 'UTC')` — the cutoff as UTC wall time,
 * for comparing against a `timestamp WITHOUT time zone` column that holds UTC.
 *
 * Comparing a tz-less column directly against `${iso}::timestamptz` converts
 * the COLUMN using the connection's `TimeZone`, so a non-UTC session shifts the
 * cutoff by hours. A bare `${iso}::timestamp` cast is correct only while every
 * caller passes a `Z`-suffixed string (it drops any offset rather than
 * honouring it); this helper honours the offset and needs no such convention.
 * (Rows written by `defaultNow()` are stored in the session `TimeZone`, which
 * is UTC on every Breeze deployment — the same assumption as
 * `jobs/scheduleRegistry.ts`.)
 */
export function utcWallTime(iso: string): SQL {
  return sql`(${iso}::timestamptz AT TIME ZONE 'UTC')`;
}

/**
 * Read a retention job's `<NAME>_RETENTION_ENFORCE` flag.
 *
 * `true`/`1` → true and `false`/`0` → false (trimmed, case-insensitive). Unset
 * or empty → `codeDefault`: compose maps every knob as `${VAR:-}`, so an
 * unconfigured deployment hands the process an empty string, and that must mean
 * "not configured", never "enforce".
 *
 * Anything else (`yes`, `on`, `enforce`, a typo) warns and returns FALSE,
 * regardless of `codeDefault`. Deletion cannot be undone, so an ambiguous value
 * fails toward counting: an operator who wrote `ENFORCE=no` against a default of
 * `true` meant off, and one who wrote `ENFORCE=yes` against `false` loses one
 * night of deletion and a warning tells them why.
 */
export function retentionEnforceFromEnv(logPrefix: string, name: string, codeDefault: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return codeDefault;
  const value = raw.trim().toLowerCase();
  if (value === '') return codeDefault;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  console.warn(
    `${logPrefix} Unrecognised ${name}="${raw}" (expected true/1 or false/0); ` +
    'running REPORT-ONLY — nothing will be deleted.',
  );
  return false;
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
  const { table, where, batchSize, label } = options;
  assertBatchArgs('prune', options);
  const target = sql.raw(table);
  return runCtidBatches(`prune ${table}`, options.maxBatches, batchSize, () =>
    inFreshSystemContext(label, () => db.execute(sql`
      DELETE FROM ${target}
      WHERE ctid IN (
        SELECT ctid
        FROM ${target}
        WHERE ${where}
        LIMIT ${batchSize}
      )
    `)),
  );
}

/**
 * `pruneInCtidBatches`' twin for a scrub: `UPDATE <table> SET <set>` over
 * bounded `ctid` batches, each in its own fresh system transaction.
 *
 * `where` MUST exclude rows this sweep has already updated (e.g. `AND
 * output_purged_at IS NULL`). Otherwise every batch re-selects the same rows,
 * every batch comes back full, and the sweep spins to `maxBatches` rewriting
 * them — reporting a backlog forever. `deleted` in the result counts rows
 * updated.
 *
 * Do NOT call this inside a `withSystemDbAccessContext`. See the module header.
 */
export async function updateInCtidBatches(options: {
  table: string;
  set: SQL;
  where: SQL;
  batchSize: number;
  maxBatches: number;
  label: string;
}): Promise<BatchedPruneResult> {
  const { table, set, where, batchSize, label } = options;
  assertBatchArgs('update', options);
  const target = sql.raw(table);
  return runCtidBatches(`update ${table}`, options.maxBatches, batchSize, () =>
    inFreshSystemContext(label, () => db.execute(sql`
      UPDATE ${target}
      SET ${set}
      WHERE ctid IN (
        SELECT ctid
        FROM ${target}
        WHERE ${where}
        LIMIT ${batchSize}
      )
    `)),
  );
}

/**
 * Count the rows `where` selects in `table`, bounded at `cap`, in one fresh
 * system context. The report half of REPORT FIRST (module header).
 *
 * Scans at most `cap + 1` matching rows: `capped` is true when more than `cap`
 * are eligible, and `eligible` is then `cap` (the caller logs it as `cap+`).
 * Throws on a missing or non-numeric count rather than reading it as 0 — a
 * report that says "nothing eligible" because the driver returned nothing is
 * evidence for an enforce decision that nobody actually saw.
 */
export async function countEligibleRows(options: {
  table: string;
  where: SQL;
  cap: number;
  label: string;
}): Promise<{ eligible: number; capped: boolean }> {
  const { table, where, cap, label } = options;
  if (!BARE_IDENTIFIER.test(table)) {
    throw new Error(`[retentionBatch] Refusing to count "${table}": table must be a bare SQL identifier`);
  }
  if (!Number.isInteger(cap) || cap < 1) {
    throw new Error(`[retentionBatch] Refusing to count "${table}": cap must be a positive integer, got ${cap}`);
  }

  const target = sql.raw(table);
  const result = await inFreshSystemContext(label, () => db.execute(sql`
    SELECT count(*)::int AS n
    FROM (
      SELECT 1
      FROM ${target}
      WHERE ${where}
      LIMIT ${cap + 1}
    ) s
  `));

  const rows: unknown = Array.isArray(result)
    ? result
    : (result as { rows?: unknown } | null | undefined)?.rows;
  const raw = Array.isArray(rows) ? (rows[0] as { n?: unknown } | undefined)?.n : undefined;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`[retentionBatch] Eligible-row count for "${table}" came back unreadable (${JSON.stringify(raw)})`);
  }
  return { eligible: Math.min(n, cap), capped: n > cap };
}

function assertBatchArgs(
  verb: 'prune' | 'update',
  { table, batchSize, maxBatches }: { table: string; batchSize: number; maxBatches: number },
): void {
  if (!BARE_IDENTIFIER.test(table)) {
    throw new Error(`[retentionBatch] Refusing to ${verb} "${table}": table must be a bare SQL identifier`);
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`[retentionBatch] Refusing to ${verb} "${table}": batchSize must be a positive integer, got ${batchSize}`);
  }
  if (!Number.isInteger(maxBatches) || maxBatches < 1) {
    throw new Error(`[retentionBatch] Refusing to ${verb} "${table}": maxBatches must be a positive integer, got ${maxBatches}`);
  }
}

/**
 * The shared loop: run one batch statement at a time until a short batch or
 * `maxBatches`. A rejected batch propagates immediately — it is never retried
 * here, so a persistent failure cannot spin the loop; the next scheduled run is
 * the retry.
 *
 * Earlier batches have already committed by then, and the thrown error carries
 * no count, so the loop logs what it had already affected before rethrowing:
 * a mid-sweep failure must not delete rows with no record of how many.
 */
async function runCtidBatches(
  what: string,
  maxBatches: number,
  batchSize: number,
  runBatch: () => Promise<unknown>,
): Promise<BatchedPruneResult> {
  let deleted = 0;
  let batches = 0;
  let lastBatchAffected = 0;

  while (batches < maxBatches) {
    // One transaction per batch — see the LOCK DURATION note in the header.
    let result: unknown;
    try {
      result = await runBatch();
    } catch (err) {
      console.error(
        `[retentionBatch] ${what}: batch ${batches + 1} failed after ${batches} committed batch(es) ` +
        `affecting ${deleted} rows; stopping, the remainder is left for the next run`,
      );
      throw err;
    }
    // extractRowCount throws on a null/undefined driver result rather than
    // reading it as "0 rows", which would end the loop early and silently leave
    // old rows behind. (An object carrying neither `count` nor `rowCount` still
    // yields 0 — the guard covers a broken driver, not every broken mock.)
    lastBatchAffected = extractRowCount(result);
    deleted += lastBatchAffected;
    batches += 1;
    if (lastBatchAffected < batchSize) break;
  }

  return {
    deleted,
    batches,
    hasMore: batches >= maxBatches && lastBatchAffected >= batchSize,
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
