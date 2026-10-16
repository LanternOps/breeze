import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';
import { jobSchedule } from './scheduleRegistry';

/**
 * Endpoint message retention (#8742 W02).
 *
 *  1. Bodies: 90 days after a send, title and body are nulled and
 *     body_purged_at is stamped (the row, its hash and length stay as history).
 *  2. Expiry: a delivery still queued/delivered/displayed past its expiry is
 *     marked `expired` (the agent drops the card at expiry; this closes the
 *     server's view when no event or result arrives).
 *  3. History: messages older than 13 months are deleted (deliveries and
 *     receipts cascade), and so are detached deliveries (a device that moved
 *     orgs) older than 13 months.
 *
 * Every pass is batched and reports its row count. Runs in system scope:
 * retention is cross-tenant by design and runs outside any request.
 */

export const ENDPOINT_MESSAGE_RETENTION_QUEUE = 'endpoint-message-retention';
const JOB_NAME = 'endpoint-message-retention';

export const ENDPOINT_MESSAGE_BODY_RETENTION_DAYS = 90;
export const ENDPOINT_MESSAGE_HISTORY_RETENTION_MONTHS = 13;
const BATCH = 1000;
const MAX_BATCHES_PER_PASS = 200;

export interface EndpointMessageRetentionResult {
  bodiesPurged: number;
  deliveriesExpired: number;
  messagesDeleted: number;
  detachedDeliveriesDeleted: number;
}

function rowCount(res: unknown): number {
  const r = res as { count?: number; rowCount?: number } | unknown[];
  if (Array.isArray(r)) return r.length;
  return Number((r as { count?: number }).count ?? (r as { rowCount?: number }).rowCount ?? 0);
}

async function batched(run: () => Promise<number>): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES_PER_PASS; i += 1) {
    const n = await run();
    total += n;
    if (n < BATCH) break;
  }
  return total;
}

/** One retention run. Exported for tests; `now` is injectable. */
export async function runEndpointMessageRetentionOnce(now: Date = new Date()): Promise<EndpointMessageRetentionResult> {
  const nowIso = now.toISOString();
  return withSystemDbAccessContext(async () => {
    const bodiesPurged = await batched(async () => rowCount(await db.execute(sql`
      UPDATE endpoint_messages
         SET title = NULL, body = NULL, body_purged_at = ${nowIso}::timestamptz
       WHERE id IN (
         SELECT id FROM endpoint_messages
          WHERE body_purged_at IS NULL
            AND created_at < ${nowIso}::timestamptz - make_interval(days => ${ENDPOINT_MESSAGE_BODY_RETENTION_DAYS})
          ORDER BY created_at
          LIMIT ${BATCH}
       )
      RETURNING id`)));

    const deliveriesExpired = await batched(async () => rowCount(await db.execute(sql`
      UPDATE endpoint_message_deliveries
         SET status = 'expired', updated_at = ${nowIso}::timestamptz
       WHERE id IN (
         SELECT id FROM endpoint_message_deliveries
          WHERE status IN ('queued', 'delivered', 'displayed')
            AND expires_at IS NOT NULL
            AND expires_at < ${nowIso}::timestamptz
          LIMIT ${BATCH}
       )
         AND status IN ('queued', 'delivered', 'displayed')
      RETURNING id`)));

    const messagesDeleted = await batched(async () => rowCount(await db.execute(sql`
      DELETE FROM endpoint_messages
       WHERE id IN (
         SELECT id FROM endpoint_messages
          WHERE created_at < ${nowIso}::timestamptz - make_interval(months => ${ENDPOINT_MESSAGE_HISTORY_RETENTION_MONTHS})
          ORDER BY created_at
          LIMIT ${BATCH}
       )
      RETURNING id`)));

    const detachedDeliveriesDeleted = await batched(async () => rowCount(await db.execute(sql`
      DELETE FROM endpoint_message_deliveries
       WHERE id IN (
         SELECT id FROM endpoint_message_deliveries
          WHERE endpoint_message_id IS NULL
            AND created_at < ${nowIso}::timestamptz - make_interval(months => ${ENDPOINT_MESSAGE_HISTORY_RETENTION_MONTHS})
          LIMIT ${BATCH}
       )
      RETURNING id`)));

    const result = { bodiesPurged, deliveriesExpired, messagesDeleted, detachedDeliveriesDeleted };
    if (bodiesPurged + deliveriesExpired + messagesDeleted + detachedDeliveriesDeleted > 0) {
      console.log('[endpointMessageRetention] run complete', result);
    }
    return result;
  });
}

let queue: Queue | null = null;
let worker: Worker | null = null;

function getQueue(): Queue {
  if (!queue) queue = new Queue(ENDPOINT_MESSAGE_RETENTION_QUEUE, { connection: getBullMQConnection() });
  return queue;
}

async function processJob(_job: Job): Promise<unknown> {
  return runEndpointMessageRetentionOnce();
}

async function scheduleRepeatableJob(): Promise<void> {
  const q = getQueue();
  for (const job of await q.getRepeatableJobs()) {
    if (job.name === JOB_NAME) await q.removeRepeatableByKey(job.key);
  }
  await q.add(
    JOB_NAME,
    { type: JOB_NAME, queuedAt: new Date().toISOString() },
    {
      jobId: ENDPOINT_MESSAGE_RETENTION_QUEUE,
      // String literal: the schedule contract test resolves `jobSchedule('<literal>')` statically.
      repeat: { pattern: jobSchedule('endpoint-message-retention') },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    },
  );
}

export async function initializeEndpointMessageRetentionWorker(): Promise<void> {
  if (worker) return;
  worker = new Worker(ENDPOINT_MESSAGE_RETENTION_QUEUE, processJob, {
    connection: getBullMQConnection(),
    concurrency: 1,
  });
  attachWorkerObservability(worker, 'endpointMessageRetention');
  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await worker.close();
    worker = null;
    throw err;
  }
  console.log('[endpointMessageRetention] Initialized');
}

export async function shutdownEndpointMessageRetentionWorker(): Promise<void> {
  await worker?.close();
  worker = null;
  await queue?.close();
  queue = null;
}
