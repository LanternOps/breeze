/**
 * The `ticket-import` queue consumer (#8313 W4; spec
 * docs/superpowers/specs/api-platform/2026-10-19-ticket-import-modules-design.md
 * §5.8). One job per slice of a run, plus the stalled-run sweep.
 *
 * - The slice runs only under the per-partner + global lease
 *   (services/ticketImport/importLease.ts). A busy lease defers the job.
 * - A slice that worked its TICKET_IMPORT_SLICE_MS hands the run to seq + 1
 *   with a compare-and-set, and this worker enqueues that successor: the
 *   first job in the repo that continues itself (F24). A retried slice whose
 *   successor already took over exits, re-enqueueing the successor in case
 *   the first enqueue was lost (a plain add under the successor's id is a
 *   no-op when it exists).
 * - No run is left `running` with no job (review #9): the successor's enqueue
 *   is retried and, if it still fails, the run is failed (`worker_error`); a
 *   job that exhausts its attempts fails its run, in the processor and on
 *   BullMQ's `failed` event (a stalled job never reaches the processor's
 *   catch); and a repeatable sweep fails a run with no sign of life for
 *   3 × TICKET_IMPORT_SLICE_MS + TICKET_IMPORT_LEASE_MS (`worker_lost`). A
 *   new run resumes any of them from the ledger.
 * - Deferrals spend no attempt (F22): a busy lease, a 429 from either window
 *   bucket, or a source Retry-After move the job to delayed with
 *   `moveToDelayed` + `DelayedError`, the mechanism of
 *   jobs/accountingJobDelay.ts, kept local so its log names this queue. Each
 *   records when the slice is due back, a sign of life for the sweep.
 * - Worker options are F24's long-job set. A lost lease or a shutdown makes
 *   the slice stop at its next ticket boundary.
 */
import { DelayedError, Queue, Worker, type Job } from 'bullmq';
import { withDbAccessContext } from '../db';
import { createAuditLogAsync } from '../services/auditService';
import { assertQueueJobName, parseQueueJobData } from '../services/bullmqValidation';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { acquireImportLease, type ImportLease } from '../services/ticketImport/importLease';
import { ticketImportLimits } from '../services/ticketImport/importLimits';
import {
  closeTicketImportQueue,
  enqueueTicketImportSlice,
  getTicketImportQueue,
  TICKET_IMPORT_QUEUE,
  TICKET_IMPORT_SLICE_JOB,
  TICKET_IMPORT_SWEEP_JOB,
} from '../services/ticketImport/importQueue';
import { runSlice, type SliceDeps, type SliceOutcome } from '../services/ticketImport/importRunner';
import { failRun, runContext, sweepStalledRuns, touchRun } from '../services/ticketImport/runLedger';
import { ticketImportSliceJobDataSchema, type TicketImportSliceJobData } from './queueSchemas';
import { attachWorkerObservability } from './workerObservability';

const WORKER_NAME = 'ticketImportWorker';
/** A busy lease waits this long, plus jitter, before the slice tries again. */
const LEASE_RETRY_MS = 10_000;
const MAX_DEFER_MS = 24 * 60 * 60 * 1000;
/** The stalled-run sweep's period: sub-hourly, so outside scheduleRegistry by design. */
const SWEEP_EVERY_MS = 300_000;
const SWEEP_JOB_ID = 'ticket-import-stalled-run-sweep';
const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

let worker: Worker | null = null;
let stopping = false;

export type ProcessSliceDeps = {
  acquireLease?: typeof acquireImportLease;
  runSlice?: typeof runSlice;
  enqueue?: (data: TicketImportSliceJobData) => Promise<void>;
  /** Waits between the successor's enqueue attempts; default 250 ms then 1 s. */
  enqueueRetryDelaysMs?: readonly number[];
  sliceDeps?: SliceDeps;
};

export type ProcessSliceResult = SliceOutcome | { kind: 'lease_busy' };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** moveToDelayed(now + delay) + DelayedError: the job waits and keeps its attempts. */
async function deferSlice(job: Job, token: string | undefined, delayMs: number, reason: string): Promise<never> {
  const delay = Math.min(Math.max(1_000, Number.isFinite(delayMs) ? delayMs : LEASE_RETRY_MS), MAX_DEFER_MS);
  if (!token) {
    // Without the lock token the job cannot be moved; a normal retry applies.
    throw new Error(`ticket import slice deferred (${reason}) without a lock token`);
  }
  await job.moveToDelayed(Date.now() + delay, token);
  console.warn(`[${WORKER_NAME}] slice deferred without spending an attempt`, { jobId: job.id, reason, delayMs: delay });
  throw new DelayedError();
}

async function failRunQuietly(data: Pick<TicketImportSliceJobData, 'runId' | 'partnerId'>, reason: string): Promise<boolean> {
  try {
    return await withDbAccessContext(runContext(data.partnerId), () => failRun(data.partnerId, data.runId, reason));
  } catch (error) {
    console.error(`[${WORKER_NAME}] could not fail run ${data.runId}`, error);
    captureException(error, undefined, { service: WORKER_NAME });
    return false;
  }
}

/**
 * Enqueues the successor slice, retrying a failed enqueue. False when it
 * still failed: the caller then fails the run rather than leave it running
 * with no job.
 */
async function enqueueSuccessor(data: TicketImportSliceJobData, deps: ProcessSliceDeps): Promise<boolean> {
  const enqueue = deps.enqueue ?? ((next: TicketImportSliceJobData) => enqueueTicketImportSlice(next));
  const delays = deps.enqueueRetryDelaysMs ?? [250, 1_000];
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      await enqueue(data);
      return true;
    } catch (error) {
      console.error(`[${WORKER_NAME}] could not enqueue slice ${data.seq} of run ${data.runId}`, error instanceof Error ? error.message : error);
      if (attempt < delays.length) await sleep(delays[attempt]!);
    }
  }
  return false;
}

export async function processTicketImportSlice(job: Job, token?: string, deps: ProcessSliceDeps = {}): Promise<ProcessSliceResult> {
  assertQueueJobName(TICKET_IMPORT_QUEUE, job, TICKET_IMPORT_SLICE_JOB);
  const data = parseQueueJobData(TICKET_IMPORT_QUEUE, job, ticketImportSliceJobDataSchema);
  const limits = ticketImportLimits();

  const lease: ImportLease | null = await (deps.acquireLease ?? acquireImportLease)({
    partnerId: data.partnerId,
    globalCap: limits.globalConcurrency,
    leaseMs: limits.leaseMs,
  });
  if (!lease) {
    const delayMs = LEASE_RETRY_MS + Math.floor(Math.random() * 5_000);
    // A sign of life while the slice waits its turn, so the sweep leaves it alone.
    await withDbAccessContext(runContext(data.partnerId), () => touchRun(data.partnerId, data.runId, new Date(Date.now() + delayMs)))
      .catch((error: unknown) => console.error(`[${WORKER_NAME}] could not record a deferral of run ${data.runId}`, error));
    await deferSlice(job, token, delayMs, 'lease_busy');
    return { kind: 'lease_busy' };
  }

  let outcome: SliceOutcome;
  try {
    outcome = await (deps.runSlice ?? runSlice)(data, {
      ...deps.sliceDeps,
      shouldYield: () => stopping || !lease.held() || (deps.sliceDeps?.shouldYield?.() ?? false),
    });
  } catch (error) {
    // The last attempt on an unexpected error fails the run, so it does not
    // hold its source's one active run forever.
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade + 1 >= attempts) await failRunQuietly(data, 'worker_error');
    throw error;
  } finally {
    await lease.release();
  }

  switch (outcome.kind) {
    case 'continue':
      if (!(await enqueueSuccessor({ ...data, seq: data.seq + 1 }, deps))) {
        await failRunQuietly(data, 'worker_error');
        return { kind: 'finished', state: 'failed', stopReason: 'worker_error' };
      }
      break;
    case 'superseded':
      // A retried slice whose successor took over: make sure the successor exists.
      if (outcome.active && outcome.sliceSeq === data.seq + 1 && !(await enqueueSuccessor({ ...data, seq: data.seq + 1 }, deps))) {
        await failRunQuietly(data, 'worker_error');
      }
      break;
    case 'defer':
      await deferSlice(job, token, outcome.delayMs, outcome.reason);
      break;
    case 'finished':
      break;
  }
  return outcome;
}

/**
 * The stalled-run sweep (review #9): fails every queued or running run with
 * no sign of life for 3 × TICKET_IMPORT_SLICE_MS + TICKET_IMPORT_LEASE_MS,
 * as `worker_lost`, with a partner-level audit row each.
 */
export async function runStalledRunSweep(now: Date = new Date()): Promise<{ failed: number }> {
  const limits = ticketImportLimits();
  const staleBefore = new Date(now.getTime() - (3 * limits.sliceMs + limits.leaseMs));
  const swept = await sweepStalledRuns(staleBefore);
  for (const run of swept) {
    console.warn(`[${WORKER_NAME}] run ${run.id} showed no sign of life since ${staleBefore.toISOString()}; failed as worker_lost`);
    void createAuditLogAsync({
      partnerId: run.partnerId,
      actorType: 'system',
      actorId: SYSTEM_ACTOR_ID,
      action: 'ticket_import.run_finished',
      resourceType: 'ticket_import_run',
      resourceId: run.id,
      details: { sourceId: run.sourceId, kind: run.kind, state: 'failed', stopReason: 'worker_lost' },
      result: 'failure',
    });
  }
  return { failed: swept.length };
}

export async function processTicketImportJob(job: Job, token?: string, deps: ProcessSliceDeps = {}): Promise<unknown> {
  if (job.name === TICKET_IMPORT_SWEEP_JOB) return runStalledRunSweep();
  return processTicketImportSlice(job, token, deps);
}

/**
 * BullMQ's `failed` event (review #9): a slice job that exhausted its
 * attempts, including one that stalled more than `maxStalledCount` times and
 * so never reached the processor's catch, fails its run.
 */
export async function handleTicketImportJobFailed(job: Job | undefined, error: unknown): Promise<boolean> {
  if (!job || job.name !== TICKET_IMPORT_SLICE_JOB) return false;
  if (job.attemptsMade < (job.opts.attempts ?? 1)) return false;
  const parsed = ticketImportSliceJobDataSchema.safeParse(job.data);
  if (!parsed.success) return false;
  console.error(`[${WORKER_NAME}] slice ${parsed.data.seq} of run ${parsed.data.runId} exhausted its attempts`, error instanceof Error ? error.message : error);
  return failRunQuietly(parsed.data, 'worker_error');
}

export async function scheduleTicketImportSweep(queue: Queue = getTicketImportQueue()): Promise<void> {
  for (const repeatable of await queue.getRepeatableJobs()) {
    if (repeatable.name === TICKET_IMPORT_SWEEP_JOB) await queue.removeRepeatableByKey(repeatable.key);
  }
  await queue.add(TICKET_IMPORT_SWEEP_JOB, {}, {
    jobId: SWEEP_JOB_ID,
    repeat: { every: SWEEP_EVERY_MS },
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 25 },
  });
}

export async function initializeTicketImportWorker(): Promise<void> {
  if (worker) return;
  stopping = false;
  worker = new Worker(
    TICKET_IMPORT_QUEUE,
    (job: Job, token?: string) => processTicketImportJob(job, token),
    {
      connection: getBullMQConnection(),
      concurrency: ticketImportLimits().workerConcurrency,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    },
  );
  attachWorkerObservability(worker, WORKER_NAME);
  worker.on('failed', (job, error) => {
    void handleTicketImportJobFailed(job, error);
  });
  await scheduleTicketImportSweep();
}

export async function shutdownTicketImportWorker(): Promise<void> {
  // Running slices stop at their next ticket boundary and hand over.
  stopping = true;
  if (worker) {
    await worker.close();
    worker = null;
  }
  await closeTicketImportQueue();
}

export const __testOnly = { WORKER_NAME, SWEEP_EVERY_MS, SWEEP_JOB_ID, setStopping: (value: boolean) => { stopping = value; } };
