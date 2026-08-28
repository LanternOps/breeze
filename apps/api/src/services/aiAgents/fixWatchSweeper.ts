/**
 * Wave 6.2a (#3828) — the fix-held watch sweeper.
 *
 * DB-backed, not a Redis delayed job per watch. The deciding failure mode: a
 * watch row commits, but its delayed job is lost (enqueue failure, Redis
 * flush/restore, eviction, an operational reset). There is no atomic
 * Postgres+Redis transaction, so a lost job would strand the watch `pending`
 * forever with nothing able to rediscover it. A periodic sweep over due rows
 * can always be reconstructed from the table, which is the source of truth.
 *
 * Lifecycle per row, in this order for a reason:
 *
 *   1. CLAIM under a lease (`pending`/expired-`checking` -> `checking`), so two
 *      workers never check the same watch.
 *   2. Read the circuit epoch — the generation this result is allowed to
 *      affect.
 *   3. Run the check OUTSIDE any transaction. It can take seconds (a device
 *      command), and holding a Postgres connection across it is what exhausted
 *      the pool on 2026-05-21.
 *   4. Finalize: write the verdict and move the circuit, guarded on that epoch.
 *
 * An `inconclusive` verdict is retried with backoff and only becomes terminal
 * once the budget is spent — an offline device must never open a breaker.
 */
import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import {
  AI_AGENT_FIX_WATCH_CONTRACT_VERSION,
  aiAgentFixWatches,
  type AiAgentFixWatchRow,
} from '../../db/schema/aiAgentFixWatches';
import { recordCircuitFailure, recordCircuitSuccess, readCircuitEpoch } from './circuitLedger';
import { runFixWatchCheck } from './fixWatchCheck';
import { notifyFixRegressed } from './fixWatchNotify';
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
 * Comfortably longer than a check can take (the device read is capped at 8s by
 * `VERIFY_READ_TIMEOUT_MS`) but short enough that a SIGKILLed worker's rows
 * come back on the next sweep rather than the next hour.
 */
export const FIX_WATCH_LEASE_MS = 5 * 60 * 1000;

/** Rows per sweep. Bounded so one sweep cannot monopolise the command queue. */
export const FIX_WATCH_SWEEP_BATCH = 50;

/**
 * How many times an inconclusive check is retried before it is accepted as
 * permanently unresolved. Four attempts across the backoff below spans roughly
 * two hours — long enough to cover an ordinary reboot or a laptop that is
 * closed for a meeting.
 */
export const FIX_WATCH_MAX_ATTEMPTS = 4;

/** Backoff before the next attempt, indexed by attempts already made. */
function retryDelayMs(attempts: number): number {
  const schedule = [5 * 60 * 1000, 20 * 60 * 1000, 60 * 60 * 1000];
  return schedule[Math.min(attempts, schedule.length - 1)]!;
}

export interface FixWatchSweepResult {
  claimed: number;
  held: number;
  regressed: number;
  inconclusive: number;
  retried: number;
  skippedUnknownContract: number;
}

/**
 * Atomically claims up to `limit` due watches.
 *
 * `FOR UPDATE SKIP LOCKED` inside the sub-select is what makes two concurrent
 * sweepers disjoint rather than merely unlikely to collide: the second worker
 * skips rows the first has locked instead of blocking on them.
 *
 * Reclaims expired `checking` leases in the same statement — a row whose worker
 * died is due again, and needs no separate reaper.
 */
async function claimDueWatches(now: Date, limit: number): Promise<AiAgentFixWatchRow[]> {
  return db
    .update(aiAgentFixWatches)
    .set({
      status: 'checking',
      leaseExpiresAt: new Date(now.getTime() + FIX_WATCH_LEASE_MS),
      updatedAt: now,
    })
    .where(sql`${aiAgentFixWatches.id} IN (
      SELECT id FROM ${aiAgentFixWatches}
      WHERE ${and(
        lte(aiAgentFixWatches.dueAt, now),
        or(
          eq(aiAgentFixWatches.status, 'pending'),
          and(
            eq(aiAgentFixWatches.status, 'checking'),
            or(
              isNull(aiAgentFixWatches.leaseExpiresAt),
              lte(aiAgentFixWatches.leaseExpiresAt, now),
            ),
          ),
        ),
      )}
      ORDER BY ${aiAgentFixWatches.dueAt} ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )`)
    .returning();
}

/** Terminal write for one watch. */
async function finalize(
  watch: AiAgentFixWatchRow,
  status: AiAgentFixWatchRow['status'],
  detail: string,
  now: Date,
): Promise<void> {
  await db
    .update(aiAgentFixWatches)
    .set({
      status,
      detail,
      checkedAt: now,
      attempts: watch.attempts + 1,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(eq(aiAgentFixWatches.id, watch.id));
}

/** Returns a claimed row to `pending`, due again after a backoff. */
async function reschedule(watch: AiAgentFixWatchRow, detail: string, now: Date): Promise<void> {
  const attempts = watch.attempts + 1;
  await db
    .update(aiAgentFixWatches)
    .set({
      status: 'pending',
      detail,
      attempts,
      dueAt: new Date(now.getTime() + retryDelayMs(attempts - 1)),
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(eq(aiAgentFixWatches.id, watch.id));
}

/**
 * One sweep. Safe to call concurrently with itself — every row is claimed
 * exclusively before any work happens against it.
 */
export async function sweepDueFixWatches(now = new Date()): Promise<FixWatchSweepResult> {
  const result: FixWatchSweepResult = {
    claimed: 0, held: 0, regressed: 0, inconclusive: 0, retried: 0, skippedUnknownContract: 0,
  };

  const claimed = await inSystemDbContext(() => claimDueWatches(now, FIX_WATCH_SWEEP_BATCH));
  result.claimed = claimed.length;

  for (const watch of claimed) {
    // A row written by a NEWER API process may mean something this code does
    // not implement. Refuse it rather than re-score it under the wrong rules —
    // a mixed-version deploy is the ordinary case, not an exotic one.
    if (watch.contractVersion > AI_AGENT_FIX_WATCH_CONTRACT_VERSION) {
      result.skippedUnknownContract += 1;
      await inSystemDbContext(() => finalize(
        watch,
        'cancelled',
        `watch contract v${watch.contractVersion} is newer than this process understands`,
        now,
      ));
      continue;
    }

    const circuitKey = {
      orgId: watch.orgId,
      agentId: watch.agentId,
      deviceId: watch.deviceId,
      opKey: watch.opKey,
      targetFingerprint: watch.targetFingerprint,
    };

    // Captured BEFORE the check, released only if it still holds afterwards:
    // this is the window in which a human could clear the breaker while the
    // device read is in flight.
    const epoch = await inSystemDbContext(() => readCircuitEpoch(circuitKey));

    // Deliberately outside every DB context — see the header.
    const check = await runFixWatchCheck(watch);

    if (check.verdict === 'inconclusive') {
      const exhausted = watch.attempts + 1 >= FIX_WATCH_MAX_ATTEMPTS;
      if (exhausted) {
        result.inconclusive += 1;
        await inSystemDbContext(() => finalize(watch, 'inconclusive', check.detail, now));
      } else {
        result.retried += 1;
        await inSystemDbContext(() => reschedule(watch, check.detail, now));
      }
      continue;
    }

    if (check.verdict === 'held') {
      result.held += 1;
      await inSystemDbContext(async () => {
        await finalize(watch, 'held', check.detail, now);
        await recordCircuitSuccess(circuitKey, now);
      });
      continue;
    }

    result.regressed += 1;
    const circuit = await inSystemDbContext(async () => {
      await finalize(watch, 'regressed', check.detail, now);
      return recordCircuitFailure({
        ...circuitKey,
        source: 'fix_regressed',
        reason: check.detail,
        expectedEpoch: epoch,
        now,
      });
    });

    // Its own notification, never a second run-finished one: that one was sent
    // (and deduped) when the run ended, and it said the fix worked.
    await notifyFixRegressed({ watch, detail: check.detail, circuitOpened: circuit.opened });
  }

  return result;
}
