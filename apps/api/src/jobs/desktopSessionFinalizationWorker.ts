import { Worker, type Job } from 'bullmq';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';
import {
  desktopSessionFinalizationJobDataSchema,
} from './queueSchemas';
import {
  finalizeDesktopSessionOnce,
  getDesktopFinalizationIntent,
  releaseDesktopFinalizationIntent,
} from '../services/desktopSessionFinalization';
import { assertQueueJobName, parseQueueJobData } from '../services/bullmqValidation';

const QUEUE_NAME = 'desktop-session-finalization';
const JOB_NAME = 'finalize-desktop-session';

let queue: ReturnType<typeof createInstrumentedQueue> | null = null;
let worker: Worker | null = null;

function stableJobId(sessionId: string, finalizationId: string): string {
  return `desktop-finalize-${sessionId}-${finalizationId}`;
}

function getQueue() {
  if (!queue) queue = createInstrumentedQueue(QUEUE_NAME);
  return queue;
}

export async function getDesktopSessionFinalizationJobState(
  sessionId: string,
  finalizationId: string,
): Promise<string | null> {
  const job = await getQueue().getJob(stableJobId(sessionId, finalizationId));
  return job ? job.getState() : null;
}

export async function enqueueDesktopSessionFinalization(input: {
  sessionId: string;
  finalizationId: string;
}): Promise<{ acknowledged: true; jobId: string }> {
  const data = desktopSessionFinalizationJobDataSchema.parse({
    version: 1,
    ...input,
  });
  const expectedId = stableJobId(input.sessionId, input.finalizationId);
  const job = await getQueue().add(JOB_NAME, data, {
    jobId: expectedId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 1_000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 250 },
  });
  if (job.id !== expectedId) {
    throw new Error('desktop finalization queue acknowledgement mismatch');
  }
  return { acknowledged: true, jobId: expectedId };
}

export async function processDesktopSessionFinalizationJob(job: Job): Promise<{
  result: 'finalized' | 'already_finalized';
}> {
  assertQueueJobName(QUEUE_NAME, job, JOB_NAME);
  const data = parseQueueJobData(
    QUEUE_NAME,
    job,
    desktopSessionFinalizationJobDataSchema,
  );
  const persisted = await getDesktopFinalizationIntent(data.sessionId);
  if (
    !persisted
    || persisted.input.finalizationId !== data.finalizationId
    || persisted.input.sessionId !== data.sessionId
  ) {
    throw new Error('desktop finalization payload missing or mismatched');
  }
  const result = await finalizeDesktopSessionOnce(persisted.input);
  if (result === 'stop_pending') {
    throw new Error('desktop finalization stop pending');
  }
  const released = await releaseDesktopFinalizationIntent(
    data.sessionId,
    data.finalizationId,
    persisted.canonicalPayload,
  );
  if (!released) throw new Error('desktop finalization intent compare-delete failed');
  return { result };
}

export async function initializeDesktopSessionFinalizationWorker(): Promise<void> {
  if (worker) return;
  worker = new Worker(
    QUEUE_NAME,
    processDesktopSessionFinalizationJob,
    {
      connection: getBullMQConnection(),
      concurrency: 2,
    },
  );
  attachWorkerObservability(worker, 'desktopSessionFinalizationWorker');
}

export async function shutdownDesktopSessionFinalizationWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}

export const __testOnly = {
  QUEUE_NAME,
  JOB_NAME,
  stableJobId,
};
