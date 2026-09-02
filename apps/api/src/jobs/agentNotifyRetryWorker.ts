/**
 * agentNotifyRetryWorker — durable retry lane for run-finished notifications
 * (AI agents wave 4a, Task 6, #3826).
 *
 * `deliverRunFinishedNotifications` (services/aiAgents/runFinishedNotify.ts)
 * is the SAME notify body both paths call: `runLoop.ts`'s `finishRun`, right
 * after the run's terminal status commits, calls it in-process first — most
 * runs notify synchronously and this queue never sees them. Only a FAILURE
 * there (recipient resolution, or a notification write) enqueues a job here.
 * Delivery is idempotent even across an in-process attempt plus a later
 * retry: `createNotification`'s `(userId, dedupeKey)` conflict-ignore
 * (`services/userNotifications.ts`) makes re-delivery a no-op for any
 * recipient who was already notified before the failure.
 *
 * Deliberately its OWN tiny queue/worker rather than another job name on the
 * `ai-agent` queue (`jobs/aiAgentRunner.ts`): that queue explicitly carries
 * NO retries (a crashed agent run must never be replayed — see its header
 * comment), while this one is retries-only by design (`attempts: 5`,
 * exponential backoff). Mixing the two semantics onto one queue would make
 * one of them silently wrong.
 *
 * The job processor lets a repeat failure PROPAGATE (no internal catch) so
 * BullMQ's own `attempts`/backoff — set once, at enqueue time in
 * `enqueueAgentNotifyRetry` — is what retries it. `enqueueAgentNotifyRetry`
 * itself never throws: it is the LAST line of defense after an in-process
 * notify already failed once, so a second failure here (e.g. Redis also
 * down) must not become a third failure mode stacked on top — logged +
 * captured instead. Either way, the run's own terminal status already
 * committed and is unaffected.
 */
import { Worker, type Job } from 'bullmq';
import type { Queue } from 'bullmq';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { assertQueueJobName, parseQueueJobData } from '../services/bullmqValidation';
import { attachWorkerObservability } from './workerObservability';
import { deliverRunFinishedNotifications } from '../services/aiAgents/runFinishedNotify';
import { agentNotifyRetryQueueJobDataSchema, type AgentNotifyRetryQueueJobData } from './queueSchemas';

export const AGENT_NOTIFY_RETRY_QUEUE = 'agent-notify-retry';
export const AGENT_NOTIFY_RETRY_JOB_NAME = 'notify-run-finished';

/** '-' separator only (repo rule, #1101) — never ':'. One job per run: a
 *  second failure for the SAME run before the first retry has fired reuses
 *  the same id rather than stacking duplicate retry jobs. */
export function getAgentNotifyRetryJobId(runId: string): string {
  return `agent-notify-${runId}`;
}

let notifyRetryQueue: Queue<AgentNotifyRetryQueueJobData> | null = null;

function getAgentNotifyRetryQueue(): Queue<AgentNotifyRetryQueueJobData> {
  if (!notifyRetryQueue) {
    // createInstrumentedQueue wires the #1105 held-context tripwire into
    // `add()` — this is called from `finishRun`, outside any held DB context
    // (the status CAS transaction already committed by the time notify runs).
    notifyRetryQueue = createInstrumentedQueue<AgentNotifyRetryQueueJobData>(AGENT_NOTIFY_RETRY_QUEUE);
  }
  return notifyRetryQueue;
}

/**
 * Best-effort enqueue: NEVER throws. See the header comment for why.
 */
export async function enqueueAgentNotifyRetry(runId: string): Promise<void> {
  try {
    await getAgentNotifyRetryQueue().add(
      AGENT_NOTIFY_RETRY_JOB_NAME,
      { runId } satisfies AgentNotifyRetryQueueJobData,
      {
        jobId: getAgentNotifyRetryJobId(runId),
        attempts: 5,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
      },
    );
  } catch (error) {
    console.error('[AgentNotifyRetryWorker] failed to enqueue notify retry', { runId, error });
    captureException(error instanceof Error ? error : new Error(String(error)));
  }
}

/** The job body, exported for unit tests — the Worker below is a thin wrapper. */
export async function processAgentNotifyRetryJob(job: Job<AgentNotifyRetryQueueJobData>): Promise<void> {
  assertQueueJobName(AGENT_NOTIFY_RETRY_QUEUE, job, AGENT_NOTIFY_RETRY_JOB_NAME);
  const data = parseQueueJobData(AGENT_NOTIFY_RETRY_QUEUE, job, agentNotifyRetryQueueJobDataSchema);
  // No try/catch here on purpose — see the header comment: a repeat failure
  // must propagate so BullMQ's own attempts/backoff (set at enqueue time)
  // retries it, rather than this function silently swallowing it.
  await deliverRunFinishedNotifications(data.runId);
}

let notifyRetryWorker: Worker<AgentNotifyRetryQueueJobData> | null = null;

export function initializeAgentNotifyRetryWorker(): void {
  if (notifyRetryWorker) return;

  notifyRetryWorker = new Worker<AgentNotifyRetryQueueJobData>(
    AGENT_NOTIFY_RETRY_QUEUE,
    processAgentNotifyRetryJob,
    {
      connection: getBullMQConnection(),
      concurrency: 3,
    },
  );
  attachWorkerObservability(notifyRetryWorker, 'agentNotifyRetry');

  notifyRetryWorker.on('error', (error) => {
    console.error('[AgentNotifyRetryWorker] Worker error:', error);
  });
  notifyRetryWorker.on('failed', (job, error) => {
    // All 5 attempts exhausted: the recipients for this run never learned it
    // finished. Loud on purpose — this is the operator-side trail.
    console.error('[AgentNotifyRetryWorker] notify retry exhausted', {
      jobId: job?.id,
      runId: (job?.data as { runId?: string } | undefined)?.runId,
      error,
    });
  });

  console.log('[AgentNotifyRetryWorker] initialized');
}

export async function shutdownAgentNotifyRetryWorker(): Promise<void> {
  if (notifyRetryWorker) {
    await notifyRetryWorker.close();
    notifyRetryWorker = null;
  }
  if (notifyRetryQueue) {
    await notifyRetryQueue.close();
    notifyRetryQueue = null;
  }
}
