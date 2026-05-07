import { Job, Queue, Worker } from 'bullmq';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { db } from '../db';
import { approvalRequests } from '../db/schema/approvals';
import { aiToolExecutions } from '../db/schema/ai';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { writeAuditEvent, requestLikeFromSnapshot } from '../services/auditEvents';

/**
 * Reaps `approval_requests` rows whose `expires_at` is in the past while still
 * `status='pending'`, flipping them to `expired`. Mirrors the deny-path
 * behavior for any linked `ai_tool_executions` row so the AI Agent SDK's
 * `waitForApproval` poll resolves promptly instead of waiting the full 5-minute
 * ceiling.
 *
 * Runs every 30 seconds. Stays inside `withSystemDbAccessContext` to satisfy
 * RLS — `approval_requests` is user-scoped, but expiry reaping is a system job.
 */

const QUEUE_NAME = 'approval-expiry-reaper';
const REAP_INTERVAL_MS = 30 * 1000; // every 30s
const MAX_REAP_PER_RUN = 500;

type ReaperJobData = { type: 'reap-expired-approvals'; queuedAt: string };

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') {
    throw new Error(
      '[ApprovalExpiryReaper] withSystemDbAccessContext not available — reaper cannot run without system DB access',
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

/**
 * Single pass: flip pending+expired approvals to `expired`, mirror linked
 * ai_tool_executions to `rejected`, and write an audit row per transition.
 *
 * Returns the number of approval rows transitioned.
 */
export async function reapExpiredApprovals(): Promise<number> {
  // Single SQL update — atomic per row, returns rows we transitioned so we can
  // mirror to ai_tool_executions and emit audit. We bound it to MAX_REAP_PER_RUN
  // via a CTE so that a backlog spike can't lock the table for too long.
  const transitioned = await db.execute<{
    id: string;
    user_id: string;
    execution_id: string | null;
    action_label: string;
    action_tool_name: string;
    risk_tier: string;
    requesting_client_label: string;
    expires_at: Date;
  }>(sql`
    WITH due AS (
      SELECT id
      FROM ${approvalRequests}
      WHERE ${approvalRequests.status} = 'pending'
        AND ${approvalRequests.expiresAt} < now()
      ORDER BY ${approvalRequests.expiresAt} ASC
      LIMIT ${MAX_REAP_PER_RUN}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${approvalRequests} AS a
    SET status = 'expired',
        decided_at = now()
    FROM due
    WHERE a.id = due.id
      AND a.status = 'pending'
    RETURNING
      a.id,
      a.user_id,
      a.execution_id,
      a.action_label,
      a.action_tool_name,
      a.risk_tier,
      a.requesting_client_label,
      a.expires_at;
  `);

  const rows = (transitioned as unknown as { rows?: Array<{
    id: string;
    user_id: string;
    execution_id: string | null;
    action_label: string;
    action_tool_name: string;
    risk_tier: string;
    requesting_client_label: string;
    expires_at: Date;
  }> }).rows ?? (transitioned as unknown as Array<{
    id: string;
    user_id: string;
    execution_id: string | null;
    action_label: string;
    action_tool_name: string;
    risk_tier: string;
    requesting_client_label: string;
    expires_at: Date;
  }>);

  if (!Array.isArray(rows) || rows.length === 0) {
    return 0;
  }

  // Mirror linked ai_tool_executions in a single UPDATE ... WHERE id IN (...)
  // for the rows that actually had an execution_id. Mirror failures should not
  // mask the user-facing transition: best-effort, log and continue.
  const executionIds = rows
    .map((r) => r.execution_id)
    .filter((v): v is string => typeof v === 'string' && v.length > 0);

  if (executionIds.length > 0) {
    try {
      await db
        .update(aiToolExecutions)
        .set({
          status: 'rejected',
          completedAt: new Date(),
          errorMessage: 'Approval request expired',
        })
        .where(
          and(
            inArray(aiToolExecutions.id, executionIds),
            eq(aiToolExecutions.status, 'pending'),
          ),
        );
    } catch (err) {
      console.error(
        '[ApprovalExpiryReaper] Failed to mirror status to ai_tool_executions:',
        err,
      );
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // Audit log: one row per transitioned approval. The audit helper expects a
  // RequestLike; we synthesize one with no IP/UA since this is a system job.
  const requestLike = requestLikeFromSnapshot({});
  for (const row of rows) {
    try {
      writeAuditEvent(requestLike, {
        orgId: null,
        action: 'security.approval.expired',
        resourceType: 'approval_request',
        resourceId: row.id,
        resourceName: row.action_label,
        actorType: 'system',
        actorId: null,
        result: 'success',
        details: {
          userId: row.user_id,
          actionToolName: row.action_tool_name,
          riskTier: row.risk_tier,
          requestingClientLabel: row.requesting_client_label,
          executionId: row.execution_id,
          expiresAt: row.expires_at instanceof Date
            ? row.expires_at.toISOString()
            : row.expires_at,
        },
      });
    } catch (err) {
      // Audit is best-effort — never block a transition on the audit write.
      console.error('[ApprovalExpiryReaper] Failed to write audit event:', err);
    }
  }

  if (rows.length === MAX_REAP_PER_RUN) {
    console.warn(
      `[ApprovalExpiryReaper] Hit ${MAX_REAP_PER_RUN}-item cap — backlog may be growing`,
    );
  }

  return rows.length;
}

function createWorker(): Worker<ReaperJobData> {
  return new Worker<ReaperJobData>(
    QUEUE_NAME,
    async (_job: Job<ReaperJobData>) => {
      try {
        const reaped = await runWithSystemDbAccess(reapExpiredApprovals);
        if (reaped > 0) {
          console.log(`[ApprovalExpiryReaper] Expired ${reaped} approval(s)`);
        }
        return { reaped };
      } catch (err) {
        console.error('[ApprovalExpiryReaper] Run failed:', err);
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

  // Remove any existing repeatable jobs (in case interval changed).
  const repeatables = await queue.getRepeatableJobs();
  for (const job of repeatables) {
    if (job.name === 'reap-expired-approvals') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    'reap-expired-approvals',
    { type: 'reap-expired-approvals', queuedAt: new Date().toISOString() },
    {
      jobId: 'approval-expiry-reaper',
      repeat: { every: REAP_INTERVAL_MS },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    },
  );
}

export async function initializeApprovalExpiryReaper(): Promise<void> {
  if (reaperWorker) return;

  reaperWorker = createWorker();
  reaperWorker.on('error', (error) => {
    console.error('[ApprovalExpiryReaper] Worker error:', error);
    captureException(error);
  });
  reaperWorker.on('failed', (job, error) => {
    console.error(`[ApprovalExpiryReaper] Job ${job?.id} failed:`, error);
    captureException(error);
  });

  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await reaperWorker.close();
    reaperWorker = null;
    throw err;
  }

  console.log('[ApprovalExpiryReaper] Initialized');
}

export async function shutdownApprovalExpiryReaper(): Promise<void> {
  const worker = reaperWorker;
  const queue = reaperQueue;
  reaperWorker = null;
  reaperQueue = null;

  if (worker) {
    try {
      await worker.close();
    } catch (err) {
      console.error('[ApprovalExpiryReaper] Error closing worker:', err);
    }
  }
  if (queue) {
    try {
      await queue.close();
    } catch (err) {
      console.error('[ApprovalExpiryReaper] Error closing queue:', err);
    }
  }
}
