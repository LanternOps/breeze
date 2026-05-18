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

import { db, withDbAccessContext } from '../../db';
import { aiMessages, aiSessions } from '../../db/schema';
import { eq, and } from 'drizzle-orm';
import type { AuthContext } from '../../middleware/auth';
import type { AuditSnapshot } from '../streamingSessionManager';
import { SessionEventBus } from '../streamingSessionManager';
import { captureException } from '../sentry';
import { OpenAICompatibleProvider } from './openaiCompatibleProvider';
import { buildMessagesFromHistory, ToolUseInHistoryError } from './historyBuilder';
import { recordOpenAIUsage } from '../aiCostTracker';
import { sanitizeErrorForClient } from '../aiAgent';
import type { OpenAISession } from './types';
import type { RequestLike } from '../auditEvents';

const SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const EVICTION_INTERVAL_MS = 60 * 1000;
const MAX_ACTIVE_SESSIONS = 200;

export class OpenAISessionManager {
  private sessions = new Map<string, OpenAISession>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly provider: OpenAICompatibleProvider) {
    this.evictionTimer = setInterval(() => this.evictStaleSessions(), EVICTION_INTERVAL_MS);
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
      ip: requestContext?.req.header('x-forwarded-for') ?? requestContext?.req.header('x-real-ip'),
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
    return true;
  }

  /**
   * Start a per-turn HTTP call to vLLM in the background.
   * Loads history from DB, streams the response, publishes events to session.eventBus,
   * saves assistant message, records cost, then publishes 'done'.
   *
   * The caller MUST have already called tryTransitionToProcessing() before startTurn().
   */
  startTurn(
    session: OpenAISession,
    model: string,
    systemPrompt: string,
  ): void {
    // Abort any previous turn (defensive: covers the gap between
    // tryTransitionToProcessing and startTurn) then assign a fresh controller.
    try { session.abortController.abort(); } catch { /* ignore */ }
    session.abortController = new AbortController();
    void this.runTurn(session, model, systemPrompt);
  }

  private async runTurn(
    session: OpenAISession,
    model: string,
    systemPrompt: string,
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
    ];

    const messageId = crypto.randomUUID();
    session.eventBus.publish({ type: 'message_start', messageId });

    let assistantText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let hadError = false;

    try {
      for await (const event of this.provider.chatStream(messages, {
        model,
        signal: session.abortController.signal,
      })) {
        if (session.state === 'closing' || session.state === 'closed') break;

        switch (event.type) {
          case 'content_delta':
            assistantText += event.delta;
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
          () => recordOpenAIUsage(breezeSessionId, orgId, inputTokens, outputTokens, costUsd),
        );
      } catch (err) {
        captureException(err);
        console.error('[OpenAISessionManager] Failed to record usage:', err);
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

  private evictStaleSessions(): void {
    const now = Date.now();
    for (const [sessionId, session] of [...this.sessions.entries()]) {
      const idle = now - session.lastActivityAt;
      const age = now - session.createdAt;

      if (idle > SESSION_IDLE_TIMEOUT_MS || age > SESSION_MAX_AGE_MS) {
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

        if (age > SESSION_MAX_AGE_MS) {
          withDbAccessContext(
            { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
            () =>
              db
                .update(aiSessions)
                .set({ status: 'expired', updatedAt: new Date() })
                .where(and(eq(aiSessions.id, sessionId), eq(aiSessions.status, 'active'))),
          ).catch((err) => {
            captureException(err);
            console.error('[OpenAISessionManager] Failed to expire session:', err);
          });
        }
      }
    }
  }

  private evictLeastRecentlyActive(): void {
    let oldest: { id: string; lastActivity: number } | null = null;
    for (const [id, session] of this.sessions) {
      if (!oldest || session.lastActivityAt < oldest.lastActivity) {
        oldest = { id, lastActivity: session.lastActivityAt };
      }
    }
    if (oldest) {
      console.log(`[OpenAISessionManager] LRU evicting session ${oldest.id}`);
      const session = this.sessions.get(oldest.id);
      if (session) {
        session.eventBus.publish({ type: 'error', message: 'Session evicted due to server capacity. Please start a new session.' });
        session.eventBus.publish({ type: 'done' });
      }
      this.remove(oldest.id);
    }
  }
}
