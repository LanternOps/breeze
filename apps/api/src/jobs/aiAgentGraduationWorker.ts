/**
 * AI Agent Graduation Worker (Phase 2 wave P2-5, #4192, Task 9).
 *
 * One BullMQ queue/worker pair shared across the graduation feature.
 * `AiAgentGraduationJobData` is discriminated by `task` so PR A2's daily
 * eligibility evaluator can add `{ task: 'evaluate' }` to this SAME queue
 * and worker without a second `workerRegistry.ts` entry or
 * `scheduleRegistry.ts` slot — see Deviation #10 in the plan doc.
 *
 * Task 9 (this file) implements only `prune-evidence`: `ai_agent_op_evidence`
 * is append-only and unbounded, so it needs a retention sweep the same way
 * every other high-volume ledger in this codebase does (compare
 * `jobs/aiUnattendedExposureRetention.ts`, whose structure this copies:
 * the `runWithSystemDbAccess` guard, `extractRowCount`, `recordRetentionRun`,
 * `attachWorkerObservability`, and `jobSchedule(...)`).
 *
 * Retention window: `AI_AGENT_EVIDENCE_RETENTION_DAYS` (400 days,
 * `@breeze/shared`) — bounded by executions/watches/verdicts per day, so no
 * rollup is needed (see `aiAgentGraduation.ts`'s module header). The prune
 * targets `ai_agent_op_evidence_prune_idx` (`occurred_at`), created by the
 * same migration as the table.
 */

import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import { AI_AGENT_EVIDENCE_RETENTION_DAYS } from '@breeze/shared';
import * as dbModule from '../db';
import { extractRowCount } from '../db/rowCount';
import { getBullMQConnection } from '../services/redis';
import { recordRetentionRun } from '../services/retentionMetrics';
import { attachWorkerObservability } from './workerObservability';
import { jobSchedule } from './scheduleRegistry';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error('[AiAgentGraduationWorker] withSystemDbAccessContext is not available — DB module may not have loaded correctly');
  }
  return dbModule.withSystemDbAccessContext(fn);
};

export const AI_AGENT_GRADUATION_QUEUE = 'ai-agent-graduation';
export const AI_AGENT_GRADUATION_JOB_NAME = 'ai-agent-graduation';
const REPEAT_JOB_ID = 'ai-agent-op-evidence-retention';

/**
 * Discriminated so PR A2 can add `{ task: 'evaluate' }` to the SAME queue
 * and worker without a second `workerRegistry.ts` entry. Only
 * `prune-evidence` exists in this PR.
 */
export type AiAgentGraduationJobData = { task: 'prune-evidence' };

type PruneResult = { deletedCount: number; durationMs: number };

export async function pruneOpEvidence(): Promise<PruneResult> {
  const startedAt = Date.now();
  // postgres-js does not coerce JS Date in template-literal params; pass an
  // ISO string, same convention every sibling retention worker follows.
  const cutoff = new Date(Date.now() - AI_AGENT_EVIDENCE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const result = await db.execute(sql`
    DELETE FROM ai_agent_op_evidence
    WHERE occurred_at < ${cutoff}::timestamptz
  `);
  const deletedCount = extractRowCount(result);
  const durationMs = Date.now() - startedAt;

  console.log(`[AiAgentGraduationWorker] Pruned ${deletedCount} op-evidence rows older than ${AI_AGENT_EVIDENCE_RETENTION_DAYS}d in ${durationMs}ms`);
  recordRetentionRun('ai_agent_op_evidence_retention', { rowsDeleted: deletedCount });
  return { deletedCount, durationMs };
}

async function runGraduationJob(data: AiAgentGraduationJobData): Promise<PruneResult> {
  switch (data.task) {
    case 'prune-evidence':
      return runWithSystemDbAccess(() => pruneOpEvidence());
    default: {
      // Exhaustiveness guard — fires if PR A2 adds a task variant here
      // without a corresponding case.
      const _exhaustive: never = data.task;
      throw new Error(`[AiAgentGraduationWorker] unknown task: ${String(_exhaustive)}`);
    }
  }
}

let graduationQueue: Queue | null = null;
let graduationWorker: Worker | null = null;

export function getAiAgentGraduationQueue(): Queue {
  if (!graduationQueue) {
    graduationQueue = new Queue(AI_AGENT_GRADUATION_QUEUE, { connection: getBullMQConnection() });
  }
  return graduationQueue;
}

export function createAiAgentGraduationWorker(): Worker {
  return new Worker(
    AI_AGENT_GRADUATION_QUEUE,
    async (job: Job) => runGraduationJob(job.data as AiAgentGraduationJobData),
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function initializeAiAgentGraduationWorker(): Promise<void> {
  graduationWorker = createAiAgentGraduationWorker();
  // attachWorkerObservability already routes 'error'/'failed' to Sentry
  // (#1379) — no separate console-only handlers needed.
  attachWorkerObservability(graduationWorker, 'aiAgentGraduation');

  const queue = getAiAgentGraduationQueue();
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key);
  }

  await queue.add(
    AI_AGENT_GRADUATION_JOB_NAME,
    { task: 'prune-evidence' } satisfies AiAgentGraduationJobData,
    {
      jobId: REPEAT_JOB_ID,
      // Daily at a registry-allocated slot. NOT `every: 24h` — BullMQ
      // anchors `every` to the Unix epoch, so every 24h job fires at
      // 00:00:00.000 UTC together (see jobs/scheduleRegistry.ts).
      repeat: { pattern: jobSchedule('ai-agent-op-evidence-retention') },
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 10 },
    },
  );

  console.log('[AiAgentGraduationWorker] Graduation worker initialized (prune-evidence)');
}

export async function shutdownAiAgentGraduationWorker(): Promise<void> {
  if (graduationWorker) {
    await graduationWorker.close();
    graduationWorker = null;
  }
  if (graduationQueue) {
    await graduationQueue.close();
    graduationQueue = null;
  }
}
