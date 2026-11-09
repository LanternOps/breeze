/**
 * Wisp check-in timers (#10991, W02 #10993) — a follow-up Wisp schedules on
 * its own thread (`wisp_check_ins`, migrations/2027-01-20-130000-wisp-check-ins.sql).
 *
 *   createCheckIn          ceiling + window + per-thread cap, insert, then
 *                          enqueue the delayed `check-in` job on wisp-wake
 *                          (an event row is then fired at once if its event
 *                          already happened).
 *   listCheckIns           the grant's scheduled + fired rows, due first.
 *   cancelCheckIn          scheduled | fired → cancelled, then drop the job.
 *   fireCheckIn            the job body (jobs/wispWakeScheduler.ts) and the
 *                          event path: verify the row is `scheduled` and
 *                          usable → (event rows) decide fire / cancel / skip
 *                          → claim `fire_reason` → notifyUser (which writes
 *                          the `check_in` post and the bell row in one step,
 *                          deduped on `wisp.check_in:<id>`) → compare-and-set
 *                          scheduled → fired → (event path) remove the delayed
 *                          job. In that order so a retry after a failed
 *                          notifyUser still notifies, and a retry after a
 *                          crash before the flip writes nothing twice.
 *   reconcileOrphanCheckIns  the 5-minute tick's sweep: a `scheduled` row
 *                          overdue by more than the grace with no live job
 *                          (Redis lost it) is re-enqueued with delay 0.
 *
 * Event check-ins (W04 #11493, #10410; checkInTriggers.ts): a row with a
 * `trigger_kind` other than `time` waits for a state (a device online, a
 * script / command / run finished) and its `due_at` is the deadline. It fires
 * on whichever comes first, each re-reading the subject:
 *   - at scheduling (createCheckIn), when the state already holds;
 *   - on the bus event (handleCheckInTriggerEvent, subscriber
 *     `wisp-check-in-trigger`);
 *   - on the tick (reconcileCheckInTriggers), for rows before their deadline;
 *   - at `due_at` (the delayed job): `event` if the state holds by then,
 *     otherwise `deadline` ("Did not happen by HH:MM UTC: …").
 * `fire_reason` is written first as the claim (claimCheckInFire), so one
 * reason wins. A subject deleted or moved outside the live ceiling cancels
 * the row with a `cancel_reason` instead of firing it.
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
import { and, asc, count, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import {
  WISP_CHECK_IN_INSTRUCTION_MAX,
  WISP_CHECK_IN_MAX_DELAY_MINUTES,
  WISP_CHECK_IN_MAX_SCHEDULED_PER_THREAD,
  WISP_CHECK_IN_MIN_DELAY_MINUTES,
  WISP_CHECK_IN_PENDING_STATE_LINES,
  type WispCheckIn,
  type WispCheckInContext,
  type WispCheckInFireReason,
  type WispCheckInMode,
  type WispCheckInTriggerEvent,
} from '@breeze/shared';
import { wispEnabled } from '../../config/env';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { wispGrants } from '../../db/schema/wisp';
import { wispCheckIns, type WispCheckInRow } from '../../db/schema/wispCheckIns';
import { wispThreads } from '../../db/schema/wispThreads';
import type { BreezeEvent } from '../eventBus';
import { captureException } from '../sentry';
import {
  isTriggerEvent,
  loadTriggerSubject,
  triggerConditionOf,
  triggerSubjectScope,
  type CheckInEvidence,
  type TriggerGoneReason,
} from './checkInTriggers';
import { checkInTitle, fireRunCheckIn } from './checkInRuns';
import { assertWithinCeiling, GrantInactiveError, resolveGrantCeiling, type GrantCeiling } from './grantAuthority';
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
export async function threadForGrant(grantId: string): Promise<{ id: string; partnerId: string; focusOrgId: string | null } | null> {
  const [row] = await sys(() => db
    .select({ id: wispThreads.id, partnerId: wispThreads.partnerId, focusOrgId: wispThreads.focusOrgId })
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
 *
 * `trigger` (W04 #11493) makes it an event check-in: `dueAt` is then the
 * deadline, and `orgId` must be the trigger subject's own org (the tool reads
 * it from the subject and checks the subject against the ceiling first).
 *
 * `mode: 'run'` (W07 #11496) makes it a run check-in: it needs an org, and the
 * row pins the ceiling's revision (`grant_revision_id`) so a later revision of
 * the grant never applies to the run. Every row records that revision.
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
    /** Absent / null = a time check-in. */
    trigger?: { kind: WispCheckInTriggerEvent; subjectId: string } | null;
    /** Absent = `notify`. */
    mode?: WispCheckInMode;
  },
  now: Date = new Date(),
): Promise<WispCheckInRow> {
  const mode: WispCheckInMode = input.mode ?? 'notify';
  // A run assesses one org; a partner-level run would have nothing to assess.
  if (mode === 'run' && input.orgId === null) throw new Error('createCheckIn: a run check-in needs an org');
  // An event's subject always belongs to an org; a partner-level event row would have no org to re-check at fire time.
  if (input.trigger && input.orgId === null) throw new Error('createCheckIn: an event check-in needs its subject\'s org');
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
    // creates cannot both pass the cap. A `running` row (W07) still holds its
    // place: its run has not posted yet.
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('wisp.check_ins.create'), hashtext(${input.threadId}))`);
    const [counted] = await db
      .select({ n: count() })
      .from(wispCheckIns)
      .where(and(eq(wispCheckIns.threadId, input.threadId), inArray(wispCheckIns.status, ['scheduled', 'running'])));
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
        triggerKind: input.trigger?.kind ?? 'time',
        triggerSubjectId: input.trigger?.subjectId ?? null,
        mode,
        grantRevisionId: ceiling.revisionId,
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

  // An event that already happened fires now. Checked AFTER the insert and the
  // deadline enqueue, so an event that lands between the tool's subject read
  // and the insert is still seen here (or by the tick). A failure here is
  // reported, not thrown: the row is scheduled and the tick re-checks it.
  if (row.triggerKind !== 'time') {
    let outcome: Awaited<ReturnType<typeof fireCheckIn>> = 'skipped';
    try {
      outcome = await fireCheckIn(row.id, now, { path: 'event' });
    } catch (err) {
      report('fire_on_schedule', err, { checkInId: row.id, grantId: row.grantId });
    }
    if (outcome !== 'skipped') {
      // The caller must not say "scheduled" about a row that already fired or
      // was cancelled; if the re-read fails, the outcome stands in for it.
      try {
        const [after] = await sys(() => db.select().from(wispCheckIns).where(eq(wispCheckIns.id, row.id)).limit(1), 'wisp-check-in-create-reread');
        if (after) return after;
      } catch (err) {
        report('reread_after_fire', err, { checkInId: row.id, grantId: row.grantId });
      }
      return outcome === 'fired' || outcome === 'running'
        ? { ...row, status: outcome, firedAt: now }
        : { ...row, status: 'cancelled', cancelledAt: now };
    }
  }
  return row;
}

/** The grant's `scheduled`, `running` (W07) and `fired` (not yet consumed) check-ins, due first. */
export async function listCheckIns(grantId: string, opts: { limit: number }): Promise<WispCheckInRow[]> {
  const limit = Math.max(1, Math.min(LIST_LIMIT_MAX, Math.trunc(opts.limit) || 1));
  return sys(() => db
    .select()
    .from(wispCheckIns)
    .where(and(eq(wispCheckIns.grantId, grantId), inArray(wispCheckIns.status, ['scheduled', 'running', 'fired'])))
    .orderBy(asc(wispCheckIns.dueAt), asc(wispCheckIns.id))
    .limit(limit), 'wisp-check-in-list');
}

/**
 * Cancel one of the grant's own check-ins. null when it does not exist, is
 * another grant's, or is no longer cancellable (consumed / cancelled). The
 * job is removed afterwards, best effort: fireCheckIn's compare-and-set on
 * `scheduled` is what keeps a cancelled row cancelled, not the removal.
 * A `running` row (W07) can be cancelled too: its run is not stopped (it is
 * read-only and already admitted), but its result is never posted
 * (postCheckInRunResult only settles a `running` row).
 */
export async function cancelCheckIn(grantId: string, checkInId: string, now: Date = new Date()): Promise<WispCheckInRow | null> {
  const [row] = await sys(() => db
    .update(wispCheckIns)
    .set({ status: 'cancelled', cancelledAt: now })
    .where(and(
      eq(wispCheckIns.id, checkInId),
      eq(wispCheckIns.grantId, grantId),
      inArray(wispCheckIns.status, ['scheduled', 'running', 'fired']),
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

/**
 * Why Breeze cancelled a check-in it could never deliver (`cancel_reason`):
 * the grant is not usable, the row no longer matches its thread / grantor, or
 * (an event row) its subject is gone or outside the live ceiling.
 */
export type CheckInCancelReason = 'grant_inactive' | 'thread_mismatch' | 'grantor_changed' | TriggerGoneReason;

/**
 * Who is firing: `job` — the delayed job at `due_at` and the orphan refire
 * (a time row fires `due`; an event row fires `event` if its state holds,
 * else `deadline`); `event` — the bus event, the tick and the scheduling
 * call (an event row fires only when its state holds; a time row never).
 */
export type CheckInFirePath = 'job' | 'event';

/**
 * A deadline job this far before `due_at` fires nothing (clock skew between
 * the process that enqueued it and the worker); the orphan reconcile refires
 * it after `due_at`.
 */
export const CHECK_IN_DEADLINE_EARLY_TOLERANCE_MS = 60_000;

/** scheduled → cancelled with a reason, compare-and-set. True when this call made the change. */
async function cancelScheduled(checkInId: string, now: Date, reason: CheckInCancelReason): Promise<boolean> {
  const changed = await sys(() => db
    .update(wispCheckIns)
    .set({ status: 'cancelled', cancelledAt: now, cancelReason: reason })
    .where(and(eq(wispCheckIns.id, checkInId), eq(wispCheckIns.status, 'scheduled')))
    .returning({ id: wispCheckIns.id }), 'wisp-check-in-cancel-unusable');
  return changed.length > 0;
}

/**
 * The fire claim: record `reason` on a still-`scheduled` row unless a
 * DIFFERENT reason already claimed it. Written before notifyUser, so exactly
 * one reason wins the event / tick / deadline race and the post always says
 * the reason the row ends with. The same reason may claim again: that is a
 * retry, and notifyUser's dedupe key makes the second post a no-op.
 */
export async function claimCheckInFire(checkInId: string, reason: WispCheckInFireReason): Promise<boolean> {
  const claimed = await sys(() => db
    .update(wispCheckIns)
    .set({ fireReason: reason })
    .where(and(
      eq(wispCheckIns.id, checkInId),
      eq(wispCheckIns.status, 'scheduled'),
      or(isNull(wispCheckIns.fireReason), eq(wispCheckIns.fireReason, reason)),
    ))
    .returning({ id: wispCheckIns.id }), 'wisp-check-in-fire-claim');
  return claimed.length > 0;
}

/** `HH:MM UTC`; a deadline post is written at (or just after) that time, so the date is not needed. */
function utcClock(at: Date): string {
  return `${at.toISOString().slice(11, 16)} UTC`;
}

/**
 * The post / bell body for a fire: the instruction, or for a `deadline` fire
 * what did not happen by the due time first ("Did not happen by 15:40 UTC:
 * the device is still offline. <instruction>"). Built from the row alone, so
 * a re-fire of a claimed row (fireCheckIn) writes the same body.
 */
export function checkInPostBody(row: Pick<WispCheckInRow, 'instruction' | 'triggerKind' | 'dueAt'>, reason: WispCheckInFireReason): string {
  if (reason !== 'deadline' || row.triggerKind === 'time') return row.instruction;
  return `Did not happen by ${utcClock(row.dueAt)}: ${WISP_CHECK_IN_PENDING_STATE_LINES[row.triggerKind]}. ${row.instruction}`;
}

type FireRead = {
  row: WispCheckInRow;
  threadGrantId: string | null;
  grantStatus: string | null;
  grantExpiresAt: Date | null;
  grantorUserId: string | null;
  grantRevisionId: string | null;
};

/** The usability checks (grant, thread, grantor), each with its cancel reason; null = usable. */
function unusableReason(read: FireRead, now: Date): CheckInCancelReason | null {
  if (read.grantStatus !== 'active' || !read.grantExpiresAt || read.grantExpiresAt.getTime() <= now.getTime()) return 'grant_inactive';
  if (read.threadGrantId !== read.row.grantId) return 'thread_mismatch';
  if (read.grantorUserId !== read.row.userId) return 'grantor_changed';
  return null;
}

type EventDecision =
  | { kind: 'fire'; reason: WispCheckInFireReason; evidence: CheckInEvidence | null }
  | { kind: 'cancel'; reason: CheckInCancelReason }
  | { kind: 'skip' };

/**
 * What an event row does now. A claimed reason is honoured (a crash between
 * the claim and the flip is re-fired with it); a `deadline` claim belongs to
 * the job path, so the event path leaves it. The subject is read first and a
 * deleted one cancels; a still-pending state on the event path stops there,
 * without resolving the grant. Anything that would post (the state holds, the
 * deadline, a re-fire) re-checks the subject against the LIVE ceiling first:
 * org, site and the kind's read permission, as at scheduling, so a revision
 * that dropped any of them cancels with `outside_ceiling`.
 */
async function decideEventFire(read: FireRead, path: CheckInFirePath, now: Date): Promise<EventDecision> {
  const { row } = read;
  if (!isTriggerEvent(row.triggerKind) || row.triggerSubjectId === null) return { kind: 'skip' };
  const claimed = row.fireReason ?? null;
  if (claimed !== null && path === 'event' && claimed !== 'event') return { kind: 'skip' };

  const subject = await loadTriggerSubject(row.triggerKind, row.triggerSubjectId);
  if (!subject || subject.partnerId !== row.partnerId) return { kind: 'cancel', reason: 'subject_deleted' };
  const condition = triggerConditionOf(subject, now);
  if (claimed === null && !condition.met) {
    if (path === 'event') return { kind: 'skip' };
    if (now.getTime() < row.dueAt.getTime() - CHECK_IN_DEADLINE_EARLY_TOLERANCE_MS) return { kind: 'skip' };
  }

  let ceiling: GrantCeiling;
  try {
    if (!read.grantRevisionId) throw new GrantInactiveError(row.grantId, 'active', 'no pinned revision', 'corrupt');
    ceiling = await resolveGrantCeiling(row.grantId, read.grantRevisionId);
  } catch (err) {
    if (!(err instanceof GrantInactiveError)) throw err;
    // Wisp switched off on this deployment is not the grant's doing: leave the
    // row for when it is back on (the orphan reconcile refires it then).
    if (!wispEnabled()) {
      console.info('[wisp.checkIns] event check-in left scheduled: Wisp is disabled', { checkInId: row.id });
      return { kind: 'skip' };
    }
    if (err.kind === 'corrupt') captureException(err, undefined, { component: 'wisp.checkIns', op: 'fire_ceiling', checkInId: row.id, grantId: row.grantId });
    return { kind: 'cancel', reason: 'grant_inactive' };
  }
  const gone = triggerSubjectScope(subject, ceiling);
  if (gone) return { kind: 'cancel', reason: gone };
  // W07: what the state showed, for a run check-in's assessment (null when it did not hold).
  const evidence = condition.met ? condition.evidence : null;
  if (claimed !== null) return { kind: 'fire', reason: claimed, evidence };
  return { kind: 'fire', reason: condition.met ? 'event' : 'deadline', evidence };
}

/**
 * Fire one check-in. 'running' — a run check-in (W07) admitted its
 * assessment run (checkInRuns.ts fireRunCheckIn); its result is posted when
 * the run settles. 'skipped' — missing, not `scheduled` (already fired,
 * cancelled, consumed), cancelled while notifyUser ran, claimed by another
 * reason, or (an event row) not due on this path yet. 'cancelled' — it can
 * never be delivered: the grant is no longer usable (paused, revoked,
 * expired), the row no longer matches its thread / grantor, or an event row's
 * subject is deleted or outside the live ceiling; `cancel_reason` says which.
 * 'fired' — the grantor was notified and the row is `fired`.
 *
 * Order: usability → (event rows) the trigger decision → the claim
 * (`claimCheckInFire`) → notifyUser → compare-and-set scheduled → fired →
 * (event path) remove the delayed job. A notifyUser throw propagates so
 * BullMQ retries; the row is still `scheduled` and claimed, and the retry's
 * notifyUser is a no-op if the first one had already committed (dedupe key
 * `wisp.check_in:<id>`).
 */
export async function fireCheckIn(
  checkInId: string,
  now: Date = new Date(),
  opts: { path?: CheckInFirePath } = {},
): Promise<'fired' | 'running' | 'cancelled' | 'skipped'> {
  const path = opts.path ?? 'job';
  const [read] = await sys(() => db
    .select({
      row: wispCheckIns,
      threadGrantId: wispThreads.grantId,
      grantStatus: wispGrants.status,
      grantExpiresAt: wispGrants.expiresAt,
      grantorUserId: wispGrants.grantorUserId,
      grantRevisionId: wispGrants.currentRevisionId,
    })
    .from(wispCheckIns)
    .leftJoin(wispThreads, and(eq(wispThreads.id, wispCheckIns.threadId), eq(wispThreads.partnerId, wispCheckIns.partnerId)))
    .leftJoin(wispGrants, and(eq(wispGrants.id, wispCheckIns.grantId), eq(wispGrants.partnerId, wispCheckIns.partnerId)))
    .where(eq(wispCheckIns.id, checkInId))
    .limit(1), 'wisp-check-in-fire-read');
  if (!read || read.row.status !== 'scheduled') return 'skipped';
  const { row } = read;
  // The event path only ever selects event rows; belt and braces.
  if (path === 'event' && row.triggerKind === 'time') return 'skipped';

  // Each of these would make notifyUser throw on every retry (or deliver
  // under a grant that may no longer act): end the row instead.
  const unusable = unusableReason(read, now);
  if (unusable) {
    console.info('[wisp.checkIns] check-in cancelled: grant or thread no longer usable', {
      checkInId, grantId: row.grantId, grantStatus: read.grantStatus ?? 'missing', reason: unusable,
    });
    return (await cancelScheduled(checkInId, now, unusable)) ? 'cancelled' : 'skipped';
  }

  let reason: WispCheckInFireReason = 'due';
  let evidence: CheckInEvidence | null = null;
  if (row.triggerKind !== 'time') {
    const decision = await decideEventFire(read, path, now);
    if (decision.kind === 'skip') return 'skipped';
    if (decision.kind === 'cancel') {
      console.info('[wisp.checkIns] event check-in cancelled', {
        checkInId, grantId: row.grantId, reason: decision.reason, triggerKind: row.triggerKind, subjectId: row.triggerSubjectId,
      });
      return (await cancelScheduled(checkInId, now, decision.reason)) ? 'cancelled' : 'skipped';
    }
    reason = decision.reason;
    evidence = decision.evidence;
  }

  if (!(await claimCheckInFire(checkInId, reason))) return 'skipped';

  // W07: a run check-in checks on its own instead of posting the instruction.
  if (row.mode === 'run') {
    const outcome = await fireRunCheckIn(row, {
      currentRevisionId: read.grantRevisionId,
      fireReason: reason,
      evidence,
      postBody: checkInPostBody(row, reason),
      now,
    });
    if (outcome === 'skipped') return 'skipped';
    if (path === 'event') await removeDeadlineJob(checkInId, row.grantId);
    return outcome;
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
    body: checkInPostBody(row, reason),
    deepLink: mobileDeepLink(row.threadId, null),
  });

  const flipped = await sys(() => db
    .update(wispCheckIns)
    .set({ status: 'fired', firedAt: now })
    .where(and(eq(wispCheckIns.id, checkInId), eq(wispCheckIns.status, 'scheduled')))
    .returning({ id: wispCheckIns.id }), 'wisp-check-in-fire-flip');
  if (flipped.length === 0) return 'skipped';

  if (path === 'event') await removeDeadlineJob(checkInId, row.grantId);
  return 'fired';
}

/**
 * Fired ahead of its deadline: the deadline job has nothing left to do. Best
 * effort — that job finds the row no longer `scheduled` and skips anyway.
 */
async function removeDeadlineJob(checkInId: string, grantId: string): Promise<void> {
  try {
    await removeCheckInJob(checkInId);
  } catch (err) {
    report('remove_job', err, { checkInId, grantId });
  }
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
// Event check-ins (W04 #11493): the bus-event fast path and the tick reconcile
// ---------------------------------------------------------------------------

/**
 * Bus event → the trigger kind it can satisfy and the payload key holding the
 * subject id. `device_commands` has no bus event: `command_finished` is
 * checked by the tick alone. The `wisp-check-in-trigger` subscriber
 * (eventSubscribers.ts) subscribes to exactly these types.
 */
export const CHECK_IN_TRIGGER_EVENT_SUBJECTS: Readonly<Record<string, { kind: WispCheckInTriggerEvent; idKey: string }>> = Object.freeze({
  'device.online': { kind: 'device_online', idKey: 'deviceId' },
  'script.completed': { kind: 'script_finished', idKey: 'executionId' },
  'script.failed': { kind: 'script_finished', idKey: 'executionId' },
  'ai.agent.run.completed': { kind: 'run_settled', idKey: 'runId' },
  'ai.agent.run.failed': { kind: 'run_settled', idKey: 'runId' },
  'ai.agent.run.skipped': { kind: 'run_settled', idKey: 'runId' },
});
/**
 * Rows one event fires. Many threads can wait on one subject; rows past the
 * limit are fired by the next tick.
 */
export const CHECK_IN_TRIGGER_EVENT_LIMIT = 50;
/** Event rows the tick evaluates per run (one page; see triggerSweepCursor). */
export const CHECK_IN_TRIGGER_RECONCILE_LIMIT = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The event fast path: the scheduled event rows waiting on this event's
 * subject (one partial-index lookup) each get `fireCheckIn(…, { path: 'event' })`,
 * which re-reads the subject's state — the event is a hint, the state decides.
 * Dark while `wispEnabled()` is off. Throws after trying every row when any
 * failed (the subscriber contract), so the delivery retries; fireCheckIn is
 * idempotent, so a retry re-fires nothing.
 */
export async function handleCheckInTriggerEvent(event: BreezeEvent): Promise<void> {
  if (!wispEnabled()) return;
  const mapping = CHECK_IN_TRIGGER_EVENT_SUBJECTS[event.type];
  if (!mapping) return;
  const subjectId = (event.payload as Record<string, unknown> | undefined)?.[mapping.idKey];
  if (typeof subjectId !== 'string' || !UUID_RE.test(subjectId)) return;

  const waiting = await sys(() => db
    .select({ id: wispCheckIns.id })
    .from(wispCheckIns)
    .where(and(
      eq(wispCheckIns.status, 'scheduled'),
      eq(wispCheckIns.triggerKind, mapping.kind),
      eq(wispCheckIns.triggerSubjectId, subjectId),
    ))
    .orderBy(asc(wispCheckIns.dueAt), asc(wispCheckIns.id))
    .limit(CHECK_IN_TRIGGER_EVENT_LIMIT), 'wisp-check-in-trigger-event');

  let firstError: unknown = null;
  for (const { id } of waiting) {
    try {
      await fireCheckIn(id, new Date(), { path: 'event' });
    } catch (err) {
      report('trigger_event_row', err, { checkInId: id, eventType: event.type });
      firstError ??= err;
    }
  }
  if (firstError !== null) throw firstError;
}

/**
 * Where the next tick's page starts when the last page was full (keyset on
 * `(due_at, id)`), so every pending row is evaluated within
 * ceil(rows / CHECK_IN_TRIGGER_RECONCILE_LIMIT) ticks instead of the nearest
 * deadlines starving the rest. Per process: a restart starts from the top,
 * which only re-evaluates rows sooner.
 */
let triggerSweepCursor: { dueAt: Date; id: string } | null = null;

/** Test-only: start the next sweep from the nearest deadline. */
export function _resetCheckInTriggerSweepForTests(): void {
  triggerSweepCursor = null;
}

/**
 * The tick's sweep of event rows whose deadline has not passed yet, a page of
 * CHECK_IN_TRIGGER_RECONCILE_LIMIT at a time in deadline order (a full page
 * hands the next tick a cursor; a short one wraps to the top): each is fired
 * if its state holds (the only fast path `command_finished` and a cancelled
 * script have, and the net under a lost bus event), cancelled if its subject
 * is gone, and left alone while pending. Rows past `due_at` belong to the
 * deadline job and the orphan reconcile. A failing row never stops the sweep
 * (rows behind it would starve); the first CHECK_IN_RECONCILE_MAX_FAILURES are
 * reported and the rest counted in one line.
 */
export async function reconcileCheckInTriggers(
  now: Date,
  opts: { limit?: number } = {},
): Promise<{ fired: number; cancelled: number }> {
  const limit = opts.limit ?? CHECK_IN_TRIGGER_RECONCILE_LIMIT;
  const cursor = triggerSweepCursor;
  const waiting = await sys(() => db
    .select({ id: wispCheckIns.id, dueAt: wispCheckIns.dueAt })
    .from(wispCheckIns)
    .where(and(
      eq(wispCheckIns.status, 'scheduled'),
      ne(wispCheckIns.triggerKind, 'time'),
      gt(wispCheckIns.dueAt, now),
      cursor
        ? or(gt(wispCheckIns.dueAt, cursor.dueAt), and(eq(wispCheckIns.dueAt, cursor.dueAt), gt(wispCheckIns.id, cursor.id)))
        : undefined,
    ))
    .orderBy(asc(wispCheckIns.dueAt), asc(wispCheckIns.id))
    .limit(limit), 'wisp-check-in-trigger-reconcile');
  const last = waiting.at(-1);
  triggerSweepCursor = waiting.length === limit && last ? { dueAt: last.dueAt, id: last.id } : null;
  if (triggerSweepCursor) {
    console.info('[wisp.checkIns] trigger reconcile page full; the next tick continues from here', { limit });
  }

  let fired = 0;
  let cancelled = 0;
  let failures = 0;
  for (const { id } of waiting) {
    try {
      const outcome = await fireCheckIn(id, now, { path: 'event' });
      if (outcome === 'fired' || outcome === 'running') fired += 1;
      else if (outcome === 'cancelled') cancelled += 1;
    } catch (err) {
      failures += 1;
      if (failures <= CHECK_IN_RECONCILE_MAX_FAILURES) report('trigger_reconcile_row', err, { checkInId: id });
    }
  }
  if (failures > CHECK_IN_RECONCILE_MAX_FAILURES) {
    console.error('[wisp.checkIns] trigger reconcile: more rows failed than were reported; retried next tick', {
      failures, reported: CHECK_IN_RECONCILE_MAX_FAILURES, fired, cancelled,
    });
  }
  return { fired, cancelled };
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
    trigger: row.triggerKind !== 'time' && row.triggerSubjectId !== null
      ? { kind: row.triggerKind, subjectId: row.triggerSubjectId }
      : null,
    fireReason: row.fireReason ?? null,
    cancelReason: row.cancelReason ?? null,
    mode: row.mode,
    runId: row.runId ?? null,
  };
}
