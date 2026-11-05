/**
 * Wisp check-in timers (#10991, W02 #10993) — a follow-up Wisp schedules on
 * its own thread (`wisp_check_ins`, migrations/2027-01-20-130000-wisp-check-ins.sql).
 *
 *   createCheckIn          ceiling + window + per-thread cap, insert, then
 *                          enqueue the delayed `check-in` job on wisp-wake.
 *   listCheckIns           the grant's scheduled + fired rows, due first.
 *   cancelCheckIn          scheduled | fired → cancelled, then drop the job.
 *   fireCheckIn            the job body (jobs/wispWakeScheduler.ts): verify
 *                          the row is `scheduled` → notifyUser (which writes
 *                          the `check_in` post and the bell row in one step,
 *                          deduped on `wisp.check_in:<id>`) → compare-and-set
 *                          scheduled → fired. In that order so a retry after a
 *                          failed notifyUser still notifies, and a retry after
 *                          a crash before the flip writes nothing twice.
 *   reconcileOrphanCheckIns  the 5-minute tick's sweep: a `scheduled` row
 *                          overdue by more than the grace with no live job
 *                          (Redis lost it) is re-enqueued with delay 0.
 *
 * Lifecycle: scheduled → fired → consumed; scheduled | fired → cancelled.
 * Every transition is a compare-and-set on the expected status, so a cancel
 * that races the fire path always ends `cancelled` (the post may exist; the
 * next turn never prepends a cancelled row).
 *
 * DB access: every read and write runs in a FRESH system context
 * (`runOutsideDbContext(withSystemDbAccessContext)`); every enqueue, job
 * removal and notifyUser call happens after that block has returned (#1105).
 */
import { randomUUID } from 'node:crypto';
import { and, asc, count, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  WISP_CHECK_IN_INSTRUCTION_MAX,
  WISP_CHECK_IN_MAX_DELAY_MINUTES,
  WISP_CHECK_IN_MAX_SCHEDULED_PER_THREAD,
  WISP_CHECK_IN_MIN_DELAY_MINUTES,
  type WispCheckIn,
  type WispCheckInContext,
} from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { wispGrants } from '../../db/schema/wisp';
import { wispCheckIns, type WispCheckInRow } from '../../db/schema/wispCheckIns';
import { wispThreads } from '../../db/schema/wispThreads';
import { captureException } from '../sentry';
import { assertWithinCeiling, type GrantCeiling } from './grantAuthority';
import { notifyUser } from './notifyUser';
import { mobileDeepLink } from './nudgeLinks';
import { checkInJobId, enqueueCheckIn, isCheckInJobLive, removeCheckInJob } from './wake';

/** A `scheduled` row this far past due with no live job is treated as orphaned. */
export const CHECK_IN_RECONCILE_GRACE_MS = 120_000;
/** Orphans re-enqueued per tick, oldest due first; the rest wait for the next tick. */
export const CHECK_IN_RECONCILE_LIMIT = 200;
/**
 * A sweep stops after this many failed rows: a Redis outage fails every row
 * the same way, and reporting 200 of them per tick would flood Sentry. The
 * rows left over are retried on the next tick.
 */
export const CHECK_IN_RECONCILE_MAX_FAILURES = 5;
/** listCheckIns never returns more than this, whatever `limit` asks for. */
const LIST_LIMIT_MAX = 100;
/** Code points of the instruction shown in the post / bell title. */
const TITLE_INSTRUCTION_CHARS = 80;

const MIN_DELAY_MS = WISP_CHECK_IN_MIN_DELAY_MINUTES * 60_000;
const MAX_DELAY_MS = WISP_CHECK_IN_MAX_DELAY_MINUTES * 60_000;

/** The due time is outside 1 minute .. 7 days after scheduling. */
export class CheckInWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckInWindowError';
  }
}

/** The thread already holds WISP_CHECK_IN_MAX_SCHEDULED_PER_THREAD scheduled check-ins. */
export class CheckInLimitReachedError extends Error {
  constructor(threadId: string) {
    super(`thread ${threadId} already has ${WISP_CHECK_IN_MAX_SCHEDULED_PER_THREAD} scheduled check-ins`);
    this.name = 'CheckInLimitReachedError';
  }
}

function sys<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function report(op: string, err: unknown, tags: Record<string, string>): void {
  console.error(`[wisp.checkIns] ${op} failed`, { ...tags, error: errMessage(err) });
  captureException(err, undefined, { component: 'wisp.checkIns', op, ...tags });
}

// ---------------------------------------------------------------------------
// Create / list / cancel (on behalf of a grant)
// ---------------------------------------------------------------------------

/** The grant's thread (threads and grants are 1:1), or null when it has none yet. */
export async function threadForGrant(grantId: string): Promise<{ id: string; partnerId: string } | null> {
  const [row] = await sys(() => db
    .select({ id: wispThreads.id, partnerId: wispThreads.partnerId })
    .from(wispThreads)
    .where(eq(wispThreads.grantId, grantId))
    .limit(1), 'wisp-check-in-thread-for-grant');
  return row ?? null;
}

/**
 * Schedule one check-in on `threadId`, which must be the ceiling's grant's own
 * thread. `orgId` is the session's org (null = a partner-level thread) and
 * must be inside the live ceiling; an inactive grant writes nothing.
 * `created_at` is `now`, the same clock the window was checked against (the
 * DB CHECK bounds `due_at` by the row's own `created_at`).
 *
 * The job is enqueued after the insert has committed. If that enqueue fails
 * the row is still returned: the tick's reconcile fires it within the grace
 * plus one tick of its due time.
 */
export async function createCheckIn(
  ceiling: GrantCeiling,
  input: {
    threadId: string;
    sessionId: string | null;
    dueAt: Date;
    instruction: string;
    orgId: string | null;
    context: WispCheckInContext | null;
  },
  now: Date = new Date(),
): Promise<WispCheckInRow> {
  // Status gate always; the org term only for an org-scoped check-in (a
  // partner-level thread's check-in is about the thread, not a partner-wide
  // subject).
  assertWithinCeiling(ceiling, input.orgId === null ? {} : { orgId: input.orgId });

  const delayMs = input.dueAt.getTime() - now.getTime();
  if (!Number.isFinite(delayMs) || delayMs < MIN_DELAY_MS || delayMs > MAX_DELAY_MS) {
    throw new CheckInWindowError(
      `a check-in must be due between ${WISP_CHECK_IN_MIN_DELAY_MINUTES} minute and ${WISP_CHECK_IN_MAX_DELAY_MINUTES / 1440} days from now`,
    );
  }
  // Tools validate with Zod first; this is belt and braces for the DB CHECK.
  const chars = Array.from(input.instruction).length;
  if (input.instruction.trim() === '' || chars > WISP_CHECK_IN_INSTRUCTION_MAX) {
    throw new RangeError(`a check-in instruction must be 1 to ${WISP_CHECK_IN_INSTRUCTION_MAX} characters`);
  }

  const row = await sys(async () => {
    const [thread] = await db
      .select({ id: wispThreads.id })
      .from(wispThreads)
      .where(and(
        eq(wispThreads.id, input.threadId),
        eq(wispThreads.grantId, ceiling.grantId),
        eq(wispThreads.partnerId, ceiling.partnerId),
      ))
      .limit(1);
    if (!thread) throw new Error(`createCheckIn: thread ${input.threadId} is not grant ${ceiling.grantId}'s thread`);

    // Serialise creates per thread (the createWatch precedent) so two racing
    // creates cannot both pass the cap.
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('wisp.check_ins.create'), hashtext(${input.threadId}))`);
    const [counted] = await db
      .select({ n: count() })
      .from(wispCheckIns)
      .where(and(eq(wispCheckIns.threadId, input.threadId), eq(wispCheckIns.status, 'scheduled')));
    if (Number(counted?.n ?? 0) >= WISP_CHECK_IN_MAX_SCHEDULED_PER_THREAD) throw new CheckInLimitReachedError(input.threadId);

    const id = randomUUID();
    const [inserted] = await db
      .insert(wispCheckIns)
      .values({
        id,
        partnerId: ceiling.partnerId,
        orgId: input.orgId,
        grantId: ceiling.grantId,
        threadId: input.threadId,
        sessionId: input.sessionId,
        userId: ceiling.grantorUserId,
        dueAt: input.dueAt,
        instruction: input.instruction,
        context: input.context,
        status: 'scheduled',
        jobId: checkInJobId(id),
        createdAt: now,
      })
      .returning();
    if (!inserted) throw new Error('wisp_check_ins insert returned no row');
    return inserted;
  }, 'wisp-check-in-create');

  try {
    await enqueueCheckIn(row.id, delayMs);
  } catch (err) {
    report('enqueue', err, { checkInId: row.id, grantId: row.grantId });
  }
  return row;
}

/** The grant's `scheduled` and `fired` (not yet consumed) check-ins, due first. */
export async function listCheckIns(grantId: string, opts: { limit: number }): Promise<WispCheckInRow[]> {
  const limit = Math.max(1, Math.min(LIST_LIMIT_MAX, Math.trunc(opts.limit) || 1));
  return sys(() => db
    .select()
    .from(wispCheckIns)
    .where(and(eq(wispCheckIns.grantId, grantId), inArray(wispCheckIns.status, ['scheduled', 'fired'])))
    .orderBy(asc(wispCheckIns.dueAt), asc(wispCheckIns.id))
    .limit(limit), 'wisp-check-in-list');
}

/**
 * Cancel one of the grant's own check-ins. null when it does not exist, is
 * another grant's, or is no longer cancellable (consumed / cancelled). The
 * job is removed afterwards, best effort: fireCheckIn's compare-and-set on
 * `scheduled` is what keeps a cancelled row cancelled, not the removal.
 */
export async function cancelCheckIn(grantId: string, checkInId: string, now: Date = new Date()): Promise<WispCheckInRow | null> {
  const [row] = await sys(() => db
    .update(wispCheckIns)
    .set({ status: 'cancelled', cancelledAt: now })
    .where(and(
      eq(wispCheckIns.id, checkInId),
      eq(wispCheckIns.grantId, grantId),
      inArray(wispCheckIns.status, ['scheduled', 'fired']),
    ))
    .returning(), 'wisp-check-in-cancel');
  if (!row) return null;
  try {
    await removeCheckInJob(checkInId);
  } catch (err) {
    report('remove_job', err, { checkInId, grantId });
  }
  return row;
}

// ---------------------------------------------------------------------------
// Fire path (the `check-in` job) and reconcile (the tick)
// ---------------------------------------------------------------------------

/** scheduled → cancelled, compare-and-set. True when this call made the change. */
async function cancelScheduled(checkInId: string, now: Date): Promise<boolean> {
  const changed = await sys(() => db
    .update(wispCheckIns)
    .set({ status: 'cancelled', cancelledAt: now })
    .where(and(eq(wispCheckIns.id, checkInId), eq(wispCheckIns.status, 'scheduled')))
    .returning({ id: wispCheckIns.id }), 'wisp-check-in-cancel-unusable');
  return changed.length > 0;
}

function checkInTitle(instruction: string): string {
  return `Check-in due: ${Array.from(instruction).slice(0, TITLE_INSTRUCTION_CHARS).join('')}`;
}

/**
 * Fire one check-in. 'skipped' — missing, not `scheduled` (already fired,
 * cancelled, consumed), or cancelled while notifyUser ran. 'cancelled' — the
 * grant is no longer usable (paused, revoked, expired) or the row no longer
 * matches its thread / grantor, so it can never be delivered. 'fired' — the
 * grantor was notified and the row is `fired`.
 *
 * A notifyUser throw propagates so BullMQ retries; the row is still
 * `scheduled`, and the retry's notifyUser is a no-op if the first one had
 * already committed (dedupe key `wisp.check_in:<id>`).
 */
export async function fireCheckIn(checkInId: string, now: Date = new Date()): Promise<'fired' | 'cancelled' | 'skipped'> {
  const [read] = await sys(() => db
    .select({
      row: wispCheckIns,
      threadGrantId: wispThreads.grantId,
      grantStatus: wispGrants.status,
      grantExpiresAt: wispGrants.expiresAt,
      grantorUserId: wispGrants.grantorUserId,
    })
    .from(wispCheckIns)
    .leftJoin(wispThreads, and(eq(wispThreads.id, wispCheckIns.threadId), eq(wispThreads.partnerId, wispCheckIns.partnerId)))
    .leftJoin(wispGrants, and(eq(wispGrants.id, wispCheckIns.grantId), eq(wispGrants.partnerId, wispCheckIns.partnerId)))
    .where(eq(wispCheckIns.id, checkInId))
    .limit(1), 'wisp-check-in-fire-read');
  if (!read || read.row.status !== 'scheduled') return 'skipped';
  const { row } = read;

  // Each of these would make notifyUser throw on every retry (or deliver
  // under a grant that may no longer act): end the row instead.
  const unusable =
    read.grantStatus !== 'active'
    || !read.grantExpiresAt || read.grantExpiresAt.getTime() <= now.getTime()
    || read.threadGrantId !== row.grantId
    || read.grantorUserId !== row.userId;
  if (unusable) {
    console.info('[wisp.checkIns] check-in cancelled: grant or thread no longer usable', {
      checkInId, grantId: row.grantId, grantStatus: read.grantStatus ?? 'missing',
    });
    return (await cancelScheduled(checkInId, now)) ? 'cancelled' : 'skipped';
  }

  await notifyUser({
    category: 'wisp_nudge',
    kind: 'check_in',
    userId: row.userId,
    grantId: row.grantId,
    threadId: row.threadId,
    concernId: null,
    checkIn: { id: row.id, orgId: row.orgId },
    title: checkInTitle(row.instruction),
    body: row.instruction,
    deepLink: mobileDeepLink(row.threadId, null),
  });

  const flipped = await sys(() => db
    .update(wispCheckIns)
    .set({ status: 'fired', firedAt: now })
    .where(and(eq(wispCheckIns.id, checkInId), eq(wispCheckIns.status, 'scheduled')))
    .returning({ id: wispCheckIns.id }), 'wisp-check-in-fire-flip');
  return flipped.length > 0 ? 'fired' : 'skipped';
}

/**
 * Re-enqueue (delay 0) every `scheduled` row overdue by more than the grace
 * whose job is not live, at most CHECK_IN_RECONCILE_LIMIT per call, oldest
 * due first. A row whose job is live (waiting, delayed incl. a retry backoff,
 * active) is left to it. Per-row failures are reported and skipped; after
 * CHECK_IN_RECONCILE_MAX_FAILURES of them the sweep stops until the next tick.
 */
export async function reconcileOrphanCheckIns(now: Date): Promise<{ refired: number }> {
  const cutoff = new Date(now.getTime() - CHECK_IN_RECONCILE_GRACE_MS);
  const overdue = await sys(() => db
    .select({ id: wispCheckIns.id })
    .from(wispCheckIns)
    .where(and(eq(wispCheckIns.status, 'scheduled'), lt(wispCheckIns.dueAt, cutoff)))
    .orderBy(asc(wispCheckIns.dueAt), asc(wispCheckIns.id))
    .limit(CHECK_IN_RECONCILE_LIMIT), 'wisp-check-in-reconcile');

  if (overdue.length === CHECK_IN_RECONCILE_LIMIT) {
    // Live-job rows count against the page too, so a long backlog can push a
    // real orphan to a later tick. Visible here rather than silent.
    console.warn('[wisp.checkIns] reconcile page full; older overdue rows first, the rest wait for the next tick', { limit: CHECK_IN_RECONCILE_LIMIT });
  }

  let refired = 0;
  let failures = 0;
  for (const { id } of overdue) {
    try {
      if (await isCheckInJobLive(id)) continue;
      await enqueueCheckIn(id, 0);
      refired += 1;
    } catch (err) {
      report('reconcile_row', err, { checkInId: id });
      failures += 1;
      if (failures >= CHECK_IN_RECONCILE_MAX_FAILURES) {
        console.error('[wisp.checkIns] reconcile stopped after repeated failures; retried next tick', { failures, refired });
        break;
      }
    }
  }
  return { refired };
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

export function toCheckInDto(row: WispCheckInRow): WispCheckIn {
  return {
    id: row.id,
    threadId: row.threadId,
    status: row.status,
    dueAt: row.dueAt.toISOString(),
    instruction: row.instruction,
    subject: row.context?.subject ?? null,
    firedAt: row.firedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
