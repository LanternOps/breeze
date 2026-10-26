/**
 * Tool catalog W04 (#5219), plan Task A8 — the flow runner worker.
 *
 * One BullMQ job on the `flow-runs` queue = one SLICE of one run
 * (services/flows/runSlice.ts owns the state machine). The job is a typed
 * reference (`{ runId }`); the slice re-reads the run and decides everything
 * from the database, so a duplicate, late, or stalled delivery is harmless:
 * the run lease admits one slice at a time and every write is fenced on it
 * (services/flows/runLease.ts, Decision 15).
 *
 * Slot refusal (Decision 8): the slice has already released its lease; the
 * job moves itself back to delayed for `slotRetryDelayMs` and throws
 * `DelayedError`, so BullMQ neither counts an attempt nor fails the job
 * (the jobs/accountingJobDelay.ts pattern).
 *
 * The worker runs whatever FLOWS_ENABLED says: with the flag off a queued
 * run must still end (`flows_disabled`) rather than sit in `queued` forever,
 * and nothing enqueues runs while the flag is off, so the idle cost is one
 * blocking connection per socket-owner process.
 *
 * Placement: socket-owner — a step dispatches device commands (run_script),
 * like automationWorker and aiAgentRunner.
 */
import { DelayedError, type Job, Worker } from 'bullmq';
import { FLOW_RUN_LIMITS } from '@breeze/shared';
import { parseQueueJobData } from '../services/bullmqValidation';
import { getBullMQConnection } from '../services/redis';
import { runFlowSlice } from '../services/flows/runSlice';
import { closeFlowRunQueue, FLOW_RUNS_QUEUE } from './flowRunQueue';
import { flowRunJobDataSchema, type FlowRunJobData } from './queueSchemas';
import { attachWorkerObservability } from './workerObservability';

export { FLOW_RUNS_QUEUE, enqueueFlowRunSlice } from './flowRunQueue';

export const FLOW_RUNNER_CONCURRENCY = 10;

let worker: Worker<FlowRunJobData> | null = null;

export async function processFlowRunJob(job: Job<FlowRunJobData>, token?: string): Promise<void> {
  const { runId } = parseQueueJobData(FLOW_RUNS_QUEUE, job, flowRunJobDataSchema);
  const result = await runFlowSlice(runId);
  if (result.kind === 'no_slot') {
    const lockToken = token ?? job.token;
    if (!lockToken) {
      // Without the lock token BullMQ cannot move the job; a thrown error
      // fails this delivery and the reconciler re-enqueues the run.
      throw new Error(`[FlowRunner] no slot for run ${runId} and no job lock token to delay with`);
    }
    await job.moveToDelayed(Date.now() + FLOW_RUN_LIMITS.slotRetryDelayMs, lockToken);
    throw new DelayedError();
  }
}

export function createFlowRunWorker(): Worker<FlowRunJobData> {
  return new Worker<FlowRunJobData>(
    FLOW_RUNS_QUEUE,
    // Deliberately NOT wrapped in a DB context: a slice spans step executions
    // of up to an hour; every read and checkpoint opens its own short one.
    async (job: Job<FlowRunJobData>, token?: string) => processFlowRunJob(job, token),
    {
      connection: getBullMQConnection(),
      concurrency: FLOW_RUNNER_CONCURRENCY,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    },
  );
}

export async function initializeFlowRunner(): Promise<void> {
  if (worker) return;
  worker = createFlowRunWorker();
  attachWorkerObservability(worker, 'flowRunner');
  worker.on('error', (error) => {
    console.error('[FlowRunner] Worker error:', error);
  });
  console.log('[FlowRunner] Flow runner initialized');
}

export async function shutdownFlowRunner(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  await closeFlowRunQueue();
}
