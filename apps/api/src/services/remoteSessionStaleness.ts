import { and, eq, lte, or, sql } from 'drizzle-orm';
import { remoteSessions } from '../db/schema';

export const REMOTE_SESSION_PENDING_STALE_MS = 5 * 60 * 1000;
export const REMOTE_SESSION_CONNECTING_STALE_MS = 2 * 60 * 1000;
/**
 * Zombie ceiling for `active` sessions: an active row older than this is
 * considered orphaned. The stale-command reaper ends remote_sessions rows past
 * it. The active-sessions banner also uses it to hide (not end) VNC tunnel
 * rows 24h after creation, since nothing ends those.
 */
export const REMOTE_SESSION_ACTIVE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
      // Measured from the latest start attempt when one recorded its time (a
      // WebSocket-fallback start waits here through its consent prompt),
      // otherwise from creation. started_at is never earlier than created_at,
      // so this can only keep a row longer, never expire one sooner.
      // The cutoff is bound as an ISO string: a Date inside a raw sql
      // template bypasses the column encoder and fails to bind (#3369).
      sql`COALESCE(${remoteSessions.startedAt}, ${remoteSessions.createdAt}) <= ${new Date(now.getTime() - REMOTE_SESSION_CONNECTING_STALE_MS).toISOString()}::timestamp`,
    ),
  );
}
