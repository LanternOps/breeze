import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { db } from '../db';
import { invoiceStripePayments } from '../db/schema/stripePayments';
import { invoices } from '../db/schema/invoices';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { eraseExpiredStripeCredentials } from '../services/stripeCredentialArchive';
import {
  EXPIRE_ATTEMPTS_PER_REQUEST,
  runProviderPhase,
  type OpenSessionRow,
  type RevocationSummary,
} from '../services/stripeSessionRevocation';
import { attachWorkerObservability } from './workerObservability';

/**
 * Durable drain for Checkout-session revocation intent (SEC-150).
 *
 * Phase 1 of a transition commits `revocation_requested` and phase 2 tries
 * Stripe inside the request's 12-second budget. Everything the request could not
 * finish — a Stripe outage, a rate limit, a row the budget never reached — lands
 * here. The transition stays refused until this worker proves the session is
 * dead, so this is the component that makes fail-closed bounded rather than
 * permanent.
 *
 * Eligibility comes from PostgreSQL's clock, never the worker host's: a drifted
 * container must not resurrect a backed-off row or starve a due one (#5503).
 */

const QUEUE_NAME = 'stripe-session-revocation-sweep';
const INTERVAL_MS = 60 * 1000;
/** Rows per pass. Same bound as the reconcile sweep. */
export const MAX_PER_RUN = 200;
/** Per-partner fairness cap — one broken Stripe account must not starve the rest. */
export const MAX_PER_PARTNER_PER_RUN = 25;
/** The eraser is cheap and idempotent; once an hour is ample for a daily window. */
const ERASER_INTERVAL_MS = 60 * 60 * 1000;

type SweepJobData = { type: 'revoke-stripe-sessions'; queuedAt: string };

let lastEraserRunAt = 0;
let sweepQueue: Queue<SweepJobData> | null = null;
let sweepWorker: Worker<SweepJobData> | null = null;

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') {
    throw new Error('[StripeSessionRevocationSweep] withSystemDbAccessContext not available');
  }
  return withSystem(fn);
};

function getQueue(): Queue<SweepJobData> {
  if (!sweepQueue) sweepQueue = new Queue<SweepJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  return sweepQueue;
}

/**
 * Due rows, oldest intent first, with a per-partner cap applied in SQL so one
 * partner's backlog cannot consume the whole pass. Caller supplies a SYSTEM
 * context — `invoice_stripe_payments` is org-axis and `invoices` is the only
 * place the partner binding lives.
 */
export async function selectDueRevocations(): Promise<OpenSessionRow[]> {
  const result = (await db.execute<{
    id: string; org_id: string; invoice_id: string; partner_id: string;
    stripe_account_id: string; stripe_object_id: string;
    revocation_credential_id: string | null; revocation_attempts: number;
    revocation_requested_at: Date | null;
  }>(sql`
    SELECT id, org_id, invoice_id, partner_id, stripe_account_id, stripe_object_id,
           revocation_credential_id, revocation_attempts, revocation_requested_at
    FROM (
      SELECT m.id, m.org_id, m.invoice_id, i.partner_id, m.stripe_account_id,
             m.stripe_object_id, m.revocation_credential_id, m.revocation_attempts,
             m.revocation_requested_at, m.revocation_next_attempt_at,
             ROW_NUMBER() OVER (
               PARTITION BY i.partner_id
               ORDER BY m.revocation_next_attempt_at ASC NULLS FIRST, m.id ASC
             ) AS partner_rank
      FROM ${invoiceStripePayments} m
      JOIN ${invoices} i ON i.id = m.invoice_id
      WHERE m.revocation_state = 'revocation_requested'
        AND m.revocation_next_attempt_at IS NOT NULL
        AND m.revocation_next_attempt_at <= now()
    ) ranked
    WHERE partner_rank <= ${MAX_PER_PARTNER_PER_RUN}
    ORDER BY revocation_next_attempt_at ASC, id ASC
    LIMIT ${MAX_PER_RUN}
  `)) as unknown as { rows?: Array<Record<string, unknown>> };

  const list = (result.rows ?? (result as unknown as Array<Record<string, unknown>>)) ?? [];
  if (!Array.isArray(list)) return [];
  return list.map((r) => ({
    id: String(r.id),
    orgId: String(r.org_id),
    invoiceId: String(r.invoice_id),
    partnerId: String(r.partner_id),
    stripeAccountId: String(r.stripe_account_id),
    stripeObjectId: String(r.stripe_object_id),
    revocationCredentialId: r.revocation_credential_id ? String(r.revocation_credential_id) : null,
    revocationAttempts: Number(r.revocation_attempts ?? 0),
    revocationRequestedAt: r.revocation_requested_at ? new Date(r.revocation_requested_at as string) : null,
  }));
}

/**
 * One pass. The row selection needs a system context; the provider phase must
 * run with NO context at all (it opens its own short transactions around each
 * Stripe call), so the two are deliberately not wrapped together.
 */
export async function runStripeSessionRevocationSweep(): Promise<RevocationSummary> {
  const rows = await runWithSystemDbAccess(selectDueRevocations);
  if (rows.length === 0) return { requested: 0, revoked: 0, charged: 0, blocked: 0, stillPending: 0 };

  // No wall-clock budget here: unlike a request, the worker's whole job is to
  // finish. The per-run row cap is what bounds a pass.
  const summary = await runProviderPhase(rows, {
    budgetMs: Number.POSITIVE_INFINITY,
    attemptsPerRow: EXPIRE_ATTEMPTS_PER_REQUEST,
  });
  console.log('[StripeSessionRevocationSweep] pass complete', summary);
  if (rows.length === MAX_PER_RUN) {
    console.warn(`[StripeSessionRevocationSweep] hit the ${MAX_PER_RUN}-row cap — backlog may be growing`);
  }
  return summary;
}

/** Destroy superseded credentials whose retention window has closed. */
export async function runCredentialEraser(now: number = Date.now()): Promise<number> {
  if (now - lastEraserRunAt < ERASER_INTERVAL_MS) return 0;
  lastEraserRunAt = now;
  const erased = await runWithSystemDbAccess(() => eraseExpiredStripeCredentials(new Date(now)));
  if (erased > 0) console.log(`[StripeSessionRevocationSweep] erased ${erased} superseded Stripe credential(s)`);
  return erased;
}

/** Test seam: the eraser's throttle is module state. */
export function resetCredentialEraserThrottleForTests(): void { lastEraserRunAt = 0; }

function createWorker(): Worker<SweepJobData> {
  return new Worker<SweepJobData>(
    QUEUE_NAME,
    async (_job: Job<SweepJobData>) => {
      try {
        const summary = await runStripeSessionRevocationSweep();
        const erasedCredentials = await runCredentialEraser();
        return { ...summary, erasedCredentials };
      } catch (err) {
        console.error('[StripeSessionRevocationSweep] run failed:', err);
        captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
          stripe_revocation_stage: 'expire',
        });
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
    if (job.name === 'revoke-stripe-sessions') await queue.removeRepeatableByKey(job.key);
  }
  await queue.add(
    'revoke-stripe-sessions',
    { type: 'revoke-stripe-sessions', queuedAt: new Date().toISOString() },
    { jobId: 'stripe-session-revocation-sweep', repeat: { every: INTERVAL_MS }, removeOnComplete: { count: 20 }, removeOnFail: { count: 200 } },
  );
}

export async function initializeStripeSessionRevocationSweep(): Promise<void> {
  if (sweepWorker) return;
  sweepWorker = createWorker();
  attachWorkerObservability(sweepWorker, 'stripeSessionRevocationSweep');
  sweepWorker.on('error', (error) => { console.error('[StripeSessionRevocationSweep] Worker error:', error); captureException(error); });
  sweepWorker.on('failed', (job, error) => { console.error(`[StripeSessionRevocationSweep] Job ${job?.id} failed:`, error); captureException(error); });
  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await sweepWorker.close();
    sweepWorker = null;
    throw err;
  }
  console.log('[StripeSessionRevocationSweep] Initialized');
}

export async function shutdownStripeSessionRevocationSweep(): Promise<void> {
  const worker = sweepWorker;
  const queue = sweepQueue;
  sweepWorker = null;
  sweepQueue = null;
  if (worker) { try { await worker.close(); } catch (err) { console.error('[StripeSessionRevocationSweep] Error closing worker:', err); } }
  if (queue) { try { await queue.close(); } catch (err) { console.error('[StripeSessionRevocationSweep] Error closing queue:', err); } }
}
