/**
 * Invoice Worker
 *
 * BullMQ worker for async invoice side effects:
 *   - render-pdf:     render + store the PDF for a just-issued invoice.
 *   - overdue-sweep:  daily flip of past-due sent/partially_paid invoices to overdue.
 *
 * Mirrors alertWorker.ts (queue + worker + repeatable scheduling + init/shutdown).
 * The job HANDLERS (processRenderPdf / processOverdueSweep) are exported so tests
 * can drive them directly without enqueuing through a live BullMQ queue (which
 * would open a socket to the test Redis and hang — see the test-Redis NOAUTH note).
 */

import { Queue, Worker, Job } from 'bullmq';
import * as dbModule from '../db';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { renderInvoicePdf } from '../services/invoicePdf';
import { runOverdueSweep } from '../services/invoiceService';

const INVOICE_QUEUE = 'invoice-jobs';
const OVERDUE_SWEEP_CRON = '0 6 * * *'; // daily at 06:00

// Mirror alertWorker.ts: prefer withSystemDbAccessContext (background scope) when
// present, falling back to bare invocation in the mocked unit-test harness.
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

// Job data types
interface RenderPdfJobData {
  type: 'render-pdf';
  invoiceId: string;
}
interface OverdueSweepJobData {
  type: 'overdue-sweep';
}
type InvoiceJobData = RenderPdfJobData | OverdueSweepJobData;

let invoiceQueue: Queue<InvoiceJobData> | null = null;

/** Get or create the invoice-jobs queue. */
export function getInvoiceQueue(): Queue<InvoiceJobData> {
  if (!invoiceQueue) {
    invoiceQueue = new Queue<InvoiceJobData>(INVOICE_QUEUE, { connection: getBullMQConnection() });
  }
  return invoiceQueue;
}

// ---------------------------------------------------------------------------
// Job handlers (exported for direct unit testing)
// ---------------------------------------------------------------------------

/** Render + store the PDF for an invoice, inside system DB scope. The worker only
 *  ever runs for just-issued (non-draft) invoices, so documentId is non-null in
 *  practice; the type allows null because renderInvoicePdf skips persistence for
 *  drafts (preview-only). */
export async function processRenderPdf(data: RenderPdfJobData): Promise<{ invoiceId: string; documentId: string | null }> {
  return runWithSystemDbAccess(async () => {
    const { documentId } = await renderInvoicePdf(data.invoiceId);
    return { invoiceId: data.invoiceId, documentId };
  });
}

/** Flip past-due open invoices to overdue, inside system DB scope. */
export async function processOverdueSweep(): Promise<{ swept: number }> {
  // runOverdueSweep already wraps itself in runOutsideDbContext + system context,
  // so we call it directly (double-wrapping the system context is harmless but
  // unnecessary).
  const swept = await runOverdueSweep();
  return { swept };
}

/** Create the invoice worker. */
export function createInvoiceWorker(): Worker<InvoiceJobData> {
  return new Worker<InvoiceJobData>(
    INVOICE_QUEUE,
    async (job: Job<InvoiceJobData>) => {
      switch (job.data.type) {
        case 'render-pdf':
          return processRenderPdf(job.data);
        case 'overdue-sweep':
          return processOverdueSweep();
        default:
          throw new Error(`Unknown invoice job type: ${(job.data as { type: string }).type}`);
      }
    },
    {
      connection: getBullMQConnection(),
      concurrency: 5,
    }
  );
}

// ---------------------------------------------------------------------------
// Enqueue helper (Redis-outage-safe; mirrors emitInvoiceEvent)
// ---------------------------------------------------------------------------

/**
 * Enqueue a PDF render for a just-issued invoice. Fire-and-forget by design: a
 * Redis outage must NEVER fail the issuance that triggered it (mirrors
 * emitInvoiceEvent). The email/send path renders synchronously and does not
 * depend on this job, so a dropped enqueue only delays the cached PDF.
 */
export async function enqueueInvoicePdfRender(invoiceId: string): Promise<void> {
  try {
    await getInvoiceQueue().add(
      'render-pdf',
      { type: 'render-pdf', invoiceId },
      {
        jobId: `invoice-render-${invoiceId}`,
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      }
    );
  } catch (err) {
    console.error('[InvoiceWorker] failed to enqueue render-pdf', `invoiceId=${invoiceId}`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}

// ---------------------------------------------------------------------------
// Scheduling + lifecycle
// ---------------------------------------------------------------------------

/** Schedule the daily overdue sweep, clearing any existing repeatables first. */
async function scheduleInvoiceJobs(): Promise<void> {
  const queue = getInvoiceQueue();

  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key);
  }

  await queue.add(
    'overdue-sweep',
    { type: 'overdue-sweep' },
    {
      repeat: { pattern: OVERDUE_SWEEP_CRON },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    }
  );

  console.log('[InvoiceWorker] Scheduled daily overdue sweep');
}

let invoiceWorker: Worker<InvoiceJobData> | null = null;

/** Initialize the invoice worker + schedule repeatables. Call during app startup. */
export async function initializeInvoiceWorkers(): Promise<void> {
  try {
    invoiceWorker = createInvoiceWorker();

    invoiceWorker.on('error', (error) => {
      console.error('[InvoiceWorker] Worker error:', error);
    });
    invoiceWorker.on('failed', (job, error) => {
      console.error(`[InvoiceWorker] Job ${job?.id} failed:`, error);
    });

    await scheduleInvoiceJobs();

    console.log('[InvoiceWorker] Invoice workers initialized');
  } catch (error) {
    console.error('[InvoiceWorker] Failed to initialize:', error);
    throw error;
  }
}

/** Shutdown the invoice worker + queue gracefully. */
export async function shutdownInvoiceWorkers(): Promise<void> {
  if (invoiceWorker) {
    await invoiceWorker.close();
    invoiceWorker = null;
  }
  if (invoiceQueue) {
    await invoiceQueue.close();
    invoiceQueue = null;
  }
  console.log('[InvoiceWorker] Invoice workers shut down');
}
