import { Job, Queue, Worker } from 'bullmq';
import * as dbModule from '../db';
import { getBullMQConnection } from '../services/redis';
import { captureException, captureMessage } from '../services/sentry';
import {
  AI_BUDGET_RESERVATION_ACTIVE_TTL_MS,
  AI_BUDGET_RESERVATION_INDETERMINATE_TTL_MS,
  expireStaleAiBudgetReservations,
} from '../services/aiBudgetReservations';
import { attachWorkerObservability } from './workerObservability';

/**
 * Expiry sweep for durable AI budget reservations (SEC-142/143, review B3).
 *
 * An admission reserves the organization's ENTIRE remaining daily/monthly cap
 * and every unknown provider outcome is deliberately kept `indeterminate`, so
 * without this job a single Anthropic 529 — or a deploy that kills an in-flight
 * turn — would hold a tenant's monthly budget at zero until the 1st, with no
 * admin path to clear it.
 *
 * Admission is already correct without the sweep: it only counts reservations
 * whose `expires_at` is still in the future. This job exists so the stored
 * `status` matches reality for anyone reading the table, and so every reclaimed
 * cap leaves a trace.
 *
 * Runs every 5 min. Idempotent by construction — the UPDATE's predicate matches
 * only rows still holding capacity past their window, so an overlapping run,
 * a retry, or a second process sweeps nothing twice.
 */

const QUEUE_NAME = 'ai-budget-reservation-sweep';
const JOB_NAME = 'expire-stale-ai-budget-reservations';
const INTERVAL_MS = 5 * 60 * 1000; // every 5 min
const MAX_PER_RUN = 500;

type SweepJobData = { type: 'expire-stale-ai-budget-reservations'; queuedAt: string };

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') {
    throw new Error('[AiBudgetReservationSweep] withSystemDbAccessContext not available');
  }
  return withSystem(fn, 'aiBudgetReservationSweep.expire');
};

let sweepQueue: Queue<SweepJobData> | null = null;
let sweepWorker: Worker<SweepJobData> | null = null;

function getQueue(): Queue<SweepJobData> {
  if (!sweepQueue) sweepQueue = new Queue<SweepJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  return sweepQueue;
}

/**
 * One pass. Returns the number of reservations whose capacity was reclaimed.
 *
 * Reporting is two-tier, and deliberately NOT a Sentry breadcrumb: `scrubEvent`
 * (services/sentry.ts) deletes `breadcrumbs` from every outbound event, so a
 * per-row breadcrumb would be dead code — the same "type advertising a
 * capability it does not have" failure that module's own comments call out.
 * Per-row detail therefore goes to `console.warn` (structured, ids and amounts
 * only, no customer content), and ONE grouped `captureMessage` per run carries
 * the signal to Sentry with a registered event code and a low-cardinality tag.
 * One issue saying "budgets are being reclaimed", not one per reservation.
 */
export async function sweepExpiredAiBudgetReservations(): Promise<number> {
  const expired = await expireStaleAiBudgetReservations(MAX_PER_RUN);
  if (expired.length === 0) return 0;

  let activeTtl = 0;
  let indeterminateTtl = 0;
  for (const row of expired) {
    if (row.reason === 'active_ttl') activeTtl++; else indeterminateTtl++;
    console.warn('[AiBudgetReservationSweep] reservation expired', {
      reservationId: row.reservationId,
      orgId: row.orgId,
      reason: row.reason,
      reservedCostCents: row.reservedCostCents,
    });
  }

  console.warn(
    `[AiBudgetReservationSweep] reclaimed ${expired.length} reservation(s) ` +
    `(active_ttl=${activeTtl}, indeterminate_ttl=${indeterminateTtl})`,
  );
  captureMessage('AI budget reservations expired without settling', {
    eventCode: 'ai_budget_reservation_expired',
    // Low-cardinality on purpose: which TTL fired, never which org. An
    // active_ttl run means dispatches are dying before they settle; an
    // indeterminate_ttl run means provider outcomes stayed unknown for a day.
    tags: { ai_budget_expiry_reason: activeTtl > 0 ? 'active_ttl' : 'indeterminate_ttl' },
  });

  if (expired.length === MAX_PER_RUN) {
    console.warn(`[AiBudgetReservationSweep] hit the ${MAX_PER_RUN}-row cap — backlog may be growing`);
  }
  return expired.length;
}

function createWorker(): Worker<SweepJobData> {
  return new Worker<SweepJobData>(
    QUEUE_NAME,
    async (_job: Job<SweepJobData>) => {
      try {
        return { expired: await runWithSystemDbAccess(sweepExpiredAiBudgetReservations) };
      } catch (err) {
        console.error('[AiBudgetReservationSweep] run failed:', err);
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
    if (job.name === JOB_NAME) await queue.removeRepeatableByKey(job.key);
  }
  await queue.add(
    JOB_NAME,
    { type: JOB_NAME, queuedAt: new Date().toISOString() },
    {
      jobId: QUEUE_NAME,
      repeat: { every: INTERVAL_MS },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    },
  );
}

export async function initializeAiBudgetReservationSweep(): Promise<void> {
  if (sweepWorker) return;
  sweepWorker = createWorker();
  attachWorkerObservability(sweepWorker, 'aiBudgetReservationSweep');
  sweepWorker.on('error', (error) => {
    console.error('[AiBudgetReservationSweep] Worker error:', error);
    captureException(error);
  });
  sweepWorker.on('failed', (job, error) => {
    console.error(`[AiBudgetReservationSweep] Job ${job?.id} failed:`, error);
    captureException(error);
  });
  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await sweepWorker.close();
    sweepWorker = null;
    throw err;
  }
  console.log(
    '[AiBudgetReservationSweep] Initialized ' +
    `(every ${INTERVAL_MS / 60000}m; active TTL ${AI_BUDGET_RESERVATION_ACTIVE_TTL_MS / 60000}m, ` +
    `indeterminate TTL ${AI_BUDGET_RESERVATION_INDETERMINATE_TTL_MS / 3600000}h)`,
  );
}

export async function shutdownAiBudgetReservationSweep(): Promise<void> {
  const worker = sweepWorker;
  const queue = sweepQueue;
  sweepWorker = null;
  sweepQueue = null;
  if (worker) {
    try { await worker.close(); } catch (err) { console.error('[AiBudgetReservationSweep] Error closing worker:', err); }
  }
  if (queue) {
    try { await queue.close(); } catch (err) { console.error('[AiBudgetReservationSweep] Error closing queue:', err); }
  }
}
