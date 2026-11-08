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
import { and, eq } from 'drizzle-orm';
import { db, runAfterDbContextCommit } from '../db';
import { aiSessions } from '../db/schema';
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
 * Lazy expiry in the caller's DB context: when an active session is over, stamp
 * it 'expired' and schedule its summary finalize. Returns why, or null when the
 * session is live (or not active: nothing to retire).
 */
export async function expireIfStale(
  session: { id: string; status: string; createdAt: Instant; lastActivityAt: Instant },
  now: number = Date.now(),
): Promise<SessionExpiryReason | null> {
  if (session.status !== 'active') return null;
  const reason = sessionExpiryReason(session, now);
  if (!reason) return null;
  await db.update(aiSessions)
    .set({ status: 'expired', updatedAt: new Date(now) })
    .where(and(eq(aiSessions.id, session.id), eq(aiSessions.status, 'active')));
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
