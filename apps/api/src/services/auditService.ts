import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { auditLogs } from '../db/schema';
import { captureException } from './sentry';

export type InitiatedByType = 'manual' | 'ai' | 'automation' | 'policy' | 'schedule' | 'agent' | 'integration';

export interface CreateAuditLogParams {
  orgId?: string | null;
  actorType?: 'user' | 'api_key' | 'agent' | 'system';
  actorId: string;
  actorEmail?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  resourceName?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  result: 'success' | 'failure' | 'denied';
  errorMessage?: string;
  initiatedBy?: InitiatedByType;
}

/**
 * Bounded in-memory retry queue for audit writes that hit a transient DB
 * failure. This is intentionally simple — production-grade durability would
 * use Redis or a persistent queue, but in-process retry + Sentry-capture on
 * exhaustion is enough to prevent the silent-drop class of bugs the original
 * fire-and-forget design allowed (an action happens but the audit row never
 * lands and nobody notices).
 *
 * Each retry attempts an exponential backoff: 5s, 10s, 20s, ... A periodic
 * timer in `apps/api/src/index.ts` drains the queue every 30s, and SIGTERM
 * does a best-effort final drain bounded by a hard timeout.
 */
interface RetryQueueItem {
  entry: CreateAuditLogParams;
  attempts: number;
  nextAt: number;
}

const RETRY_QUEUE: RetryQueueItem[] = [];
const MAX_QUEUE = 10_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 5_000;

/**
 * Persist a single audit log row. Runs OUTSIDE the caller's request
 * transaction (see comment block below) and throws on failure so callers can
 * decide how to react (synchronous `createAuditLog` propagates, async
 * `createAuditLogAsync` queues for retry).
 */
async function persistAuditLog(params: CreateAuditLogParams): Promise<void> {
  // Audit writes must run on a connection OUTSIDE the caller's request
  // transaction. Two reasons:
  //   1. System-scope semantics. Audits are written from both pre-auth paths
  //      (no tx yet) and authenticated handlers where the caller's scope
  //      can't insert rows with NULL or cross-org org_id under RLS. The
  //      previous `withSystemDbAccessContext` call was a no-op when already
  //      inside a tx (see `withDbAccessContext`'s short-circuit), leaving
  //      the insert running under the caller's scope and failing the
  //      `audit_logs` insert policy for partner-scope callers with a
  //      NULL-org audit row.
  //   2. Tx isolation. A failed audit insert inside the request tx aborts
  //      the whole transaction in Postgres, silently rolling back the
  //      caller's real work (e.g. password change) even though the route
  //      returned 200 — because `createAuditLogAsync` swallows the error.
  //
  // `runOutsideDbContext` exits the AsyncLocalStorage so the nested
  // `withSystemDbAccessContext` actually opens a fresh system-scope
  // transaction on its own pooled connection.
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const { actorType = 'user', ...rest } = params;
      await db.insert(auditLogs).values({ actorType, ...rest });
    })
  );
}

/**
 * Synchronous-await variant: rejects on DB failure. Used by paths that need
 * to know the audit row landed (e.g. critical security events the caller
 * wants to surface).
 */
export async function createAuditLog(params: CreateAuditLogParams): Promise<void> {
  return persistAuditLog(params);
}

/**
 * Fire-and-forget variant. Caller does not need to `await` (existing
 * call sites don't). On failure, the entry is pushed to a bounded in-memory
 * retry queue and a background drain re-attempts with exponential backoff.
 * After MAX_ATTEMPTS exhausted, the failure is reported to Sentry and
 * dropped.
 *
 * Returning Promise<void> lets tests `await` to deterministically observe
 * the first-attempt outcome — but the return is intentionally never a
 * rejection: this function never throws back to its caller.
 */
export async function createAuditLogAsync(params: CreateAuditLogParams): Promise<void> {
  try {
    await persistAuditLog(params);
  } catch (err) {
    enqueueForRetry(params, err);
  }
}

function enqueueForRetry(entry: CreateAuditLogParams, err: unknown): void {
  if (RETRY_QUEUE.length >= MAX_QUEUE) {
    // Queue full — drop now and Sentry-capture so the failure is visible.
    // We don't await retries inline because that would let a backpressured
    // DB stall every caller.
    captureException(err);
    if (process.env.NODE_ENV !== 'test') {
      console.error(
        '[audit] retry queue full, dropping entry:',
        { action: entry.action, resourceType: entry.resourceType }
      );
    }
    return;
  }

  RETRY_QUEUE.push({
    entry,
    attempts: 1,
    nextAt: Date.now() + BASE_BACKOFF_MS,
  });
  if (process.env.NODE_ENV !== 'test') {
    console.error('[audit] write failed, queued for retry:', err);
  }
}

/**
 * Drains the retry queue. Items whose `nextAt` is in the future are skipped
 * (backoff still in effect). Items that exhaust MAX_ATTEMPTS are removed
 * from the queue and reported to Sentry — at that point the audit row is
 * permanently lost and we want operator visibility.
 *
 * The `nowMs` opt is for tests so they can force-drain without juggling
 * fake timers.
 */
export async function drainAuditRetryQueue(
  opts: { nowMs?: number } = {}
): Promise<{ attempted: number; successful: number; dropped: number }> {
  const now = opts.nowMs ?? Date.now();
  const stats = { attempted: 0, successful: 0, dropped: 0 };

  // Walk backwards so splice() in-place doesn't break the index.
  for (let i = RETRY_QUEUE.length - 1; i >= 0; i--) {
    const item = RETRY_QUEUE[i];
    if (!item || item.nextAt > now) continue;

    stats.attempted++;
    try {
      await persistAuditLog(item.entry);
      RETRY_QUEUE.splice(i, 1);
      stats.successful++;
    } catch (err) {
      item.attempts++;
      if (item.attempts >= MAX_ATTEMPTS) {
        RETRY_QUEUE.splice(i, 1);
        stats.dropped++;
        captureException(err);
        if (process.env.NODE_ENV !== 'test') {
          console.error(
            '[audit] retry exhausted, dropping entry:',
            { action: item.entry.action, attempts: item.attempts, err }
          );
        }
      } else {
        item.nextAt = now + BASE_BACKOFF_MS * 2 ** item.attempts;
      }
    }
  }

  return stats;
}

/** Test-only: clear the retry queue between tests. */
export function _resetRetryQueueForTest(): void {
  RETRY_QUEUE.length = 0;
}

/** Test-only / health-check: current queue depth. */
export function getAuditRetryQueueDepth(): number {
  return RETRY_QUEUE.length;
}
