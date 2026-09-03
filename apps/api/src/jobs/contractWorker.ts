/**
 * Contract Worker
 *
 * BullMQ worker for the daily billing sweep: finds active contracts whose
 * next_billing_at is <= today, calls generateDueInvoice for each, and counts
 * billed vs. failed. One contract failure never aborts the rest.
 *
 * Mirrors invoiceWorker.ts (queue, repeatable cron, init/shutdown, error
 * handling). Note: unlike invoiceWorker (which calls a self-wrapping service),
 * this worker supplies the system db access context itself per call —
 * generateDueInvoice does NOT self-wrap.
 */

import { Queue, Worker } from 'bullmq';
import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { contracts } from '../db/schema';
import { generateDueInvoice } from '../services/contractService';
import { buildAutomationEligibleOrgPredicate } from '../services/tenantStatus';
import { runContractRenewalSweep } from '../services/contractRenewal';
import { issueInvoice } from '../services/invoiceService';
import { sendInvoiceEmail } from '../services/invoicePdf';
import { jobSchedule } from './scheduleRegistry';

const CONTRACT_QUEUE = 'contract-jobs';
// Daily, before the invoice overdue sweep in the same hour lane.
const BILLING_SWEEP_CRON = jobSchedule('contract-billing-sweep');

let contractQueue: Queue | null = null;
let contractWorker: Worker | null = null;

/** Get or create the contract-jobs queue. */
export function getContractQueue(): Queue {
  if (!contractQueue) {
    contractQueue = new Queue(CONTRACT_QUEUE, { connection: getBullMQConnection() });
  }
  return contractQueue;
}

/**
 * Bill every active contract whose next_billing_at <= asOf.
 * Each contract is independent — one failure does not abort the rest.
 */
export async function runContractBillingSweep(asOf: Date = new Date()): Promise<{ billed: number; failed: number }> {
  const today = asOf.toISOString().slice(0, 10);

  const due = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db.select({ id: contracts.id }).from(contracts).where(
        and(
          eq(contracts.status, 'active' as never),
          isNotNull(contracts.nextBillingAt),
          lte(contracts.nextBillingAt, today),
          // Org-lifecycle Wave 4: same gate as the renewal/overdue sweeps —
          // an archived tenant must not keep generating (and auto-issuing +
          // emailing) invoices from inside its purge countdown. Structurally
          // identical to runContractRenewalSweep, so it is fixed with it.
          buildAutomationEligibleOrgPredicate(contracts.orgId)
        )
      )
    )
  );

  let billed = 0;
  let failed = 0;

  for (const row of due) {
    let res;
    try {
      res = await runOutsideDbContext(() =>
        withSystemDbAccessContext(() => generateDueInvoice(row.id, asOf))
      );
      if (res.generated) billed++;
      // Wave 3 (#3775): a catalog line billed at the contract snapshot because
      // the price book has no row in the contract's currency is never silent —
      // one structured warning per gap so ops can fill the book.
      for (const gap of res.priceBookGaps) {
        console.warn(
          '[contract-billing] price-book gap: contract %s line %s item %s has no %s price — billed at the contract snapshot',
          row.id, gap.contractLineId, gap.catalogItemId, gap.currencyCode
        );
      }
      // #3205: a role-billed contract with devices no line covers (unclassified
      // 'unknown' devices, or roles with no line) still bills — but never silently.
      if (res.uncoveredDevices && res.uncoveredDevices.total > 0) {
        console.warn(
          '[contract-billing] uncovered devices: contract %s has %d billable device(s) no line bills — %s',
          row.id, res.uncoveredDevices.total, JSON.stringify(res.uncoveredDevices.byRole)
        );
      }
    } catch (err) {
      failed++;
      console.error('[ContractWorker] generation failed', `contractId=${row.id}`, err instanceof Error ? err.message : err);
      captureException(err instanceof Error ? err : new Error(String(err)));
      continue;
    }

    // Post-commit, best-effort auto-issue + email. The billing transaction has
    // already committed (invoice drafted + period claimed + pointer advanced), so a
    // failure here must NOT abort the sweep or count as a billing failure — the
    // invoice is at worst left as a correctly-claimed draft, never re-billed.
    // issueInvoice begins with a read (getOwnedInvoiceOr404) that requires an ambient
    // db context — without one it connects as breeze_app with no GUC and the RLS
    // policy returns false, making the invoice invisible. Wrap in a fresh system
    // context (outside the already-committed billing txn) so reads resolve correctly.
    if (res.generated && res.autoIssue && res.invoiceId && res.actor) {
      try {
        await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
          await issueInvoice(res.invoiceId!, res.actor!);
          await sendInvoiceEmail(res.invoiceId!, res.actor!);
        }));
      } catch (err) {
        console.error('[ContractWorker] post-commit issue/send failed', `contractId=${row.id}`, `invoiceId=${res.invoiceId}`, err instanceof Error ? err.message : err);
        captureException(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  return { billed, failed };
}

/** Create the contract BullMQ worker. */
export function createContractWorker(): Worker {
  return new Worker(
    CONTRACT_QUEUE,
    async (job) => {
      if (job.name === 'billing-sweep') {
        // Renewal pre-pass MUST run before billing so an about-to-expire auto-renew
        // contract has its term extended before generateDueInvoice decides expiry.
        await runOutsideDbContext(() => withSystemDbAccessContext(() => runContractRenewalSweep()));
        return runContractBillingSweep();
      }
      throw new Error(`Unknown contract job: ${job.name}`);
    },
    { connection: getBullMQConnection(), concurrency: 1 }
  );
}

/** Schedule the daily billing sweep, clearing any existing repeatables first. */
export async function scheduleContractJobs(): Promise<void> {
  const queue = getContractQueue();

  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key);
  }

  await queue.add(
    'billing-sweep',
    { type: 'billing-sweep' },
    {
      repeat: { pattern: BILLING_SWEEP_CRON },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    }
  );

  console.log('[ContractWorker] Scheduled daily billing sweep');
}

/** Initialize the contract worker + schedule repeatables. Call during app startup. */
export async function initializeContractWorkers(): Promise<void> {
  try {
    contractWorker = createContractWorker();

    contractWorker.on('error', (error) => {
      console.error('[ContractWorker] Worker error:', error);
      captureException(error);
    });
    contractWorker.on('failed', (job, error) => {
      console.error(`[ContractWorker] Job ${job?.id} failed:`, error);
      captureException(error);
    });

    await scheduleContractJobs();

    console.log('[ContractWorker] Contract workers initialized');
  } catch (error) {
    console.error('[ContractWorker] Failed to initialize:', error);
    throw error;
  }
}

/** Shutdown the contract worker + queue gracefully. */
export async function shutdownContractWorkers(): Promise<void> {
  if (contractWorker) {
    await contractWorker.close();
    contractWorker = null;
  }
  if (contractQueue) {
    await contractQueue.close();
    contractQueue = null;
  }
  console.log('[ContractWorker] Contract workers shut down');
}
