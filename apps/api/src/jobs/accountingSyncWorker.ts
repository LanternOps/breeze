/**
 * Accounting Sync Worker
 *
 * BullMQ worker for QuickBooks invoice push/void side effects (Phase C, Task 4
 * — .superpowers/sdd/2026-09-01-quickbooks-phase-c-invoice-push/task-4-brief.md).
 * Fired from `invoiceService.ts`'s issue/void post-commit hooks, this is the
 * ONLY caller of `pushInvoiceToAccounting`/`voidInvoiceInAccounting`
 * (`accountingInvoicePush.ts`) that runs off the request path.
 *
 * Mirrors `invoiceWorker.ts` (queue singleton, discriminated job data,
 * exported handler for direct unit testing, createXWorker, initialize/
 * shutdown pair) and `contractWorker.ts` (the coordinator does NOT self-wrap
 * in system DB context, so the worker supplies `runOutsideDbContext(() =>
 * withSystemDbAccessContext(...))` itself around every job).
 *
 * Retry taxonomy (keys on `AccountingInvoicePushError.code`):
 *   - TERMINAL (logged, no rethrow — BullMQ marks the job complete): every
 *     404/409 code (`invoice_not_pushable`, `customer_not_mapped`,
 *     `home_currency_unknown`, `currency_mismatch`,
 *     `customer_currency_mismatch`, `dependency_not_ready`, `not_connected`,
 *     `reauth_required`) PLUS `record_failed` (502 — the remote QuickBooks
 *     write already landed; only the local persist failed, so retrying would
 *     create a duplicate invoice in QuickBooks, not fix anything). Retrying
 *     any of these can never succeed: the mapping row already carries the
 *     error for an operator/route to see and act on.
 *   - RETRYABLE (rethrown so BullMQ's attempts/backoff fires): `quickbooks_error`
 *     (502 — a genuine QuickBooks/network failure) and any error that is not
 *     a typed `AccountingInvoicePushError` at all. The provider sends a
 *     deterministic QBO `requestid` on invoice CREATE (Task 3), so a retried
 *     create after a timeout is idempotent on the QuickBooks side.
 */

import { Queue, Worker, Job } from 'bullmq';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { attachWorkerObservability } from './workerObservability';
import { getConnection } from '../services/accounting/accountingConnectionService';
import {
  pushInvoiceToAccounting,
  voidInvoiceInAccounting,
  AccountingInvoicePushError,
  type AccountingInvoicePushErrorCode,
} from '../services/accounting/accountingInvoicePush';

export const ACCOUNTING_SYNC_QUEUE = 'accounting-sync';

interface PushInvoiceJobData {
  type: 'push-invoice';
  invoiceId: string;
  partnerId: string;
}
interface VoidInvoiceJobData {
  type: 'void-invoice';
  invoiceId: string;
  partnerId: string;
}
export type AccountingSyncJobData = PushInvoiceJobData | VoidInvoiceJobData;

// Every 404/409 code is terminal (retrying cannot fix a permanent mapping/
// currency problem), plus `record_failed` — a 502 that is NEVER retry-safe
// because the QuickBooks write already succeeded. `quickbooks_error` is the
// one 502 code deliberately absent from this set: it is the only retryable
// typed outcome.
const TERMINAL_CODES: ReadonlySet<AccountingInvoicePushErrorCode> = new Set([
  'invoice_not_pushable',
  'customer_not_mapped',
  'home_currency_unknown',
  'currency_mismatch',
  'customer_currency_mismatch',
  'dependency_not_ready',
  'not_connected',
  'reauth_required',
  'record_failed',
]);

let accountingSyncQueue: Queue<AccountingSyncJobData> | null = null;

/** Get or create the accounting-sync queue. */
export function getAccountingSyncQueue(): Queue<AccountingSyncJobData> {
  if (!accountingSyncQueue) {
    accountingSyncQueue = new Queue<AccountingSyncJobData>(ACCOUNTING_SYNC_QUEUE, { connection: getBullMQConnection() });
  }
  return accountingSyncQueue;
}

// ---------------------------------------------------------------------------
// Job handler (exported for direct unit testing)
// ---------------------------------------------------------------------------

/**
 * Runs one push/void job inside a system DB context — the coordinator
 * (`accountingInvoicePush.ts`) does not self-wrap, matching `contractWorker`'s
 * `generateDueInvoice`.
 *
 * Gating:
 *   - No QuickBooks connection, or one not in `status: 'connected'` — return
 *     without calling the coordinator (nothing to sync against).
 *   - `pushMode: 'manual'` gates PUSH jobs only. VOID jobs always process when
 *     a mapping exists — books must not keep a voided invoice open in
 *     QuickBooks just because auto-push is off; `voidInvoiceInAccounting`
 *     itself no-ops when the invoice was never pushed.
 */
export async function processAccountingSyncJob(data: AccountingSyncJobData): Promise<void> {
  await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const conn = await getConnection(db, data.partnerId, 'quickbooks');
    if (!conn || conn.status !== 'connected') return;
    if (data.type === 'push-invoice' && conn.pushMode !== 'auto') return;

    try {
      if (data.type === 'push-invoice') {
        await pushInvoiceToAccounting(data.invoiceId, data.partnerId);
      } else {
        await voidInvoiceInAccounting(data.invoiceId, data.partnerId);
      }
    } catch (err) {
      if (err instanceof AccountingInvoicePushError && TERMINAL_CODES.has(err.code)) {
        console.error(
          '[AccountingSyncWorker] terminal failure, not retrying',
          `type=${data.type}`, `invoiceId=${data.invoiceId}`, `code=${err.code}`, err.message,
        );
        captureException(err, undefined, { service: 'accountingSyncWorker', type: data.type, invoiceId: data.invoiceId, code: err.code });
        return;
      }
      // quickbooks_error (502) or an unexpected/non-typed error — rethrow so
      // BullMQ's attempts/backoff (set at enqueue time) retries it.
      throw err;
    }
  }));
}

/** Create the accounting-sync worker. */
export function createAccountingSyncWorker(): Worker<AccountingSyncJobData> {
  return new Worker<AccountingSyncJobData>(
    ACCOUNTING_SYNC_QUEUE,
    async (job: Job<AccountingSyncJobData>) => processAccountingSyncJob(job.data),
    {
      connection: getBullMQConnection(),
      concurrency: 2,
    }
  );
}

// ---------------------------------------------------------------------------
// Enqueue helpers (Redis-outage-safe; mirror enqueueInvoicePdfRender)
// ---------------------------------------------------------------------------

const ENQUEUE_OPTS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
};

/**
 * Enqueue a QuickBooks push for a just-issued invoice. Fire-and-forget: a
 * Redis outage must NEVER fail the issuance that triggered it — the invoice
 * is simply not auto-synced until the next manual push/retry.
 */
export async function enqueueAccountingInvoicePush(invoiceId: string, partnerId: string): Promise<void> {
  try {
    await getAccountingSyncQueue().add(
      'push-invoice',
      { type: 'push-invoice', invoiceId, partnerId },
      { jobId: `accounting-push-${invoiceId}`, ...ENQUEUE_OPTS }
    );
  } catch (err) {
    console.error('[AccountingSyncWorker] failed to enqueue push-invoice', `invoiceId=${invoiceId}`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Enqueue a QuickBooks void for a just-voided invoice. Fire-and-forget for
 * the same reason as the push enqueue above.
 */
export async function enqueueAccountingInvoiceVoid(invoiceId: string, partnerId: string): Promise<void> {
  try {
    await getAccountingSyncQueue().add(
      'void-invoice',
      { type: 'void-invoice', invoiceId, partnerId },
      { jobId: `accounting-void-${invoiceId}`, ...ENQUEUE_OPTS }
    );
  } catch (err) {
    console.error('[AccountingSyncWorker] failed to enqueue void-invoice', `invoiceId=${invoiceId}`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let accountingSyncWorker: Worker<AccountingSyncJobData> | null = null;

/** Initialize the accounting-sync worker. Call during app startup. No
 *  repeatable jobs — Phase C has no scheduled accounting sync. */
export async function initializeAccountingSyncWorkers(): Promise<void> {
  try {
    accountingSyncWorker = createAccountingSyncWorker();
    attachWorkerObservability(accountingSyncWorker, 'accountingSyncWorker');

    accountingSyncWorker.on('error', (error) => {
      console.error('[AccountingSyncWorker] Worker error:', error);
    });
    accountingSyncWorker.on('failed', (job, error) => {
      console.error(`[AccountingSyncWorker] Job ${job?.id} failed:`, error);
    });

    console.log('[AccountingSyncWorker] Accounting sync worker initialized');
  } catch (error) {
    console.error('[AccountingSyncWorker] Failed to initialize:', error);
    throw error;
  }
}

/** Shutdown the accounting-sync worker + queue gracefully. */
export async function shutdownAccountingSyncWorkers(): Promise<void> {
  if (accountingSyncWorker) {
    await accountingSyncWorker.close();
    accountingSyncWorker = null;
  }
  if (accountingSyncQueue) {
    await accountingSyncQueue.close();
    accountingSyncQueue = null;
  }
  console.log('[AccountingSyncWorker] Accounting sync worker shut down');
}
