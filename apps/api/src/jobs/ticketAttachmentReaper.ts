import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { deleteObjectKeys } from '../services/ticketAttachmentStorage';
import { jobSchedule } from './scheduleRegistry';

/**
 * Reaps abandoned PENDING ticket attachments (W08 #3902, spec D2).
 *
 * A pending row (`comment_id IS NULL`) is an upload that was never claimed by a
 * comment — the technician closed the composer, the comment POST failed, or the
 * app was killed mid-flight. After a 24h grace period the row and its object are
 * deleted.
 *
 * Two rules that must not drift:
 *  - ONLY `comment_id IS NULL`. An attached row is customer data; reaping one
 *    would silently delete a photo out of a live ticket thread.
 *  - Objects BEFORE rows, and abort on a storage fault (spec D9). The row is
 *    the only index to the object key; deleting it first would strand bytes in
 *    the bucket forever. Aborting leaves the batch for the next hour.
 *
 * Runs on an ALLOCATED hourly slot rather than `repeat: { every: 1h }` —
 * BullMQ's `every` is epoch-anchored, so every hourly job would co-fire at
 * :00 and pile onto the shared Postgres pool (see scheduleRegistry's header).
 */

const QUEUE_NAME = 'ticket-attachment-pending-reaper';
const JOB_NAME = 'reap-pending-ticket-attachments';
const MAX_REAP_PER_RUN = 500;
/** Grace period before an unclaimed upload is considered abandoned. */
const PENDING_GRACE_HOURS = 24;

export const TICKET_ATTACHMENT_REAPER_SCHEDULE_KEY = 'ticket-attachment-pending-reaper' as const;

type ReaperJobData = { type: typeof JOB_NAME; queuedAt: string };

/** `db.execute<T>` constrains T to Record<string, unknown>; a `type` with an
 *  index signature satisfies that where a bare `interface` does not. */
type PendingRow = {
  id: string;
  storage_backend: string;
  storage_key: string | null;
} & Record<string, unknown>;

let reaperQueue: Queue<ReaperJobData> | null = null;
let reaperWorker: Worker<ReaperJobData> | null = null;

function getQueue(): Queue<ReaperJobData> {
  if (!reaperQueue) {
    reaperQueue = new Queue<ReaperJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return reaperQueue;
}

/**
 * One sweep. Returns the number of rows deleted.
 *
 * Runs under a SYSTEM db context at the worker boundary: `breeze_has_org_access`
 * is TRUE under scope 'system', so the sweep sees every org. A CONTEXTLESS
 * statement resolves scope 'none' and would silently see nothing — a reaper
 * that reports success having done no work.
 */
export async function reapPendingAttachments(): Promise<number> {
  const selected = await db.execute<PendingRow>(sql`
    SELECT id, storage_backend, storage_key
    FROM ticket_attachments
    WHERE comment_id IS NULL
      AND created_at < now() - interval '${sql.raw(String(PENDING_GRACE_HOURS))} hours'
    ORDER BY created_at ASC
    LIMIT ${sql.raw(String(MAX_REAP_PER_RUN))}
  `);

  const rows = (selected as unknown as { rows?: PendingRow[] }).rows
    ?? (selected as unknown as PendingRow[]);
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  // Objects first. A fault throws and the rows survive — the next run re-reads
  // the same keys and finishes the job.
  const keys = rows
    .filter((r) => r.storage_backend === 's3' && r.storage_key)
    .map((r) => r.storage_key as string);
  if (keys.length > 0) {
    await deleteObjectKeys(keys);
  }

  const idList = sql.join(rows.map((r) => sql`${r.id}::uuid`), sql`, `);
  await db.execute(sql`
    DELETE FROM ticket_attachments
    WHERE id IN (${idList})
      AND comment_id IS NULL
  `);

  if (rows.length === MAX_REAP_PER_RUN) {
    console.warn(`[TicketAttachmentReaper] Hit ${MAX_REAP_PER_RUN}-item cap — backlog may be growing`);
  }
  return rows.length;
}

function createWorker(): Worker<ReaperJobData> {
  return new Worker<ReaperJobData>(
    QUEUE_NAME,
    async (_job: Job<ReaperJobData>) => {
      try {
        const reaped = await withSystemDbAccessContext(() => reapPendingAttachments());
        if (reaped > 0) {
          console.log(`[TicketAttachmentReaper] Reaped ${reaped} abandoned upload(s)`);
        }
        return { reaped };
      } catch (err) {
        console.error('[TicketAttachmentReaper] Run failed:', err);
        captureException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    },
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

async function scheduleRepeatableJob(): Promise<void> {
  const queue = getQueue();
  const repeatables = await queue.getRepeatableJobs();
  for (const job of repeatables) {
    if (job.name === JOB_NAME) {
      await queue.removeRepeatableByKey(job.key);
    }
  }
  await queue.add(
    JOB_NAME,
    { type: JOB_NAME, queuedAt: new Date().toISOString() },
    {
      jobId: QUEUE_NAME,
      // Allocated slot, never an inline pattern (scheduleRegistry is the
      // single place a coarse schedule is chosen).
      // String literal, not the exported const: the schedule contract test
      // statically resolves `jobSchedule('<literal>')` only.
      repeat: { pattern: jobSchedule('ticket-attachment-pending-reaper') },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    },
  );
}

export async function initializeTicketAttachmentReaper(): Promise<void> {
  if (reaperWorker) return;
  reaperWorker = createWorker();
  reaperWorker.on('error', (error) => {
    console.error('[TicketAttachmentReaper] Worker error:', error);
    captureException(error);
  });
  reaperWorker.on('failed', (job, error) => {
    console.error(`[TicketAttachmentReaper] Job ${job?.id} failed:`, error);
    captureException(error);
  });
  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await reaperWorker.close();
    reaperWorker = null;
    throw err;
  }
  console.log('[TicketAttachmentReaper] Initialized');
}

export async function shutdownTicketAttachmentReaper(): Promise<void> {
  const worker = reaperWorker;
  const queue = reaperQueue;
  reaperWorker = null;
  reaperQueue = null;
  if (worker) {
    try { await worker.close(); } catch (err) { console.error('[TicketAttachmentReaper] Error closing worker:', err); }
  }
  if (queue) {
    try { await queue.close(); } catch (err) { console.error('[TicketAttachmentReaper] Error closing queue:', err); }
  }
}
