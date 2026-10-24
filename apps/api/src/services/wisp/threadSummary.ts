/**
 * Wisp W04 — the deterministic thread summary (Wisp design §6; w00 "Threads
 * (W04)"). No model call: the summary a new session inherits is the last
 * paragraph of the previous session's last assistant reply, truncated to the
 * column's 4 000-character CHECK. The model-written `update_thread_summary`
 * tool is out of scope for W04.
 */
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { aiMessages } from '../../db/schema/ai';
import { wispThreadSessions, wispThreads } from '../../db/schema/wispThreads';
import { inSystemContext } from './grantAuthority';
import { updateThreadSummary } from './threads';

/** = the `wisp_threads_summary_len_chk` CHECK (char_length(summary) <= 4000). */
export const THREAD_SUMMARY_MAX_CHARS = 4_000;
/** A whitespace cut is preferred when it keeps at least this much. */
const SOFT_CUT_MIN = 3_500;
const ELLIPSIS = '…';

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Deterministic: trim; at most 4 000 → unchanged. Otherwise cut at the last
 * whitespace at index ≥ 3 500 (within the first 4 000 units), else hard-cut at
 * 3 999, and append '…'. The result is ≤ 4 000 UTF-16 units (so ≤ 4 000 code
 * points for the CHECK) and never ends in half a surrogate pair.
 */
export function truncateSummary(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= THREAD_SUMMARY_MAX_CHARS) return trimmed;

  const window = trimmed.slice(0, THREAD_SUMMARY_MAX_CHARS);
  let cut = -1;
  for (let i = window.length - 1; i >= SOFT_CUT_MIN; i -= 1) {
    if (/\s/.test(window[i]!)) { cut = i; break; }
  }
  let head: string;
  if (cut >= 0) {
    head = trimmed.slice(0, cut).trimEnd();
  } else {
    let end = THREAD_SUMMARY_MAX_CHARS - 1;
    if (isHighSurrogate(trimmed.charCodeAt(end - 1))) end -= 1;
    head = trimmed.slice(0, end);
  }
  return `${head}${ELLIPSIS}`;
}

/**
 * The last `assistant` message with non-empty content → its last paragraph
 * (paragraphs split on blank lines), trimmed; null when there is none.
 */
export function summaryFromMessages(messages: Array<{ role: string; content: string | null }>): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role !== 'assistant' || typeof m.content !== 'string') continue;
    const content = m.content.trim();
    if (content === '') continue;
    const paragraphs = content.split(/\n\s*\n/);
    const last = paragraphs[paragraphs.length - 1]!.trim();
    if (last !== '') return last;
  }
  return null;
}

/**
 * Close-out of one Wisp session: recompute the thread summary from THAT
 * session's messages only. A no-op when the session is not attached to a
 * thread; idempotent (writes only when the truncated summary differs from the
 * stored one). System context throughout — callers include the SDK background
 * processor and the eviction sweep, where no request context exists.
 */
export async function finalizeWispSessionSummary(sessionId: string): Promise<{ updated: boolean }> {
  return inSystemContext(async () => {
    const [link] = await db
      .select({ threadId: wispThreadSessions.threadId })
      .from(wispThreadSessions)
      .where(eq(wispThreadSessions.sessionId, sessionId))
      .limit(1);
    if (!link) return { updated: false };

    // Only the newest assistant message with visible content can become the
    // summary, so read just that row (same result as feeding every message,
    // ordered by created_at, to summaryFromMessages; bounded read).
    const messages = await db
      .select({ role: aiMessages.role, content: aiMessages.content })
      .from(aiMessages)
      .where(and(
        eq(aiMessages.sessionId, sessionId),
        eq(aiMessages.role, 'assistant'),
        isNotNull(aiMessages.content),
        // Any non-whitespace character (PG regex \S), matching the trim() below.
        sql`${aiMessages.content} ~ '\\S'`,
      ))
      .orderBy(desc(aiMessages.createdAt))
      .limit(1);
    const computed = summaryFromMessages(messages);
    if (computed === null) return { updated: false };

    const [thread] = await db
      .select({ summary: wispThreads.summary })
      .from(wispThreads)
      .where(eq(wispThreads.id, link.threadId))
      .limit(1);
    if (!thread || truncateSummary(computed) === thread.summary) return { updated: false };

    await updateThreadSummary(link.threadId, computed);
    return { updated: true };
  });
}
