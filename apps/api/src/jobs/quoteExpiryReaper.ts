import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { db } from '../db';
import { quotes } from '../db/schema/quotes';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { writeAuditEvent, requestLikeFromSnapshot } from '../services/auditEvents';

/**
 * Reaps `quotes` rows whose `expiry_date` has passed while still `sent`/`viewed`,
 * flipping them to `expired`. Mirrors the read-time guard in quoteAcceptService /
 * the portal+public read paths (see quoteExpiry.ts) so the lifecycle converges:
 * the guard blocks accept the instant a quote expires; the sweep makes the status
 * column reflect that for lists/filters and the `quotes_expiry_idx` partial index.
 *
 * Runs every 15 minutes. Expiry is date-granular, so a tighter cadence buys little;
 * the read-time guard already covers the sub-sweep window. Stays inside
 * `withSystemDbAccessContext` — quotes is partner+org dual-axis, but expiry reaping
 * is a system job.
 */

const QUEUE_NAME = 'quote-expiry-reaper';
const REAP_INTERVAL_MS = 15 * 60 * 1000; // every 15 min
const MAX_REAP_PER_RUN = 500;

type ReaperJobData = { type: 'reap-expired-quotes'; queuedAt: string };

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') {
    throw new Error(
      '[QuoteExpiryReaper] withSystemDbAccessContext not available — reaper cannot run without system DB access',
    );
  }
  return withSystem(fn);
};

let reaperQueue: Queue<ReaperJobData> | null = null;
let reaperWorker: Worker<ReaperJobData> | null = null;

function getQueue(): Queue<ReaperJobData> {
  if (!reaperQueue) {
    reaperQueue = new Queue<ReaperJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return reaperQueue;
}

/**
 * Single pass: flip sent/viewed quotes past their expiry_date to `expired`, and
 * write an audit row per transition. Bounded to MAX_REAP_PER_RUN via a CTE so a
 * backlog spike can't lock the table for too long. `expiry_date < CURRENT_DATE`
 * matches isQuoteExpired's UTC day-boundary definition (a quote is valid THROUGH
 * its expiry_date). Returns the number of quotes transitioned.
 */
export async function expireQuotes(): Promise<number> {
  const transitioned = await db.execute<{
    id: string;
    org_id: string;
    quote_number: string | null;
    expiry_date: string;
  }>(sql`
    WITH due AS (
      SELECT id
      FROM ${quotes}
      WHERE ${quotes.status} IN ('sent', 'viewed')
        AND ${quotes.expiryDate} IS NOT NULL
        AND ${quotes.expiryDate} < CURRENT_DATE
      ORDER BY ${quotes.expiryDate} ASC
      LIMIT ${MAX_REAP_PER_RUN}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${quotes} AS q
    SET status = 'expired',
        updated_at = now()
    FROM due
    WHERE q.id = due.id
      AND q.status IN ('sent', 'viewed')
    RETURNING q.id, q.org_id, q.quote_number, q.expiry_date;
  `);

  const rows = (transitioned as unknown as { rows?: Array<{ id: string; org_id: string; quote_number: string | null; expiry_date: string }> }).rows
    ?? (transitioned as unknown as Array<{ id: string; org_id: string; quote_number: string | null; expiry_date: string }>);

  if (!Array.isArray(rows) || rows.length === 0) {
    return 0;
  }

  // Audit log: one row per transitioned quote. Best-effort — never block a
  // transition on the audit write.
  const requestLike = requestLikeFromSnapshot({});
  for (const row of rows) {
    try {
      writeAuditEvent(requestLike, {
        orgId: row.org_id,
        action: 'billing.quote.expired',
        resourceType: 'quote',
        resourceId: row.id,
        resourceName: row.quote_number,
        actorType: 'system',
        actorId: null,
        result: 'success',
        details: { expiryDate: row.expiry_date },
      });
    } catch (err) {
      console.error('[QuoteExpiryReaper] Failed to write audit event:', err);
    }
  }

  if (rows.length === MAX_REAP_PER_RUN) {
    console.warn(`[QuoteExpiryReaper] Hit ${MAX_REAP_PER_RUN}-item cap — backlog may be growing`);
  }

  return rows.length;
}

function createWorker(): Worker<ReaperJobData> {
  return new Worker<ReaperJobData>(
    QUEUE_NAME,
    async (_job: Job<ReaperJobData>) => {
      try {
        const reaped = await runWithSystemDbAccess(expireQuotes);
        if (reaped > 0) {
          console.log(`[QuoteExpiryReaper] Expired ${reaped} quote(s)`);
        }
        return { reaped };
      } catch (err) {
        console.error('[QuoteExpiryReaper] Run failed:', err);
        captureException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    },
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

async function scheduleRepeatableJob(): Promise<void> {
  const queue = getQueue();
  const repeatables = await queue.getRepeatableJobs();
  for (const job of repeatables) {
    if (job.name === 'reap-expired-quotes') {
      await queue.removeRepeatableByKey(job.key);
    }
  }
  await queue.add(
    'reap-expired-quotes',
    { type: 'reap-expired-quotes', queuedAt: new Date().toISOString() },
    {
      jobId: 'quote-expiry-reaper',
      repeat: { every: REAP_INTERVAL_MS },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    },
  );
}

export async function initializeQuoteExpiryReaper(): Promise<void> {
  if (reaperWorker) return;
  reaperWorker = createWorker();
  reaperWorker.on('error', (error) => {
    console.error('[QuoteExpiryReaper] Worker error:', error);
    captureException(error);
  });
  reaperWorker.on('failed', (job, error) => {
    console.error(`[QuoteExpiryReaper] Job ${job?.id} failed:`, error);
    captureException(error);
  });
  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await reaperWorker.close();
    reaperWorker = null;
    throw err;
  }
  console.log('[QuoteExpiryReaper] Initialized');
}

export async function shutdownQuoteExpiryReaper(): Promise<void> {
  const worker = reaperWorker;
  const queue = reaperQueue;
  reaperWorker = null;
  reaperQueue = null;
  if (worker) {
    try { await worker.close(); } catch (err) { console.error('[QuoteExpiryReaper] Error closing worker:', err); }
  }
  if (queue) {
    try { await queue.close(); } catch (err) { console.error('[QuoteExpiryReaper] Error closing queue:', err); }
  }
}
