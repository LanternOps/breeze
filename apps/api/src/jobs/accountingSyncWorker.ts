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
 *     `reauth_required`, `void_blocked_by_payments` (each a 404 or 409 — see
 *     the codes' own status in `accountingInvoicePush.ts`; the last one is
 *     QuickBooks refusing to void an invoice a Payment settles there, a rule
 *     that answers the same on every attempt — #5180) PLUS `record_failed` (502 — the remote
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
import { and, eq, inArray, lt } from 'drizzle-orm';
import { accountingEntityMappings } from '../db/schema/accounting';
import { jobSchedule } from './scheduleRegistry';
import { syncMappedEntity, AccountingMappingError, type MappingEntityType, type AccountingMappingErrorCode } from '../services/accounting/accountingMappingService';
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
  notePaymentJobSkipped,
  paymentDeleteAwaitsRemoteRef,
  AccountingPaymentPushError,
  PAYMENT_NOT_CONNECTED_MESSAGE,
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
interface SyncMappingJobData {
  type: 'sync-mapping';
  partnerId: string;
  breezeEntityType: MappingEntityType;
  breezeEntityId: string;
}
export type AccountingSyncJobData =
  PushInvoiceJobData | VoidInvoiceJobData | PushPaymentJobData | DeletePaymentJobData
  | SyncMappingJobData | { type: 'mapping-sweep' };

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
  'void_blocked_by_payments',
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

const MAPPING_TERMINAL_CODES: ReadonlySet<AccountingMappingErrorCode> = new Set([
  'not_connected', 'reauth_required', 'mapping_conflict', 'entity_not_found',
  'income_account_required', 'mapping_not_ready', 'currency_mismatch',
  'item_price_required', 'record_failed',
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
 *     without calling the coordinator (nothing to sync against). The ONE
 *     exception is a `delete-payment` whose mapping has no remote id: its
 *     grace-window resolution needs no live realm — see
 *     `paymentDeleteAwaitsRemoteRef`.
 *   - `pushMode: 'manual'` gates INVOICE PUSH jobs only. VOID jobs always
 *     process when a mapping exists — books must not keep a voided invoice
 *     open in QuickBooks just because auto-push is off;
 *     `voidInvoiceInAccounting` itself no-ops when the invoice was never
 *     pushed. PAYMENT jobs are gated by the coordinator, not here — see
 *     `processPaymentJob` below.
 */
export async function processAccountingSyncJob(data: AccountingSyncJobData): Promise<void> {
  if (data.type === 'mapping-sweep') {
    await processMappingSweep();
    return;
  }
  await runOutsideDbContext(async () => {
    // The gate read gets its own short system context; the coordinator is then
    // called with NO ambient context and opens its own per-phase ones through
    // this runner (accountingInvoicePush.ts's DB ACCESS CONTRACT). Wrapping the
    // whole job in one context — as this once did — held a pooled connection
    // across every QuickBooks call and rolled back the coordinator's error
    // markers whenever it threw.
    const runInDbContext = <T>(fn: () => Promise<T>): Promise<T> =>
      withSystemDbAccessContext(fn, `accountingSync.${data.type}`);

    if (data.type === 'sync-mapping') {
      try {
        await syncMappedEntity({
          partnerId: data.partnerId, provider: 'quickbooks',
          breezeEntityType: data.breezeEntityType, breezeEntityId: data.breezeEntityId,
        }, runInDbContext);
      } catch (err) {
        // Configuration/ownership refusals need operator action. Provider and
        // unexpected failures use the queue's existing attempts/backoff policy.
        if (!(err instanceof AccountingMappingError) || !MAPPING_TERMINAL_CODES.has(err.code)) throw err;
        console.error('[AccountingSyncWorker] terminal mapping failure, not retrying', err.code, err.message);
        captureException(err, undefined, {
          service: 'accountingSyncWorker', accounting_job_type: data.type,
          accounting_entity_id: data.breezeEntityId, accounting_error_code: err.code,
        });
      }
      return;
    }
    const conn = await runInDbContext(() => getConnection(db, data.partnerId, 'quickbooks'));
    if (!conn || conn.status !== 'connected') {
      // A payment job's mapping row is the OUTBOX, so returning silently here
      // left it `pending` with an empty `last_error` while the 15-minute sweep
      // re-enqueued it forever against a realm that may have been disconnected
      // for weeks (finding I2). The reason is recorded on the row — but the skip
      // is NOT counted against PAYMENT_PUSH_MAX_ATTEMPTS: nothing reached
      // QuickBooks, and counting it retired every pending push in the partner
      // after ~25 hours of a disconnected realm, right before the reconnect that
      // would have completed them (`notePaymentJobSkipped`).
      if (data.type === 'delete-payment'
        && await paymentDeleteAwaitsRemoteRef(data.mappingId, data.partnerId, runInDbContext)) {
        // ...EXCEPT a delete that has no remote id to aim at. That row's whole
        // resolution — park inside PAYMENT_DELETE_UNRESOLVED_GRACE_MS, then drop
        // it loudly — happens before the coordinator resolves a connection at
        // all, and its own comment says it must work for a disconnected realm.
        // Returning here made it unreachable (review finding 8), so a payment
        // destroyed mid-create waited on a reconnect that may never come.
        await processPaymentJob(data, runInDbContext);
        return;
      }
      if (data.type === 'push-payment' || data.type === 'delete-payment') {
        await notePaymentJobSkipped(data.mappingId, data.partnerId, PAYMENT_NOT_CONNECTED_MESSAGE);
      }
      return;
    }
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
        captureException(err, undefined, {
          service: 'accountingSyncWorker',
          accounting_job_type: data.type,
          invoice_id: data.invoiceId,
          accounting_error_code: err.code,
        });
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
        service: 'accountingPaymentPush',
        accounting_job_type: data.type,
        accounting_mapping_id: data.mappingId,
        accounting_error_code: err.code,
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

/** A lost enqueue is recovered from the pending mapping by the sweep. */
export async function enqueueAccountingMappingSync(
  breezeEntityType: MappingEntityType, breezeEntityId: string, partnerId: string,
): Promise<boolean> {
  try {
    await getAccountingSyncQueue().add('sync-mapping', {
      type: 'sync-mapping', partnerId, breezeEntityType, breezeEntityId,
    }, { jobId: mappingJobId(breezeEntityType, breezeEntityId, partnerId), ...ENQUEUE_OPTS });
    return true;
  } catch (err) {
    console.error('[AccountingSyncWorker] failed to enqueue sync-mapping', err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
    return false;
  }
}

function mappingJobId(entityType: MappingEntityType, entityId: string, partnerId: string): string {
  return `accounting-mapping-${partnerId}-${entityType}-${entityId}`;
}

/** Read in a short system context; release its connection before touching Redis. */
export async function processMappingSweep(now = new Date()): Promise<{ enqueued: number; failed: number }> {
  return runOutsideDbContext(async () => {
    const rows = await withSystemDbAccessContext(() => db.select({
      partnerId: accountingEntityMappings.partnerId,
      breezeEntityType: accountingEntityMappings.breezeEntityType,
      breezeEntityId: accountingEntityMappings.breezeEntityId,
    }).from(accountingEntityMappings).where(and(
      eq(accountingEntityMappings.syncStatus, 'pending'),
      inArray(accountingEntityMappings.linkStatus, ['confirmed', 'create_new']),
      inArray(accountingEntityMappings.breezeEntityType, ['org', 'catalog_item']),
      lt(accountingEntityMappings.updatedAt, new Date(now.getTime() - 15 * 60_000)),
    )), 'accountingSync.mapping-sweep');
    let enqueued = 0;
    let failed = 0;
    for (const row of rows) {
      const entityType = row.breezeEntityType as MappingEntityType;
      const job = await getAccountingSyncQueue().getJob(mappingJobId(entityType, row.breezeEntityId, row.partnerId));
      if (job) {
        const state = await job.getState();
        if (state !== 'completed' && state !== 'failed' && state !== 'unknown') continue;
        await job.remove();
      }
      if (await enqueueAccountingMappingSync(entityType, row.breezeEntityId, row.partnerId)) enqueued++;
      else failed++;
    }
    return { enqueued, failed };
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let accountingSyncWorker: Worker<AccountingSyncJobData> | null = null;

/** Initialize the accounting-sync worker and pending-mapping recovery sweep. */
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

    const queue = getAccountingSyncQueue();
    for (const repeatable of await queue.getRepeatableJobs()) {
      if (repeatable.name === 'mapping-sweep') await queue.removeRepeatableByKey(repeatable.key);
    }
    await queue.add('mapping-sweep', { type: 'mapping-sweep' }, {
      repeat: { pattern: jobSchedule('accounting-mapping-sweep') },
      ...ENQUEUE_OPTS,
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
