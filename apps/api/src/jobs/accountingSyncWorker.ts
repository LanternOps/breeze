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
 * shutdown pair). The coordinator does NOT self-wrap in a DB context and must
 * be entered with none open, so this worker runs `runOutsideDbContext` around
 * the job and hands the coordinator a SYSTEM-context runner it re-enters per
 * phase — never one context wrapped around the whole job.
 *
 * Retry taxonomy (keys on `AccountingInvoicePushError.code` — a fixed
 * `TERMINAL_CODES` allowlist below, NOT the HTTP `.status`: `invoice_not_pushable`
 * alone carries both 404 (unknown invoice) and 409 (draft/void), so "terminal
 * = 404/409" would be inaccurate shorthand for how the match actually works):
 *   - TERMINAL (logged, no rethrow — BullMQ marks the job complete): every
 *     code in `TERMINAL_CODES` — `invoice_not_pushable`, `customer_not_mapped`,
 *     `home_currency_unknown`, `currency_mismatch`,
 *     `customer_currency_mismatch`, `dependency_not_ready`, `not_connected`,
 *     `reauth_required` (each a 404 or 409 — see the codes' own status in
 *     `accountingInvoicePush.ts`) PLUS `record_failed` (502 — the remote
 *     QuickBooks write already landed; only the local persist failed, so
 *     retrying would create a duplicate invoice in QuickBooks, not fix
 *     anything). Retrying any of these can never succeed: the mapping row
 *     already carries the error for an operator/route to see and act on.
 *   - RETRYABLE (rethrown so BullMQ's attempts/backoff fires): `quickbooks_error`
 *     (502 — a genuine QuickBooks/network failure), `sync_in_progress` (409 —
 *     a void raced a push that has not recorded its remote id yet), and any
 *     error that is not a typed `AccountingInvoicePushError` at all. The provider sends a
 *     deterministic QBO `requestid` on invoice CREATE (Task 3), so a retried
 *     create after a timeout is idempotent on the QuickBooks side.
 *
 * PAYMENT jobs (Phase D2 — `push-payment`/`delete-payment`) run the same
 * two-lane taxonomy against `AccountingPaymentPushError.code`, via the
 * separate `PAYMENT_TERMINAL_CODES` set below: `push_disabled`,
 * `customer_not_mapped`, `home_currency_unknown`, `currency_mismatch`,
 * `invoice_void`, `record_failed`, `not_connected` and `reauth_required` are
 * terminal; `quickbooks_error`, `sync_in_progress` and `invoice_not_synced`
 * (plus any non-typed error) are retryable. Unlike invoice jobs, the
 * `pushMode` gate does NOT apply to payment jobs — see the handler below.
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
import {
  pushPaymentToAccounting,
  deletePaymentInAccounting,
  AccountingPaymentPushError,
  type AccountingPaymentPushErrorCode,
  type PaymentPushOutcome,
  type PaymentDeleteOutcome,
} from '../services/accounting/accountingPaymentPush';

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
interface PushPaymentJobData {
  type: 'push-payment';
  /** accounting_entity_mappings.id — the outbox row, NOT the invoice_payments id.
   *  The mapping is the durable record of what is owed; the job is a nudge. */
  mappingId: string;
  partnerId: string;
}
interface DeletePaymentJobData {
  type: 'delete-payment';
  mappingId: string;
  partnerId: string;
}
export type AccountingSyncJobData =
  PushInvoiceJobData | VoidInvoiceJobData | PushPaymentJobData | DeletePaymentJobData;

// Matched by CODE, not `.status` — every code below is terminal because
// retrying cannot fix a permanent mapping/currency problem (most carry status
// 404 or 409; `invoice_not_pushable` alone can be either, depending which
// precondition failed), plus `record_failed` — a 502 that is NEVER retry-safe
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

/**
 * Terminal for a PAYMENT job. Same rule as the invoice set above — retrying can
 * never fix a permanent configuration problem, and the mapping row already
 * carries the reason for an operator. `record_failed` is terminal for the
 * stronger reason: the QuickBooks Payment already exists, so a retry would
 * create a SECOND one for money that moved once. `quickbooks_error`,
 * `sync_in_progress` and `invoice_not_synced` are the retryable trio.
 */
const PAYMENT_TERMINAL_CODES: ReadonlySet<AccountingPaymentPushErrorCode> = new Set([
  'push_disabled',
  'customer_not_mapped',
  'home_currency_unknown',
  'currency_mismatch',
  'invoice_void',
  'record_failed',
  'not_connected',
  'reauth_required',
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
 * Runs one push/void/payment job. The coordinators (`accountingInvoicePush.ts`,
 * `accountingPaymentPush.ts`) do not self-wrap in a DB context and assert they
 * were entered with none — see the runner built below.
 *
 * Gating:
 *   - No QuickBooks connection, or one not in `status: 'connected'` — return
 *     without calling the coordinator (nothing to sync against).
 *   - `pushMode: 'manual'` gates INVOICE PUSH jobs only. VOID jobs always
 *     process when a mapping exists — books must not keep a voided invoice
 *     open in QuickBooks just because auto-push is off;
 *     `voidInvoiceInAccounting` itself no-ops when the invoice was never
 *     pushed. PAYMENT jobs are gated by the coordinator, not here — see
 *     `processPaymentJob` below.
 */
export async function processAccountingSyncJob(data: AccountingSyncJobData): Promise<void> {
  await runOutsideDbContext(async () => {
    // The gate read gets its own short system context; the coordinator is then
    // called with NO ambient context and opens its own per-phase ones through
    // this runner (accountingInvoicePush.ts's DB ACCESS CONTRACT). Wrapping the
    // whole job in one context — as this once did — held a pooled connection
    // across every QuickBooks call and rolled back the coordinator's error
    // markers whenever it threw.
    const runInDbContext = <T>(fn: () => Promise<T>): Promise<T> =>
      withSystemDbAccessContext(fn, `accountingSync.${data.type}`);

    const conn = await runInDbContext(() => getConnection(db, data.partnerId, 'quickbooks'));
    if (!conn || conn.status !== 'connected') return;
    // The pushMode gate applies to push-invoice ONLY. A payment job that exists
    // at all was authorised when its mapping row was created — `requestPaymentPush`
    // already refused in manual mode, so a payment job in manual mode came from
    // the invoice push's own fan-out and must run. Deletes run in every mode:
    // once Breeze created a Payment in QuickBooks it owns its removal.
    if (data.type === 'push-invoice' && conn.pushMode !== 'auto') return;

    if (data.type === 'push-payment' || data.type === 'delete-payment') {
      await processPaymentJob(data, runInDbContext);
      return;
    }

    try {
      if (data.type === 'push-invoice') {
        await pushInvoiceToAccounting(data.invoiceId, data.partnerId, runInDbContext);
      } else {
        await voidInvoiceInAccounting(data.invoiceId, data.partnerId, runInDbContext);
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
      // quickbooks_error (502), sync_in_progress (409 — a push is mid-flight,
      // retry once it lands) or an unexpected/non-typed error: rethrow so
      // BullMQ's attempts/backoff (set at enqueue time) retries it.
      throw err;
    }
  });
}

/**
 * Runs one payment job (push or delete) through the payment coordinator.
 *
 * The coordinator NEVER touches Redis (see `accountingPaymentPush.ts`'s
 * header), so the follow-up delete it decides on — the payment was
 * voided/refunded while the create was in flight — is enqueued HERE. If this
 * enqueue is lost the sweep re-enqueues it within 15 minutes; the mapping row
 * still carries `pending_op = 'delete'` until the delete actually lands.
 */
async function processPaymentJob(
  data: PushPaymentJobData | DeletePaymentJobData,
  runInDbContext: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<void> {
  const startedAt = Date.now();
  let outcome: PaymentPushOutcome | PaymentDeleteOutcome;
  try {
    outcome = data.type === 'push-payment'
      ? await pushPaymentToAccounting(data.mappingId, data.partnerId, runInDbContext)
      : await deletePaymentInAccounting(data.mappingId, data.partnerId, runInDbContext);
  } catch (err) {
    if (err instanceof AccountingPaymentPushError && PAYMENT_TERMINAL_CODES.has(err.code)) {
      console.error(
        '[AccountingSyncWorker] terminal payment failure, not retrying',
        `type=${data.type}`, `mappingId=${data.mappingId}`, `code=${err.code}`, err.message,
      );
      captureException(err, undefined, {
        service: 'accountingPaymentPush', type: data.type, mappingId: data.mappingId, code: err.code,
      });
      return;
    }
    throw err;
  }

  console.log(
    '[AccountingSyncWorker] payment job complete',
    `type=${data.type}`, `mappingId=${data.mappingId}`, `outcome=${outcome}`, `durationMs=${Date.now() - startedAt}`,
  );

  // The coordinator's converted_to_delete outcome (a push that discovered its
  // payment was voided mid-flight) needs a follow-up delete job — the
  // coordinator itself never touches Redis, so that enqueue happens here.
  if (outcome === 'converted_to_delete') {
    await enqueueAccountingPaymentDelete(data.mappingId, data.partnerId);
  }
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

/**
 * `removeOnComplete`/`removeOnFail` are `true` (drop immediately), NOT a
 * retained count. The jobId is deterministic per invoice
 * (`accounting-push-<invoiceId>`), and BullMQ SILENTLY drops an `add()` whose
 * jobId still exists in the completed/failed sets — so retaining the last 100
 * completed / 500 failed jobs made a re-push after fixing a mapping a no-op
 * that the route still reported as `enqueued`. Dedup of a job that is genuinely
 * IN FLIGHT is unaffected (that lives in wait/active, not the retained sets),
 * and durable failure state already lives on the mapping row plus Sentry, so
 * nothing is lost by not keeping the job records.
 */
const ENQUEUE_OPTS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: true,
  removeOnFail: true,
};

/**
 * Enqueue a QuickBooks push for a just-issued invoice. Fire-and-forget: a
 * Redis outage must NEVER fail the issuance that triggered it — the invoice
 * is simply not auto-synced until the next manual push/retry.
 *
 * Returns whether the queue ACCEPTED the job. The post-commit issue/void hooks
 * ignore it (there is nothing they could do), but the bulk push route reports
 * it: counting a swallowed Redis failure as "enqueued" told the operator the
 * work was queued when nothing had been.
 */
export async function enqueueAccountingInvoicePush(invoiceId: string, partnerId: string): Promise<boolean> {
  try {
    await getAccountingSyncQueue().add(
      'push-invoice',
      { type: 'push-invoice', invoiceId, partnerId },
      { jobId: `accounting-push-${invoiceId}`, ...ENQUEUE_OPTS }
    );
    return true;
  } catch (err) {
    console.error('[AccountingSyncWorker] failed to enqueue push-invoice', `invoiceId=${invoiceId}`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
    return false;
  }
}

/**
 * Enqueue a QuickBooks void for a just-voided invoice. Fire-and-forget for
 * the same reason as the push enqueue above.
 */
export async function enqueueAccountingInvoiceVoid(invoiceId: string, partnerId: string): Promise<boolean> {
  try {
    await getAccountingSyncQueue().add(
      'void-invoice',
      { type: 'void-invoice', invoiceId, partnerId },
      { jobId: `accounting-void-${invoiceId}`, ...ENQUEUE_OPTS }
    );
    return true;
  } catch (err) {
    console.error('[AccountingSyncWorker] failed to enqueue void-invoice', `invoiceId=${invoiceId}`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
    return false;
  }
}

/**
 * Nudge the worker to push a pending payment mapping. Fire-and-forget: the
 * mapping row is the durable record, so a Redis outage only delays the push
 * until the 15-minute reconcile sweep re-enqueues it.
 *
 * The jobId carries the OPERATION as well as the mapping id. With a shared
 * `accounting-payment-<mappingId>` id, a delete enqueued while a push job for
 * the same row was still active would be silently swallowed as a duplicate —
 * and the QuickBooks Payment would stay in the books forever.
 */
export async function enqueueAccountingPaymentPush(mappingId: string, partnerId: string): Promise<boolean> {
  return enqueuePaymentJob('push-payment', mappingId, partnerId);
}

/** Same contract as the push enqueue above, for the removal half. */
export async function enqueueAccountingPaymentDelete(mappingId: string, partnerId: string): Promise<boolean> {
  return enqueuePaymentJob('delete-payment', mappingId, partnerId);
}

async function enqueuePaymentJob(
  type: 'push-payment' | 'delete-payment', mappingId: string, partnerId: string,
): Promise<boolean> {
  const op = type === 'push-payment' ? 'push' : 'delete';
  try {
    await getAccountingSyncQueue().add(
      type,
      { type, mappingId, partnerId } as AccountingSyncJobData,
      { jobId: `accounting-payment-${mappingId}-${op}`, ...ENQUEUE_OPTS },
    );
    return true;
  } catch (err) {
    console.error(`[AccountingSyncWorker] failed to enqueue ${type}`, `mappingId=${mappingId}`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
    return false;
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
