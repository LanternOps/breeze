/**
 * AI Agent Graduation Worker (Phase 2 wave P2-5, #4192, Tasks 9 and A2-3).
 *
 * One BullMQ queue/worker pair shared across the graduation feature.
 * `AiAgentGraduationJobData` is discriminated by `task` so PR A2's daily
 * eligibility evaluator adds `{ task: 'evaluate' }` to this SAME queue and
 * worker without a second `workerRegistry.ts` entry — see Deviation #10 in
 * the plan doc. `scheduleRegistry.ts` still gets its own slot for the
 * evaluator (`'ai-agent-graduation-evaluate'`), since the two tasks fire at
 * different times of day; only the queue/worker pair and the registry entry
 * are shared.
 *
 * Task 9 implements `prune-evidence`: `ai_agent_op_evidence` is append-only
 * and unbounded, so it needs a retention sweep the same way every other
 * high-volume ledger in this codebase does (compare
 * `jobs/aiUnattendedExposureRetention.ts`, whose structure this copies:
 * the `runWithSystemDbAccess` guard, `extractRowCount`, `recordRetentionRun`,
 * `attachWorkerObservability`, and `jobSchedule(...)`).
 *
 * Retention window: `AI_AGENT_EVIDENCE_RETENTION_DAYS` (400 days,
 * `@breeze/shared`) — bounded by executions/watches/verdicts per day, so no
 * rollup is needed (see `aiAgentGraduation.ts`'s module header). The prune
 * targets `ai_agent_op_evidence_prune_idx` (`occurred_at`), created by the
 * same migration as the table.
 *
 * Task A2-3 implements `evaluate`: the daily sweep that refreshes every
 * tracked `(org, agent, op_key)` tuple's graduation row
 * (`evaluateAllGraduations`, delegating each tuple to
 * `services/aiAgents/graduationService.ts#refreshGraduationRow`). Each tuple
 * is its own `withSystemDbAccessContext` transaction (opened inside
 * `refreshGraduationRow`, not here) and its own `pg_advisory_xact_lock`, so
 * one slow or failing tuple neither blocks nor rolls back any other —
 * per-tuple error boundary mirrors `jobs/aiAgentSweepScheduler.ts:256-303`
 * and `jobs/aiAgentImpactRollup.ts`'s per-org scan loop: log and continue,
 * never let one bad tuple lose the whole night's pass.
 */

import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import { AI_AGENT_EVIDENCE_RETENTION_DAYS } from '@breeze/shared';
import * as dbModule from '../db';
import { extractRowCount } from '../db/rowCount';
import { listTrackedTuples, refreshGraduationRow } from '../services/aiAgents/graduationService';
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
const EVALUATE_REPEAT_JOB_ID = 'ai-agent-graduation-evaluate';

/**
 * Discriminated so the SAME queue and worker carry both the retention prune
 * (Task 9) and the daily eligibility evaluator (Task A2-3) — no second
 * `workerRegistry.ts` entry (Deviation #10).
 */
export type AiAgentGraduationJobData = { task: 'prune-evidence' } | { task: 'evaluate' };

type PruneResult = { deletedCount: number; durationMs: number };
type EvaluateResult = { tuples: number; changed: number; durationMs: number };

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

/**
 * Refreshes every tuple `listTrackedTuples()` returns, each under its own
 * advisory-locked transaction so one slow tuple never blocks the rest and a
 * failure mid-sweep leaves the already-refreshed rows committed.
 */
export async function evaluateAllGraduations(): Promise<EvaluateResult> {
  const startedAt = Date.now();
  const tuples = await listTrackedTuples();

  let changed = 0;
  for (const tuple of tuples) {
    // Per-tuple error boundary — same reasoning as
    // `aiAgentSweepScheduler.ts:256-303` and `aiAgentImpactRollup.ts`'s
    // per-org scan loop: this is a once-a-day repeatable with no
    // `attempts`/backoff, so an uncaught rejection here would lose the whole
    // night's sweep for every OTHER tuple, not just this one.
    try {
      const result = await refreshGraduationRow(tuple.orgId, tuple.agentId, tuple.opKey);
      if (result.changed) changed++;
    } catch (error) {
      console.error('[AiAgentGraduationWorker] evaluate failed for one tuple — continuing the sweep', {
        orgId: tuple.orgId,
        agentId: tuple.agentId,
        opKey: tuple.opKey,
        error,
      });
    }
  }

  const durationMs = Date.now() - startedAt;
  console.log(`[AiAgentGraduationWorker] Evaluated ${tuples.length} graduation tuples (${changed} changed) in ${durationMs}ms`);
  return { tuples: tuples.length, changed, durationMs };
}

async function runGraduationJob(data: AiAgentGraduationJobData): Promise<PruneResult | EvaluateResult> {
  switch (data.task) {
    case 'prune-evidence':
      return runWithSystemDbAccess(() => pruneOpEvidence());
    case 'evaluate':
      // No `runWithSystemDbAccess` wrapper here, deliberately: both
      // `listTrackedTuples` and `refreshGraduationRow` already open (or
      // join) their own system DB context per call — see
      // `graduationService.ts`'s `inSystemDbContext`. Wrapping this in an
      // outer context would only pin an idle-in-transaction connection for
      // the whole sweep without being joined by the per-tuple transactions
      // inside it, the same pool-holding trap `aiAgentImpactRollup.ts`'s
      // header calls out.
      return evaluateAllGraduations();
    default: {
      // Exhaustiveness guard — fires if a future task variant is added here
      // without a corresponding case. Assigned from `data`, not `data.task`:
      // once every union member is handled by a `case`, TS narrows `data`
      // itself to `never` here, but a `.task` property READ off an
      // already-`never`-typed value errors ("Property does not exist on
      // type never") for a 2+-member discriminated union — a single-member
      // union (as this was before Task A2-3 added `evaluate`) does not hit
      // this, which is why the one-case version compiled.
      const _exhaustive: never = data;
      throw new Error(`[AiAgentGraduationWorker] unknown task: ${String((_exhaustive as { task: unknown }).task)}`);
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

  await queue.add(
    AI_AGENT_GRADUATION_JOB_NAME,
    { task: 'evaluate' } satisfies AiAgentGraduationJobData,
    {
      jobId: EVALUATE_REPEAT_JOB_ID,
      // Own registry-allocated daily slot, distinct from the prune job's —
      // same queue/worker, different jobId and cron pattern.
      repeat: { pattern: jobSchedule('ai-agent-graduation-evaluate') },
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 10 },
    },
  );

  console.log('[AiAgentGraduationWorker] Graduation worker initialized (prune-evidence, evaluate)');
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
