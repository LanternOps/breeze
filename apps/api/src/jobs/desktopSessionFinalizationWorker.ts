import { Worker, type Job } from 'bullmq';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import { getBullMQConnection } from '../services/redis';
import {
  attachWorkerObservability,
  type WorkerFailureClassification,
} from './workerObservability';
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

/**
 * Named failure types for this handler (BREEZE-1J).
 *
 * `scrubEvent` in services/sentry deletes `message`, `logentry` and `extra` from
 * every outbound event, so a bare `new Error('...')` arrives in production as
 * `Error: [redacted]` with one app frame — four different conditions rendered
 * as the same contentless blank. The exception TYPE does survive the scrubber
 * (`rebuildSafeException` keeps a structural class name), so giving each
 * condition its own class is what makes these events readable without any
 * change to the scrubber's tag allowlist.
 */

/**
 * The persisted finalization intent is gone. The only writer that removes it is
 * a successful compare-delete, so this means the inline WS close path or the
 * 30s orphan-recovery scanner already finalized this session and released the
 * intent before this job got its turn. Nothing is lost and no retry can bring
 * the intent back, so the handler calls `job.discard()` before throwing this —
 * burning four more attempts on a race we already lost adds only Sentry volume.
 *
 * `discard()` rather than BullMQ's `UnrecoverableError`, for two reasons.
 * BullMQ decides "unrecoverable" by `instanceof UnrecoverableError || err.name
 * === 'UnrecoverableError'`, and Sentry's scrubber only lets `err.name` through
 * — so inheriting the marker means either the retry stops or the event says
 * which condition fired, never both. And importing an UnrecoverableError VALUE
 * here would reach ~92 suites that stub `bullmq` with a partial `vi.mock`
 * (this module is pulled in transitively via routes/desktopWs), breaking each
 * one at collection time. `discard()` is an instance method already on the job
 * this handler is holding, so it costs neither.
 */
export class DesktopFinalizationIntentAbsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesktopFinalizationIntentAbsentError';
  }
}

/**
 * An intent IS persisted but it names a different session/finalization than the
 * job does. That is an identity anomaly, not a race — the stable job id encodes
 * both — so it keeps full error severity and full retries.
 */
export class DesktopFinalizationIntentMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesktopFinalizationIntentMismatchError';
  }
}

/**
 * The agent has not acknowledged the `desktop_stream_stop` command yet, so the
 * session must NOT be made terminal (fail-closed — see finalizeDesktopSessionOnce).
 *
 * This is the expected steady state for the common case: the session ended
 * BECAUSE the agent went away, so the stop command has nobody to ack it and no
 * amount of retrying inside ~15s changes that. Recovery is owned by the
 * background orphan scanner, which re-drives `finalizeDesktopSessionOnce`
 * directly every REMOTE_WS_SHARED_LEASE_TTL_MS until the agent comes back. The
 * throw is only how this handler asks BullMQ for its short retry ladder.
 */
export class DesktopFinalizationStopPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesktopFinalizationStopPendingError';
  }
}

/**
 * Finalization succeeded but the compare-delete of the intent did not. The
 * intent stays owned and must be retried — a genuine fault.
 */
export class DesktopFinalizationIntentReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesktopFinalizationIntentReleaseError';
  }
}

/**
 * Maps this worker's expected-but-noisy failure modes onto a severity, so a
 * disconnected agent stops paging as an error-level exception while a genuine
 * identity anomaly or release failure still does. Reasons are hardcoded labels
 * — no session, device or tenant identifier goes into a tag.
 */
export function classifyDesktopFinalizationFailure(
  _job: Job | undefined,
  err: Error,
): WorkerFailureClassification | null {
  if (err instanceof DesktopFinalizationStopPendingError) {
    return {
      reason: 'desktop_stop_pending',
      level: 'warning',
      reportOnlyWhenExhausted: true,
    };
  }
  if (err instanceof DesktopFinalizationIntentAbsentError) {
    return { reason: 'desktop_intent_already_released', level: 'warning' };
  }
  return null;
}

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
  if (!persisted) {
    // Stop BullMQ retrying a race that is already lost (see the error's docs).
    // Optional call: the job is BullMQ's, but this handler is also driven
    // directly from tests with a plain job-shaped literal.
    job.discard?.();
    throw new DesktopFinalizationIntentAbsentError(
      'desktop finalization intent already released by another finalizer',
    );
  }
  if (
    persisted.input.finalizationId !== data.finalizationId
    || persisted.input.sessionId !== data.sessionId
  ) {
    throw new DesktopFinalizationIntentMismatchError(
      'desktop finalization payload mismatched',
    );
  }
  const result = await finalizeDesktopSessionOnce(persisted.input);
  if (result === 'stop_pending') {
    throw new DesktopFinalizationStopPendingError('desktop finalization stop pending');
  }
  const released = await releaseDesktopFinalizationIntent(
    data.sessionId,
    data.finalizationId,
    persisted.canonicalPayload,
  );
  if (!released) {
    throw new DesktopFinalizationIntentReleaseError(
      'desktop finalization intent compare-delete failed',
    );
  }
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
  attachWorkerObservability(worker, 'desktopSessionFinalizationWorker', {
    classifyFailure: classifyDesktopFinalizationFailure,
  });
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
