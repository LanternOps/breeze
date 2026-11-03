/**
 * Tool catalog W04 (#5219), plan Task A8 / Decision 9 — flow run body
 * retention.
 *
 * Daily (`jobSchedule('flow-run-retention')`). For terminal runs that finished
 * more than `flowRunRetentionDays()` ago and are not pruned yet, in batches of
 * 1,000: `flow_runs.trigger_payload` / `inputs` and every step's
 * `rendered_input` / `output` become NULL, and `bodies_pruned_at` is stamped.
 * Rows are NEVER deleted: an action intent references its run ON DELETE
 * RESTRICT and intents are retained evidence, and the shells (status, timing,
 * error codes, approvers) are the run history. Shell volume is bounded by
 * W05's caps.
 *
 * Each batch is one statement in its own fresh system transaction (the
 * retentionBatch.ts lock-duration rationale); `bodies_pruned_at IS NULL`
 * makes it idempotent and resumable. Updating a terminal run is allowed by
 * flow_runs_immutable_trg (status unchanged) and required to be finished by
 * flow_runs_pruned_chk.
 */
import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import { flowUsagePeriodKey } from '@breeze/shared';
import { flowRunRetentionDays, flowWebhookDeliveryRetentionDays } from '../config/env';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { getBullMQConnection } from '../services/redis';
import { recordRetentionRun } from '../services/retentionMetrics';
import { attachWorkerObservability } from './workerObservability';
import { jobSchedule } from './scheduleRegistry';

const LOG = '[FlowRunRetention]';
const QUEUE_NAME = 'flow-run-retention';
const JOB_NAME = 'flow-run-retention';
const REPEAT_JOB_ID = 'flow-run-retention';
const DAY_MS = 24 * 60 * 60 * 1000;

export const FLOW_RUN_RETENTION_BATCH_SIZE = 1000;
const MAX_BATCHES = 50;

export interface FlowRunPruneSummary {
  runs: number;
  steps: number;
  batches: number;
  hasMore: boolean;
}

async function pruneBatch(cutoffIso: string, batchSize: number): Promise<{ runs: number; steps: number }> {
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.execute(sql`
    WITH target AS (
      SELECT id FROM flow_runs
      WHERE status IN ('completed', 'failed', 'cancelled', 'expired')
        AND finished_at < ${cutoffIso}::timestamptz
        AND bodies_pruned_at IS NULL
      ORDER BY finished_at
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    ),
    pruned_steps AS (
      UPDATE flow_run_steps s
      SET rendered_input = NULL, output = NULL
      FROM target
      WHERE s.run_id = target.id AND (s.rendered_input IS NOT NULL OR s.output IS NOT NULL)
      RETURNING s.id
    ),
    pruned_runs AS (
      UPDATE flow_runs r
      SET trigger_payload = NULL, inputs = NULL, bodies_pruned_at = now(), updated_at = now()
      FROM target
      WHERE r.id = target.id
      RETURNING r.id
    )
    SELECT (SELECT count(*) FROM pruned_runs)::int AS runs, (SELECT count(*) FROM pruned_steps)::int AS steps
  `), 'flowRunRetention.batch'));
  const row = (rows as unknown as Array<{ runs: number; steps: number }>)[0];
  if (!row || typeof row.runs !== 'number') {
    // Never read a missing result as "0 pruned": that ends the loop early.
    throw new Error(`${LOG} prune returned no summary row`);
  }
  return { runs: row.runs, steps: Number(row.steps ?? 0) };
}

export async function pruneFlowRunBodies(opts: { now?: Date; batchSize?: number; maxBatches?: number } = {}): Promise<FlowRunPruneSummary> {
  const now = opts.now ?? new Date();
  const batchSize = Math.max(1, opts.batchSize ?? FLOW_RUN_RETENTION_BATCH_SIZE);
  const maxBatches = Math.max(1, opts.maxBatches ?? MAX_BATCHES);
  const cutoffIso = new Date(now.getTime() - flowRunRetentionDays() * DAY_MS).toISOString();
  const summary: FlowRunPruneSummary = { runs: 0, steps: 0, batches: 0, hasMore: false };
  let last = 0;
  while (summary.batches < maxBatches) {
    const batch = await pruneBatch(cutoffIso, batchSize);
    summary.runs += batch.runs;
    summary.steps += batch.steps;
    summary.batches += 1;
    last = batch.runs;
    if (last < batchSize) break;
  }
  summary.hasMore = summary.batches >= maxBatches && last >= batchSize;
  if (summary.hasMore) console.warn(`${LOG} hit the ${maxBatches}-batch cap; pruning continues next run`);
  return summary;
}

// ── W5 (#5220, Decision 16): the delivery log and the usage counters ────────
// Webhook payloads live only in flow_runs.trigger_payload (pruned above).
// Delivery rows carry no body: NON-accepted rows go after
// FLOW_WEBHOOK_DELIVERY_RETENTION_DAYS; an accepted row lives as long as its
// run (it is the durable delivery → run mapping, Decision 2), so it is never
// deleted here. Counter rows go 13 months after their month. Runs are never
// deleted by any clause.

export interface FlowRetentionDeleteSummary {
  deleted: number;
  batches: number;
  hasMore: boolean;
}

async function deleteBatch(query: ReturnType<typeof sql>, label: string): Promise<number> {
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.execute(query), label));
  const row = (rows as unknown as Array<{ deleted: number }>)[0];
  if (!row || typeof row.deleted !== 'number') throw new Error(`${LOG} ${label} returned no summary row`);
  return row.deleted;
}

async function deleteInBatches(
  makeQuery: (batchSize: number) => ReturnType<typeof sql>,
  label: string,
  opts: { batchSize?: number; maxBatches?: number },
): Promise<FlowRetentionDeleteSummary> {
  const batchSize = Math.max(1, opts.batchSize ?? FLOW_RUN_RETENTION_BATCH_SIZE);
  const maxBatches = Math.max(1, opts.maxBatches ?? MAX_BATCHES);
  const summary: FlowRetentionDeleteSummary = { deleted: 0, batches: 0, hasMore: false };
  let last = 0;
  while (summary.batches < maxBatches) {
    last = await deleteBatch(makeQuery(batchSize), label);
    summary.deleted += last;
    summary.batches += 1;
    if (last < batchSize) break;
  }
  summary.hasMore = summary.batches >= maxBatches && last >= batchSize;
  if (summary.hasMore) console.warn(`${LOG} ${label} hit the ${maxBatches}-batch cap; continues next run`);
  return summary;
}

export async function pruneFlowWebhookDeliveries(opts: { now?: Date; batchSize?: number; maxBatches?: number } = {}): Promise<FlowRetentionDeleteSummary> {
  const now = opts.now ?? new Date();
  const cutoffIso = new Date(now.getTime() - flowWebhookDeliveryRetentionDays() * DAY_MS).toISOString();
  return deleteInBatches((batchSize) => sql`
    WITH target AS (
      SELECT id FROM flow_webhook_deliveries
      WHERE status <> 'accepted' AND last_attempt_at < ${cutoffIso}::timestamptz
      ORDER BY last_attempt_at
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    ),
    gone AS (
      DELETE FROM flow_webhook_deliveries d USING target WHERE d.id = target.id RETURNING d.id
    )
    SELECT (SELECT count(*) FROM gone)::int AS deleted
  `, 'flowRunRetention.deliveries', opts);
}

/** Counter rows of months more than 13 months back (`period_key` < the UTC month 13 months ago). */
export async function pruneFlowUsageCounters(opts: { now?: Date; batchSize?: number; maxBatches?: number } = {}): Promise<FlowRetentionDeleteSummary> {
  const now = opts.now ?? new Date();
  const cutoffKey = flowUsagePeriodKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 13, 1)));
  return deleteInBatches((batchSize) => sql`
    WITH target AS (
      SELECT id FROM flow_usage_counters
      WHERE period_key < ${cutoffKey}
      ORDER BY period_key
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    ),
    gone AS (
      DELETE FROM flow_usage_counters c USING target WHERE c.id = target.id RETURNING c.id
    )
    SELECT (SELECT count(*) FROM gone)::int AS deleted
  `, 'flowRunRetention.counters', opts);
}

// ── BullMQ wiring ───────────────────────────────────────────────────────────

let queue: Queue | null = null;
let worker: Worker | null = null;

function getQueue(): Queue {
  if (!queue) queue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  return queue;
}

export async function initializeFlowRunRetention(): Promise<void> {
  if (worker) return;
  worker = new Worker(
    QUEUE_NAME,
    // Not wrapped in a DB context: every batch opens its own.
    async (_job: Job) => {
      const summary = await pruneFlowRunBodies();
      console.log(`${LOG} pruned runs=${summary.runs} steps=${summary.steps} batches=${summary.batches} hasMore=${summary.hasMore}`);
      const deliveries = await pruneFlowWebhookDeliveries();
      const counters = await pruneFlowUsageCounters();
      console.log(`${LOG} deleted webhook deliveries=${deliveries.deleted} usage counters=${counters.deleted}`);
      recordRetentionRun('flow_run_retention', {
        rowsDeleted: summary.runs + summary.steps + deliveries.deleted + counters.deleted,
        incomplete: summary.hasMore || deliveries.hasMore || counters.hasMore,
      });
      return { ...summary, deliveries, counters };
    },
    { connection: getBullMQConnection(), concurrency: 1 },
  );
  attachWorkerObservability(worker, 'flowRunRetention');
  const q = getQueue();
  for (const job of await q.getRepeatableJobs()) await q.removeRepeatableByKey(job.key);
  await q.add(JOB_NAME, {}, {
    jobId: REPEAT_JOB_ID,
    repeat: { pattern: jobSchedule('flow-run-retention') },
    removeOnComplete: { count: 5 },
    removeOnFail: { count: 20 },
  });
  console.log(`${LOG} initialized`);
}

export async function shutdownFlowRunRetention(): Promise<void> {
  if (worker) { await worker.close(); worker = null; }
  if (queue) { await queue.close(); queue = null; }
}

export const __testOnly = { QUEUE_NAME, JOB_NAME, REPEAT_JOB_ID };
