/**
 * aiAgentRunner — the `ai-agent` BullMQ CONSUMER shell (AI agents wave 3c;
 * split from the producer side in wave 3.5d-b, #4086).
 *
 * This module owns DURABILITY for headless agent runs, and nothing else. The
 * decision to run at all is made by `services/aiAgents/runService.ts`
 * (`createAndEnqueueAgentRun`), which commits the `ai_agent_runs` row and then
 * hands the run id to the producer; the run loop itself lives in
 * `services/aiAgents/runLoop.ts` and is re-exported below as `executeAgentRun`.
 *
 * The enqueue side (`enqueueAgentRunJob`, the queue singleton, and explicit
 * registration with `runService` via `registerAiAgentEnqueuer()`) now lives in
 * `./aiAgentEnqueuer.ts` — split out so a process can register the enqueuer
 * without importing this consumer graph (see that file's header comment for
 * why). The symbols below are re-exported here for backward compatibility.
 *
 * One property is still load-bearing and deliberately unlike the other
 * workers:
 *
 * **No retries** (`attempts: 1`, no backoff). A crashed agent run may have
 * already invoked tools; replaying it would re-invoke them with no human in
 * the loop. The run row's `failed` status IS the retry surface — a person
 * re-triggers it.
 */
import { Job, Worker } from 'bullmq';
import { assertQueueJobName, parseQueueJobData } from '../services/bullmqValidation';
import { getBullMQConnection } from '../services/redis';
import { executeAgentRun } from '../services/aiAgents/runLoop';
import { aiAgentQueueJobDataSchema, type AiAgentQueueJobData } from './queueSchemas';
import { attachWorkerObservability } from './workerObservability';
import { AI_AGENTS_ENABLED } from '../config/env';
import {
  AI_AGENT_QUEUE,
  AI_AGENT_RUN_JOB_NAME,
  closeAiAgentQueue,
  enqueueAgentRunJob,
  getAiAgentRunJobId,
} from './aiAgentEnqueuer';

// Re-exported so callers that imported the queue identity/enqueue helpers
// from this module (the consumer shell) before the wave 3.5d-b split still
// find them here.
export { AI_AGENT_QUEUE, AI_AGENT_RUN_JOB_NAME, enqueueAgentRunJob, getAiAgentRunJobId };

/** Wall-clock ceiling for a run is 600s (the run loop owns the abort
 *  controller); the BullMQ lock has to outlive that plus teardown, hence 720s. */
const AI_AGENT_LOCK_DURATION_MS = 720_000;

let aiAgentWorker: Worker<AiAgentQueueJobData> | null = null;

/**
 * Execute one agent run — the SDK `query()` loop.
 *
 * Re-exported rather than defined here on purpose. The loop lives in
 * `services/aiAgents/runLoop.ts` so that the guardrail hooks it builds can be
 * driven by service-level tests (the red-team contract suite most of all)
 * without dragging BullMQ and Redis into their module graph, and so this file
 * stays about durability alone. The processor's contract is unchanged.
 *
 * The processor deliberately does NOT hold an ambient system DB context (see
 * `createAiAgentWorker`); every DB touch inside the loop self-contexts.
 */
export { executeAgentRun };

function createAiAgentWorker(): Worker<AiAgentQueueJobData> {
  return new Worker<AiAgentQueueJobData>(
    AI_AGENT_QUEUE,
    async (job: Job<AiAgentQueueJobData>) => {
      // Deliberately NOT wrapped in withSystemDbAccessContext. That helper opens
      // a transaction, and an agent run can legitimately last the full 600s
      // wall-clock ceiling — holding a pooled Postgres connection
      // idle-in-transaction across the whole SDK loop is exactly the #1105
      // pool-exhaustion shape, and it would also make every enqueue performed
      // during the run trip the held-context tripwire. Instead each DB touch
      // self-contexts (runService's `inSystemDbContext` / `transitionRunStatus`),
      // which is the same shape the admission gate already uses.
      assertQueueJobName(AI_AGENT_QUEUE, job, AI_AGENT_RUN_JOB_NAME);
      const data = parseQueueJobData(AI_AGENT_QUEUE, job, aiAgentQueueJobDataSchema);
      switch (data.type) {
        case 'execute-agent-run':
          return executeAgentRun(data.runId);
        default:
          throw new Error(`Unknown ai-agent job type: ${(data as { type: string }).type}`);
      }
    },
    {
      connection: getBullMQConnection(),
      // Two concurrent headless runs per API replica. Each drives an LLM loop
      // and a child process, so this is a cost/blast-radius ceiling, not a
      // throughput target.
      concurrency: 2,
      lockDuration: AI_AGENT_LOCK_DURATION_MS,
      stalledInterval: 60_000,
      // A stalled agent run is failed, not re-delivered: see "no retries".
      maxStalledCount: 1,
    },
  );
}

export function initializeAiAgentRunner(): void {
  if (aiAgentWorker) return;

  // The platform kill switch gates the WORKER, not the enqueuer (#3977). A
  // BullMQ Worker opens a blocking Redis connection and holds it for the life
  // of the process, so booting one while the feature can never run costs a
  // permanent connection per process, per region, for nothing — verified in
  // production 2026-08-26, where both regions logged this line with the flag
  // unset and unmapped in compose.
  //
  // Gated HERE rather than at the index.ts call site so no future caller can
  // route around it. `registerAiAgentEnqueuer()` (./aiAgentEnqueuer.ts) is
  // registered separately, outside this gate: the manual-trigger route must
  // still be able to enqueue in a process that never boots the worker.
  if (!AI_AGENTS_ENABLED) {
    console.log('[AiAgentRunner] BREEZE_AI_AGENTS_ENABLED is off — worker not started');
    return;
  }

  aiAgentWorker = createAiAgentWorker();
  attachWorkerObservability(aiAgentWorker, 'aiAgentRunner');

  aiAgentWorker.on('error', (error) => {
    console.error('[AiAgentRunner] Worker error:', error);
  });

  aiAgentWorker.on('failed', (job, error) => {
    console.error('[AiAgentRunner] Agent run job failed', {
      jobId: job?.id,
      runId: (job?.data as { runId?: string } | undefined)?.runId,
      error,
    });
  });

  console.log('[AiAgentRunner] AI agent runner initialized');
}

export async function shutdownAiAgentRunner(): Promise<void> {
  if (aiAgentWorker) {
    await aiAgentWorker.close();
    aiAgentWorker = null;
  }

  await closeAiAgentQueue();
}
