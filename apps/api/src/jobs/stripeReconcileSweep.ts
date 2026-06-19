import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { db } from '../db';
import { invoiceStripePayments } from '../db/schema/stripePayments';
import { invoices } from '../db/schema/invoices';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { settleCheckoutSession } from '../services/stripeSettle';

/**
 * Reconcile sweep for the API-key payment model (no inbound webhook). Finds
 * Checkout sessions we created but never settled — the customer paid but didn't
 * return to the success page (closed the tab, lost connection) so verify-on-return
 * never fired — and settles them by asking Stripe directly via the partner's key.
 *
 * Runs every 10 min. Skips very fresh mappings (verify-on-return gets first crack)
 * and stops chasing ancient ones (abandoned/unpaid checkouts). Settlement is
 * idempotent (recordStripePayment), so overlap with verify-on-return is harmless.
 */

const QUEUE_NAME = 'stripe-reconcile-sweep';
const INTERVAL_MS = 10 * 60 * 1000; // every 10 min
const MAX_PER_RUN = 200;
const MIN_AGE = "interval '2 minutes'";  // let verify-on-return go first
const MAX_AGE = "interval '7 days'";     // stop chasing abandoned checkouts

type SweepJobData = { type: 'reconcile-stripe-payments'; queuedAt: string };

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') {
    throw new Error('[StripeReconcileSweep] withSystemDbAccessContext not available');
  }
  return withSystem(fn);
};

let sweepQueue: Queue<SweepJobData> | null = null;
let sweepWorker: Worker<SweepJobData> | null = null;

function getQueue(): Queue<SweepJobData> {
  if (!sweepQueue) sweepQueue = new Queue<SweepJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  return sweepQueue;
}

/**
 * One pass: find pending mappings in the [MIN_AGE, MAX_AGE] window, resolve each
 * partner from its invoice, and try to settle via Stripe. Best-effort per row — an
 * unpaid/abandoned session just stays pending; a transient error is logged and the
 * row is retried next sweep. Returns the number of mappings actually settled.
 */
export async function reconcilePendingStripePayments(): Promise<number> {
  const rows = (await db.execute<{ partner_id: string; stripe_object_id: string }>(sql`
    SELECT i.partner_id, m.stripe_object_id
    FROM ${invoiceStripePayments} m
    JOIN ${invoices} i ON i.id = m.invoice_id
    WHERE m.status = 'pending'
      AND m.invoice_payment_id IS NULL
      AND m.stripe_object_type = 'checkout_session'
      AND m.created_at < now() - ${sql.raw(MIN_AGE)}
      AND m.created_at > now() - ${sql.raw(MAX_AGE)}
    ORDER BY m.created_at ASC
    LIMIT ${MAX_PER_RUN}
  `)) as unknown as { rows?: Array<{ partner_id: string; stripe_object_id: string }> };
  const list = rows.rows ?? (rows as unknown as Array<{ partner_id: string; stripe_object_id: string }>);
  if (!Array.isArray(list) || list.length === 0) return 0;

  let settled = 0;
  for (const r of list) {
    try {
      const res = await settleCheckoutSession(r.partner_id, r.stripe_object_id);
      if (res.settled) settled++;
    } catch (err) {
      // Best-effort: a partner who disconnected their key, or a transient Stripe
      // error, must not abort the whole sweep. Log and move on.
      console.error('[StripeReconcileSweep] settle failed', { partnerId: r.partner_id, session: r.stripe_object_id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  if (settled > 0) console.log(`[StripeReconcileSweep] settled ${settled} payment(s)`);
  if (list.length === MAX_PER_RUN) console.warn(`[StripeReconcileSweep] hit ${MAX_PER_RUN}-item cap — backlog may be growing`);
  return settled;
}

function createWorker(): Worker<SweepJobData> {
  return new Worker<SweepJobData>(
    QUEUE_NAME,
    async (_job: Job<SweepJobData>) => {
      try {
        return { settled: await runWithSystemDbAccess(reconcilePendingStripePayments) };
      } catch (err) {
        console.error('[StripeReconcileSweep] run failed:', err);
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
    if (job.name === 'reconcile-stripe-payments') await queue.removeRepeatableByKey(job.key);
  }
  await queue.add(
    'reconcile-stripe-payments',
    { type: 'reconcile-stripe-payments', queuedAt: new Date().toISOString() },
    { jobId: 'stripe-reconcile-sweep', repeat: { every: INTERVAL_MS }, removeOnComplete: { count: 20 }, removeOnFail: { count: 200 } },
  );
}

export async function initializeStripeReconcileSweep(): Promise<void> {
  if (sweepWorker) return;
  sweepWorker = createWorker();
  sweepWorker.on('error', (error) => { console.error('[StripeReconcileSweep] Worker error:', error); captureException(error); });
  sweepWorker.on('failed', (job, error) => { console.error(`[StripeReconcileSweep] Job ${job?.id} failed:`, error); captureException(error); });
  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await sweepWorker.close();
    sweepWorker = null;
    throw err;
  }
  console.log('[StripeReconcileSweep] Initialized');
}

export async function shutdownStripeReconcileSweep(): Promise<void> {
  const worker = sweepWorker;
  const queue = sweepQueue;
  sweepWorker = null;
  sweepQueue = null;
  if (worker) { try { await worker.close(); } catch (err) { console.error('[StripeReconcileSweep] Error closing worker:', err); } }
  if (queue) { try { await queue.close(); } catch (err) { console.error('[StripeReconcileSweep] Error closing queue:', err); } }
}
