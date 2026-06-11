/**
 * Reconstructs a chat history for the openai-compatible path from the ai_messages DB table.
 *
 * The Anthropic SDK manages session state internally (via its subprocess). vLLM has no
 * server-side session, so we must replay the conversation on each turn.
 *
 * Scope: user and assistant text messages only. Tool-use messages are not supported on
 * this path. If the history contains tool_use or tool_result rows, this function throws
 * so the caller can surface an explicit error rather than silently losing context.
 *
 * Important (openai-compatible turn construction): During an HTTP handler, OpenAISessionManager
 * persists the newest user row in the auth middleware transaction, then invokes
 * buildMessagesFromHistory from runTurn after runOutsideDbContext. That SELECT runs in another
 * transaction and cannot see the uncommitted INSERT, so committed history returned here
 * intentionally omits the *current* user message. Callers MUST append that message from
 * sanitized in-memory content (parallel to Anthropic: DB persistence + pushMessage to the SDK).
 * If the isolation model ever changes so buildMessagesFromHistory could see that same row, the
 * caller would duplicate the last user message and must reconcile explicitly.
 */

import { db, withDbAccessContext } from '../../db';
import { aiMessages } from '../../db/schema';
import { eq, asc } from 'drizzle-orm';
import type { ChatMessage } from './types';

export class ToolUseInHistoryError extends Error {
  constructor(sessionId: string) {
    super(
      `Session ${sessionId} contains tool-use messages incompatible with the openai-compatible provider. ` +
      'Start a new session or switch back to the Anthropic backend.',
    );
    this.name = 'ToolUseInHistoryError';
  }
}

/**
 * Load and map ai_messages for a session into ChatMessage[].
 * Throws ToolUseInHistoryError if any tool_use or tool_result row is present.
 *
 * The system prompt is NOT included here; the caller prepends it as the first message.
 */
export async function buildMessagesFromHistory(
  sessionId: string,
  orgId: string,
): Promise<ChatMessage[]> {
  const rows = await withDbAccessContext(
    { scope: 'organization', orgId, accessibleOrgIds: [orgId] },
    () =>
      db
        .select({
          role: aiMessages.role,
          content: aiMessages.content,
        })
        .from(aiMessages)
        .where(eq(aiMessages.sessionId, sessionId))
        .orderBy(asc(aiMessages.createdAt)),
  );

  const messages: ChatMessage[] = [];

  for (const row of rows) {
    if (row.role === 'tool_use' || row.role === 'tool_result') {
      throw new ToolUseInHistoryError(sessionId);
    }

    // Skip system rows (stored by some flows, not part of the chat turn history)
    if (row.role === 'system') continue;

    // Skip assistant rows with no text content (e.g. pure tool-use assistant turns)
    if (row.role === 'assistant' && !row.content) continue;

    // Skip user rows with no content (shouldn't happen, but defensive)
    if (row.role === 'user' && !row.content) continue;

    messages.push({
      role: row.role as 'user' | 'assistant',
      content: row.content ?? '',
    });
  }

  return messages;
}
