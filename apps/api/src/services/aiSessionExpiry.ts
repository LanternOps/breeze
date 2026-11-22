/**
 * #11430 — the one rule for when an AI chat session is over, and what retiring
 * one does. Shared by the send pre-flight (aiAgentSdk.ts), `GET /ai/sessions/:id`
 * (routes/ai.ts), the in-memory eviction (streamingSessionManager.ts) and the
 * 15-minute idle sweep (jobs/aiChatSessionExpirySweep.ts), so the read a client
 * resumes from can never call a session 'active' that the next send refuses.
 *
 * Retiring a session stamps `status = 'expired'` (guarded on `status = 'active'`
 * so a session the user closed is never re-stamped) and recomputes its Wisp
 * thread summary once the write has committed.
 */
import { AI_APPROVAL_TIMEOUT_MAX_MINUTES } from '@breeze/shared/validators';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { db, runAfterDbContextCommit } from '../db';
import { aiBudgetReservations, aiSessions } from '../db/schema';
import { isChatSessionType } from './aiChatSessionTypes';
import { SESSION_IDLE_TIMEOUT_MS, SESSION_MAX_AGE_MS } from './aiAgentSessionLimits';
import { captureException } from './sentry';

export type SessionExpiryReason = 'max_age' | 'idle';

type Instant = Date | string | number;

const SESSION_EXPIRED_ERRORS: Record<SessionExpiryReason, string> = {
  // Both contain "expired": routes/ai.ts maps that word to 410.
  max_age: 'Session has expired (24h max age). Please start a new session.',
  idle: 'Session has expired due to inactivity. Please start a new session.',
};

function epochMs(value: Instant): number {
  return value instanceof Date ? value.getTime() : typeof value === 'number' ? value : new Date(value).getTime();
}

/**
 * Why a session is over, or null while it is live: past the 24 h cap first,
 * then idle past the eviction window. An unreadable timestamp never expires a
 * session on its own.
 */
export function sessionExpiryReason(
  session: { createdAt: Instant; lastActivityAt: Instant },
  now: number = Date.now(),
): SessionExpiryReason | null {
  if (now - epochMs(session.createdAt) > SESSION_MAX_AGE_MS) return 'max_age';
  if (now - epochMs(session.lastActivityAt) > SESSION_IDLE_TIMEOUT_MS) return 'idle';
  return null;
}

/** The same rule as instants, for SQL: a session created before `createdBefore` or last active before `idleBefore` is over. */
export function sessionExpiryCutoffs(now: number = Date.now()): { createdBefore: Date; idleBefore: Date } {
  return { createdBefore: new Date(now - SESSION_MAX_AGE_MS), idleBefore: new Date(now - SESSION_IDLE_TIMEOUT_MS) };
}

/** The send's refusal for an expired session (routes map it to 410). */
export function sessionExpiredError(reason: SessionExpiryReason): string {
  return SESSION_EXPIRED_ERRORS[reason];
}

/**
 * The session types this rule retires outside a send: technician chat
 * conversations. Helper sessions (no user) keep their own 24 h rule
 * (routes/helper), and MCP / agent / client-AI rows are ledgers with other
 * lifecycles. The idle sweep's SQL mirrors this predicate.
 */
export function isExpirableChatSession(session: { type?: unknown; userId?: unknown }): boolean {
  return isChatSessionType(session.type) && typeof session.userId === 'string';
}

/**
 * Wisp W04 Task 5: recompute the thread summary of a session just stamped
 * 'expired'. Deferred until the surrounding DB context commits, lazily
 * imported, best effort: a failure goes to Sentry and never reaches the caller.
 */
export function scheduleWispSummaryFinalize(sessionId: string): void {
  runAfterDbContextCommit('wisp.finalizeThreadSummary', () =>
    import('./wisp/threadSummary')
      .then((m) => m.finalizeWispSessionSummary(sessionId))
      .catch((err) => {
        console.error(`[AiSessionExpiry] Wisp thread summary finalize failed for expired session ${sessionId}:`, err);
        captureException(err);
      }),
  );
}

/**
 * The longest a chat turn can run: `turnTimeoutMsFor` (streamingSessionManager.ts)
 * at the largest approval wait an org may configure. A drift test there pins it.
 */
export const LONGEST_TURN_MS = AI_APPROVAL_TIMEOUT_MAX_MINUTES * 60_000 + 60_000;

/**
 * SQL: no turn of this `ai_sessions` row may still be running.
 * `last_activity_at` only moves when a turn settles, so a turn admitted just
 * inside the idle window (or the 24 h cap) can cross it mid-stream.
 *
 * Every turn reserves budget at admission and settles the reservation at the
 * end, so an unsettled reservation admitted within LONGEST_TURN_MS is the
 * cross-process "turn in flight" signal. That covers one still `active`, and
 * one the reservation sweep relabelled `expired` / `active_ttl` because a long
 * approval wait outlived its 30-minute TTL. A deferred settlement
 * (`pending_settlement`) belongs to a finished turn. Past LONGEST_TURN_MS no
 * turn can still be running, so a reservation stranded by a crash stops
 * protecting the row. Uses ai_budget_reservations_session_turn_idx
 * (org_id, session_id, created_at).
 */
export function noTurnInFlight(): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${aiBudgetReservations}
    WHERE ${aiBudgetReservations.orgId} = ${aiSessions.orgId}
      AND ${aiBudgetReservations.sessionId} = ${aiSessions.id}
      AND ${aiBudgetReservations.createdAt} > now() - make_interval(secs => ${LONGEST_TURN_MS / 1000})
      AND ${aiBudgetReservations.pendingSettlement} IS NULL
      AND (${aiBudgetReservations.status} = 'active'
        OR (${aiBudgetReservations.status} = 'expired' AND ${aiBudgetReservations.expiryReason} = 'active_ttl'))
  )`;
}

/**
 * Lazy expiry in the caller's DB context: when an active session is over, stamp
 * it 'expired' and schedule its summary finalize. Returns why, or null when the
 * session is live (or not active: nothing to retire).
 *
 * `unlessTurnInFlight` is for the out-of-band callers (the session read): the
 * stamp also requires `noTurnInFlight()`, and the result is null unless this
 * call is the one that flipped the row. The send pre-flight omits it — a new
 * send past the limits is refused either way, exactly as before #11430.
 */
export async function expireIfStale(
  session: { id: string; status: string; createdAt: Instant; lastActivityAt: Instant },
  now: number = Date.now(),
  opts: { unlessTurnInFlight?: boolean } = {},
): Promise<SessionExpiryReason | null> {
  if (session.status !== 'active') return null;
  const reason = sessionExpiryReason(session, now);
  if (!reason) return null;
  const guard = and(eq(aiSessions.id, session.id), eq(aiSessions.status, 'active'));
  if (opts.unlessTurnInFlight) {
    const flipped = await db.update(aiSessions)
      .set({ status: 'expired', updatedAt: new Date(now) })
      .where(and(guard, noTurnInFlight()))
      .returning({ id: aiSessions.id });
    if (flipped.length === 0) return null;
  } else {
    await db.update(aiSessions)
      .set({ status: 'expired', updatedAt: new Date(now) })
      .where(guard);
  }
  scheduleWispSummaryFinalize(session.id);
  return reason;
}

const WISP_SUMMARY_FINALIZE_CONCURRENCY = 4;

/**
 * Wisp W04 Task 5: recompute the thread summary of each session just retired,
 * for callers that run outside any DB context once their write has committed
 * (the eviction timer, the idle sweep). Lazy import keeps wisp code out of the
 * callers' eager graphs. Never rejects: failures go to Sentry only.
 *
 * #10390: finalizing can include a model call of up to a minute, so sessions run
 * a few at a time rather than one by one: one session's slow call must not hold
 * back the digest another thread's next chat is seeded with.
 */
export async function finalizeWispSummaries(sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return;
  try {
    const { finalizeWispSessionSummary } = await import('./wisp/threadSummary');
    for (let i = 0; i < sessionIds.length; i += WISP_SUMMARY_FINALIZE_CONCURRENCY) {
      await Promise.all(sessionIds.slice(i, i + WISP_SUMMARY_FINALIZE_CONCURRENCY).map((id) =>
        finalizeWispSessionSummary(id).catch((err) => {
          console.error(`[AiSessionExpiry] Wisp thread summary finalize failed for expired session ${id}:`, err);
          captureException(err);
        })));
    }
  } catch (err) {
    console.error(`[AiSessionExpiry] Wisp thread summary finalize failed for ${sessionIds.length} session(s) (${sessionIds.join(', ')}):`, err);
    captureException(err);
  }
}
