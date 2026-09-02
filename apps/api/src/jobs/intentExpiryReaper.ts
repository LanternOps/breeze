import { Job, Queue, Worker } from 'bullmq';
import { and, eq, inArray, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { db } from '../db';
import { actionIntents, intentOutbox } from '../db/schema/actionIntents';
import type { ActionIntentSource } from '../db/schema/actionIntents';
import { approvalRequests } from '../db/schema/approvals';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { writeAuditEvent, requestLikeFromSnapshot } from '../services/auditEvents';
import { recordActionIntentEvent, recordActionIntentMetric } from '../services/actionIntents/metrics';
import { REVEAL_WINDOW_DAYS } from '../services/actionIntents/resultSecrets';

/**
 * Reaps `action_intents` rows past their deadline (spec
 * docs/superpowers/specs/ai-mcp/2026-07-18-action-intents-approval-layer-design.md
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
 * 1. `reapExpiredIntents` — `pending_approval`/`approved` intents past their
 *    respective deadline → `expired`. The two statuses no longer share one
 *    deadline column (tier3-supervised-four-eyes design §4.2): `pending_approval`
 *    rows expire on `approval_expires_at` (the decide-by deadline; backfilled
 *    from the legacy `expires_at` for pre-split rows) — falling back to
 *    `expires_at` when `approval_expires_at IS NULL`, since some legacy
 *    writers still leave the column unset.
 *    `approved` rows expire on `release_by` — the fixed lease the approve
 *    fan-in (`routes/approvals.ts`) stamps when it flips the intent to
 *    `approved` — falling back to `expires_at` when `release_by IS NULL`
 *    (rows approved before this deploy, which never got a lease stamped).
 *    Approval does NOT stop the clock: an approved-but-not-yet-released
 *    intent still expires if execution never begins within its lease. This
 *    split matters at the boundary: an intent approved just before
 *    `approval_expires_at` gets a FRESH `release_by` lease starting from the
 *    approval moment, so it must NOT be reaped just because
 *    `approval_expires_at` (a deadline that no longer applies once approved)
 *    has since passed — the "59:59 trap". Linked `approval_requests` rows
 *    still `pending` for that intent are expired in the same pass. Uses
 *    `recordActionIntentEvent(..., outcome: 'expired')` — `expired` is one
 *    of the seven canonical outcomes Task 4's metrics helper models (spec
 *    §7), so both the audit row and the Prometheus counter come from one
 *    call.
 *
 * 2. `reapStaleExecutingIntents` — intents stuck in `executing` with no
 *    `executed_at` for longer than STALE_EXECUTING_TIMEOUT_MINUTES (2x+ the
 *    longest tool timeout, spec §8) → `failed` with `error_code:
 *    'execution_lost'`. Keys off `execution_started_at` (the timestamp the
 *    release worker CASes approved -> executing), COALESCE'd to `decided_at`
 *    for rows that predate the column or were never stamped — approval can
 *    lag execution start, so `decided_at` alone under-counts how long a row
 *    has actually been stuck executing. This does NOT use `recordActionIntentEvent`: its
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
  execution_started_at: Date | string | null;
  decided_at: Date | null;
};

function extractRows<T>(result: unknown): T[] {
  const rows = (result as { rows?: T[] }).rows ?? (result as T[]);
  return Array.isArray(rows) ? rows : [];
}

/**
 * Flips `pending_approval` intents past `approval_expires_at` and `approved`
 * intents past `release_by` (falling back to `expires_at` for legacy rows
 * with no lease stamped) to `expired`, expires their still-`pending` linked
 * approval rows, and writes one `action_intent.expired` audit event per
 * intent. Bounded to MAX_REAP_PER_RUN via a CTE so a backlog spike can't
 * lock the table for too long. Returns the number of intents transitioned.
 */
export async function reapExpiredIntents(): Promise<number> {
  const transitioned = await db.execute<ExpiredIntentRow>(sql`
    WITH due AS (
      SELECT id
      FROM ${actionIntents}
      WHERE (
        ${actionIntents.status} = 'pending_approval'
        AND COALESCE(${actionIntents.approvalExpiresAt}, ${actionIntents.expiresAt}) < now()
      ) OR (
        ${actionIntents.status} = 'approved'
        AND COALESCE(${actionIntents.releaseBy}, ${actionIntents.expiresAt}) < now()
      )
      ORDER BY CASE
        WHEN ${actionIntents.status} = 'pending_approval' THEN COALESCE(${actionIntents.approvalExpiresAt}, ${actionIntents.expiresAt})
        ELSE COALESCE(${actionIntents.releaseBy}, ${actionIntents.expiresAt})
      END ASC
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
  //
  // NOTE ON ERROR HANDLING IN THIS FUNCTION. The whole pass runs inside ONE
  // Postgres transaction (`runWithSystemDbAccess(reapExpiredIntents)` ->
  // withSystemDbAccessContext -> baseDb.transaction). Catching a database error
  // in JS does NOT un-abort that transaction: the backend is left in 25P02,
  // every later statement fails, and the final COMMIT is silently converted to
  // ROLLBACK without raising. So a swallowed failure here does not "carry on
  // without the approval rows" — it discards the intent expiry too, while the
  // caller still returns rows.length and logs "Expired N intents", and the
  // fire-and-forget audit event records an expiry that never committed.
  //
  // Both statements below therefore PROPAGATE. Failing the pass is the honest
  // outcome: nothing commits, the worker logs and reports it, and the next tick
  // retries the same rows. This catch used to swallow, which is why it is
  // called out rather than quietly deleted.
  await db
    .update(approvalRequests)
    .set({ status: 'expired', decidedAt: new Date() })
    .where(and(eq(approvalRequests.status, 'pending'), inArray(approvalRequests.intentId, intentIds)));

  // Record the outcome so the requester can be told. The reaper previously
  // mutated intent and approval rows and wrote an audit event, but no outbox
  // row — so an intent that timed out simply went quiet on the person who asked
  // for it.
  //
  // Atomic with the expiry above, and propagating for the reason in the note:
  // an expiry that commits without its outbox row is an intent nobody is ever
  // told about, and there is no repair path because the reaper will not see
  // those rows again (their status is no longer pending_approval/approved).
  await db.insert(intentOutbox).values(
    rows.map((row) => ({
      intentId: row.id,
      eventType: 'intent_expired' as const,
      // Ids only, matching the approve/deny rows — no argument content.
      payload: { intentId: row.id, orgId: row.org_id },
    })),
  );

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
 * Flips intents stuck in `executing` (no `executed_at`,
 * `COALESCE(execution_started_at, decided_at)` older than
 * STALE_EXECUTING_TIMEOUT_MINUTES) to `failed` with `error_code:
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
        AND COALESCE(${actionIntents.executionStartedAt}, ${actionIntents.decidedAt})
              < now() - (${STALE_EXECUTING_TIMEOUT_MINUTES} * interval '1 minute')
      ORDER BY COALESCE(${actionIntents.executionStartedAt}, ${actionIntents.decidedAt}) ASC
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
      a.execution_started_at,
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
          executionStartedAt:
            row.execution_started_at instanceof Date
              ? row.execution_started_at.toISOString()
              : row.execution_started_at,
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

/**
 * Redact un-revealed reset-password secrets past the reveal window so no
 * ciphertext (or legacy plaintext) outlives REVEAL_WINDOW_DAYS at rest.
 * Counterpart of the reveal endpoint's lazy redaction; count-only logging.
 */
export async function redactExpiredUnrevealedSecrets(): Promise<number> {
  const res = await db.execute<{ id: string }>(sql`
    UPDATE ${actionIntents}
    SET result = (result - 'temporaryPasswordEnc' - 'temporaryPassword')
                 || jsonb_build_object('temporaryPasswordExpired', true)
    WHERE ${actionIntents.status} = 'completed'
      AND ${actionIntents.result} ?| array['temporaryPasswordEnc', 'temporaryPassword']
      AND ${actionIntents.executedAt} < now() - make_interval(days => ${REVEAL_WINDOW_DAYS})
    RETURNING ${actionIntents.id} AS id;
  `);
  const rows = extractRows<{ id: string }>(res);
  if (rows.length > 0) {
    console.log(
      `[IntentExpiryReaper] Redacted ${rows.length} expired un-revealed temp password(s)`,
    );
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
        const secretsRedacted = await runWithSystemDbAccess(redactExpiredUnrevealedSecrets);
        if (expired > 0 || staleFailed > 0) {
          console.log(
            `[IntentExpiryReaper] Expired ${expired} intent(s), failed ${staleFailed} stale-executing intent(s)`,
          );
        }
        return { expired, staleFailed, secretsRedacted };
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
