/**
 * aiAgentEnqueuer — producer-side registration + enqueue for AI agent runs
 * (wave 3.5d-b, #4086).
 *
 * Split out of `aiAgentRunner.ts` (which now owns only the BullMQ consumer
 * shell) so a process can register the enqueuer with
 * `services/aiAgents/runService.ts` — API routes need it even when the
 * consumer worker never starts (Redis-down boots, an `api`-role process under
 * the BREEZE_ROLE split) — WITHOUT importing the BullMQ consumer graph.
 * `enqueueAgentRunJob` and the queue singleton it uses live here;
 * `aiAgentRunner.ts` imports them back for its own shutdown path and to keep
 * re-exporting them for backward compatibility.
 *
 * Two properties are load-bearing and deliberately unlike the other workers
 * (originally documented on `aiAgentRunner.ts`, still true here):
 *
 * 1. **No retries** (`attempts: 1`, no backoff). A crashed agent run may have
 *    already invoked tools; replaying it would re-invoke them with no human in
 *    the loop. The run row's `failed` status IS the retry surface — a person
 *    re-triggers it.
 * 2. **No inline fallback when Redis is down.** `automationWorker` answers a
 *    dead queue by running the work in-process; an agent run must not, because
 *    a headless run with no durability guarantee is strictly worse than a
 *    skipped one. We return `{enqueued:false}` and the admission gate marks the
 *    run `failed` with `errorCode: 'enqueue_failed'` — loud, never silently
 *    stuck in `queued`.
 *
 * A third property changed with this split: registration used to be a
 * module-scope side effect of importing `aiAgentRunner.ts` ("a process that
 * never boots the worker can still enqueue"). Under the worker-role split the
 * lazy worker registry only loads `aiAgentRunner.ts` for a process that runs
 * global workers, so an `api`-role process would never import it and the
 * manual-trigger route would find no enqueuer registered. `registerAiAgentEnqueuer()`
 * below makes that registration explicit instead: `index.ts` and `worker.ts`
 * both call it during boot, before routes serve / before workers start, in
 * every role.
 */
import { Queue } from 'bullmq';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import { isReusableState } from '../services/bullmqUtils';
import { isRedisAvailable } from '../services/redis';
import { captureException } from '../services/sentry';
import { registerAgentRunEnqueuer } from '../services/aiAgents/runService';
import { aiAgentQueueJobDataSchema, type AiAgentQueueJobData } from './queueSchemas';

export const AI_AGENT_QUEUE = 'ai-agent';
export const AI_AGENT_RUN_JOB_NAME = 'execute-agent-run';

let aiAgentQueue: Queue<AiAgentQueueJobData> | null = null;

/**
 * '-' separator, never ':' — BullMQ rejects a custom jobId whose ':'-split
 * length is not 3, and this two-part id would throw (#1101).
 */
export function getAiAgentRunJobId(runId: string): string {
  return `ai-agent-run-${runId}`;
}

function getAiAgentQueue(): Queue<AiAgentQueueJobData> {
  if (!aiAgentQueue) {
    // createInstrumentedQueue wires the #1105 held-context tripwire into
    // `add()`: the admission gate deliberately enqueues OUTSIDE its system DB
    // context, and this is what catches a future caller that stops doing so.
    aiAgentQueue = createInstrumentedQueue<AiAgentQueueJobData>(AI_AGENT_QUEUE);
  }
  return aiAgentQueue;
}

export async function enqueueAgentRunJob(runId: string): Promise<{ enqueued: boolean; jobId?: string }> {
  const payload = aiAgentQueueJobDataSchema.safeParse({
    type: AI_AGENT_RUN_JOB_NAME,
    runId,
  });
  if (!payload.success) {
    console.error('[AiAgentRunner] Refusing to enqueue a malformed agent run job', { runId });
    return { enqueued: false };
  }

  if (!isRedisAvailable()) {
    console.error('[AiAgentRunner] Redis unavailable — refusing to enqueue agent run', { runId });
    return { enqueued: false };
  }

  try {
    const queue = getAiAgentQueue();
    const stableJobId = getAiAgentRunJobId(runId);

    const existing = await queue.getJob(stableJobId);
    if (existing) {
      const state = await existing.getState();
      if (isReusableState(state)) {
        // Already queued/active for this exact run row — reuse it rather than
        // racing a second executor against the same run.
        return { enqueued: true, jobId: existing.id ? String(existing.id) : stableJobId };
      }
      // A terminal leftover (completed/failed) only blocks the id. Removing and
      // re-adding is safe: `executeAgentRun` compare-and-sets the run row out of
      // `queued`, so a run that already reached a terminal status no-ops.
      await existing.remove().catch((error: unknown) => {
        console.warn('[AiAgentRunner] Failed to remove stale agent run job (non-fatal)', {
          jobId: stableJobId,
          error,
        });
      });
    }

    const job = await queue.add(AI_AGENT_RUN_JOB_NAME, payload.data, {
      jobId: stableJobId,
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 500 },
      // No retries, no backoff. See the header comment.
      attempts: 1,
    });

    return { enqueued: true, jobId: job.id ? String(job.id) : stableJobId };
  } catch (error) {
    // No inline fallback (header comment #2): report and refuse.
    console.error('[AiAgentRunner] Failed to enqueue agent run', { runId, error });
    captureException(error instanceof Error ? error : new Error(String(error)));
    return { enqueued: false };
  }
}

/**
 * Closes the producer-side queue handle. Called from
 * `aiAgentRunner.shutdownAiAgentRunner` so the consumer's shutdown path still
 * closes everything it owns.
 */
export async function closeAiAgentQueue(): Promise<void> {
  if (aiAgentQueue) {
    await aiAgentQueue.close();
    aiAgentQueue = null;
  }
}

/**
 * Registers `enqueueAgentRunJob` as the admission gate's enqueuer. Idempotent:
 * calling this more than once just re-registers the same function reference.
 * Must be called explicitly during boot (`index.ts` and `worker.ts`, before
 * routes serve / before workers start) in every role — see the header comment.
 */
export function registerAiAgentEnqueuer(): void {
  registerAgentRunEnqueuer(enqueueAgentRunJob);
}
