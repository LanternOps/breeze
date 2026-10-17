import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import { ENDPOINT_CHAT_LIMITS } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { queueCommandForExecutionWithSystemPrecheck } from '../services/commandQueue';
import { CommandTypes } from '../services/commandTypes';
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
 * Endpoint live chat (#8743 W03), same job (runEndpointChatRetentionOnce):
 *  4. Idle: an open chat with no activity for 30 minutes is `expired`
 *     (close_reason 'idle'); an `opening` chat the agent never confirmed in
 *     2 minutes is `failed` (open_timeout). The agent is told (chat_close,
 *     best effort, after the DB pass) so the helper window stops taking input.
 *  5. History: conversations older than 13 months are deleted (messages
 *     cascade), then message bodies older than 90 days are nulled.
 *
 * Every pass is batched and reports its row count. Runs in system scope:
 * retention is cross-tenant by design and runs outside any request.
 */

export const ENDPOINT_MESSAGE_RETENTION_QUEUE = 'endpoint-message-retention';
const JOB_NAME = 'endpoint-message-retention';
// Live chat (#8743): the 30-minute idle close needs a fine tick, so it is its
// own repeatable job on the same queue (sub-hourly, so `every:` by design; see
// scheduleRegistry.ts "HONEST SCOPE").
export const CHAT_JOB_NAME = 'endpoint-chat-retention';
export const CHAT_RETENTION_EVERY_MS = 5 * 60_000;

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

async function batched(pass: string, run: () => Promise<number>): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES_PER_PASS; i += 1) {
    const n = await run();
    total += n;
    if (n < BATCH) return total;
  }
  // Backlog larger than one pass: the next scheduled run continues it.
  console.warn(`[endpointMessageRetention] ${pass} hit the per-pass cap (${MAX_BATCHES_PER_PASS * BATCH} rows); remainder deferred to the next run`);
  return total;
}

/** One retention run. Exported for tests; `now` is injectable. */
export async function runEndpointMessageRetentionOnce(now: Date = new Date()): Promise<EndpointMessageRetentionResult> {
  const nowIso = now.toISOString();
  return withSystemDbAccessContext(async () => {
    const bodiesPurged = await batched('body purge', async () => rowCount(await db.execute(sql`
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

    const deliveriesExpired = await batched('expiry close-out', async () => rowCount(await db.execute(sql`
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

    const messagesDeleted = await batched('history delete', async () => rowCount(await db.execute(sql`
      DELETE FROM endpoint_messages
       WHERE id IN (
         SELECT id FROM endpoint_messages
          WHERE created_at < ${nowIso}::timestamptz - make_interval(months => ${ENDPOINT_MESSAGE_HISTORY_RETENTION_MONTHS})
          ORDER BY created_at
          LIMIT ${BATCH}
       )
      RETURNING id`)));

    const detachedDeliveriesDeleted = await batched('detached history delete', async () => rowCount(await db.execute(sql`
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

export interface EndpointChatRetentionResult {
  idleExpired: number;
  opensTimedOut: number;
  bodiesPurged: number;
  conversationsDeleted: number;
}

/** Tells the agent a chat ended. Best effort: an offline device learns at its next reply (409). */
export type ChatCloseNotifier = (deviceId: string, payload: Record<string, unknown>, expectedOrgId: string) => Promise<void>;

const notifyChatClosed: ChatCloseNotifier = async (deviceId, payload, expectedOrgId) => {
  const res = await queueCommandForExecutionWithSystemPrecheck(deviceId, CommandTypes.CHAT_CLOSE, payload, {
    expectedOrgId,
    offlinePolicy: { kind: 'reject' },
  });
  if (res.error) {
    console.warn('[endpointMessageRetention] chat_close not delivered', { deviceId, error: res.error });
  }
};

interface ClosedRow { id: string; device_id: string; org_id: string }

function rowsOf(res: unknown): ClosedRow[] {
  return (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as ClosedRow[];
}

/** One chat retention run. Exported for tests; `now` and the notifier are injectable. */
export async function runEndpointChatRetentionOnce(
  now: Date = new Date(),
  notify: ChatCloseNotifier = notifyChatClosed,
): Promise<EndpointChatRetentionResult> {
  const nowIso = now.toISOString();
  const closed: Array<ClosedRow & { reason: 'idle' }> = [];
  const result = await withSystemDbAccessContext(async () => {
    const idleExpired = await batched('chat idle close', async () => {
      const rows = rowsOf(await db.execute(sql`
        UPDATE endpoint_conversations
           SET status = 'expired', close_reason = 'idle', closed_at = ${nowIso}::timestamptz, updated_at = ${nowIso}::timestamptz
         WHERE id IN (
           SELECT id FROM endpoint_conversations
            WHERE status = 'open'
              AND last_activity_at < ${nowIso}::timestamptz - make_interval(mins => ${ENDPOINT_CHAT_LIMITS.idleCloseMinutes})
            LIMIT ${BATCH}
         )
           AND status = 'open'
           -- Re-checked on the row itself: a reply that committed after the
           -- subquery's snapshot keeps the chat alive.
           AND last_activity_at < ${nowIso}::timestamptz - make_interval(mins => ${ENDPOINT_CHAT_LIMITS.idleCloseMinutes})
        RETURNING id, device_id, org_id`));
      for (const r of rows) closed.push({ ...r, reason: 'idle' });
      return rows.length;
    });

    const opensTimedOut = await batched('chat open timeout', async () => {
      const rows = rowsOf(await db.execute(sql`
        UPDATE endpoint_conversations
           SET status = 'failed', error_code = 'open_timeout', updated_at = ${nowIso}::timestamptz
         WHERE id IN (
           SELECT id FROM endpoint_conversations
            WHERE status = 'opening'
              AND created_at < ${nowIso}::timestamptz - make_interval(mins => ${ENDPOINT_CHAT_LIMITS.openTimeoutMinutes})
            LIMIT ${BATCH}
         )
           AND status = 'opening'
           AND created_at < ${nowIso}::timestamptz - make_interval(mins => ${ENDPOINT_CHAT_LIMITS.openTimeoutMinutes})
        RETURNING id, device_id, org_id`));
      // The window may have come up after all (a lost result): take it down.
      for (const r of rows) closed.push({ ...r, reason: 'idle' });
      return rows.length;
    });

    // Delete before purging, so a row about to go is not rewritten first.
    const conversationsDeleted = await batched('chat history delete', async () => rowCount(await db.execute(sql`
      DELETE FROM endpoint_conversations
       WHERE id IN (
         SELECT id FROM endpoint_conversations
          WHERE created_at < ${nowIso}::timestamptz - make_interval(months => ${ENDPOINT_MESSAGE_HISTORY_RETENTION_MONTHS})
          ORDER BY created_at
          LIMIT ${BATCH}
       )
      RETURNING id`)));

    const bodiesPurged = await batched('chat body purge', async () => rowCount(await db.execute(sql`
      UPDATE endpoint_conversation_messages
         SET body = NULL, body_purged_at = ${nowIso}::timestamptz, updated_at = ${nowIso}::timestamptz
       WHERE id IN (
         SELECT id FROM endpoint_conversation_messages
          WHERE body_purged_at IS NULL
            AND created_at < ${nowIso}::timestamptz - make_interval(days => ${ENDPOINT_MESSAGE_BODY_RETENTION_DAYS})
          ORDER BY created_at
          LIMIT ${BATCH}
       )
      RETURNING id`)));

    return { idleExpired, opensTimedOut, bodiesPurged, conversationsDeleted };
  });

  // Command dispatch never runs inside the retention transaction.
  for (const c of closed) {
    try {
      await runOutsideDbContext(() => notify(c.device_id, { conversationId: c.id, reason: c.reason }, c.org_id));
    } catch (err) {
      console.warn('[endpointMessageRetention] chat_close notify threw', { conversationId: c.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (result.idleExpired + result.opensTimedOut + result.bodiesPurged + result.conversationsDeleted > 0) {
    console.log('[endpointMessageRetention] chat run complete', result);
  }
  return result;
}

let queue: Queue | null = null;
let worker: Worker | null = null;

function getQueue(): Queue {
  if (!queue) queue = new Queue(ENDPOINT_MESSAGE_RETENTION_QUEUE, { connection: getBullMQConnection() });
  return queue;
}

export async function processEndpointMessageRetentionJob(job: Pick<Job, 'name'>): Promise<unknown> {
  if (job.name === CHAT_JOB_NAME) return runEndpointChatRetentionOnce();
  return runEndpointMessageRetentionOnce();
}

const processJob = (job: Job) => processEndpointMessageRetentionJob(job);

async function scheduleRepeatableJob(): Promise<void> {
  const q = getQueue();
  for (const job of await q.getRepeatableJobs()) {
    if (job.name === JOB_NAME || job.name === CHAT_JOB_NAME) await q.removeRepeatableByKey(job.key);
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
  await q.add(
    CHAT_JOB_NAME,
    { type: CHAT_JOB_NAME, queuedAt: new Date().toISOString() },
    {
      jobId: `${ENDPOINT_MESSAGE_RETENTION_QUEUE}:chat`,
      repeat: { every: CHAT_RETENTION_EVERY_MS },
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
