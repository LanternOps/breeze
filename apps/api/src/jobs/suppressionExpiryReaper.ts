import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { db } from '../db';
import { alerts } from '../db/schema/alerts';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { writeAuditEvent, requestLikeFromSnapshot } from '../services/auditEvents';

/**
 * Reaps `alerts` rows whose timed suppression has elapsed: `status='suppressed'`
 * with a non-null `suppressed_until` in the past. Flips them back to `active`
 * and clears the stale deadline so they reappear for triage and stop blocking
 * new alerts (alertService dedupe counts 'suppressed' as open). Snooze semantics:
 * no event is published, so notification channels stay silent.
 *
 * Indefinite ("Forever", suppressed_until IS NULL) suppressions are never touched.
 *
 * Runs every 5 minutes inside `withSystemDbAccessContext` — alerts is org-scoped
 * RLS, but expiry reaping is a system job.
 */

const QUEUE_NAME = 'suppression-expiry-reaper';
const REAP_INTERVAL_MS = 5 * 60 * 1000; // every 5 min
const MAX_REAP_PER_RUN = 500;

type ReaperJobData = { type: 'reap-expired-suppressions'; queuedAt: string };

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') {
    throw new Error(
      '[SuppressionExpiryReaper] withSystemDbAccessContext not available — reaper cannot run without system DB access',
    );
  }
  return withSystem(fn);
};

let reaperQueue: Queue<ReaperJobData> | null = null;
let reaperWorker: Worker<ReaperJobData> | null = null;

function getQueue(): Queue<ReaperJobData> {
  if (!reaperQueue) {
    reaperQueue = new Queue<ReaperJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return reaperQueue;
}

/**
 * Single pass: flip past-due timed suppressions to `active`, clear their
 * deadline, and write an audit row per transition. Bounded to MAX_REAP_PER_RUN
 * via a CTE so a backlog spike can't lock the table for too long. Returns the
 * number of alerts transitioned.
 */
export async function reapExpiredSuppressions(): Promise<number> {
  const transitioned = await db.execute<{
    id: string;
    org_id: string;
    title: string;
  }>(sql`
    WITH due AS (
      SELECT id
      FROM ${alerts}
      WHERE ${alerts.status} = 'suppressed'
        AND ${alerts.suppressedUntil} IS NOT NULL
        AND ${alerts.suppressedUntil} < now()
      ORDER BY ${alerts.suppressedUntil} ASC
      LIMIT ${MAX_REAP_PER_RUN}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${alerts} AS a
    SET status = 'active',
        suppressed_until = NULL
    FROM due
    WHERE a.id = due.id
      AND a.status = 'suppressed'
    RETURNING a.id, a.org_id, a.title;
  `);

  const rows = (transitioned as unknown as { rows?: Array<{ id: string; org_id: string; title: string }> }).rows
    ?? (transitioned as unknown as Array<{ id: string; org_id: string; title: string }>);

  if (!Array.isArray(rows) || rows.length === 0) {
    return 0;
  }

  // Audit log: one row per reactivated alert. Best-effort — never block a
  // transition on the audit write. System job, so no IP/UA.
  const requestLike = requestLikeFromSnapshot({});
  for (const row of rows) {
    try {
      writeAuditEvent(requestLike, {
        orgId: row.org_id,
        action: 'alert.suppression_expired',
        resourceType: 'alert',
        resourceId: row.id,
        resourceName: row.title,
        actorType: 'system',
        actorId: null,
        result: 'success',
        details: { previousStatus: 'suppressed' },
      });
    } catch (err) {
      console.error('[SuppressionExpiryReaper] Failed to write audit event:', err);
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }

  if (rows.length === MAX_REAP_PER_RUN) {
    console.warn(`[SuppressionExpiryReaper] Hit ${MAX_REAP_PER_RUN}-item cap — backlog may be growing`);
  }

  return rows.length;
}

function createWorker(): Worker<ReaperJobData> {
  return new Worker<ReaperJobData>(
    QUEUE_NAME,
    async (_job: Job<ReaperJobData>) => {
      try {
        const reaped = await runWithSystemDbAccess(reapExpiredSuppressions);
        if (reaped > 0) {
          console.log(`[SuppressionExpiryReaper] Reactivated ${reaped} alert(s)`);
        }
        return { reaped };
      } catch (err) {
        console.error('[SuppressionExpiryReaper] Run failed:', err);
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
    if (job.name === 'reap-expired-suppressions') {
      await queue.removeRepeatableByKey(job.key);
    }
  }
  await queue.add(
    'reap-expired-suppressions',
    { type: 'reap-expired-suppressions', queuedAt: new Date().toISOString() },
    {
      jobId: 'suppression-expiry-reaper',
      repeat: { every: REAP_INTERVAL_MS },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    },
  );
}

export async function initializeSuppressionExpiryReaper(): Promise<void> {
  if (reaperWorker) return;
  reaperWorker = createWorker();
  reaperWorker.on('error', (error) => {
    console.error('[SuppressionExpiryReaper] Worker error:', error);
    captureException(error);
  });
  reaperWorker.on('failed', (job, error) => {
    console.error(`[SuppressionExpiryReaper] Job ${job?.id} failed:`, error);
    captureException(error);
  });
  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await reaperWorker.close();
    reaperWorker = null;
    throw err;
  }
  console.log('[SuppressionExpiryReaper] Initialized');
}

export async function shutdownSuppressionExpiryReaper(): Promise<void> {
  const worker = reaperWorker;
  const queue = reaperQueue;
  reaperWorker = null;
  reaperQueue = null;
  if (worker) {
    try { await worker.close(); } catch (err) { console.error('[SuppressionExpiryReaper] Error closing worker:', err); }
  }
  if (queue) {
    try { await queue.close(); } catch (err) { console.error('[SuppressionExpiryReaper] Error closing queue:', err); }
  }
}
