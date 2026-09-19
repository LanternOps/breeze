import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { deleteObjectKeys } from '../services/ticketAttachmentStorage';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';

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
 *  - CLAIM, then delete objects. The claim is one atomic
 *    `DELETE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING`,
 *    and objects are deleted only for rows it actually won.
 *
 * The claim-then-delete ordering is a REVISION of spec D9's "objects before
 * rows" (W08A review). D9's shape read the candidates unlocked, deleted their
 * objects, then re-checked `comment_id IS NULL` on the row DELETE — which
 * protected the ROW but not the OBJECT: `addTicketComment`'s claim UPDATE can
 * commit during the object round trip, and the technician then posts a live
 * comment whose photo bytes are already destroyed and unrecoverable. D9's own
 * rationale (never orphan bytes, since the row is the only index to the key)
 * is the lesser harm and is preserved as far as it can be: a storage fault is
 * loud and logs every orphaned key. Destroying live customer data to avoid
 * orphaning abandoned bytes is the wrong trade.
 *
 * The object round trip runs OUTSIDE the db context on purpose (#1105): a held
 * `withSystemDbAccessContext` is an open transaction pinning a pooled
 * connection, and a connection left idle-in-transaction across S3 latency is
 * killed by `idle_in_transaction_session_timeout` under load.
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
 * The claim runs under a SYSTEM db context: `breeze_has_org_access` is TRUE
 * under scope 'system', so the sweep sees every org. A CONTEXTLESS statement
 * resolves scope 'none' and would silently see nothing — a reaper that reports
 * success having done no work. The object delete deliberately runs after that
 * context has closed (see the header).
 */
export async function reapPendingAttachments(): Promise<number> {
  // Phase 1 — CLAIM. One atomic statement: the sub-select locks each candidate
  // and re-evaluates `comment_id IS NULL` against the locked row, so a row that
  // addTicketComment claimed in the meantime is dropped from the batch instead
  // of losing its bytes. SKIP LOCKED leaves a row another transaction is
  // mid-claim on for the next sweep rather than blocking behind it.
  const claimed = await withSystemDbAccessContext(async () => {
    const result = await db.execute<PendingRow>(sql`
      DELETE FROM ticket_attachments
      WHERE id IN (
        SELECT id
        FROM ticket_attachments
        WHERE comment_id IS NULL
          AND created_at < now() - interval '${sql.raw(String(PENDING_GRACE_HOURS))} hours'
        ORDER BY created_at ASC
        LIMIT ${sql.raw(String(MAX_REAP_PER_RUN))}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, storage_backend, storage_key
    `);
    const rows = (result as unknown as { rows?: PendingRow[] }).rows
      ?? (result as unknown as PendingRow[]);
    return Array.isArray(rows) ? rows : [];
  });
  if (claimed.length === 0) return 0;

  // Phase 2 — OBJECTS, outside the db context. Every key here belongs to a row
  // that no longer exists, so nothing live can be destroyed.
  const keys = claimed
    .filter((r) => r.storage_backend === 's3' && r.storage_key)
    .map((r) => r.storage_key as string);
  if (keys.length > 0) {
    try {
      await deleteObjectKeys(keys);
    } catch (err) {
      // The rows are already gone, so these bytes now have no index. Name every
      // key so the orphans are reconcilable from the log, then rethrow — the
      // job must fail loudly rather than report a clean sweep.
      console.error(
        `[TicketAttachmentReaper] Object delete FAILED after the rows were claimed — `
        + `${keys.length} object(s) orphaned with no row to find them by: ${keys.join(', ')}`,
      );
      throw err;
    }
  }

  const rows = claimed;
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
        // NOT wrapped in withSystemDbAccessContext here: the sweep opens its
        // own short context around the claim and closes it before the object
        // round trip. Wrapping it out here would nest — the inner context
        // short-circuits and the S3 call would run inside the held
        // transaction again (#1105).
        const reaped = await reapPendingAttachments();
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
  attachWorkerObservability(reaperWorker, 'ticketAttachmentReaper');
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
