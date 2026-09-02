/**
 * OpenAI-compatible session manager.
 *
 * Manages lightweight in-memory sessions for the openai-compatible LLM path.
 * Unlike StreamingSessionManager (Anthropic), there is no long-lived SDK subprocess.
 * Each turn is an independent HTTP call triggered by startTurn(); the session stays
 * in memory between turns purely for eventBus pub/sub and TTL eviction state.
 *
 * Why no `finally { this.remove() }` like streamingSessionManager:
 * The Anthropic `runBackgroundProcessor` finally removes the session because the SDK
 * Query subprocess lifecycle == session lifecycle (one process per session, alive
 * until close/abort/error). Here, each turn is an independent HTTP call; the session
 * must survive between turns to serve follow-up messages. Removal happens only via
 * TTL eviction or explicit `remove()`.
 *
 * Constants are copied (not imported) from streamingSessionManager.ts intentionally
 * to avoid coupling. Any divergence would be a deliberate future decision.
 */

import { db, runOutsideDbContext, withDbAccessContext } from '../../db';
import { aiMessages, aiSessions } from '../../db/schema';
import { eq, and, inArray, sql } from 'drizzle-orm';
import type { AuthContext } from '../../middleware/auth';
import type { AuditSnapshot } from '../streamingSessionManager';
import { SessionEventBus } from '../streamingSessionManager';
import { captureException, captureMessage } from '../sentry';
import { OpenAICompatibleProvider } from './openaiCompatibleProvider';
import { buildMessagesFromHistory, ToolUseInHistoryError } from './historyBuilder';
import { recordOpenAIUsage } from '../aiCostTracker';
import { sanitizeErrorForClient } from '../aiAgent';
import { getConfig } from '../../config/validate';
import { extractRowCount } from '../../db/rowCount';
import type { OpenAISession } from './types';
import type { RequestLike } from '../auditEvents';
import { getTrustedClientIpOrUndefined } from '../clientIp';

// Mirror StreamingSessionManager: leave request ALS before starting the async turn so
// nested withDbAccessContext(...) takes the transaction + set_config path (RLS GUCs).
const runOutsideDbContextSafe = runOutsideDbContext;

const SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const EVICTION_INTERVAL_MS = 60 * 1000;
const MAX_ACTIVE_SESSIONS = 200;

/**
 * How long a `processing` session may go without stream progress before
 * eviction stops treating it as a live turn.
 *
 * Eviction protects an in-flight turn (see `isTurnInFlight`), and `state` alone
 * would make that protection unbounded: `runTurn` can throw before it resets
 * state to 'idle', and a hung provider never emits another delta, so a wedged
 * session would be pinned in memory forever. `lastActivityAt` is refreshed when
 * a turn starts and on every content delta, so a genuinely live stream never
 * approaches this window — anything past it is a dead turn, and reclaiming it
 * costs nothing.
 */
export const PROCESSING_STALL_TIMEOUT_MS = 10 * 60 * 1000;

/** Throttle for the all-in-flight capacity alarm, so it cannot flood Sentry. */
const CAPACITY_ALARM_THROTTLE_MS = 5 * 60 * 1000;

export class OpenAISessionManager {
  private sessions = new Map<string, OpenAISession>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  private lastCapacityAlarmAt = 0;

  constructor(private readonly provider: OpenAICompatibleProvider) {
    // Escape the ambient DB context before arming the timer. This manager is a
    // LAZY singleton, first constructed inside an AI request handler
    // (routes/ai.ts getOpenAISessionManager), and a setInterval registered
    // inside an AsyncLocalStorage scope inherits that scope on EVERY tick for
    // the life of the process — so the sweep would otherwise run forever inside
    // one long-committed request transaction, and withDbAccessContext would
    // join it rather than opening the evicted tenant's own context.
    // streamingSessionManager gets away with a bare setInterval only because
    // its singleton is module-level; that difference is not a style choice.
    //
    // Defense in depth, deliberately untested: markSessionsExpired escapes the
    // context per statement, so today no write can observe this. It exists so
    // that any DB call LATER added to the sweep does not silently join a dead
    // request transaction — a failure the contextless-write guard cannot catch,
    // because it fires on the bare pool, not on a stale-context join.
    this.evictionTimer = runOutsideDbContextSafe(() =>
      setInterval(() => this.evictStaleSessions(), EVICTION_INTERVAL_MS),
    );
  }

  /**
   * Get or create a lightweight OpenAI session.
   * Sessions are identified by breezeSessionId (same as Anthropic path).
   */
  getOrCreate(
    breezeSessionId: string,
    orgId: string,
    auth: AuthContext,
    requestContext: RequestLike | undefined,
  ): OpenAISession {
    const snapshot: AuditSnapshot = {
      ip: requestContext ? getTrustedClientIpOrUndefined(requestContext) : undefined,
      userAgent: requestContext?.req.header('user-agent'),
    };

    const existing = this.sessions.get(breezeSessionId);
    if (existing && existing.state !== 'closed') {
      existing.auth = auth;
      existing.auditSnapshot = snapshot;
      existing.lastActivityAt = Date.now();
      return existing;
    }

    const now = Date.now();
    const session: OpenAISession = {
      breezeSessionId,
      orgId,
      eventBus: new SessionEventBus(),
      state: 'ready',
      lastActivityAt: now,
      createdAt: now,
      auth,
      auditSnapshot: snapshot,
      abortController: new AbortController(),
    };

    if (this.sessions.size >= MAX_ACTIVE_SESSIONS) {
      this.evictLeastRecentlyActive();
    }

    this.sessions.set(breezeSessionId, session);
    return session;
  }

  /** Get an existing session without creating */
  get(sessionId: string): OpenAISession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Transition session to 'processing'. Returns false if already processing
   * or in a terminal state.
   */
  tryTransitionToProcessing(session: OpenAISession): boolean {
    if (
      session.state === 'processing' ||
      session.state === 'closing' ||
      session.state === 'closed'
    ) {
      return false;
    }
    session.state = 'processing';
    // The state and its staleness clock move together: eviction reads
    // lastActivityAt to tell a live turn from a wedged one, and before this the
    // stamp was refreshed only in getOrCreate() — so a session that had been
    // sitting idle stayed the LRU victim for the whole turn it was streaming.
    session.lastActivityAt = Date.now();
    return true;
  }

  /**
   * Start a per-turn HTTP call to vLLM in the background.
   * Loads history from DB, streams the response, publishes events to session.eventBus,
   * saves assistant message, records cost, then publishes 'done'.
   *
   * The caller MUST have already called tryTransitionToProcessing() before startTurn().
   *
   * `userMessage` must be the same sanitized payload persisted to ai_messages just before this
   * call — runTurn rebuilds prompts from committed DB rows plus this in-memory current turn so
   * vLLM always receives the latest user text (never rely on SELECT seeing the pending INSERT).
   *
   * Matches Anthropic: turn work starts outside the HTTP request ALS (see
   * StreamingSessionManager runOutsideDbContextSafe) so post-stream DB writes get a
   * fresh withDbAccessContext transaction and correct breeze.* session variables.
   */
  startTurn(
    session: OpenAISession,
    _model: string,
    systemPrompt: string,
    userMessage: string,
  ): void {
    // Abort any previous turn (defensive: covers the gap between
    // tryTransitionToProcessing and startTurn) then assign a fresh controller.
    try { session.abortController.abort(); } catch { /* ignore */ }
    session.abortController = new AbortController();
    runOutsideDbContextSafe(() => {
      void this.runTurn(session, _model, systemPrompt, userMessage).catch((err) => {
        captureException(err);
        console.error('[OpenAISessionManager] Background runTurn error:', err);
      });
    });
  }

  private async runTurn(
    session: OpenAISession,
    _model: string,
    systemPrompt: string,
    userMessage: string,
  ): Promise<void> {
    const { breezeSessionId, orgId } = session;

    let history;
    try {
      history = await buildMessagesFromHistory(breezeSessionId, orgId);
    } catch (err) {
      if (err instanceof ToolUseInHistoryError) {
        session.eventBus.publish({ type: 'error', message: err.message });
        session.eventBus.publish({ type: 'done' });
        session.state = 'idle';
        return;
      }
      captureException(err);
      session.eventBus.publish({
        type: 'error',
        message: sanitizeErrorForClient(err),
      });
      session.eventBus.publish({ type: 'done' });
      session.state = 'idle';
      return;
    }

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      ...history,
      // Current user row is not visible to buildMessagesFromHistory (see historyBuilder docs).
      { role: 'user' as const, content: userMessage },
    ];

    const messageId = crypto.randomUUID();
    session.eventBus.publish({ type: 'message_start', messageId });

    let assistantText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let hadError = false;

    // ai_sessions.model targets Anthropic defaults; on this path vLLM expects MCP_LLM_MODEL
    // (validated at startup when MCP_LLM_PROVIDER=openai-compatible).
    const providerModel = getConfig().MCP_LLM_MODEL!;

    try {
      try {
        for await (const event of this.provider.chatStream(messages, {
          model: providerModel,
          signal: session.abortController.signal,
        })) {
          if (session.state === 'closing' || session.state === 'closed') break;

          switch (event.type) {
            case 'content_delta':
              assistantText += event.delta;
              // Stream progress keeps the turn alive for eviction purposes.
              session.lastActivityAt = Date.now();
              session.eventBus.publish({ type: 'content_delta', delta: event.delta });
              break;
            case 'message_end':
              inputTokens = event.inputTokens;
              outputTokens = event.outputTokens;
              session.eventBus.publish({
                type: 'message_end',
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
              });
              break;
            case 'error':
              hadError = true;
              // Mirror the catch block below: this is the same failure surface
              // (a stream error), just reported by the provider as a yielded
              // event instead of a thrown exception. `event.message` is already
              // the client-facing text (see openaiCompatibleProvider.ts — it is
              // never raw provider/response text beyond what already reaches
              // the client via the publish() below), so no separate
              // sanitization step is needed before sending it to Sentry.
              captureException(new Error(`LLM stream error: ${event.message}`));
              session.eventBus.publish({ type: 'error', message: event.message });
              break;
            case 'message_start':
              // Already published above; ignore duplicate from provider
              break;
          }
        }
      } catch (err) {
        hadError = true;
        captureException(err);
        session.eventBus.publish({ type: 'error', message: sanitizeErrorForClient(err) });
      }

      if (!hadError && assistantText) {
        try {
          await withDbAccessContext(
            { scope: 'organization', orgId, accessibleOrgIds: [orgId] },
            () =>
              db.insert(aiMessages).values({
                sessionId: breezeSessionId,
                role: 'assistant',
                content: assistantText,
                inputTokens,
                outputTokens,
              }),
          );
        } catch (err) {
          captureException(err);
          console.error('[OpenAISessionManager] Failed to save assistant message:', err);
        }

        try {
          const costUsd = this.provider.computeCostUsd(inputTokens, outputTokens);
          await withDbAccessContext(
            { scope: 'organization', orgId, accessibleOrgIds: [orgId] },
            () => recordOpenAIUsage(
              breezeSessionId,
              orgId,
              inputTokens,
              outputTokens,
              costUsd,
              'platform',
            ),
          );
        } catch (err) {
          captureException(err);
          console.error('[OpenAISessionManager] Failed to record usage:', err);
        }
      }
    } finally {
      // Turn count: increments only after we invoked the LLM HTTP path — success or failure on that path
      // (provider errors incl. HTTP 5xx, tool-call rejection, mid-stream abort). Upstream refusal before
      // chatStream starts (e.g. ToolUseInHistoryError) does not consume a turn; maintainer may revisit.
      try {
        await withDbAccessContext(
          { scope: 'organization', orgId, accessibleOrgIds: [orgId] },
          () =>
            db
              .update(aiSessions)
              .set({
                turnCount: sql`${aiSessions.turnCount} + 1`,
                updatedAt: new Date(),
              })
              .where(eq(aiSessions.id, breezeSessionId)),
        );
      } catch (err) {
        captureException(err);
        console.error('[OpenAISessionManager] Failed to increment turnCount:', err);
      }
    }

    session.eventBus.publish({ type: 'done' });
    session.state = 'idle';
  }

  /** Remove a session and close its eventBus */
  remove(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.state = 'closing';
    try { session.abortController.abort(); } catch { /* ignore */ }
    session.eventBus.closeAll();
    session.state = 'closed';
    this.sessions.delete(sessionId);
  }

  /** Interrupt the current turn for a session */
  interrupt(sessionId: string): { interrupted: boolean; reason?: string } {
    const session = this.sessions.get(sessionId);
    if (!session) return { interrupted: false, reason: 'Session not found' };
    if (session.state !== 'processing') return { interrupted: false, reason: 'Session is not processing' };
    try {
      session.abortController.abort();
      return { interrupted: true };
    } catch {
      return { interrupted: false, reason: 'Failed to abort turn' };
    }
  }

  shutdown(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    for (const sessionId of [...this.sessions.keys()]) {
      this.remove(sessionId);
    }
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  /**
   * True while a turn is actively streaming for this session.
   *
   * Eviction must never take such a session: `remove()` aborts its controller
   * and closes its event bus mid-turn, and because the provider treats a
   * user-kind abort as a clean stop, the partial `assistantText` is then
   * persisted as a COMPLETE assistant message while the terminal `done` publish
   * lands on an already-closed bus.
   *
   * Liveness is `state` AND recent progress, never `state` alone — see
   * PROCESSING_STALL_TIMEOUT_MS for why a wedged turn must stay reclaimable.
   */
  private isTurnInFlight(session: OpenAISession, now: number): boolean {
    return (
      session.state === 'processing' &&
      now - session.lastActivityAt <= PROCESSING_STALL_TIMEOUT_MS
    );
  }

  /**
   * Retire the DB row for a session that eviction has just dropped.
   *
   * An evicted session is gone from memory and the client has been told to
   * start a new one, so leaving `status = 'active'` strands the row: every
   * caller keyed on active sessions overcounts, worst under exactly the load
   * that drives LRU eviction. This mirrors what `runPreFlightChecks` would have
   * written lazily on the next request (services/aiAgentSdk.ts) — eviction just
   * stops deferring it.
   *
   * `runOutsideDbContext` is load-bearing, not decoration: `withDbAccessContext`
   * JOINS an already-open context instead of replacing it (db/index.ts), and
   * `evictLeastRecentlyActive()` is reached from `getOrCreate()` on the request
   * path, which the auth middleware has already wrapped in the REQUESTER's
   * context. Without the escape the UPDATE would run under the requester's
   * GUCs, match zero rows under RLS for a victim in another tenant, and fail
   * silently. On the timer path there is no ambient context and this is a no-op.
   *
   * The `status = 'active'` guard keeps a row already closed by the user from
   * being re-stamped as expired.
   */
  private markSessionsExpired(sessionIdsByOrg: Map<string, string[]>): void {
    if (sessionIdsByOrg.size === 0) return;
    void (async () => {
      // One org per statement, one statement at a time. A tick can retire a
      // whole cohort that idled out together, and a transaction per session
      // would put up to MAX_ACTIVE_SESSIONS of them against a pool of
      // DB_POOL_MAX (30) shared with live request traffic. Eviction is
      // background work with no deadline, so it yields to that traffic.
      for (const [orgId, sessionIds] of sessionIdsByOrg) {
        try {
          // The context escape is re-entered on EVERY iteration, never once
          // around the loop. `AsyncLocalStorage.exit()` covers the synchronous
          // call and what it schedules, but an iteration resuming after `await`
          // sees the caller's ambient context live again — and
          // withDbAccessContext JOINS an open context instead of replacing it,
          // so orgs 2..N would run under the REQUESTER's GUCs and match zero
          // rows under RLS. Pinned by the multi-org test; an earlier draft that
          // hoisted this out of the loop failed it.
          const result = await runOutsideDbContextSafe(() =>
            withDbAccessContext(
              { scope: 'organization', orgId, accessibleOrgIds: [orgId] },
              () =>
                db
                  .update(aiSessions)
                  .set({ status: 'expired', updatedAt: new Date() })
                  .where(
                    and(
                      inArray(aiSessions.id, sessionIds),
                      eq(aiSessions.status, 'active'),
                    ),
                  ),
            ),
          );

          // An UPDATE evaluated under the WRONG tenant's GUCs does not raise
          // under forced RLS — it matches zero rows and reports success. That
          // is precisely the failure the context escape above exists to
          // prevent, so it has to be observable rather than assumed. A partial
          // count is normal (the status='active' guard skips rows the user
          // already closed); zero across a whole batch is the RLS signature.
          if (extractRowCount(result) === 0) {
            console.warn(
              `[OpenAISessionManager] Expire matched 0 of ${sessionIds.length} row(s) for org ${orgId} — wrong RLS context, or all already closed: ${sessionIds.join(', ')}`,
            );
            captureMessage('AI session expire matched zero rows', {
              eventCode: 'db_write_expecting_rows_zero',
            });
          }
        } catch (err) {
          // Never abandon the remaining orgs: a failure here strands rows as
          // 'active', which is the very defect this helper exists to fix.
          // Session ids go in the log line, not a Sentry tag — the scrubber
          // allowlist deliberately voids tenant-scoped tags, so a tag here
          // would silently vanish rather than aid correlation.
          captureException(err);
          console.error(
            `[OpenAISessionManager] Failed to expire ${sessionIds.length} session(s) for org ${orgId} (${sessionIds.join(', ')}):`,
            err,
          );
        }
      }
    })().catch((err) => {
      // The loop body is fully guarded, so arriving here means the guard itself
      // threw. Terminate the promise regardless: this helper's whole purpose is
      // that an eviction never silently leaves a row 'active'.
      captureException(err);
      console.error('[OpenAISessionManager] Expire sweep failed:', err);
    });
  }

  private evictStaleSessions(): void {
    const now = Date.now();
    const expiredByOrg = new Map<string, string[]>();
    try {
      for (const [sessionId, session] of [...this.sessions.entries()]) {
        const idle = now - session.lastActivityAt;
        const age = now - session.createdAt;

        if (idle <= SESSION_IDLE_TIMEOUT_MS && age <= SESSION_MAX_AGE_MS) continue;

        // Applies to the 24h hard cap too: a session that reaches it mid-stream
        // is evicted on the first tick after its turn ends (bounded by the
        // provider's own FETCH_TIMEOUT_MS, not by this interval). Turns cannot
        // chain to hold it open indefinitely — runPreFlightChecks enforces the
        // same 24h cap before any NEW turn starts, so the slip is one turn at
        // most. Deferring briefly beats truncating an answer and storing it as
        // if it were whole.
        if (this.isTurnInFlight(session, now)) continue;

        console.log(`[OpenAISessionManager] Evicting session ${sessionId} (idle=${idle}ms, age=${age}ms)`);
        session.eventBus.publish({
          type: 'error',
          message:
            age > SESSION_MAX_AGE_MS
              ? 'Session expired (24h limit). Please start a new session.'
              : 'Session expired due to inactivity. Please start a new session.',
        });
        session.eventBus.publish({ type: 'done' });
        this.remove(sessionId);

        const forOrg = expiredByOrg.get(session.orgId);
        if (forOrg) forOrg.push(sessionId);
        else expiredByOrg.set(session.orgId, [sessionId]);
      }
    } finally {
      // In a `finally` so a throw mid-sweep still retires the sessions already
      // dropped from the Map. Losing them here would strand exactly the
      // 'active' rows this method exists to clean up, with no record of which.
      this.markSessionsExpired(expiredByOrg);
    }
  }

  private evictLeastRecentlyActive(): void {
    const now = Date.now();
    let oldest: { id: string; lastActivity: number } | null = null;
    for (const [id, session] of this.sessions) {
      // Under cap pressure the least-recently-active session is often the one
      // mid-stream, since its stamp predates the turn it is currently serving.
      if (this.isTurnInFlight(session, now)) continue;
      if (!oldest || session.lastActivityAt < oldest.lastActivity) {
        oldest = { id, lastActivity: session.lastActivityAt };
      }
    }

    if (!oldest) {
      // Every session is mid-turn. Overshooting the soft cap is self-correcting
      // — the next getOrCreate reclaims space as soon as any turn ends — while
      // corrupting a live turn is not. But the cap IS being breached and the
      // caller proceeds to add anyway, so this is a resource-exhaustion signal
      // and must reach more than stdout. Throttled: under sustained pressure
      // this runs once per request.
      console.warn(
        `[OpenAISessionManager] LRU eviction skipped: all ${this.sessions.size} sessions have a turn in flight; cap ${MAX_ACTIVE_SESSIONS} exceeded`,
      );
      const now2 = Date.now();
      if (now2 - this.lastCapacityAlarmAt >= CAPACITY_ALARM_THROTTLE_MS) {
        this.lastCapacityAlarmAt = now2;
        captureMessage('OpenAI session cap exceeded: every session mid-turn', {
          eventCode: 'ai_session_cap_all_in_flight',
        });
      }
      return;
    }

    console.log(`[OpenAISessionManager] LRU evicting session ${oldest.id}`);
    const session = this.sessions.get(oldest.id);
    if (session) {
      session.eventBus.publish({ type: 'error', message: 'Session evicted due to server capacity. Please start a new session.' });
      session.eventBus.publish({ type: 'done' });
    }
    this.remove(oldest.id);
    // Deliberately NOT expired. Unlike the staleness paths, an LRU victim is a
    // perfectly usable conversation dropped for OUR capacity reasons: history
    // lives in ai_messages and buildMessagesFromHistory rebuilds it, so the
    // user's next message would transparently recreate the session — exactly
    // like a deploy, which shutdown() is likewise careful not to expire.
    // Stamping 'expired' here would turn a transient server condition into a
    // hard 410 for a conversation that is minutes old, since runPreFlightChecks
    // rejects on status before getOrCreate ever runs. The row stays truthful:
    // 'active' means resumable, and preflight still expires it lazily once it
    // genuinely goes idle or ages out.
  }
}
