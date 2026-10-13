/**
 * LLM egress audit retention + daily rollup (#4120).
 *
 * `llm_egress_events` records one row per outbound LLM request / CONNECT, so its
 * volume scales with tool calls rather than sessions. Owner decision on #4120:
 * keep raw rows for LLM_EGRESS_EVENTS_RETENTION_DAYS (default 90, cap 3650),
 * then keep only the daily summary in `llm_egress_daily_rollups`
 * (one row per org, UTC day, surface, host).
 *
 * FOLD AND DELETE ARE ONE STATEMENT
 * ---------------------------------
 * Each batch is a single `WITH moved AS (DELETE ... RETURNING ...) INSERT INTO
 * llm_egress_daily_rollups ... ON CONFLICT DO UPDATE SET count = count + ...`.
 * A raw row therefore leaves the table only in the transaction that adds it to
 * its day's rollup: there is no window where raw is gone and the rollup is not
 * written (a separate rollup job + prune job would have one), and a row is never
 * counted twice — a concurrent or repeated run can't RETURN a row another run
 * already deleted. Adding (not overwriting) is what makes a day that is folded
 * across several batches or nights come out exact.
 *
 * Each batch commits on its own, in a FRESH system context (lock-duration
 * rationale: jobs/retentionBatch.ts). Do not wrap the loop in a context.
 *
 * breeze_app holds DELETE on llm_egress_events (2026-09-13-d revoked only
 * UPDATE) and there is no append-only trigger, so unlike aiInvocationRetention
 * no audit-admin role switch is needed.
 */
import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { getBullMQConnection } from '../services/redis';
import { recordRetentionRun } from '../services/retentionMetrics';
import { attachWorkerObservability } from './workerObservability';
import { jobSchedule } from './scheduleRegistry';
import { resolveRetentionDays, warnOnRetentionBacklog } from './retentionBatch';

const LOG = '[LlmEgressRetention]';
const QUEUE_NAME = 'llm-egress-retention';
const JOB_NAME = 'llm-egress-retention';
const REPEAT_JOB_ID = 'llm-egress-retention';

export const LLM_EGRESS_RETENTION_DEFAULT_DAYS = 90;
const MAX_RETENTION_DAYS = 3650;
const DEFAULT_BATCH_SIZE = 5000;
const DEFAULT_MAX_BATCHES = 200;

export interface LlmEgressFoldResult {
  /** Raw rows deleted (and counted into rollups) this run. */
  folded: number;
  batches: number;
  /** The batch cap stopped the run on a full batch: rows past the window remain. */
  hasMore: boolean;
  retentionDays: number;
}

function firstRowCount(result: unknown): number {
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] } | null)?.rows;
  const value = (rows?.[0] as { folded?: unknown } | undefined)?.folded;
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export async function foldAndPruneLlmEgressEvents(
  opts: { retentionDays?: number; batchSize?: number; maxBatches?: number; now?: Date } = {},
): Promise<LlmEgressFoldResult> {
  const nowMs = (opts.now ?? new Date()).getTime();
  const retentionDays = resolveRetentionDays(
    opts.retentionDays ?? process.env.LLM_EGRESS_EVENTS_RETENTION_DAYS,
    LLM_EGRESS_RETENTION_DEFAULT_DAYS, MAX_RETENTION_DAYS, LOG,
  );
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? DEFAULT_MAX_BATCHES;
  // postgres-js does not coerce a JS Date in template params; pass ISO.
  const cutoff = new Date(nowMs - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  let folded = 0;
  let batches = 0;
  let last = 0;
  while (batches < maxBatches) {
    last = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      // partner_id is NOT a grouping key: the conflict target is
      // (org_id, day, surface, host), and two partner values for one key in a
      // single INSERT would raise "ON CONFLICT DO UPDATE command cannot affect
      // row a second time" and wedge the job forever. The composite FK keeps
      // (org_id, partner_id) consistent, so any member of the group is right.
      const result = await db.execute(sql`
        WITH moved AS (
          DELETE FROM llm_egress_events
          WHERE ctid IN (
            SELECT ctid FROM llm_egress_events
            WHERE created_at < ${cutoff}::timestamptz
            LIMIT ${batchSize}
          )
          RETURNING org_id, partner_id, surface, host, blocked, created_at
        ),
        agg AS (
          SELECT org_id,
                 (array_agg(partner_id ORDER BY created_at DESC))[1] AS partner_id,
                 (created_at AT TIME ZONE 'UTC')::date AS day,
                 surface,
                 host,
                 count(*)::bigint AS request_count,
                 (count(*) FILTER (WHERE blocked))::bigint AS blocked_count,
                 min(created_at) AS first_event_at,
                 max(created_at) AS last_event_at
          FROM moved
          GROUP BY org_id, (created_at AT TIME ZONE 'UTC')::date, surface, host
        ),
        upserted AS (
          INSERT INTO llm_egress_daily_rollups AS r
            (org_id, partner_id, day, surface, host, request_count, blocked_count, first_event_at, last_event_at, updated_at)
          SELECT org_id, partner_id, day, surface, host, request_count, blocked_count, first_event_at, last_event_at, now()
          FROM agg
          ON CONFLICT (org_id, day, surface, host) DO UPDATE SET
            request_count  = r.request_count + EXCLUDED.request_count,
            blocked_count  = r.blocked_count + EXCLUDED.blocked_count,
            first_event_at = LEAST(r.first_event_at, EXCLUDED.first_event_at),
            last_event_at  = GREATEST(r.last_event_at, EXCLUDED.last_event_at),
            updated_at     = now()
          RETURNING 1
        )
        SELECT (SELECT count(*) FROM moved)::int AS folded,
               (SELECT count(*) FROM upserted)::int AS rollups
      `);
      return firstRowCount(result);
    }, 'llmEgressRetention.batch'));
    folded += last;
    batches += 1;
    if (last < batchSize) break;
  }

  const hasMore = batches >= maxBatches && last >= batchSize;
  recordRetentionRun('llm_egress_retention', { rowsDeleted: folded });
  console.log(`${LOG} Folded ${folded} egress row(s) older than ${retentionDays}d into daily rollups in ${batches} batch(es)`);
  warnOnRetentionBacklog(LOG, 'llm_egress_events', { deleted: folded, batches, hasMore });
  return { folded, batches, hasMore, retentionDays };
}

let queue: Queue | null = null;
let worker: Worker | null = null;

function getQueue(): Queue {
  if (!queue) queue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  return queue;
}

export async function initializeLlmEgressRetention(): Promise<void> {
  worker = new Worker(QUEUE_NAME, async (_job: Job) => foldAndPruneLlmEgressEvents(), {
    connection: getBullMQConnection(),
    concurrency: 1,
  });
  attachWorkerObservability(worker, 'llmEgressRetention');
  const q = getQueue();
  for (const job of await q.getRepeatableJobs()) await q.removeRepeatableByKey(job.key);
  await q.add(JOB_NAME, {}, {
    jobId: REPEAT_JOB_ID,
    // Daily at a registry-allocated slot (never `every: 24h`; see scheduleRegistry.ts).
    repeat: { pattern: jobSchedule('llm-egress-retention') },
    removeOnComplete: { count: 5 },
    removeOnFail: { count: 10 },
  });
  console.log(`${LOG} Retention worker initialized`);
}

export async function shutdownLlmEgressRetention(): Promise<void> {
  if (worker) { await worker.close(); worker = null; }
  if (queue) { await queue.close(); queue = null; }
}
