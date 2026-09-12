import { and, eq, lte, or } from 'drizzle-orm';
import { remoteSessions } from '../db/schema';

export const REMOTE_SESSION_PENDING_STALE_MS = 5 * 60 * 1000;
export const REMOTE_SESSION_CONNECTING_STALE_MS = 2 * 60 * 1000;

/**
 * Rows that failed before reaching an active remote session.
 *
 * `active` deliberately has no time-only stale definition: it is kept alive by
 * the exact WebSocket/session ownership protocols and must be ended by an
 * explicit lifecycle operation, not by this age-based cleanup predicate.
 */
export function remoteSessionStaleCondition(now: Date) {
  return or(
    and(
      eq(remoteSessions.status, 'pending'),
      lte(remoteSessions.createdAt, new Date(now.getTime() - REMOTE_SESSION_PENDING_STALE_MS)),
    ),
    and(
      eq(remoteSessions.status, 'connecting'),
      lte(remoteSessions.createdAt, new Date(now.getTime() - REMOTE_SESSION_CONNECTING_STALE_MS)),
    ),
  );
}
