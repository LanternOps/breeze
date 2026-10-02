/**
 * AI invocation ledger retention (#7600 W02). ai_invocations is APPEND-ONLY:
 * breeze_app holds no DELETE, and ai_invocations_append_only admits a delete
 * only as breeze_audit_admin with breeze.allow_audit_retention = '1'. Each
 * batch therefore runs in its own fresh system context that SET LOCALs both
 * (same pair as tenantCascade's erasure walk and jobs/auditRetention.ts), and
 * commits on its own (lock-duration rationale: jobs/retentionBatch.ts).
 *
 * Window: AI_INVOCATIONS_RETENTION_DAYS (default 400, cap 3650). Chargeback
 * (W10) aggregates BEFORE rows age out; it never mutates them — and a short
 * window never deletes a chargeable row younger than
 * CHARGEBACK_RETENTION_FLOOR_DAYS (#7608).
 */
import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { extractRowCount } from '../db/rowCount';
import { getBullMQConnection } from '../services/redis';
import { recordRetentionRun } from '../services/retentionMetrics';
import { attachWorkerObservability } from './workerObservability';
import { jobSchedule } from './scheduleRegistry';
import { parsePositiveIntEnv, resolveRetentionDays } from './retentionBatch';
import { CHARGEBACK_LOOKBACK_DAYS } from '../services/aiChargeback/chargePeriods';

const LOG = '[AiInvocationRetention]';
const QUEUE_NAME = 'ai-invocation-retention';
const JOB_NAME = 'ai-invocation-retention';
const REPEAT_JOB_ID = 'ai-invocation-retention';

export const AI_INVOCATION_RETENTION_DEFAULT_DAYS = 400;
const MAX_RETENTION_DAYS = 3650;

/** AI chargeback (#7608, spec §5.5 "aggregate before retention trims rows"): a
 *  chargeable row can still be closed until it is older than the lookback plus
 *  the longest month plus the close grace, so never prune one younger than this,
 *  whatever AI_INVOCATIONS_RETENTION_DAYS says. Claimed rows past it may go:
 *  their claim (ai_usage_charge_claims) outlives the ledger row. */
export const CHARGEBACK_RETENTION_FLOOR_DAYS = CHARGEBACK_LOOKBACK_DAYS + 31 + 2;

export async function pruneAiInvocations(opts: { retentionDays?: number; batchSize?: number; maxBatches?: number } = {}): Promise<{
  deleted: number; batches: number; hasMore: boolean; retentionDays: number;
}> {
  const retentionDays = resolveRetentionDays(
    opts.retentionDays ?? process.env.AI_INVOCATIONS_RETENTION_DAYS,
    AI_INVOCATION_RETENTION_DEFAULT_DAYS, MAX_RETENTION_DAYS, LOG,
  );
  const batchSize = opts.batchSize ?? parsePositiveIntEnv(LOG, 'AI_INVOCATIONS_RETENTION_BATCH_SIZE', 5000);
  const maxBatches = opts.maxBatches ?? parsePositiveIntEnv(LOG, 'AI_INVOCATIONS_RETENTION_MAX_BATCHES', 200);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const chargebackFloor = new Date(Date.now() - CHARGEBACK_RETENTION_FLOOR_DAYS * 24 * 60 * 60 * 1000).toISOString();

  let deleted = 0;
  let batches = 0;
  let last = 0;
  while (batches < maxBatches) {
    last = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      await db.execute(sql`SET LOCAL ROLE breeze_audit_admin`);
      await db.execute(sql`SET LOCAL breeze.allow_audit_retention = '1'`);
      const result = await db.execute(sql`
        DELETE FROM ai_invocations
        WHERE ctid IN (
          SELECT ctid FROM ai_invocations
          WHERE created_at < ${cutoff}::timestamptz
            AND (NOT chargeable OR created_at < ${chargebackFloor}::timestamptz)
          LIMIT ${batchSize}
        )`);
      return extractRowCount(result);
    }, 'aiInvocationRetention.batch'));
    deleted += last;
    batches += 1;
    if (last < batchSize) break;
  }
  recordRetentionRun('ai_invocation_retention', { rowsDeleted: deleted });
  console.log(`${LOG} Pruned ${deleted} ledger row(s) older than ${retentionDays}d in ${batches} batch(es)`);
  const hasMore = batches >= maxBatches && last >= batchSize;
  if (hasMore) {
    console.warn(`${LOG} Stopped at the ${maxBatches}-batch cap with rows still past the ${retentionDays}d window: retention backlog (raise AI_INVOCATIONS_RETENTION_MAX_BATCHES or _BATCH_SIZE if it persists)`);
  }
  return { deleted, batches, hasMore, retentionDays };
}

let queue: Queue | null = null;
let worker: Worker | null = null;

function getQueue(): Queue {
  if (!queue) queue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  return queue;
}

export async function initializeAiInvocationRetention(): Promise<void> {
  worker = new Worker(QUEUE_NAME, async (_job: Job) => pruneAiInvocations(), { connection: getBullMQConnection(), concurrency: 1 });
  attachWorkerObservability(worker, 'aiInvocationRetention');
  const q = getQueue();
  for (const job of await q.getRepeatableJobs()) await q.removeRepeatableByKey(job.key);
  await q.add(JOB_NAME, {}, {
    jobId: REPEAT_JOB_ID,
    repeat: { pattern: jobSchedule('ai-invocation-retention') },
    removeOnComplete: { count: 5 },
    removeOnFail: { count: 10 },
  });
  console.log(`${LOG} Retention worker initialized`);
}

export async function shutdownAiInvocationRetention(): Promise<void> {
  if (worker) { await worker.close(); worker = null; }
  if (queue) { await queue.close(); queue = null; }
}
