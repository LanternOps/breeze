/**
 * PAM lifecycle jobs (#1163). Two reapers cloned from the
 * approvalExpiryReaper pattern (BullMQ repeatable job + worker, CTE-bounded
 * UPDATE, withSystemDbAccessContext, audit + event per transition):
 *
 *   - elevation-expiry-enforcer (every 60s): active elevations
 *     (approved / auto_approved / actuating) whose expires_at has passed →
 *     status='expired'. This is the core time-bound safety guarantee.
 *
 *   - stale-request-expirer (every 5 min): pending requests older than the
 *     TTL → status='expired' (keeps the approval queue signal-only).
 *
 * Agent-side revoke commands for expired tech_jit_admin grants are #1150
 * scope (group-flip undo handler) — until that lands, expiry is a
 * server-side state change, audited and event-emitted.
 */
import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';

import * as dbModule from '../db';
import { db } from '../db';
import { elevationAudit, elevationRequests } from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { publishEvent } from '../services/eventBus';
import { writeAuditEvent, requestLikeFromSnapshot } from '../services/auditEvents';

const ENFORCER_QUEUE = 'pam-elevation-expiry-enforcer';
const ENFORCER_INTERVAL_MS = 60 * 1000; // every 60s
const STALE_QUEUE = 'pam-stale-request-expirer';
const STALE_INTERVAL_MS = 5 * 60 * 1000; // every 5 min
const MAX_PER_RUN = 500;

// Pending requests older than this are expired. Overridable for ops via env.
const STALE_PENDING_TTL_MINUTES = Number.parseInt(
  process.env.PAM_PENDING_REQUEST_TTL_MINUTES ?? '15',
  10,
);

type PamJobData = { type: 'enforce-elevation-expiry' | 'expire-stale-requests'; queuedAt: string };

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') {
    throw new Error(
      '[PamJobs] withSystemDbAccessContext not available — reapers cannot run without system DB access',
    );
  }
  return withSystem(fn);
};

interface TransitionedRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  device_id: string;
  flow_type: string;
  prior_status: string;
}

function extractRows(result: unknown): TransitionedRow[] {
  const maybe = result as { rows?: TransitionedRow[] };
  const rows = maybe.rows ?? (result as TransitionedRow[]);
  return Array.isArray(rows) ? rows : [];
}

/** Shared post-transition side effects: PAM audit chain + event + audit log. */
async function emitExpiryEffects(rows: TransitionedRow[], cause: 'window' | 'stale'): Promise<void> {
  if (rows.length === 0) return;
  const now = new Date();

  // PAM-specific audit chain (one row per transition). Best-effort.
  try {
    await db.insert(elevationAudit).values(
      rows.map((row) => ({
        orgId: row.org_id,
        elevationRequestId: row.id,
        eventType: 'expired' as const,
        actor: 'system' as const,
        details: { cause, prior_status: row.prior_status },
        occurredAt: now,
      })),
    );
  } catch (err) {
    console.error('[PamJobs] elevation_audit write failed:', err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }

  const requestLike = requestLikeFromSnapshot({});
  for (const row of rows) {
    try {
      writeAuditEvent(requestLike, {
        orgId: row.org_id,
        action: 'pam.elevation_request.expired',
        resourceType: 'elevation_request',
        resourceId: row.id,
        actorType: 'system',
        actorId: null,
        result: 'success',
        details: { cause, prior_status: row.prior_status, flow_type: row.flow_type },
      });
    } catch (err) {
      console.error('[PamJobs] audit event write failed:', err);
    }
    try {
      await publishEvent(
        'elevation.expired',
        row.org_id,
        {
          elevationRequestId: row.id,
          deviceId: row.device_id,
          flowType: row.flow_type,
          status: 'expired',
          cause,
        },
        'pam-jobs',
      );
    } catch (err) {
      console.error('[PamJobs] event publish failed:', err);
    }
  }
}

/**
 * Flip active elevations whose window has passed to `expired`.
 * Returns the number of rows transitioned. Exported for tests.
 */
export async function enforceElevationExpiry(): Promise<number> {
  const transitioned = await db.execute<TransitionedRow>(sql`
    WITH due AS (
      SELECT id
      FROM ${elevationRequests}
      WHERE ${elevationRequests.status} IN ('approved', 'auto_approved', 'actuating')
        AND ${elevationRequests.expiresAt} IS NOT NULL
        AND ${elevationRequests.expiresAt} < now()
      ORDER BY ${elevationRequests.expiresAt} ASC
      LIMIT ${MAX_PER_RUN}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${elevationRequests} AS e
    SET status = 'expired',
        expired_at = now(),
        updated_at = now()
    FROM due
    WHERE e.id = due.id
      AND e.status IN ('approved', 'auto_approved', 'actuating')
    RETURNING
      e.id,
      e.org_id,
      e.device_id,
      e.flow_type,
      'active'::text AS prior_status;
  `);

  const rows = extractRows(transitioned);
  await emitExpiryEffects(rows, 'window');

  if (rows.length === MAX_PER_RUN) {
    console.warn(`[PamJobs] expiry enforcer hit ${MAX_PER_RUN}-item cap — backlog may be growing`);
  }
  return rows.length;
}

/**
 * Expire pending requests older than the TTL. Returns rows transitioned.
 * Exported for tests.
 */
export async function expireStaleRequests(): Promise<number> {
  const ttlMinutes = Number.isFinite(STALE_PENDING_TTL_MINUTES) && STALE_PENDING_TTL_MINUTES > 0
    ? STALE_PENDING_TTL_MINUTES
    : 15;
  const transitioned = await db.execute<TransitionedRow>(sql`
    WITH due AS (
      SELECT id
      FROM ${elevationRequests}
      WHERE ${elevationRequests.status} = 'pending'
        AND ${elevationRequests.requestedAt} < now() - (${ttlMinutes} * interval '1 minute')
      ORDER BY ${elevationRequests.requestedAt} ASC
      LIMIT ${MAX_PER_RUN}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${elevationRequests} AS e
    SET status = 'expired',
        expired_at = now(),
        updated_at = now()
    FROM due
    WHERE e.id = due.id
      AND e.status = 'pending'
    RETURNING
      e.id,
      e.org_id,
      e.device_id,
      e.flow_type,
      'pending'::text AS prior_status;
  `);

  const rows = extractRows(transitioned);
  await emitExpiryEffects(rows, 'stale');

  if (rows.length === MAX_PER_RUN) {
    console.warn(`[PamJobs] stale expirer hit ${MAX_PER_RUN}-item cap — backlog may be growing`);
  }
  return rows.length;
}

// ============================================================
// BullMQ wiring (mirrors approvalExpiryReaper)
// ============================================================

let enforcerQueue: Queue<PamJobData> | null = null;
let enforcerWorker: Worker<PamJobData> | null = null;
let staleQueue: Queue<PamJobData> | null = null;
let staleWorker: Worker<PamJobData> | null = null;

async function scheduleRepeatable(
  queue: Queue<PamJobData>,
  type: PamJobData['type'],
  everyMs: number,
): Promise<void> {
  await queue.add(
    type,
    { type, queuedAt: new Date().toISOString() },
    {
      jobId: `${type}-repeat`,
      repeat: { every: everyMs },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    },
  );
}

function wireWorkerLogging(worker: Worker<PamJobData>, label: string): void {
  worker.on('error', (error) => {
    console.error(`[PamJobs] ${label} worker error:`, error);
    captureException(error);
  });
  worker.on('failed', (_job, error) => {
    console.error(`[PamJobs] ${label} job failed:`, error);
    captureException(error);
  });
}

export async function initializePamJobs(): Promise<void> {
  if (enforcerWorker || staleWorker) return;

  enforcerWorker = new Worker<PamJobData>(
    ENFORCER_QUEUE,
    async (_job: Job<PamJobData>) => {
      const expired = await runWithSystemDbAccess(enforceElevationExpiry);
      if (expired > 0) {
        console.log(`[PamJobs] Expired ${expired} elevation window(s)`);
      }
      return { expired };
    },
    { connection: getBullMQConnection(), concurrency: 1 },
  );
  wireWorkerLogging(enforcerWorker, 'expiry-enforcer');

  staleWorker = new Worker<PamJobData>(
    STALE_QUEUE,
    async (_job: Job<PamJobData>) => {
      const expired = await runWithSystemDbAccess(expireStaleRequests);
      if (expired > 0) {
        console.log(`[PamJobs] Expired ${expired} stale pending request(s)`);
      }
      return { expired };
    },
    { connection: getBullMQConnection(), concurrency: 1 },
  );
  wireWorkerLogging(staleWorker, 'stale-expirer');

  try {
    enforcerQueue = new Queue<PamJobData>(ENFORCER_QUEUE, { connection: getBullMQConnection() });
    staleQueue = new Queue<PamJobData>(STALE_QUEUE, { connection: getBullMQConnection() });
    await scheduleRepeatable(enforcerQueue, 'enforce-elevation-expiry', ENFORCER_INTERVAL_MS);
    await scheduleRepeatable(staleQueue, 'expire-stale-requests', STALE_INTERVAL_MS);
  } catch (err) {
    await shutdownPamJobs();
    throw err;
  }

  console.log('[PamJobs] Initialized (expiry enforcer 60s, stale expirer 5m)');
}

export async function shutdownPamJobs(): Promise<void> {
  const closers = [enforcerWorker, staleWorker, enforcerQueue, staleQueue];
  enforcerWorker = null;
  staleWorker = null;
  enforcerQueue = null;
  staleQueue = null;
  for (const closable of closers) {
    if (closable) {
      try {
        await closable.close();
      } catch (err) {
        console.error('[PamJobs] close failed:', err);
      }
    }
  }
}
