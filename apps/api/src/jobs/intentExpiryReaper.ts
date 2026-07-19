import { Job, Queue, Worker } from 'bullmq';
import { and, eq, inArray, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { db } from '../db';
import { actionIntents } from '../db/schema/actionIntents';
import type { ActionIntentSource } from '../db/schema/actionIntents';
import { approvalRequests } from '../db/schema/approvals';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { writeAuditEvent, requestLikeFromSnapshot } from '../services/auditEvents';
import { recordActionIntentEvent, recordActionIntentMetric } from '../services/actionIntents/metrics';

/**
 * Reaps `action_intents` rows past their deadline (spec
 * docs/superpowers/specs/2026-07-18-action-intents-approval-layer-design.md
 * §3.4 + §8). Kept as a sibling of `approvalExpiryReaper.ts` rather than an
 * extension of it: that file's whole shape (queue name, job data type, audit
 * action string, and its `ai_tool_executions` mirror step) is specific to
 * `approval_requests`. This sweep operates on a different table
 * (`action_intents`) with two independent CAS transitions, so folding it in
 * would roughly double that file's size while blurring two distinct
 * concerns — same "split when it improves clarity" guidance CLAUDE.md gives
 * for route/service files.
 *
 * Two sweeps run every pass:
 *
 * 1. `reapExpiredIntents` — `pending_approval`/`approved` intents whose
 *    `expires_at` has passed → `expired`. Approval does NOT stop the clock:
 *    an approved-but-not-yet-released intent still expires if execution
 *    never begins in time. Linked `approval_requests` rows still `pending`
 *    for that intent are expired in the same pass. Uses
 *    `recordActionIntentEvent(..., outcome: 'expired')` — `expired` is one
 *    of the seven canonical outcomes Task 4's metrics helper models (spec
 *    §7), so both the audit row and the Prometheus counter come from one
 *    call.
 *
 * 2. `reapStaleExecutingIntents` — intents stuck in `executing` with no
 *    `executed_at` for longer than STALE_EXECUTING_TIMEOUT_MINUTES (2x+ the
 *    longest tool timeout, spec §8) → `failed` with `error_code:
 *    'execution_lost'`. This does NOT use `recordActionIntentEvent`: its
 *    `outcome` enum only treats `rejected`/`expired`/`cancelled` as audit
 *    failures (see metrics.ts's `FAILURE_OUTCOMES`), so recording outcome
 *    `'executed'` would mis-file this as `result: 'success'`. Instead this
 *    writes the audit row directly (`action_intent.executed`, `result:
 *    'failure'`) — the exact fallback CLAUDE.md/the task brief calls for
 *    when an outcome doesn't fit the enum — and bumps the Prometheus counter
 *    separately via `recordActionIntentMetric` so `executed` totals still
 *    include this path.
 *
 * Runs every 30 seconds (mirrors approvalExpiryReaper's cadence) inside
 * `withSystemDbAccessContext` — action_intents is org-scoped RLS (shape 1),
 * but expiry/stale-execution reaping is a system job.
 */

const QUEUE_NAME = 'intent-expiry-reaper';
const REAP_INTERVAL_MS = 30 * 1000; // every 30s
const MAX_REAP_PER_RUN = 500;
// >= 2x the longest tool execution timeout (spec §8) — comfortably beyond any
// legitimate in-flight execution, so a still-`executing` row this old means
// the release worker died mid-flight, not that the tool is merely slow.
const STALE_EXECUTING_TIMEOUT_MINUTES = 20;

type ReaperJobData = { type: 'reap-expired-intents'; queuedAt: string };

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') {
    throw new Error(
      '[IntentExpiryReaper] withSystemDbAccessContext not available — reaper cannot run without system DB access',
    );
  }
  return withSystem(fn);
};

let reaperQueue: Queue<ReaperJobData> | null = null;
let reaperWorker: Worker<ReaperJobData> | null = null;

function getQueue(): Queue<ReaperJobData> {
  if (!reaperQueue) {
    reaperQueue = new Queue<ReaperJobData>(QUEUE_NAME, {
      connection: getBullMQConnection(),
    });
  }
  return reaperQueue;
}

// `type` (not `interface`) so TS's implicit index signature for object type
// literals applies — `db.execute<T>`'s constraint is `Record<string,
// unknown>`, which a plain `interface` declaration does not structurally
// satisfy without an explicit `[key: string]: unknown` member (TS2344).
type ExpiredIntentRow = {
  id: string;
  org_id: string;
  action_name: string;
  argument_digest: string;
  source: string;
  requested_by_user_id: string | null;
  expires_at: Date;
};

type StaleExecutingIntentRow = {
  id: string;
  org_id: string;
  action_name: string;
  argument_digest: string;
  source: string;
  decided_at: Date | null;
};

function extractRows<T>(result: unknown): T[] {
  const rows = (result as { rows?: T[] }).rows ?? (result as T[]);
  return Array.isArray(rows) ? rows : [];
}

/**
 * Flips `pending_approval`/`approved` intents whose `expires_at` is in the
 * past to `expired`, expires their still-`pending` linked approval rows, and
 * writes one `action_intent.expired` audit event per intent. Bounded to
 * MAX_REAP_PER_RUN via a CTE so a backlog spike can't lock the table for
 * too long. Returns the number of intents transitioned.
 */
export async function reapExpiredIntents(): Promise<number> {
  const transitioned = await db.execute<ExpiredIntentRow>(sql`
    WITH due AS (
      SELECT id
      FROM ${actionIntents}
      WHERE ${actionIntents.status} IN ('pending_approval', 'approved')
        AND ${actionIntents.expiresAt} < now()
      ORDER BY ${actionIntents.expiresAt} ASC
      LIMIT ${MAX_REAP_PER_RUN}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${actionIntents} AS a
    SET status = 'expired'
    FROM due
    WHERE a.id = due.id
      AND a.status IN ('pending_approval', 'approved')
    RETURNING
      a.id,
      a.org_id,
      a.action_name,
      a.argument_digest,
      a.source,
      a.requested_by_user_id,
      a.expires_at;
  `);

  const rows = extractRows<ExpiredIntentRow>(transitioned);
  if (rows.length === 0) {
    return 0;
  }

  const intentIds = rows.map((r) => r.id);

  // Expire any still-pending approval rows fanned out for these intents —
  // approval does not stop the clock, so an approved intent can still have
  // sibling rows sitting `pending` when it times out.
  try {
    await db
      .update(approvalRequests)
      .set({ status: 'expired', decidedAt: new Date() })
      .where(and(eq(approvalRequests.status, 'pending'), inArray(approvalRequests.intentId, intentIds)));
  } catch (err) {
    console.error('[IntentExpiryReaper] Failed to expire linked approval_requests:', err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }

  for (const row of rows) {
    try {
      recordActionIntentEvent({
        orgId: row.org_id,
        intentId: row.id,
        actionName: row.action_name,
        argumentDigest: row.argument_digest,
        source: row.source as ActionIntentSource,
        outcome: 'expired',
        details: {
          requestedByUserId: row.requested_by_user_id,
          expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
        },
      });
    } catch (err) {
      console.error('[IntentExpiryReaper] Failed to write audit event:', err);
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }

  if (rows.length === MAX_REAP_PER_RUN) {
    console.warn(`[IntentExpiryReaper] Hit ${MAX_REAP_PER_RUN}-item cap — backlog may be growing`);
  }

  return rows.length;
}

/**
 * Flips intents stuck in `executing` (no `executed_at`, `decided_at` older
 * than STALE_EXECUTING_TIMEOUT_MINUTES) to `failed` with `error_code:
 * 'execution_lost'`. Writes an `action_intent.executed` audit event with
 * `result: 'failure'` directly (see file header for why this bypasses
 * `recordActionIntentEvent`). Returns the number of intents transitioned.
 */
export async function reapStaleExecutingIntents(): Promise<number> {
  const transitioned = await db.execute<StaleExecutingIntentRow>(sql`
    WITH due AS (
      SELECT id
      FROM ${actionIntents}
      WHERE ${actionIntents.status} = 'executing'
        AND ${actionIntents.executedAt} IS NULL
        AND ${actionIntents.decidedAt} < now() - (${STALE_EXECUTING_TIMEOUT_MINUTES} * interval '1 minute')
      ORDER BY ${actionIntents.decidedAt} ASC
      LIMIT ${MAX_REAP_PER_RUN}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${actionIntents} AS a
    SET status = 'failed',
        error_code = 'execution_lost'
    FROM due
    WHERE a.id = due.id
      AND a.status = 'executing'
      AND a.executed_at IS NULL
    RETURNING
      a.id,
      a.org_id,
      a.action_name,
      a.argument_digest,
      a.source,
      a.decided_at;
  `);

  const rows = extractRows<StaleExecutingIntentRow>(transitioned);
  if (rows.length === 0) {
    return 0;
  }

  const requestLike = requestLikeFromSnapshot({});
  for (const row of rows) {
    try {
      writeAuditEvent(requestLike, {
        orgId: row.org_id,
        action: 'action_intent.executed',
        resourceType: 'action_intent',
        resourceId: row.id,
        actorType: 'system',
        actorId: null,
        result: 'failure',
        details: {
          actionName: row.action_name,
          argumentDigest: row.argument_digest,
          source: row.source,
          errorCode: 'execution_lost',
          decidedAt: row.decided_at instanceof Date ? row.decided_at.toISOString() : row.decided_at,
          staleExecutingTimeoutMinutes: STALE_EXECUTING_TIMEOUT_MINUTES,
        },
      });
      recordActionIntentMetric(row.source as ActionIntentSource, row.action_name, 'executed');
    } catch (err) {
      console.error('[IntentExpiryReaper] Failed to write stale-executing audit event:', err);
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }

  if (rows.length === MAX_REAP_PER_RUN) {
    console.warn(`[IntentExpiryReaper] Hit ${MAX_REAP_PER_RUN}-item cap on stale-executing sweep — backlog may be growing`);
  }

  return rows.length;
}

function createWorker(): Worker<ReaperJobData> {
  return new Worker<ReaperJobData>(
    QUEUE_NAME,
    async (_job: Job<ReaperJobData>) => {
      try {
        const expired = await runWithSystemDbAccess(reapExpiredIntents);
        const staleFailed = await runWithSystemDbAccess(reapStaleExecutingIntents);
        if (expired > 0 || staleFailed > 0) {
          console.log(
            `[IntentExpiryReaper] Expired ${expired} intent(s), failed ${staleFailed} stale-executing intent(s)`,
          );
        }
        return { expired, staleFailed };
      } catch (err) {
        console.error('[IntentExpiryReaper] Run failed:', err);
        captureException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1,
    },
  );
}

async function scheduleRepeatableJob(): Promise<void> {
  const queue = getQueue();

  const repeatables = await queue.getRepeatableJobs();
  for (const job of repeatables) {
    if (job.name === 'reap-expired-intents') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    'reap-expired-intents',
    { type: 'reap-expired-intents', queuedAt: new Date().toISOString() },
    {
      jobId: 'intent-expiry-reaper',
      repeat: { every: REAP_INTERVAL_MS },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    },
  );
}

export async function initializeIntentExpiryReaper(): Promise<void> {
  if (reaperWorker) return;

  reaperWorker = createWorker();
  reaperWorker.on('error', (error) => {
    console.error('[IntentExpiryReaper] Worker error:', error);
    captureException(error);
  });
  reaperWorker.on('failed', (job, error) => {
    console.error(`[IntentExpiryReaper] Job ${job?.id} failed:`, error);
    captureException(error);
  });

  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await reaperWorker.close();
    reaperWorker = null;
    throw err;
  }

  console.log('[IntentExpiryReaper] Initialized');
}

export async function shutdownIntentExpiryReaper(): Promise<void> {
  const worker = reaperWorker;
  const queue = reaperQueue;
  reaperWorker = null;
  reaperQueue = null;

  if (worker) {
    try {
      await worker.close();
    } catch (err) {
      console.error('[IntentExpiryReaper] Error closing worker:', err);
    }
  }
  if (queue) {
    try {
      await queue.close();
    } catch (err) {
      console.error('[IntentExpiryReaper] Error closing queue:', err);
    }
  }
}
