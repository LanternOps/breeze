/**
 * LLM provider abstraction - chat-only PoC (no tool-calling).
 *
 * The Anthropic path (claude-agent-sdk) remains the source of truth.
 * The openai-compatible path is best-effort, no SLA, gated by MCP_LLM_PROVIDER env flag.
 */

import type { SessionEventBus } from '../streamingSessionManager';
import type { AuthContext } from '../../middleware/auth';
import type { AuditSnapshot } from '../streamingSessionManager';

// ============================================
// Provider discriminant
// ============================================

export type LLMProviderType = 'anthropic' | 'openai-compatible';

// ============================================
// Chat message shape (OpenAI-compatible wire format)
// ============================================

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ============================================
// Per-turn stream events emitted by the provider
// ============================================

export type LLMStreamEvent =
  | { type: 'content_delta'; delta: string }
  | { type: 'message_start' }
  | { type: 'message_end'; inputTokens: number; outputTokens: number }
  | { type: 'error'; message: string };

// ============================================
// Provider interface
// ============================================

/**
 * Minimal provider interface for the chat-only PoC.
 * Only chatStream() is required; tool-calling is explicitly out of scope for this path.
 */
export interface LLMProvider {
  /**
   * Stream a chat completion. Yields LLMStreamEvents until the response is complete.
   * Implementations MUST throw (or yield an error event) if the response contains
   * tool_calls, since tool-calling is unsupported on the openai-compatible path.
   */
  chatStream(
    messages: ChatMessage[],
    options: {
      model: string;
      maxTokens?: number;
      signal?: AbortSignal;
    },
  ): AsyncIterable<LLMStreamEvent>;
}

// ============================================
// OpenAI-compatible session (lightweight, no SDK Query)
// ============================================

/**
 * In-memory session for the openai-compatible path.
 * Each turn is an independent HTTP call; the session persists only for
 * eventBus pub/sub and TTL eviction state between turns.
 */
export interface OpenAISession {
  readonly breezeSessionId: string;
  readonly orgId: string;
  eventBus: SessionEventBus;
  state: 'initializing' | 'ready' | 'processing' | 'idle' | 'closing' | 'closed';
  lastActivityAt: number;
  readonly createdAt: number;
  auth: AuthContext;
  auditSnapshot: AuditSnapshot;
  /** Aborts the in-flight HTTP turn, if any */
  abortController: AbortController;
}
