/**
 * Wisp run-mode check-ins (W07 #11496, feature #11489; #10410 wave B, spec
 * 2026-11-06-wisp-chat-grant-followups §6.2 B). A check-in scheduled with
 * `mode: 'run'` (the grantor approved it on a card) checks on its own when it
 * fires: it admits ONE read-only assessment run under the grant, and the
 * run's result is posted to the thread when it settles.
 *
 *   fireRunCheckIn          called by fireCheckIn (checkIns.ts) after the fire
 *                           claim. Revision pin → deleted subject device →
 *                           recover an admitted run → enqueueAssessment →
 *                           compare-and-set scheduled → running (run_id set).
 *                           Anything that cannot run degrades to the Phase 1
 *                           post ("I couldn't check on my own: …. Run it now?")
 *                           and the row becomes `fired`, so the instruction
 *                           returns with the grantor's next message.
 *   postCheckInRunResult    the settled run's post: the run's summary
 *                           (sanitised, capped) → `consumed`; a run that did
 *                           not finish → "My check didn't finish (<status>).
 *                           Run it now? …" → `fired`. Called from the run
 *                           loop's finishRun and by the tick's reconcile.
 *   reconcileRunningCheckIns  the 5-minute tick's sweep for `running` rows
 *                           whose run settled without a post (a skipped or
 *                           reaped run never reaches finishRun; a crash
 *                           between settle and post).
 *
 * One post per check-in, ever: every post here goes through notifyUser's
 * `wisp.check_in:<id>` dedupe key, the same key a notify check-in uses.
 *
 * One run per check-in, ever: the run's dedupe key is
 * `checkInRunDedupeKey(id)` on `(org_id, dedupe_key)`, so a BullMQ retry, the
 * event path and the tick all land on the same run, and a crash between the
 * admission and the compare-and-set is recovered by looking the run up.
 *
 * Revision pin (plan Open Decision 5): the row stores the revision it was
 * scheduled under. A grant whose current revision differs runs nothing — a
 * widened revision never applies, a narrowed one never runs it — and
 * enqueueAssessment re-checks the same pin (`requireRevisionId`) when it
 * reads the grant, so a revision landing between the two checks runs nothing
 * either.
 *
 * Untrusted text: the instruction is model-written (the grantor approved it)
 * and is sanitised (`sanitizeCheckInInstruction`) before it enters the run's
 * trigger_ref; the run's summary is model output over device data and is
 * sanitised and capped (`cleanText`) before it is posted.
 *
 * DB access: every read and write runs in a FRESH system context; every
 * admission and notifyUser call happens outside it (#1105).
 */
import { and, asc, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { WispCheckInFireReason } from '@breeze/shared';
import { wispEnabled } from '../../config/env';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { devices } from '../../db/schema/devices';
import { organizations } from '../../db/schema/orgs';
import { wispGrants } from '../../db/schema/wisp';
import { wispCheckIns, type WispCheckInRow } from '../../db/schema/wispCheckIns';
import { wispThreadPosts } from '../../db/schema/wispThreadPosts';
import { wispThreads } from '../../db/schema/wispThreads';
import { captureException } from '../sentry';
import { sanitizeCheckInInstruction } from './checkInTurn';
import { AI_AGENT_RUN_SETTLED_STATUSES, type CheckInEvidence } from './checkInTriggers';
import { GrantInactiveError, resolveGrantCeiling } from './grantAuthority';
import { isOrgReadableOnThread, nudgeDedupeKey, notifyUser } from './notifyUser';
import { mobileDeepLink } from './nudgeLinks';
import { cleanText, SPECIALIST_RESULT_BODY_MAX_CHARS, specialistRunLink } from './specialistResult';

/** Code points of the instruction shown in the post / bell title. */
const TITLE_INSTRUCTION_CHARS = 80;
/** Running rows the tick settles per run, oldest first; the rest wait for the next tick. */
export const CHECK_IN_RUN_RECONCILE_LIMIT = 200;
/** A sweep reports at most this many failed rows (a DB outage fails them all the same way). */
const RECONCILE_MAX_REPORTED_FAILURES = 5;
/**
 * A `running` row older than this is closed out by the tick: a run still not
 * settled (a lost job) posts as did-not-finish, and a row whose post keeps
 * failing is cancelled (`post_failed`), so no row holds a cap slot or the head
 * of the sweep for ever.
 */
export const CHECK_IN_RUN_STALE_MS = 24 * 60 * 60 * 1000;
/** Admission skips that scheduling should have made impossible: reported, not only logged. */
const UNEXPECTED_SKIPS: ReadonlySet<string> = new Set(['grant_org_site_restricted', 'grant_org_out_of_ceiling', 'duplicate']);

/** The run's dedupe key: one check-in admits at most one run. Starts with CHECK_IN_RUN_DEDUPE_PREFIX (assessment.ts). */
export function checkInRunDedupeKey(checkInId: string): string {
  return `wisp-check-in-${checkInId}`;
}

/** The post / bell title of a fire, a degrade or a run that did not finish. */
export function checkInTitle(instruction: string): string {
  return `Check-in due: ${Array.from(instruction).slice(0, TITLE_INSTRUCTION_CHARS).join('')}`;
}

/** The post / bell title of a run's result. */
function checkInResultTitle(instruction: string): string {
  return `Checked: ${Array.from(instruction).slice(0, TITLE_INSTRUCTION_CHARS).join('')}`;
}

/** What the degraded post says stopped the check (the `<reason>` in "I couldn't check on my own: <reason>."). */
export function degradeReasonText(skipped: string): string {
  if (skipped === 'budget_exhausted') return "today's budget is spent";
  if (skipped === 'grant_revision_changed') return 'the grant changed since this was scheduled';
  return 'the check could not start';
}

/** The degraded post: what stopped the check, then the ask and the instruction (or the deadline line + instruction). */
export function degradedBody(skipped: string, postBody: string): string {
  return `I couldn't check on my own: ${degradeReasonText(skipped)}. Run it now? ${postBody}`;
}

export const CHECK_IN_DEVICE_DELETED_BODY = 'The device was deleted; nothing to check.';

function sys<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

function report(op: string, err: unknown, tags: Record<string, string>): void {
  console.error(`[wisp.checkInRuns] ${op} failed`, { ...tags, error: err instanceof Error ? err.message : String(err) });
  captureException(err, undefined, { component: 'wisp.checkInRuns', op, ...tags });
}

/** Deliver one check-in post (kind check_in, deduped on `wisp.check_in:<id>`). */
async function postForCheckIn(
  row: Pick<WispCheckInRow, 'id' | 'orgId' | 'userId' | 'grantId' | 'threadId'>,
  title: string,
  body: string,
  link?: string,
): Promise<'posted' | 'already'> {
  const res = await notifyUser({
    category: 'wisp_nudge',
    kind: 'check_in',
    userId: row.userId,
    grantId: row.grantId,
    threadId: row.threadId,
    concernId: null,
    checkIn: { id: row.id, orgId: row.orgId, ...(link ? { link } : {}) },
    title,
    body,
    deepLink: mobileDeepLink(row.threadId, null),
  });
  // `backoff` with no in-app row is notifyUser's dedupe hit: the post already exists.
  return !res.inApp && res.suppressed === 'backoff' ? 'already' : 'posted';
}

/** This check-in's one post (any of fire, degrade or result) is already on its thread. */
async function checkInPostExists(row: Pick<WispCheckInRow, 'id' | 'threadId' | 'grantId'>): Promise<boolean> {
  // The same key notifyUser writes for a check_in post (one per check-in, ever).
  const key = nudgeDedupeKey({
    kind: 'check_in', checkInId: row.id, concernId: null, grantId: row.grantId, threadId: row.threadId,
    nextEligibleNudgeAt: null, now: new Date(), digestCadenceMinutes: 0,
  });
  const found = await sys(() => db
    .select({ id: wispThreadPosts.id })
    .from(wispThreadPosts)
    .where(and(eq(wispThreadPosts.threadId, row.threadId), eq(wispThreadPosts.dedupeKey, key)))
    .limit(1), 'wisp-check-in-run-post-exists');
  return found.length > 0;
}

/** scheduled → fired (the post asked the grantor), compare-and-set. */
async function flipScheduledToFired(checkInId: string, now: Date): Promise<boolean> {
  const flipped = await sys(() => db
    .update(wispCheckIns)
    .set({ status: 'fired', firedAt: now })
    .where(and(eq(wispCheckIns.id, checkInId), eq(wispCheckIns.status, 'scheduled')))
    .returning({ id: wispCheckIns.id }), 'wisp-check-in-run-degrade-flip');
  return flipped.length > 0;
}

/** scheduled → running with the admitted run, compare-and-set. */
async function markRunning(checkInId: string, runId: string, now: Date): Promise<boolean> {
  const flipped = await sys(() => db
    .update(wispCheckIns)
    .set({ status: 'running', runId, firedAt: now })
    .where(and(eq(wispCheckIns.id, checkInId), eq(wispCheckIns.status, 'scheduled'), eq(wispCheckIns.mode, 'run')))
    .returning({ id: wispCheckIns.id }), 'wisp-check-in-run-mark-running');
  return flipped.length > 0;
}

/**
 * The run this check-in already admitted, by its dedupe key, or null. An
 * admission whose enqueue never landed (`failed` / `enqueue_failed`) is not
 * one: enqueueAssessment reclaims that row instead.
 */
async function findAdmittedRun(orgId: string, checkInId: string): Promise<string | null> {
  const [run] = await sys(() => db
    .select({ id: aiAgentRuns.id, status: aiAgentRuns.status, errorCode: aiAgentRuns.errorCode })
    .from(aiAgentRuns)
    .where(and(eq(aiAgentRuns.orgId, orgId), eq(aiAgentRuns.dedupeKey, checkInRunDedupeKey(checkInId))))
    .limit(1), 'wisp-check-in-run-find');
  if (!run || (run.status === 'failed' && run.errorCode === 'enqueue_failed')) return null;
  return run.id;
}

/** The context subject's device is gone (deleted, or never this partner's). Only a `device` subject is checked. */
async function contextDeviceDeleted(row: WispCheckInRow): Promise<boolean> {
  const subject = row.context?.subject;
  if (!subject || subject.kind !== 'device') return false;
  const [found] = await sys(() => db
    .select({ id: devices.id })
    .from(devices)
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .where(and(eq(devices.id, subject.id), eq(organizations.partnerId, row.partnerId)))
    .limit(1), 'wisp-check-in-run-device');
  return !found;
}

export type RunCheckInFireOutcome = 'running' | 'fired' | 'skipped';

/**
 * Fire one run check-in that fireCheckIn has already verified (usable grant,
 * thread and grantor; an event row's subject inside the live ceiling) and
 * claimed. `postBody` is what a notify fire would post (the instruction, or
 * the deadline line + the instruction): it is the run's instruction and the
 * degraded post's text. 'running' — a run was admitted (or recovered) and the
 * row names it. 'fired' — nothing ran; the grantor was told why and asked to
 * run it now. 'skipped' — the row left `scheduled` meanwhile (cancelled).
 *
 * A throw (DB, admission, notifyUser) propagates so the caller's job retries:
 * the row is still `scheduled` and claimed, the retry recovers an admitted run
 * by its dedupe key, and notifyUser's dedupe key keeps a degraded post to one.
 */
export async function fireRunCheckIn(
  row: WispCheckInRow,
  input: {
    currentRevisionId: string | null;
    fireReason: WispCheckInFireReason;
    evidence: CheckInEvidence | null;
    postBody: string;
    now: Date;
  },
): Promise<RunCheckInFireOutcome> {
  const { now, postBody } = input;
  if (row.mode !== 'run' || row.orgId === null) throw new Error(`fireRunCheckIn: check-in ${row.id} is not a run check-in`);
  const orgId = row.orgId;

  const degrade = async (skipped: string): Promise<RunCheckInFireOutcome> => {
    console.info('[wisp.checkInRuns] run check-in degraded to a post', { checkInId: row.id, grantId: row.grantId, skipped });
    if (UNEXPECTED_SKIPS.has(skipped)) {
      report('unexpected_skip', new Error(`run check-in admission skipped: ${skipped}`), { checkInId: row.id, grantId: row.grantId, skipped });
    }
    await postForCheckIn(row, checkInTitle(row.instruction), degradedBody(skipped, postBody));
    return (await flipScheduledToFired(row.id, now)) ? 'fired' : 'skipped';
  };

  // 1. A retry after the admission committed: the same run, never a second
  //    one. First, because a run already admitted passed every check below
  //    when it was admitted (a revision landing since must not drop it).
  const admitted = await findAdmittedRun(orgId, row.id);
  if (admitted) return (await markRunning(row.id, admitted, now)) ? 'running' : 'skipped';

  // 2. A retry after a degrade (or device-deleted) post landed but its flip
  //    did not: the post stands, so finish the flip and run nothing. Admitting
  //    now would end in a result the post's dedupe key could never show.
  if (await checkInPostExists(row)) return (await flipScheduledToFired(row.id, now)) ? 'fired' : 'skipped';

  // 3. The revision pin: any other current revision runs nothing.
  const pinnedRevisionId = row.grantRevisionId;
  if (pinnedRevisionId === null || pinnedRevisionId !== input.currentRevisionId) return degrade('grant_revision_changed');

  // 4. A deleted subject device: nothing to check, and nothing to ask.
  if (await contextDeviceDeleted(row)) {
    await postForCheckIn(row, checkInTitle(row.instruction), CHECK_IN_DEVICE_DELETED_BODY);
    return (await flipScheduledToFired(row.id, now)) ? 'fired' : 'skipped';
  }

  // 5. Admit. Lazy: the assessment graph stays off the chat tool's import path.
  const { enqueueAssessment } = await import('./assessment');
  const result = await runOutsideDbContext(() => enqueueAssessment({
    grantId: row.grantId,
    orgId,
    reason: {
      kind: 'check_in',
      checkInId: row.id,
      instruction: sanitizeCheckInInstruction(postBody),
      evidence: input.evidence,
    },
    dedupeKey: checkInRunDedupeKey(row.id),
    requireRevisionId: pinnedRevisionId,
  }));
  if ('runId' in result) return (await markRunning(row.id, result.runId, now)) ? 'running' : 'skipped';

  // 6. Admission saw a run with this key that step 1 did not (a racing fire).
  if (result.skipped === 'duplicate') {
    const raced = await findAdmittedRun(orgId, row.id);
    if (raced) return (await markRunning(row.id, raced, now)) ? 'running' : 'skipped';
  }
  return degrade(result.skipped);
}

// ---------------------------------------------------------------------------
// The settled run's post
// ---------------------------------------------------------------------------

/** Run statuses whose result is posted as an answer; every other settled status "didn't finish". */
const RESULT_STATUSES: ReadonlySet<string> = new Set(['completed', 'awaiting_approval']);
const SETTLED: readonly string[] = AI_AGENT_RUN_SETTLED_STATUSES;

export type CheckInRunPostOutcome = 'posted' | 'already' | 'not_check_in' | 'not_settled' | 'cancelled' | 'disabled';

/** The status a did-not-finish post names when the run row is gone. */
const RUN_UNAVAILABLE_STATUS = 'unavailable';

/** The answer body: the run's summary, sanitised and capped, plus a pending-approval line. */
export function checkInRunResultBody(run: { status: string; summary: string | null }): string {
  const waiting = run.status === 'awaiting_approval' ? ' A step I proposed is waiting for your approval.' : '';
  const room = SPECIALIST_RESULT_BODY_MAX_CHARS - Array.from(waiting).length;
  const summary = run.summary ? cleanText(run.summary, room) : '';
  return `${summary || 'I checked and found nothing to report.'}${waiting}`;
}

/** The body of a run that settled without an answer. */
export function checkInRunUnfinishedBody(status: string, postBody: string): string {
  return `My check didn't finish (${status}). Run it now? ${postBody}`;
}

/** running → cancelled with a reason, compare-and-set. */
async function cancelRunning(checkInId: string, now: Date, reason: string): Promise<boolean> {
  const changed = await sys(() => db
    .update(wispCheckIns)
    .set({ status: 'cancelled', cancelledAt: now, cancelReason: reason })
    .where(and(eq(wispCheckIns.id, checkInId), eq(wispCheckIns.status, 'running')))
    .returning({ id: wispCheckIns.id }), 'wisp-check-in-run-cancel');
  return changed.length > 0;
}

/**
 * Post the result of a settled check-in run, once. 'not_check_in' — no
 * check-in names this run (any other assessment). 'already' — the row is no
 * longer `running` (posted, or cancelled by the user). 'not_settled' — the run
 * is still going (a row `running` for over CHECK_IN_RUN_STALE_MS, or whose
 * run row is gone, posts as did-not-finish instead). 'disabled' — Wisp is off.
 * 'cancelled' — the post may no longer go to the thread: the
 * grant is not usable, the thread or grantor changed, or the run's org is no
 * longer readable on the thread (`cancel_reason` says which).
 *
 * Order: read → the usability and audience checks → notifyUser (deduped on
 * `wisp.check_in:<id>`) → compare-and-set running → consumed | fired. A crash
 * between the post and the flip is settled by the next call, whose notifyUser
 * is a no-op; the finalizer and the reconcile racing end with one post.
 */
export async function postCheckInRunResult(runId: string, now: Date = new Date()): Promise<CheckInRunPostOutcome> {
  if (!wispEnabled()) return 'disabled';
  const [read] = await sys(() => db
    .select({
      row: wispCheckIns,
      runStatus: aiAgentRuns.status,
      runSummary: aiAgentRuns.summary,
      threadGrantId: wispThreads.grantId,
      grantStatus: wispGrants.status,
      grantExpiresAt: wispGrants.expiresAt,
      grantorUserId: wispGrants.grantorUserId,
      grantRevisionId: wispGrants.currentRevisionId,
    })
    .from(wispCheckIns)
    // Org-pinned: a run of another org never settles this row (it reads as gone).
    .leftJoin(aiAgentRuns, and(eq(aiAgentRuns.id, wispCheckIns.runId), eq(aiAgentRuns.orgId, wispCheckIns.orgId)))
    .leftJoin(wispThreads, and(eq(wispThreads.id, wispCheckIns.threadId), eq(wispThreads.partnerId, wispCheckIns.partnerId)))
    .leftJoin(wispGrants, and(eq(wispGrants.id, wispCheckIns.grantId), eq(wispGrants.partnerId, wispCheckIns.partnerId)))
    .where(eq(wispCheckIns.runId, runId))
    .limit(1), 'wisp-check-in-run-post-read');
  if (!read) return 'not_check_in';
  const { row } = read;
  if (row.status !== 'running') return 'already';
  const runStatus = read.runStatus ?? RUN_UNAVAILABLE_STATUS;
  const stale = row.firedAt !== null && now.getTime() - row.firedAt.getTime() > CHECK_IN_RUN_STALE_MS;
  if (read.runStatus !== null && !SETTLED.includes(read.runStatus) && !stale) return 'not_settled';

  const cancel = async (reason: string): Promise<CheckInRunPostOutcome> => {
    console.info('[wisp.checkInRuns] run check-in result not posted', { checkInId: row.id, runId, reason });
    return (await cancelRunning(row.id, now, reason)) ? 'cancelled' : 'already';
  };
  if (read.grantStatus !== 'active' || !read.grantExpiresAt || read.grantExpiresAt.getTime() <= now.getTime()) return cancel('grant_inactive');
  if (read.threadGrantId !== row.grantId) return cancel('thread_mismatch');
  if (read.grantorUserId !== row.userId) return cancel('grantor_changed');
  if (!read.grantRevisionId || row.orgId === null) return cancel('grant_inactive');
  try {
    const ceiling = await resolveGrantCeiling(row.grantId, read.grantRevisionId);
    // The answer is about the run's org: the thread must still be able to show it.
    if (!isOrgReadableOnThread(ceiling, row.orgId)) return cancel('outside_ceiling');
  } catch (err) {
    if (!(err instanceof GrantInactiveError)) throw err;
    if (err.kind === 'corrupt') captureException(err, undefined, { component: 'wisp.checkInRuns', op: 'post_ceiling', checkInId: row.id });
    return cancel('grant_inactive');
  }

  const answered = read.runStatus !== null && RESULT_STATUSES.has(read.runStatus);
  const delivered = answered
    ? await postForCheckIn(row, checkInResultTitle(row.instruction), checkInRunResultBody({ status: runStatus, summary: read.runSummary }), specialistRunLink(runId))
    : await postForCheckIn(row, checkInTitle(row.instruction), checkInRunUnfinishedBody(runStatus, row.instruction), read.runStatus === null ? undefined : specialistRunLink(runId));

  // An answer leaves nothing for the next turn (consumed); a run that did not
  // finish asked the grantor to run it now, so the instruction returns with
  // their next message (fired).
  const flipped = await sys(() => db
    .update(wispCheckIns)
    .set(answered ? { status: 'consumed', consumedAt: now } : { status: 'fired' })
    .where(and(eq(wispCheckIns.id, row.id), eq(wispCheckIns.status, 'running')))
    .returning({ id: wispCheckIns.id }), 'wisp-check-in-run-post-flip');
  if (flipped.length === 0) return 'already';
  return delivered;
}

/**
 * The tick's sweep, oldest first, at most CHECK_IN_RUN_RECONCILE_LIMIT, each
 * through postCheckInRunResult: `running` rows whose run has settled, whose
 * run row is gone, or that have been running for over CHECK_IN_RUN_STALE_MS.
 * A failing row never stops the sweep; the first few failures are reported. A
 * stale row whose post still fails is cancelled (`post_failed`), so it cannot
 * hold the head of the sweep or a cap slot for ever.
 */
export async function reconcileRunningCheckIns(now: Date): Promise<{ posted: number }> {
  if (!wispEnabled()) return { posted: 0 };
  const staleBefore = new Date(now.getTime() - CHECK_IN_RUN_STALE_MS);
  const due = await sys(() => db
    .select({ id: wispCheckIns.id, runId: wispCheckIns.runId, firedAt: wispCheckIns.firedAt })
    .from(wispCheckIns)
    .leftJoin(aiAgentRuns, and(eq(aiAgentRuns.id, wispCheckIns.runId), eq(aiAgentRuns.orgId, wispCheckIns.orgId)))
    .where(and(
      eq(wispCheckIns.status, 'running'),
      isNotNull(wispCheckIns.runId),
      or(
        inArray(aiAgentRuns.status, [...AI_AGENT_RUN_SETTLED_STATUSES]),
        isNull(aiAgentRuns.id),
        lt(wispCheckIns.firedAt, staleBefore),
      ),
    ))
    .orderBy(asc(wispCheckIns.firedAt), asc(wispCheckIns.id))
    .limit(CHECK_IN_RUN_RECONCILE_LIMIT), 'wisp-check-in-run-reconcile');

  let posted = 0;
  let failures = 0;
  for (const { id, runId, firedAt } of due) {
    if (!runId) continue;
    try {
      if ((await postCheckInRunResult(runId, now)) === 'posted') posted += 1;
    } catch (err) {
      failures += 1;
      if (failures <= RECONCILE_MAX_REPORTED_FAILURES) report('reconcile_row', err, { runId });
      if (firedAt !== null && firedAt.getTime() < staleBefore.getTime()) {
        try {
          if (await cancelRunning(id, now, 'post_failed')) {
            report('reconcile_gave_up', err, { checkInId: id, runId });
          }
        } catch (cancelErr) {
          report('reconcile_give_up_cancel', cancelErr, { checkInId: id, runId });
        }
      }
    }
  }
  if (failures > RECONCILE_MAX_REPORTED_FAILURES) {
    console.error('[wisp.checkInRuns] reconcile: more rows failed than were reported; retried next tick', { failures, posted });
  }
  return { posted };
}
