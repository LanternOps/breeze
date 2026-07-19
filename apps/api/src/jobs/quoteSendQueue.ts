/**
 * Quote delayed-send queue — the "Undo send" window.
 *
 * Clicking Send schedules the real dispatch as a delayed BullMQ job (default
 * 30s) instead of emailing immediately; the quote stays a DRAFT with
 * send_scheduled_at/send_job_id stamped so the UI shows "Sending in Ns — Undo"
 * and cancel can verify there is something to cancel. When the job fires it
 * runs the exact sendQuote pipeline a direct send uses (freeze, contract-var
 * gate, PDF, email, draft→sent) under a system DB context with the ORIGINAL
 * actor, so every app-layer access check still applies.
 *
 * Failure semantics are deliberately conservative — nothing is ever half-sent:
 * - sendQuote rejects at fire time (e.g. a contract variable was cleared
 *   during the window): the quote stays a DRAFT, the schedule is cleared, and
 *   send_email_reason is stamped 'send_failed' so the UI can show a persistent
 *   "scheduled send failed" banner — the user saw a success toast at schedule
 *   time and may be long gone, so an ephemeral signal is not enough.
 * - the job is lost entirely (Redis flush): nothing runs, so the stale
 *   schedule columns survive; the UI treats a past send_scheduled_at on a
 *   draft as "not scheduled" and restores the Send button.
 *
 * Ownership is an atomic DB claim on send_job_id (unique per schedule): the
 * worker, an undo, a reschedule, and a direct send each take the row's jobId
 * out from under the others with a conditional UPDATE, so exactly one of them
 * wins and the loser reliably no-ops. cancelQuoteSend answers from that claim
 * — never from the Redis remove result, which can't distinguish "window
 * elapsed" from "Redis down".
 */
import { Worker, type Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Queue } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { db, withSystemDbAccessContext } from '../db';
import { quotes } from '../db/schema/quotes';
import { sendQuote, type SendQuoteEmailOptions } from '../services/quoteLifecycle';
import { QuoteServiceError, type QuoteActor } from '../services/quoteTypes';

const QUOTE_SEND_QUEUE = 'quote-send';
// BullMQ jobIds must not contain colons (repo rule). The id is unique PER
// SCHEDULE (not per quote): the row's send_job_id names the one live schedule,
// so an orphaned job from an earlier schedule fails its claim and no-ops even
// if its Redis removal failed.
const newJobId = (quoteId: string) => `quote-send-${quoteId}-${randomUUID()}`;

export interface QuoteSendJobData {
  quoteId: string;
  /** The send_job_id this job was enqueued under — its claim ticket. Optional
   *  only for jobs enqueued before the unique-id scheme shipped; the worker
   *  falls back to the legacy `quote-send-<quoteId>` id for those. */
  jobId?: string;
  /** Snapshot of the scheduling actor — app-layer checks in sendQuote run
   *  against this exactly as a direct send would. */
  actor: QuoteActor;
  emailOpts: SendQuoteEmailOptions;
}

let queue: Queue | null = null;
function getQuoteSendQueue(): Queue {
  if (!queue) queue = new Queue(QUOTE_SEND_QUEUE, { connection: getBullMQConnection() });
  return queue;
}

/** Schedule (or replace) the delayed send for a quote. Stamps the schedule
 *  columns on the row; returns the fire time. Runs in the caller's org-scoped
 *  request context. */
export async function scheduleQuoteSend(
  quoteId: string,
  actor: QuoteActor,
  emailOpts: SendQuoteEmailOptions,
  delayMs: number,
): Promise<{ sendScheduledAt: Date }> {
  const q = getQuoteSendQueue();
  const jobId = newJobId(quoteId);
  const sendScheduledAt = new Date(Date.now() + delayMs);
  // Read the prior schedule state: the old delayed job needs cleaning up, and
  // a prior failure marker must be restorable if this schedule fails to enqueue.
  const [prior] = await db.select({ sendJobId: quotes.sendJobId, sendEmailReason: quotes.sendEmailReason })
    .from(quotes).where(eq(quotes.id, quoteId));
  // Stamp BEFORE enqueueing: if the stamp fails the route errors and no job
  // exists; the reverse order can fire a send the UI never showed. Stamping
  // also clears any send_email_reason left by a previously failed attempt —
  // this fresh schedule supersedes that failure. draft-only re-check closes
  // the race with a concurrent direct send.
  const stamped = await db.update(quotes)
    .set({ sendScheduledAt, sendJobId: jobId, sendEmailReason: null })
    .where(and(eq(quotes.id, quoteId), eq(quotes.status, 'draft')))
    .returning({ id: quotes.id });
  if (stamped.length === 0) {
    throw new QuoteServiceError('Quote was already sent', 409, 'INVALID_STATE');
  }
  if (prior?.sendJobId) {
    // Best-effort: the row now points at the new id, so the old job is inert
    // regardless (its claim fails) — but leave an operator trail on failure
    // instead of a blanket swallow.
    await q.remove(prior.sendJobId).catch((err) => {
      console.warn(`[quote-send] failed to remove replaced job ${prior.sendJobId}:`, err);
      captureException(err);
    });
  }
  try {
    await q.add(QUOTE_SEND_QUEUE, { quoteId, jobId, actor, emailOpts } satisfies QuoteSendJobData, {
      jobId,
      delay: delayMs,
      // One shot, no retries: a failed send must leave the quote a plain draft
      // (visible to the user as "still a draft"), never retry an email minutes
      // later after the tech has moved on.
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    });
  } catch (err) {
    // Enqueue failed (e.g. Redis down): un-stamp so the UI doesn't count down
    // toward a send that will never fire, RESTORING any failure marker the
    // stamp just cleared (a failed retry must not erase the durable "scheduled
    // send failed" banner), then let the route surface the error.
    await db.update(quotes)
      .set({ sendScheduledAt: null, sendJobId: null, sendEmailReason: prior?.sendEmailReason ?? null })
      .where(and(eq(quotes.id, quoteId), eq(quotes.sendJobId, jobId)))
      .catch((unstampErr) => captureException(unstampErr));
    throw err;
  }
  return { sendScheduledAt };
}

/** Cancel a scheduled send. Returns whether the undo actually won — false
 *  means the window had elapsed (the send fired or is firing). The answer
 *  comes from the DB claim, not from Redis: winning the claim makes the job
 *  a guaranteed no-op even if the Redis removal fails. */
export async function cancelQuoteSend(quoteId: string): Promise<boolean> {
  const [row] = await db.select({ sendJobId: quotes.sendJobId, status: quotes.status })
    .from(quotes).where(eq(quotes.id, quoteId));
  if (!row || row.status !== 'draft' || !row.sendJobId) return false;
  // Claim the schedule. 0 rows = the worker (or a concurrent undo/direct
  // send) got there first — genuinely too late.
  const claimed = await db.update(quotes)
    .set({ sendScheduledAt: null, sendJobId: null })
    .where(and(eq(quotes.id, quoteId), eq(quotes.status, 'draft'), eq(quotes.sendJobId, row.sendJobId)))
    .returning({ id: quotes.id });
  if (claimed.length === 0) return false;
  // Best-effort Redis cleanup; the claim above already made the job inert.
  await getQuoteSendQueue().remove(row.sendJobId).catch((err) => {
    console.warn(`[quote-send] failed to remove job ${row.sendJobId} on undo:`, err);
    captureException(err);
  });
  return true;
}

/** The job body, exported for unit tests — the Worker below is a thin wrapper. */
export async function processQuoteSendJob(data: QuoteSendJobData): Promise<void> {
  const { quoteId, actor, emailOpts } = data;
  // Pre-unique-id jobs (enqueued before a deploy of this scheme) carry no
  // jobId in the payload; they were stamped under the legacy derivable id.
  const jobId = data.jobId ?? `quote-send-${quoteId}`;
  // The send runs under a system context: a bare db read/write from the
  // worker has no RLS context — reads see nothing and writes silently hit 0
  // rows, stranding stale schedule state. withSystemDbAccessContext is ONE
  // Postgres transaction, so a rethrow from inside it would roll back
  // everything written within — which is why the failure marker below is
  // persisted in a SEPARATE context after this one has rolled back (found by
  // the real-DB integration suite: an in-transaction catch-and-stamp was
  // undone by its own rethrow, so the failure banner could never appear).
  let sendError: unknown;
  const failed = await withSystemDbAccessContext(async () => {
    // Atomic claim: fire only if this job is still the row's registered
    // schedule, and take that registration out from under any concurrent
    // undo/reschedule in the same statement. Losing the claim (undone,
    // rescheduled under a new id, already sent, or deleted) means this job
    // is an orphan and must not send — and it must NOT touch the schedule
    // columns either: they may now belong to a newer schedule.
    const claimed = await db.update(quotes)
      .set({ sendJobId: null })
      .where(and(eq(quotes.id, quoteId), eq(quotes.status, 'draft'), eq(quotes.sendJobId, jobId)))
      .returning({ id: quotes.id });
    if (claimed.length === 0) return false;
    // The real send: same pipeline, same actor-scoped app-layer checks. Its
    // draft→sent claim also clears the schedule columns atomically with the
    // flip. A failed email outcome is persisted afterward so the UI can
    // surface an honest warning when the send committed but no email went
    // out — the delayed path has no request to return `emailed:false` to.
    // (Success needs no write: the flip already cleared the marker.)
    const result = await sendQuote(quoteId, actor, emailOpts);
    if (!result.emailed) {
      await db.update(quotes)
        .set({ sendEmailReason: result.emailReason ?? 'send_failed' })
        .where(eq(quotes.id, quoteId));
    }
    return false;
  }).catch((err) => {
    sendError = err;
    return true;
  });
  if (!failed) return;
  // Fire-time rejection: the transaction above rolled back (including the
  // claim, so the row still carries this job's id), and the quote stays a
  // DRAFT. Persist the failure durably — the user saw a success toast at
  // schedule time; without a marker the quote silently reverts to a plain
  // draft and the customer never hears anything. 'schedule_failed' (not
  // 'send_failed') because on a draft this means "the whole scheduled send
  // failed", not "email transport failed after the send committed". Guards:
  // draft-only keeps a lost 409 race (direct send won) from stamping failure
  // onto a sent quote; the jobId match keeps it off a NEWER schedule stamped
  // after the rollback released the row lock — clobbering that would show
  // "failed" while the new job is still live and about to fire.
  await withSystemDbAccessContext(() =>
    db.update(quotes)
      .set({ sendScheduledAt: null, sendJobId: null, sendEmailReason: 'schedule_failed' })
      .where(and(eq(quotes.id, quoteId), eq(quotes.status, 'draft'), eq(quotes.sendJobId, jobId)))
  ).catch((persistErr) => captureException(persistErr));
  throw sendError; // → worker 'failed' handler: log + Sentry
}

let worker: Worker | null = null;

export function initializeQuoteSendWorker(): void {
  worker = new Worker(
    QUOTE_SEND_QUEUE,
    async (job: Job<QuoteSendJobData>) => processQuoteSendJob(job.data),
    { connection: getBullMQConnection(), concurrency: 3 },
  );
  worker.on('error', (error) => {
    console.error('[quote-send] Worker error:', error);
    captureException(error);
  });
  worker.on('failed', (job, error) => {
    // The quote stays a draft (schedule cleared in processQuoteSendJob's
    // finally); this log + Sentry event is the operator-side trail.
    console.error(`[quote-send] Job ${job?.id} failed:`, error);
    captureException(error);
  });
  console.log('[quote-send] Worker initialized');
}

export async function shutdownQuoteSendWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
