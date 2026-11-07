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
 *
 * Measured from the latest start attempt, which is creation time until the
 * first one. A session that is renegotiating moves back to `connecting` with an
 * old started_at and created_at, and must not read as stale because of them
 * (#11149). started_at is for the hard deadline only.
 */
export function remoteSessionStaleCondition(now: Date) {
  return or(
    and(
      eq(remoteSessions.status, 'pending'),
      lte(remoteSessions.lastStartAttemptAt, new Date(now.getTime() - REMOTE_SESSION_PENDING_STALE_MS)),
    ),
    and(
      eq(remoteSessions.status, 'connecting'),
      lte(remoteSessions.lastStartAttemptAt, new Date(now.getTime() - REMOTE_SESSION_CONNECTING_STALE_MS)),
    ),
  );
}

/**
 * The `started_at` value for a desktop start or answer: the session's original
 * start if it has one, otherwise `now`.
 *
 * The lease hard deadline (session max duration) is measured from this column,
 * so it must not move once set. A reconnect re-offers on the same row and the
 * agent answers again; restamping here would let a viewer that reconnects
 * periodically hold a session past its maximum (#11113).
 *
 * `now` is bound as an ISO string: a Date inside a raw sql template bypasses the
 * column encoder and fails to bind (#3369).
 */
export function originalRemoteSessionStart(now: Date = new Date()) {
  return sql`COALESCE(${remoteSessions.startedAt}, ${now.toISOString()}::timestamp)`;
}
