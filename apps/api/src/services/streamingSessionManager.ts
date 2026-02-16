/**
 * Streaming Session Manager
 *
 * Manages persistent Claude Agent SDK Query instances using AsyncIterable
 * (streaming input mode). Each session holds a long-lived subprocess that
 * accepts follow-up messages without replaying history.
 *
 * Core components:
 * - StreamInputController: AsyncIterable<SDKUserMessage> fed to query({ prompt })
 * - SessionEventBus: pub/sub for AiStreamEvent with ring buffer
 * - StreamingSessionManager: singleton Map<string, ActiveSession> with eviction
 * - Background SDK Processor: iterates Query output, translates to AiStreamEvents
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKResultMessage, SDKUserMessage, McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { db, runOutsideDbContext } from '../db';
import { aiSessions, aiMessages } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiStreamEvent } from '@breeze/shared/types/ai';
import { AsyncEventQueue } from '../utils/asyncQueue';
import { recordUsageFromSdkResult } from './aiCostTracker';
import { sanitizeErrorForClient } from './aiAgent';
import { createBreezeMcpServer, BREEZE_MCP_TOOL_NAMES } from './aiAgentSdkTools';
import { createSessionPreToolUse, createSessionPostToolUse } from './aiAgentSdk';
import type { RequestLike } from './auditEvents';

const SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2h idle eviction (aligned with pre-flight check)
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h hard limit
const EVICTION_INTERVAL_MS = 60 * 1000; // Check every 60s
const MAX_ACTIVE_SESSIONS = 200;
const EVENT_RING_BUFFER_SIZE = 100;
const SDK_TURN_TIMEOUT_MS = 3 * 60 * 1000; // 3 min per-turn timeout
const MCP_PREFIX = 'mcp__breeze__';

// ============================================
// StreamInputController
// ============================================

/**
 * Wraps an AsyncEventQueue<SDKUserMessage> as the prompt source for query().
 * Follow-up messages are pushed via pushMessage() — no subprocess restart needed.
 *
 * NOTE: The first message is pushed with whatever session_id is known (empty string
 * for new sessions). The SDK manages session IDs internally — the subprocess must
 * receive the first message to start processing, so we cannot block on the init
 * event (which only arrives after the subprocess starts).
 */
export class StreamInputController {
  private queue = new AsyncEventQueue<SDKUserMessage>();
  private sdkSessionId: string | null = null;

  /** Feed this to query({ prompt }) */
  getInputStream(): AsyncIterable<SDKUserMessage> {
    return this.queue;
  }

  /**
   * Set the SDK session ID. Called once by the background processor when
   * the system init event arrives, or upfront for resumed sessions.
   */
  setSdkSessionId(id: string): void {
    if (this.sdkSessionId) {
      console.warn('[StreamInputController] SDK session ID already set, ignoring duplicate:', id);
      return;
    }
    this.sdkSessionId = id;
  }

  /**
   * Push a new user message into the stream.
   * Uses the known SDK session ID if available, otherwise empty string
   * (the SDK assigns session IDs internally for new sessions).
   */
  pushMessage(content: string): void {
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: this.sdkSessionId ?? '',
    };

    this.queue.push(message);
  }

  /** Close the input stream, terminating the Query */
  close(): void {
    this.queue.close();
  }
}

// ============================================
// SessionEventBus
// ============================================

/**
 * Pub/sub for AiStreamEvent. Multiple SSE subscribers can listen.
 * Ring buffer stores last N events for potential reconnection replay.
 */
export class SessionEventBus {
  private subscribers = new Map<string, AsyncEventQueue<AiStreamEvent>>();
  private ringBuffer: AiStreamEvent[] = [];

  /** Subscribe to events. Returns an async iterable. Closes any existing subscription with the same ID. */
  subscribe(id: string): AsyncIterable<AiStreamEvent> {
    // Close existing subscriber with same ID to prevent resource leak
    const existing = this.subscribers.get(id);
    if (existing) {
      existing.close();
    }
    const queue = new AsyncEventQueue<AiStreamEvent>();
    this.subscribers.set(id, queue);
    return queue;
  }

  /** Unsubscribe and close the subscriber's queue */
  unsubscribe(id: string): void {
    const queue = this.subscribers.get(id);
    if (queue) {
      queue.close();
      this.subscribers.delete(id);
    }
  }

  /** Publish an event to all subscribers and the ring buffer */
  publish(event: AiStreamEvent): void {
    this.ringBuffer.push(event);
    if (this.ringBuffer.length > EVENT_RING_BUFFER_SIZE) {
      this.ringBuffer.shift();
    }

    for (const queue of this.subscribers.values()) {
      queue.push(event);
    }
  }

  /** Get recent events from the ring buffer for reconnection replay */
  getReplayEvents(fromIndex = 0): AiStreamEvent[] {
    return this.ringBuffer.slice(fromIndex);
  }

  /** Close all subscriber queues */
  closeAll(): void {
    for (const queue of this.subscribers.values()) {
      queue.close();
    }
    this.subscribers.clear();
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}

// ============================================
// ActiveSession
// ============================================

export type SessionState = 'initializing' | 'ready' | 'processing' | 'idle' | 'closing' | 'closed';

/** Immutable audit snapshot extracted from the HTTP request context */
export interface AuditSnapshot {
  ip: string | undefined;
  userAgent: string | undefined;
}

export interface ActiveSession {
  readonly breezeSessionId: string;
  sdkSessionId: string | null;
  query: Query;
  abortController: AbortController;
  inputController: StreamInputController;
  eventBus: SessionEventBus;
  state: SessionState;
  lastActivityAt: number;
  readonly createdAt: number;
  auth: AuthContext;
  /** Immutable audit data extracted from the latest request (avoids holding stale Hono context) */
  auditSnapshot: AuditSnapshot;
  mcpServer: McpSdkServerConfigWithInstance;
  /** FIFO queue of toolUseIds from content_block_start for postToolUse correlation */
  toolUseIdQueue: string[];
  /** Promise that resolves when background processor finishes */
  readonly processorPromise: Promise<void>;
  /** Timer for per-turn timeout; cleared when 'result' arrives */
  turnTimeoutId: ReturnType<typeof setTimeout> | null;
}

// ============================================
// StreamingSessionManager (singleton)
// ============================================

export class StreamingSessionManager {
  private sessions = new Map<string, ActiveSession>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.evictionTimer = setInterval(() => this.evictStaleSessions(), EVICTION_INTERVAL_MS);
  }

  /**
   * Check state and transition to 'processing'.
   * Allows transition from 'initializing', 'ready', or 'idle' states.
   * Rejects only true concurrent work and teardown/closed sessions.
   * Returns true if successful, false if session is not in a valid state.
   */
  tryTransitionToProcessing(session: ActiveSession): boolean {
    if (session.state === 'processing' || session.state === 'closing' || session.state === 'closed') {
      return false;
    }
    session.state = 'processing';
    return true;
  }

  /**
   * Get or create an active streaming session.
   * If the session exists in memory and is alive, reuse it.
   * If not, create a new one (potentially resuming from saved sdkSessionId).
   */
  async getOrCreate(
    breezeSessionId: string,
    dbSession: {
      orgId: string;
      sdkSessionId: string | null;
      model: string;
      maxTurns: number;
      turnCount: number;
      systemPrompt: string | null;
    },
    auth: AuthContext,
    requestContext: RequestLike | undefined,
    systemPrompt: string,
    maxBudgetUsd: number | undefined,
    allowedTools?: string[],
  ): Promise<ActiveSession> {
    const snapshot: AuditSnapshot = {
      ip: requestContext?.req.header('x-forwarded-for') ?? requestContext?.req.header('x-real-ip'),
      userAgent: requestContext?.req.header('user-agent'),
    };

    const existing = this.sessions.get(breezeSessionId);
    if (existing && existing.state !== 'closed') {
      // Update per-request context
      existing.auth = auth;
      existing.auditSnapshot = snapshot;
      existing.lastActivityAt = Date.now();
      return existing;
    }

    // Create new session components
    const inputController = new StreamInputController();
    const eventBus = new SessionEventBus();
    const abortController = new AbortController();

    if (dbSession.sdkSessionId) {
      inputController.setSdkSessionId(dbSession.sdkSessionId);
    }

    // Build partial session object so callbacks can reference it.
    // query and processorPromise are filled in after creation.
    const now = Date.now();
    const session: ActiveSession = {
      breezeSessionId,
      sdkSessionId: dbSession.sdkSessionId,
      query: null as unknown as Query, // set below
      abortController,
      inputController,
      eventBus,
      state: 'initializing',
      lastActivityAt: now,
      createdAt: now,
      auth,
      auditSnapshot: snapshot,
      mcpServer: null as unknown as McpSdkServerConfigWithInstance, // set below
      toolUseIdQueue: [],
      processorPromise: Promise.resolve(),
      turnTimeoutId: null,
    };

    // Create session-scoped callbacks (close over session object)
    const preToolUse = createSessionPreToolUse(session);
    const postToolUse = createSessionPostToolUse(session);

    // Create MCP server with pre/post tool-use callbacks
    const mcpServer = createBreezeMcpServer(() => session.auth, preToolUse, postToolUse);
    session.mcpServer = mcpServer;

    const maxTurns = Math.max(1, dbSession.maxTurns - dbSession.turnCount);

    // CRITICAL: Create SDK query and background processor OUTSIDE the request's
    // AsyncLocalStorage DB context. The auth middleware wraps requests in a
    // transaction (via withDbAccessContext). Without this escape hatch, the SDK's
    // tool handlers inherit the transaction context and hang after the HTTP
    // request completes and the transaction commits.
    runOutsideDbContext(() => {
      const sdkQuery = query({
        prompt: inputController.getInputStream(),
        options: {
          systemPrompt,
          model: dbSession.model,
          maxTurns,
          maxBudgetUsd,
          tools: [],
          allowedTools: allowedTools ?? BREEZE_MCP_TOOL_NAMES,
          mcpServers: { breeze: mcpServer },
          includePartialMessages: true,
          abortController,
          resume: dbSession.sdkSessionId ?? undefined,
          persistSession: true,
          settingSources: [],
          thinking: { type: 'disabled' },
          stderr: (data: string) => {
            if (data.includes('error') || data.includes('Error') || data.includes('FATAL')) {
              console.error('[SDK-stderr]', breezeSessionId, data.trim());
            }
          },
        }
      });

      (session as { query: Query }).query = sdkQuery;

      // Start background processor (inherits the clean context)
      (session as { processorPromise: Promise<void> }).processorPromise = this.runBackgroundProcessor(session);
      session.processorPromise.catch((err) => {
        console.error('[StreamingSessionManager] Background processor error:', err);
      });
    });

    // Enforce max active sessions via LRU eviction
    if (this.sessions.size >= MAX_ACTIVE_SESSIONS) {
      this.evictLeastRecentlyActive();
    }

    this.sessions.set(breezeSessionId, session);

    return session;
  }

  /** Get an existing session without creating */
  get(sessionId: string): ActiveSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Remove a session (close query, clean up resources) */
  remove(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.state = 'closing';
    if (session.turnTimeoutId) {
      clearTimeout(session.turnTimeoutId);
      session.turnTimeoutId = null;
    }
    try { session.inputController.close(); } catch (err) {
      console.error('[StreamingSessionManager] Failed to close input controller:', sessionId, err);
    }
    try { session.query.close(); } catch (err) {
      console.error('[StreamingSessionManager] Failed to close SDK query:', sessionId, err);
    }
    session.eventBus.closeAll();
    session.state = 'closed';
    this.sessions.delete(sessionId);
  }

  /** Interrupt the current query for a session */
  async interrupt(sessionId: string): Promise<{ interrupted: boolean; reason?: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { interrupted: false, reason: 'Session not found in memory' };
    }
    if (session.state !== 'processing') {
      return { interrupted: false, reason: 'Session is not currently processing' };
    }

    try {
      await session.query.interrupt();
      return { interrupted: true };
    } catch (err) {
      console.error('[StreamingSessionManager] Interrupt failed:', err);
      return { interrupted: false, reason: 'Failed to interrupt SDK query' };
    }
  }

  /** Shutdown: clean up all sessions and stop eviction timer */
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

  /** Start the per-turn timeout. Publishes error + done if SDK hangs. */
  startTurnTimeout(session: ActiveSession): void {
    this.clearTurnTimeout(session);
    session.turnTimeoutId = setTimeout(() => {
      if (session.state === 'processing') {
        console.error('[StreamingSessionManager] Turn timeout for session:', session.breezeSessionId);
        session.eventBus.publish({ type: 'error', message: 'AI request timed out. Please try again.' });
        session.eventBus.publish({ type: 'done' });
        session.state = 'idle';
      }
    }, SDK_TURN_TIMEOUT_MS);
  }

  /** Clear the per-turn timeout (called when 'result' arrives) */
  clearTurnTimeout(session: ActiveSession): void {
    if (session.turnTimeoutId) {
      clearTimeout(session.turnTimeoutId);
      session.turnTimeoutId = null;
    }
  }

  // ============================================
  // Background SDK Processor
  // ============================================

  private async runBackgroundProcessor(session: ActiveSession): Promise<void> {
    let currentMessageId = crypto.randomUUID();
    let messageStarted = false;

    try {
      for await (const message of session.query) {
        // Stop publishing if session is being torn down
        if (session.state === 'closing' || session.state === 'closed') break;

        switch (message.type) {
          case 'system': {
            if ('subtype' in message && message.subtype === 'init' && 'session_id' in message) {
              const sid = message.session_id;
              session.sdkSessionId = sid;
              session.inputController.setSdkSessionId(sid);

              db.update(aiSessions)
                .set({ sdkSessionId: sid })
                .where(eq(aiSessions.id, session.breezeSessionId))
                .catch((err) => console.error('[StreamingSessionManager] Failed to store SDK session ID:', err));
            }

            if (session.state === 'initializing') {
              session.state = 'ready';
            }
            break;
          }

          case 'stream_event': {
            const event = message.event;

            if (event.type === 'message_start') {
              currentMessageId = crypto.randomUUID();
              messageStarted = true;
              session.eventBus.publish({ type: 'message_start', messageId: currentMessageId });
            } else if (event.type === 'content_block_delta') {
              if ('delta' in event && event.delta.type === 'text_delta') {
                session.eventBus.publish({ type: 'content_delta', delta: event.delta.text });
              }
            } else if (event.type === 'content_block_start') {
              if ('content_block' in event && event.content_block.type === 'tool_use') {
                const block = event.content_block;

                // Track toolUseId for postToolUse correlation.
                // content_block_start fires before the tool executes;
                // postToolUse shifts the queue after execution.
                session.toolUseIdQueue.push(block.id);

                session.eventBus.publish({
                  type: 'tool_use_start',
                  toolName: block.name.startsWith(MCP_PREFIX)
                    ? block.name.slice(MCP_PREFIX.length)
                    : block.name,
                  toolUseId: block.id,
                  input: {},
                });
              }
            } else if (event.type === 'message_delta') {
              if (messageStarted) {
                session.eventBus.publish({
                  type: 'message_end',
                  inputTokens: 0,
                  outputTokens: event.usage?.output_tokens ?? 0,
                });
                messageStarted = false;
              }
            }
            break;
          }

          case 'assistant': {
            const assistantContent = message.message.content
              .filter((b) => b.type === 'text')
              .map((b) => ('text' in b ? (b as { text: string }).text : ''))
              .join('');

            try {
              await db.insert(aiMessages).values({
                sessionId: session.breezeSessionId,
                role: 'assistant',
                content: assistantContent || null,
                contentBlocks: message.message.content as unknown as Record<string, unknown>[],
                inputTokens: message.message.usage?.input_tokens ?? 0,
                outputTokens: message.message.usage?.output_tokens ?? 0,
              });
            } catch (err) {
              console.error('[StreamingSessionManager] Failed to save assistant message:', err);
            }

            for (const block of message.message.content) {
              if (block.type === 'tool_use') {
                const bareName = block.name.startsWith(MCP_PREFIX)
                  ? block.name.slice(MCP_PREFIX.length)
                  : block.name;

                try {
                  await db.insert(aiMessages).values({
                    sessionId: session.breezeSessionId,
                    role: 'tool_use',
                    toolName: bareName,
                    toolInput: block.input as Record<string, unknown>,
                    toolUseId: block.id,
                  });
                } catch (err) {
                  console.error('[StreamingSessionManager] Failed to save tool_use message:', err);
                }
              }
            }
            break;
          }

          case 'user': {
            // SDK replays user messages during resume — skip, already in DB
            break;
          }

          case 'result': {
            // Clear per-turn timeout on result
            this.clearTurnTimeout(session);

            const resultMsg = message as SDKResultMessage;
            const orgId = session.auth.orgId;

            if (!orgId) {
              console.warn('[StreamingSessionManager] Skipping usage recording — no orgId on session', session.breezeSessionId);
              session.eventBus.publish({ type: 'done' });
              session.state = 'idle';
              break;
            }

            if (resultMsg.subtype === 'success') {
              try {
                await recordUsageFromSdkResult(session.breezeSessionId, orgId, {
                  total_cost_usd: resultMsg.total_cost_usd,
                  usage: {
                    input_tokens: resultMsg.usage.input_tokens,
                    output_tokens: resultMsg.usage.output_tokens,
                  },
                  num_turns: resultMsg.num_turns,
                });
              } catch (err) {
                console.error('[StreamingSessionManager] Failed to record SDK usage:', err);
              }
            } else {
              const errors = 'errors' in resultMsg ? resultMsg.errors : [];
              const errorMsg = errors.length > 0 ? errors[0] : `AI query ended: ${resultMsg.subtype}`;

              if (resultMsg.subtype === 'error_max_budget_usd') {
                session.eventBus.publish({ type: 'error', message: 'AI budget limit reached for this query.' });
              } else if (resultMsg.subtype === 'error_max_turns') {
                session.eventBus.publish({ type: 'error', message: 'Maximum conversation turns reached.' });
              } else {
                session.eventBus.publish({ type: 'error', message: sanitizeErrorForClient(new Error(errorMsg ?? 'Unknown error')) });
              }

              try {
                await recordUsageFromSdkResult(session.breezeSessionId, orgId, {
                  total_cost_usd: resultMsg.total_cost_usd,
                  usage: {
                    input_tokens: resultMsg.usage.input_tokens,
                    output_tokens: resultMsg.usage.output_tokens,
                  },
                  num_turns: resultMsg.num_turns,
                });
              } catch (err) {
                console.error('[StreamingSessionManager] Failed to record SDK usage on error:', err);
              }
            }

            // Signal this turn is done, but DON'T close the event bus —
            // session stays alive for follow-up messages
            session.eventBus.publish({ type: 'done' });
            session.state = 'idle';
            break;
          }

          default:
            break;
        }
      }
    } catch (err) {
      console.error('[StreamingSessionManager] Query error:', err);
      session.eventBus.publish({ type: 'error', message: sanitizeErrorForClient(err) });
      session.eventBus.publish({ type: 'done' });
    } finally {
      // Always clean up the session from the map after the processor exits
      this.clearTurnTimeout(session);
      if (this.sessions.has(session.breezeSessionId)) {
        this.remove(session.breezeSessionId);
      }
    }
  }

  // ============================================
  // Eviction
  // ============================================

  private evictStaleSessions(): void {
    const now = Date.now();

    for (const [sessionId, session] of [...this.sessions.entries()]) {
      const idle = now - session.lastActivityAt;
      const age = now - session.createdAt;

      if (idle > SESSION_IDLE_TIMEOUT_MS || age > SESSION_MAX_AGE_MS) {
        console.log(`[StreamingSessionManager] Evicting session ${sessionId} (idle=${idle}ms, age=${age}ms)`);

        // Notify connected SSE clients before removing
        session.eventBus.publish({
          type: 'error',
          message: age > SESSION_MAX_AGE_MS
            ? 'Session expired (24h limit). Please start a new session.'
            : 'Session expired due to inactivity. Please start a new session.',
        });
        session.eventBus.publish({ type: 'done' });

        this.remove(sessionId);

        if (age > SESSION_MAX_AGE_MS) {
          db.update(aiSessions)
            .set({ status: 'expired', updatedAt: new Date() })
            .where(and(eq(aiSessions.id, sessionId), eq(aiSessions.status, 'active')))
            .catch((err) => console.error('[StreamingSessionManager] Failed to expire session:', err));
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
      console.log(`[StreamingSessionManager] LRU evicting session ${oldest.id}`);
      const session = this.sessions.get(oldest.id);
      if (session) {
        session.eventBus.publish({ type: 'error', message: 'Session evicted due to server capacity. Please start a new session.' });
        session.eventBus.publish({ type: 'done' });
      }
      this.remove(oldest.id);
    }
  }
}

// Singleton instance
export const streamingSessionManager = new StreamingSessionManager();
