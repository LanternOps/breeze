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
 * Failure semantics are deliberately conservative: if the job is lost (Redis
 * flush) or sendQuote rejects at fire time (e.g. a contract variable was
 * cleared during the window), the quote simply remains a draft and the
 * schedule columns are cleared — no email goes out, nothing is half-sent. The
 * UI treats a past send_scheduled_at on a draft as "not scheduled".
 */
import { Worker, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { Queue } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { db, withSystemDbAccessContext } from '../db';
import { quotes } from '../db/schema/quotes';
import { sendQuote, type SendQuoteEmailOptions } from '../services/quoteLifecycle';
import type { QuoteActor } from '../services/quoteTypes';

const QUOTE_SEND_QUEUE = 'quote-send';
// BullMQ jobIds must not contain colons (repo rule) — and one job per quote:
// re-scheduling replaces the previous job under the same id.
const jobIdFor = (quoteId: string) => `quote-send-${quoteId}`;

export interface QuoteSendJobData {
  quoteId: string;
  /** Snapshot of the scheduling actor — app-layer checks in sendQuote run
   *  against this exactly as a direct send would. */
  actor: QuoteActor;
  emailOpts: SendQuoteEmailOptions;
}

let queue: Queue | null = null;
export function getQuoteSendQueue(): Queue {
  if (!queue) queue = new Queue(QUOTE_SEND_QUEUE, { connection: getBullMQConnection() });
  return queue;
}

/** Schedule (or replace) the delayed send for a quote. Stamps the schedule
 *  columns on the row; returns the fire time. */
export async function scheduleQuoteSend(
  quoteId: string,
  actor: QuoteActor,
  emailOpts: SendQuoteEmailOptions,
  delayMs: number,
): Promise<{ sendScheduledAt: Date }> {
  const q = getQuoteSendQueue();
  const jobId = jobIdFor(quoteId);
  // Replace any prior schedule: BullMQ won't enqueue a duplicate jobId, so a
  // stale delayed job must be removed first (no-op when none exists).
  await q.remove(jobId).catch(() => { /* not present / already fired */ });
  const sendScheduledAt = new Date(Date.now() + delayMs);
  await q.add(QUOTE_SEND_QUEUE, { quoteId, actor, emailOpts } satisfies QuoteSendJobData, {
    jobId,
    delay: delayMs,
    // One shot, no retries: a failed send must leave the quote a plain draft
    // (visible to the user as "still a draft"), never retry an email minutes
    // later after the tech has moved on.
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: true,
  });
  await db.update(quotes).set({ sendScheduledAt, sendJobId: jobId }).where(eq(quotes.id, quoteId));
  return { sendScheduledAt };
}

/** Cancel a scheduled send. Returns whether a pending job was actually
 *  removed — false means the window already elapsed (job fired or is firing). */
export async function cancelQuoteSend(quoteId: string): Promise<boolean> {
  const q = getQuoteSendQueue();
  const removed = await q.remove(jobIdFor(quoteId)).then((n) => n === 1).catch(() => false);
  // Clear the bookkeeping either way: a stale schedule on a draft must not
  // keep the UI in "Sending…" forever.
  await db.update(quotes).set({ sendScheduledAt: null, sendJobId: null }).where(eq(quotes.id, quoteId));
  return removed;
}

/** The job body, exported for unit tests — the Worker below is a thin wrapper. */
export async function processQuoteSendJob(data: QuoteSendJobData): Promise<void> {
  const { quoteId, actor, emailOpts } = data;
  try {
    await withSystemDbAccessContext(async () => {
      // Cancel/reschedule race guard: only fire if this job is still the
      // quote's registered schedule. (cancelQuoteSend clears sendJobId; a
      // reschedule re-stamps it — same id — so this only skips true orphans.)
      const [row] = await db.select({ sendJobId: quotes.sendJobId, status: quotes.status })
        .from(quotes).where(eq(quotes.id, quoteId));
      if (!row || row.status !== 'draft' || row.sendJobId !== jobIdFor(quoteId)) return;
      // The real send: same pipeline, same actor-scoped app-layer checks. The
      // email outcome is persisted so the UI can surface an honest post-flip
      // warning when the send committed but no email went out — the delayed
      // path has no request to return `emailed:false` to.
      const result = await sendQuote(quoteId, actor, emailOpts);
      await db.update(quotes)
        .set({ sendEmailReason: result.emailed ? null : (result.emailReason ?? 'send_failed') })
        .where(eq(quotes.id, quoteId));
    });
  } finally {
    // Fired, failed, or skipped — the schedule is over either way. Must run
    // under the system context: a bare db.update from the worker has no RLS
    // context and silently writes 0 rows, stranding the stale schedule.
    await withSystemDbAccessContext(() =>
      db.update(quotes).set({ sendScheduledAt: null, sendJobId: null }).where(eq(quotes.id, quoteId))
    ).catch(() => { /* row deleted during the window — nothing to clear */ });
  }
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
