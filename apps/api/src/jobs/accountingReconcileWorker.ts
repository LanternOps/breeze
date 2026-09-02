/**
 * Accounting Reconcile Worker (QuickBooks -> Breeze payment pull-back)
 *
 * Phase D, Task 4 —
 * `.superpowers/sdd/2026-09-02-quickbooks-phase-d-payment-pullback/task-4-brief.md`.
 *
 * Drains one QuickBooks CDC window per connection: `reconcileChanges` (Task 2)
 * reads everything that changed since the connection's `cdc_cursor`, and the
 * appliers in `accountingPaymentPull.ts` (Task 3) land each item. A 15-minute
 * repeatable `sweep` job fans out one `reconcile-connection` job per
 * pull-enabled connection; the QuickBooks webhook route enqueues the same job
 * shape with `trigger: 'webhook'`, and the "Sync now" route with
 * `trigger: 'manual'`.
 *
 * Structured on `accountingSyncWorker.ts` (queue singleton, discriminated job
 * data, handler exported for direct unit testing, createX/initialize/shutdown)
 * and on `huntressSync.ts:1108-1126` for the remove-then-add repeatable
 * registration.
 *
 * DB CONTEXT. Every Task-1/Task-3 entry point this module calls asserts it was
 * entered with NO ambient DB access context and takes a `DbContextRunner`
 * instead (`services/accounting/dbContextGuard.ts` — read its header). So the
 * job body runs under `runOutsideDbContext` and hands down a runner that opens
 * ONE SHORT system context per phase. Wrapping the whole job in a single
 * context would pin a pooled Postgres connection idle-in-transaction across
 * every QuickBooks round trip (#1105) AND turn each applier's sync-state write
 * into a savepoint that vanishes the moment anything downstream throws.
 *
 * DELETIONS BEFORE ADDITIONS (plan decision 4). Within one CDC window a
 * payment can be created and deleted, or an invoice deleted after a payment
 * landed against it. Processing deletions first means the window can only ever
 * converge on "deleted"; the reverse order would resurrect a row and then
 * delete it, or delete a row and then re-create it from the same window.
 *
 * RETRY TAXONOMY — the cursor is the whole point:
 *   - CLEAN (cursor advances, job completes): `applied`, `updated`,
 *     `replayed`, `reversed`, and the three RECORDED PERMANENT outcomes
 *     `skipped_unmapped`, `currency_mismatch` and `invoice_void`. The last
 *     three cannot be fixed by retrying — the divergence is already recorded
 *     on the mapping row for an operator — so holding the cursor for them
 *     would wedge the connection and re-report the same item every 15 minutes
 *     forever.
 *   - DIRTY (cursor is LEFT EXACTLY WHERE IT WAS and the job rethrows so
 *     BullMQ's attempts/backoff replays the whole window): any per-item
 *     `failed`, whether an applier threw or a reversal reported `failed`.
 *     Advancing past a failed item loses it permanently — nothing else ever
 *     re-reads that window. Replay is safe: the appliers are idempotent (the
 *     `(payment, invoice)` mapping claim is at-most-once and a reversal whose
 *     mapping row is already gone is a clean no-op).
 */

import { Queue, Worker, Job } from 'bullmq';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { attachWorkerObservability } from './workerObservability';
import {
  advanceReconcileCursor,
  backfillRealmFingerprints,
  getConnection,
  listReconcilableConnections,
  stampReconcileRunError,
} from '../services/accounting/accountingConnectionService';
import { resolveConnectionAndToken } from '../services/accounting/accountingMappingService';
import { getAccountingProvider } from '../services/accounting/providerRegistry';
import type { ChangeSetPaymentLine } from '../services/accounting/types';
import {
  applyAccountingPayment,
  markInvoiceDeletedRemotely,
  reverseAccountingPayment,
  reverseStaleAllocations,
  type PaymentPullOutcome,
} from '../services/accounting/accountingPaymentPull';
import { listOwedPaymentMappings } from '../services/accounting/accountingPaymentPush';
import { enqueueAccountingPaymentPush, enqueueAccountingPaymentDelete } from './accountingSyncWorker';

export const ACCOUNTING_RECONCILE_QUEUE = 'accounting-reconcile';

/**
 * 15 minutes. Deliberately BELOW `COARSE_REPEAT_INTERVAL_MS` (1 h), so this
 * repeat needs no `scheduleRegistry` slot — `scheduleRegistry.contract.test.ts`
 * only asserts on coarse `every` values at or above that threshold (same
 * rationale as `fixWatchWorker.ts:40`).
 */
export const RECONCILE_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

export interface ReconcileConnectionJobData {
  type: 'reconcile-connection';
  connectionId: string;
  partnerId: string;
  trigger: 'webhook' | 'sweep' | 'manual';
}

export interface ReconcileSweepJobData {
  type: 'sweep';
}

export type AccountingReconcileJobData = ReconcileConnectionJobData | ReconcileSweepJobData;

export interface ReconcileRunSummary {
  applied: number;
  updated: number;
  replayed: number;
  reversed: number;
  skippedUnmapped: number;
  currencyMismatch: number;
  /**
   * QuickBooks took money against an invoice Breeze had already voided. Added
   * after the Task-4 brief was written (Task 3 introduced the outcome): CLEAN
   * for cursor purposes, exactly like `currencyMismatch`.
   */
  invoiceVoid: number;
  /**
   * The connection was re-authorised against a DIFFERENT QuickBooks realm while
   * this run was in flight, so the applier declined to write (finding C). CLEAN
   * for the run's error accounting — nothing failed, and the cursor is held by
   * the compare-and-set below, not by this counter.
   */
  realmChanged: number;
  failed: number;
  invoicesMarkedDeleted: number;
  cursorBefore: Date | null;
  cursorAfter: Date | null;
}

let accountingReconcileQueue: Queue<AccountingReconcileJobData> | null = null;

/** Get or create the accounting-reconcile queue. */
export function getAccountingReconcileQueue(): Queue<AccountingReconcileJobData> {
  if (!accountingReconcileQueue) {
    accountingReconcileQueue = new Queue<AccountingReconcileJobData>(
      ACCOUNTING_RECONCILE_QUEUE,
      { connection: getBullMQConnection() },
    );
  }
  return accountingReconcileQueue;
}

// ---------------------------------------------------------------------------
// Summary helpers
// ---------------------------------------------------------------------------

function emptySummary(cursorBefore: Date | null): ReconcileRunSummary {
  return {
    applied: 0,
    updated: 0,
    replayed: 0,
    reversed: 0,
    skippedUnmapped: 0,
    currencyMismatch: 0,
    invoiceVoid: 0,
    realmChanged: 0,
    failed: 0,
    invoicesMarkedDeleted: 0,
    cursorBefore,
    cursorAfter: null,
  };
}

/**
 * Fold one applier outcome into the run summary. `failed` is a real arm, not a
 * default: a REVERSAL that reports `failed` (rather than throwing) must hold
 * the cursor exactly like a thrown apply does, and routing it through the same
 * counter is what makes that automatic.
 */
function tally(summary: ReconcileRunSummary, outcome: PaymentPullOutcome): void {
  switch (outcome) {
    case 'applied': summary.applied++; break;
    case 'updated': summary.updated++; break;
    case 'replayed': summary.replayed++; break;
    case 'reversed': summary.reversed++; break;
    case 'skipped_unmapped': summary.skippedUnmapped++; break;
    case 'currency_mismatch': summary.currencyMismatch++; break;
    case 'invoice_void': summary.invoiceVoid++; break;
    case 'realm_changed': summary.realmChanged++; break;
    case 'failed': summary.failed++; break;
  }
}

/**
 * Group a CDC window's payment lines by QuickBooks Payment id, PRESERVING the
 * order the provider emitted them in (a `Map` iterates in insertion order), so
 * the applier sequence stays deterministic and testable.
 */
function groupPaymentsById(
  lines: readonly ChangeSetPaymentLine[],
): Map<string, ChangeSetPaymentLine[]> {
  const grouped = new Map<string, ChangeSetPaymentLine[]>();
  for (const line of lines) {
    const existing = grouped.get(line.remotePaymentId);
    if (existing) existing.push(line);
    else grouped.set(line.remotePaymentId, [line]);
  }
  return grouped;
}

function logRunLine(data: ReconcileConnectionJobData, summary: ReconcileRunSummary, durationMs: number): void {
  console.log(
    '[AccountingReconcileWorker] run complete',
    `connectionId=${data.connectionId}`,
    `trigger=${data.trigger}`,
    `applied=${summary.applied}`,
    `updated=${summary.updated}`,
    `replayed=${summary.replayed}`,
    `reversed=${summary.reversed}`,
    `skippedUnmapped=${summary.skippedUnmapped}`,
    `currencyMismatch=${summary.currencyMismatch}`,
    `invoiceVoid=${summary.invoiceVoid}`,
    `realmChanged=${summary.realmChanged}`,
    `failed=${summary.failed}`,
    `invoicesMarkedDeleted=${summary.invoicesMarkedDeleted}`,
    `cursorBefore=${summary.cursorBefore?.toISOString() ?? 'null'}`,
    `cursorAfter=${summary.cursorAfter?.toISOString() ?? 'null'}`,
    `durationMs=${durationMs}`,
  );
}

// ---------------------------------------------------------------------------
// Job handlers (exported for direct unit testing)
// ---------------------------------------------------------------------------

/**
 * Reconcile ONE connection's CDC window.
 *
 * Returns null when the job is a no-op: no connection, a connection that is
 * not the one the job names, one that is not `connected`, or one with BOTH
 * direction switches off. Phase D2 (spec decision 6): pull-off/push-on still
 * runs the CDC pass — it is what ADOPTS a Breeze-created Payment whose phase
 * 2 never landed and what notices a Breeze-origin Payment deleted in
 * QuickBooks — it just suppresses new QuickBooks-origin imports. A
 * switched-off connection (both switches off) short-circuits BEFORE
 * `resolveConnectionAndToken`: that call is itself a QuickBooks round trip
 * plus a token write, and refreshing tokens for a connection the operator has
 * fully disabled is work nobody asked for.
 */
export async function processReconcileConnectionJob(
  data: ReconcileConnectionJobData,
): Promise<ReconcileRunSummary | null> {
  const startedAt = Date.now();
  return runOutsideDbContext(async () => {
    const runInDbContext = <T>(fn: () => Promise<T>): Promise<T> =>
      withSystemDbAccessContext(fn, `accountingReconcile.${data.trigger}`);

    const conn = await runInDbContext(() => getConnection(db, data.partnerId, 'quickbooks'));
    const shortCircuit = (reason: 'missing' | 'connection_mismatch' | 'not_connected' | 'both_switches_off'): null => {
      console.log(
        '[AccountingReconcileWorker] short-circuit',
        `connectionId=${data.connectionId}`, `trigger=${data.trigger}`, `reason=${reason}`,
      );
      return null;
    };
    if (!conn) return shortCircuit('missing');
    if (conn.id !== data.connectionId) return shortCircuit('connection_mismatch');
    if (conn.status !== 'connected') return shortCircuit('not_connected');
    if (!conn.pullPayments && !conn.pushPayments) return shortCircuit('both_switches_off');

    const { conn: fresh, liveConn } = await resolveConnectionAndToken(data.partnerId, 'quickbooks', runInDbContext);
    // The realm generation this ENTIRE run is staked on (finding C). Reconnecting
    // to a different QuickBooks company reuses this same connection row, so every
    // write below re-checks this value inside its own transaction and the final
    // cursor write is a compare-and-set on it.
    const expectedRealmFingerprint = fresh.realmIdFingerprint;
    const provider = getAccountingProvider(fresh.provider);
    const changes = await runOutsideDbContext(() => provider.reconcileChanges(liveConn, fresh.cdcCursor));

    const summary = emptySummary(fresh.cdcCursor);

    // Deletions BEFORE additions (decision 4): a delete-and-recreate inside one
    // CDC window must not resurrect-then-delete.
    for (const remoteInvoiceId of changes.deletedInvoices) {
      const outcome = await markInvoiceDeletedRemotely(fresh, remoteInvoiceId, runInDbContext, expectedRealmFingerprint);
      if (outcome === 'marked') summary.invoicesMarkedDeleted++;
    }
    for (const remotePaymentId of changes.deletedPayments) {
      for (const reversal of await reverseAccountingPayment(fresh, remotePaymentId, runInDbContext, expectedRealmFingerprint)) {
        tally(summary, reversal.outcome);
      }
    }
    // Additions are grouped BY PAYMENT (finding B), not applied as a flat line
    // list. A QuickBooks Payment can be edited to settle a different set of
    // invoices, and the edit emits the Payment — never a deletion — so the only
    // way to see a dropped allocation is to diff the payment's CURRENT line set
    // against the mapping rows Breeze already holds for it. That diff needs the
    // whole payment, which a per-line loop never has.
    for (const [remotePaymentId, lines] of groupPaymentsById(changes.payments)) {
      for (const line of lines) {
        try {
          tally(summary, (await applyAccountingPayment(fresh, line, runInDbContext, expectedRealmFingerprint)).outcome);
        } catch (err) {
          // Collected, not rethrown here: one poisonous payment must not skip
          // the rest of the window. The `failed` counter below turns the whole
          // run dirty, so the cursor stays put and the window replays intact.
          summary.failed++;
          console.error(
            '[AccountingReconcileWorker] payment apply failed',
            `connectionId=${fresh.id}`,
            `remotePaymentId=${line.remotePaymentId}`,
            err instanceof Error ? err.message : err,
          );
          captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
            service: 'accountingPaymentPull',
            connectionId: fresh.id,
            remotePaymentId: line.remotePaymentId,
          });
        }
      }

      // AFTER this payment's own lines: anything the payment used to settle and
      // no longer does. Runs even when a line above failed — the current line
      // set comes from QuickBooks, not from whether Breeze could apply it.
      for (const stale of await reverseStaleAllocations(
        fresh, remotePaymentId, lines.map((l) => l.remoteInvoiceId), runInDbContext, expectedRealmFingerprint,
      )) {
        tally(summary, stale.outcome);
      }
    }

    // The run line is emitted by `finish()` below, AFTER the cursor CAS, so
    // `cursorAfter` reflects what was actually claimed (null on a throw or a
    // lost CAS). Logging it here printed `cursorAfter=null` on every run.
    const finish = (): void => logRunLine(data, summary, Date.now() - startedAt);

    // Surface the run's outcome ON THE CONNECTION (finding H). Without this a
    // failing run left nothing an operator could see: the job retried, gave up
    // inside BullMQ, `last_reconcile_at` quietly stopped advancing and the
    // integration panel still read "connected". Counts only — never a
    // QuickBooks response body (Phase C rule). Cleared on the next clean run,
    // and prefix-scoped so it can never wipe a reauth message.
    const runError = changes.overflowed
      ? 'QuickBooks truncated the last change window and the backfill did not complete; payments may be missing'
      : summary.failed > 0
        ? `${summary.failed} item(s) failed in the last reconcile run`
        : null;
    await runInDbContext(() => stampReconcileRunError(db, fresh.id, data.partnerId, runError));

    if (changes.overflowed) {
      // Finding A. The provider could not fully enumerate the window even after
      // re-reading the truncated entity through /query. Everything it DID
      // return has been applied above (those are real changes), but the cursor
      // must stay put: advancing it would skip whatever QuickBooks withheld,
      // and nothing ever re-reads a window the cursor has moved past.
      const err = new Error(
        `accounting reconcile for connection ${fresh.id} could not be fully enumerated `
        + '(QuickBooks truncated the change window and the /query backfill did not complete)',
      );
      console.error('[AccountingReconcileWorker] CDC window truncated', `connectionId=${fresh.id}`, `trigger=${data.trigger}`);
      captureException(err, undefined, {
        service: 'accountingReconcileWorker', connectionId: fresh.id, trigger: data.trigger,
      });
      finish();
      throw err;
    }

    if (summary.failed > 0) {
      // Leave the cursor exactly where it was and rethrow so BullMQ retries the
      // whole window. Advancing past a failed item loses it permanently.
      finish();
      throw new Error(`accounting reconcile for connection ${fresh.id} had ${summary.failed} failed item(s)`);
    }

    const advanced = await runInDbContext(() => advanceReconcileCursor(
      db, fresh.id, data.partnerId, expectedRealmFingerprint, changes.cursor, new Date(),
    ));
    if (!advanced) {
      // The connection was re-authorised against a different realm mid-run
      // (finding C). Not an error: the OAuth callback already wiped the
      // mappings and nulled this cursor, so claiming it here would hand the NEW
      // realm a watermark taken from the OLD realm's change stream and skip its
      // first window. Log and let the next sweep start the new realm cleanly.
      console.warn(
        '[AccountingReconcileWorker] cursor CAS lost — realm changed during the run',
        `connectionId=${fresh.id}`, `trigger=${data.trigger}`,
      );
      captureException(
        new Error(`accounting reconcile cursor CAS lost for connection ${fresh.id} (realm changed mid-run)`),
        undefined,
        { service: 'accountingReconcileWorker', connectionId: fresh.id, trigger: data.trigger },
      );
      finish();
      return summary;
    }
    summary.cursorAfter = changes.cursor;
    finish();
    return summary;
  });
}

/**
 * The 15-minute fan-out, in two passes.
 *
 * Pass 1 enqueues one `reconcile-connection` job per connection with either
 * direction switched on. Pass 2 is the OUTBOX BACKSTOP (spec decision 1): every
 * `accounting_entity_mappings` row that still owes QuickBooks a push or a delete,
 * whose lease has expired and whose last update is older than the grace window,
 * is re-enqueued on the accounting-sync queue. That is what makes a lost
 * enqueue — Redis down, the process dying between COMMIT and `add()`, BullMQ
 * exhausting its attempts — recover with no operator action.
 *
 * Pass 2 is deliberately NOT gated on any connection switch: a delete must
 * propagate even for a connection whose push is switched off, because Breeze
 * created that Payment in QuickBooks and owns its removal.
 *
 * Both passes read inside ONE short system context each, CLOSED before any Redis
 * work — an `add()` that blocks on a slow Redis must never hold a pooled
 * Postgres connection.
 */
export async function processReconcileSweep(): Promise<{
  enqueued: number; failed: number; pendingOpsEnqueued: number; pendingOpsFailed: number;
}> {
  return runOutsideDbContext(async () => {
    const connections = await withSystemDbAccessContext(
      () => listReconcilableConnections(db, 'quickbooks'),
      'accountingReconcile.sweep.list',
    );

    let enqueued = 0;
    let failed = 0;
    for (const connection of connections) {
      if (await enqueueAccountingReconcile(connection.id, connection.partnerId, 'sweep')) enqueued++;
      else failed++;
    }

    const owed = await withSystemDbAccessContext(
      () => listOwedPaymentMappings(db, new Date()),
      'accountingReconcile.sweep.pendingOps',
    );

    let pendingOpsEnqueued = 0;
    let pendingOpsFailed = 0;
    for (const row of owed) {
      const accepted = row.pendingOp === 'push'
        ? await enqueueAccountingPaymentPush(row.id, row.partnerId)
        : await enqueueAccountingPaymentDelete(row.id, row.partnerId);
      if (accepted) pendingOpsEnqueued++;
      else pendingOpsFailed++;
    }

    console.log(
      '[AccountingReconcileWorker] sweep complete',
      `connections=${connections.length}`, `enqueued=${enqueued}`, `failed=${failed}`,
      `pendingOps=${owed.length}`, `pendingOpsEnqueued=${pendingOpsEnqueued}`, `pendingOpsFailed=${pendingOpsFailed}`,
    );
    return { enqueued, failed, pendingOpsEnqueued, pendingOpsFailed };
  });
}

/** Create the accounting-reconcile worker. */
export function createAccountingReconcileWorker(): Worker<AccountingReconcileJobData> {
  return new Worker<AccountingReconcileJobData>(
    ACCOUNTING_RECONCILE_QUEUE,
    async (job: Job<AccountingReconcileJobData>) => {
      switch (job.data.type) {
        case 'sweep':
          return processReconcileSweep();
        case 'reconcile-connection':
          return processReconcileConnectionJob(job.data);
        default:
          throw new Error(`Unknown accounting reconcile job type: ${(job.data as { type: string }).type}`);
      }
    },
    {
      connection: getBullMQConnection(),
      concurrency: 2,
    },
  );
}

// ---------------------------------------------------------------------------
// Enqueue helper
// ---------------------------------------------------------------------------

/**
 * `removeOnComplete`/`removeOnFail` are `true` (drop the record immediately),
 * NOT a retained count — the Phase C lesson. The jobId is deterministic per
 * connection, and BullMQ SILENTLY drops an `add()` whose jobId still sits in
 * the retained completed/failed sets, so retaining records would make the very
 * next sweep tick (or a "Sync now" after fixing a mapping) a no-op that the
 * route still reported as queued. Dedup of a job that is genuinely IN FLIGHT
 * is unaffected — that lives in wait/active, not in the retained sets — which
 * is exactly the dedup this queue wants: two concurrent runs for one
 * connection would race on the same cursor.
 *
 * No colons in the jobId (global constraint).
 */
const ENQUEUE_OPTS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: true,
  removeOnFail: true,
};

/**
 * Enqueue a CDC reconcile for one connection.
 *
 * Returns whether the queue ACCEPTED the job, honestly: the webhook route and
 * the "Sync now" route both report it, and counting a swallowed Redis failure
 * as "queued" would tell the operator work was scheduled when nothing had been.
 */
export async function enqueueAccountingReconcile(
  connectionId: string,
  partnerId: string,
  trigger: ReconcileConnectionJobData['trigger'],
): Promise<boolean> {
  try {
    await getAccountingReconcileQueue().add(
      'reconcile-connection',
      { type: 'reconcile-connection', connectionId, partnerId, trigger },
      { jobId: `accounting-reconcile-${connectionId}`, ...ENQUEUE_OPTS },
    );
    return true;
  } catch (err) {
    console.error(
      '[AccountingReconcileWorker] failed to enqueue reconcile-connection',
      `connectionId=${connectionId}`,
      `trigger=${trigger}`,
      err instanceof Error ? err.message : err,
    );
    captureException(err instanceof Error ? err : new Error(String(err)));
    return false;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let accountingReconcileWorker: Worker<AccountingReconcileJobData> | null = null;

/**
 * Remove-then-add, mirroring `huntressSync.ts`'s `scheduleRepeatSyncAll`.
 * BullMQ keys a repeatable on its options, so a changed interval would
 * otherwise leave the OLD schedule running alongside the new one forever.
 */
async function scheduleRepeatSweep(): Promise<void> {
  const queue = getAccountingReconcileQueue();
  const repeatables = await queue.getRepeatableJobs();
  for (const repeatable of repeatables) {
    if (repeatable.name === 'sweep') {
      await queue.removeRepeatableByKey(repeatable.key);
    }
  }

  await queue.add(
    'sweep',
    { type: 'sweep' },
    {
      repeat: { every: RECONCILE_SWEEP_INTERVAL_MS },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 30 },
    },
  );
}

/**
 * Initialize the accounting-reconcile worker and register the 15-minute sweep.
 *
 * Also runs the idempotent realm-fingerprint backfill (plan decision 8) — the
 * webhook route resolves a realm to a connection by fingerprint, so a
 * connection whose fingerprint was never computed is invisible to webhooks
 * until it is. It is deliberately NON-FATAL: a backfill problem reports to
 * Sentry and boot continues, because a worker that refuses to start would also
 * stop the sweep that is the webhook path's backstop.
 */
export async function initializeAccountingReconcileWorkers(): Promise<void> {
  try {
    accountingReconcileWorker = createAccountingReconcileWorker();
    attachWorkerObservability(accountingReconcileWorker, 'accountingReconcileWorker');

    accountingReconcileWorker.on('error', (error) => {
      console.error('[AccountingReconcileWorker] Worker error:', error);
    });
    accountingReconcileWorker.on('failed', (job, error) => {
      console.error(`[AccountingReconcileWorker] Job ${job?.id} failed:`, error);
    });

    try {
      const backfill = await backfillRealmFingerprints();
      console.log(
        '[AccountingReconcileWorker] realm fingerprint backfill',
        `scanned=${backfill.scanned}`,
        `updated=${backfill.updated}`,
        `skipped=${backfill.skipped}`,
      );
    } catch (error) {
      console.error('[AccountingReconcileWorker] realm fingerprint backfill failed (continuing):', error);
      captureException(error instanceof Error ? error : new Error(String(error)));
    }

    await scheduleRepeatSweep();

    console.log('[AccountingReconcileWorker] Accounting reconcile worker initialized');
  } catch (error) {
    console.error('[AccountingReconcileWorker] Failed to initialize:', error);
    throw error;
  }
}

/** Shutdown the accounting-reconcile worker + queue gracefully. */
export async function shutdownAccountingReconcileWorkers(): Promise<void> {
  if (accountingReconcileWorker) {
    await accountingReconcileWorker.close();
    accountingReconcileWorker = null;
  }
  if (accountingReconcileQueue) {
    await accountingReconcileQueue.close();
    accountingReconcileQueue = null;
  }
  console.log('[AccountingReconcileWorker] Accounting reconcile worker shut down');
}
