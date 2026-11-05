/**
 * #10390 — what a closed Wisp session leaves for the next one (Wisp design §6).
 *
 * Two steps, in this order:
 *  1. A deterministic digest of the session (what was asked, what was checked,
 *     the last answer without its closing question or offer) is stored at once.
 *     A session rotated right after the close is seeded before any model call
 *     could finish, so it must find something true.
 *  2. `refineThreadSummary` then replaces the digest with a model-written
 *     "Concluded / Open" note, when the grant opted in (`summary_refine`, default
 *     off) and a model call is allowed and works. Otherwise the digest stays.
 *
 * The session's closing line is never the summary: "Ask me to check back in
 * 5–10 minutes" carries nothing the next session can use. The assessment rollup
 * writes its own column (`updateThreadPicture`); the two never share one.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db';
import { aiMessages } from '../../db/schema/ai';
import { wispThreadSessions, wispThreads } from '../../db/schema/wispThreads';
import { captureException } from '../sentry';
import { inSystemContext } from './grantAuthority';
import { claimThreadSummary } from './threads';

/** The session summary's bound; the column's own CHECK is wider (4 000). */
export const THREAD_SUMMARY_MAX_CHARS = 1_500;
/** = the `wisp_threads_picture_len_chk` CHECK. */
export const THREAD_PICTURE_MAX_CHARS = 4_000;
const ELLIPSIS = '…';

const DIGEST_ASKED_MAX_CHARS = 300;
const DIGEST_CHECKED_MAX_CHARS = 200;
/** A session's newest messages, and how much of each; both only bound the read. */
const SESSION_MESSAGE_LIMIT = 200;
const SESSION_MESSAGE_MAX_CHARS = 8_000;

const SENTENCE_BREAK = /(?<=[.!?…])\s+/;
// A closing-line heuristic for the digest only, biased towards keeping text: a
// stray offer in the digest is harmless, a dropped conclusion is not. So "If you
// want X, set Y" stays; only "If you want, I can…" reads as an offer.
const ENDS_IN_QUESTION = /\?[)\]*_`]*$/;
const OPENS_AN_OFFER = /^(?:[-*•]\s+)?[*_`]*(?:(?:also|and|or|so),?\s+)?(?:ask me|let me know|want me to|would you like|do you want|shall i|should i|if you want me to|if you(?:'d| would)? (?:like|prefer|want)\b[^.]*\bi(?:'ll| can| could)\b|check back|i'll check back|feel free|happy to|just say|tell me)\b/i;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Deterministic: trim; at most `max` → unchanged. Otherwise cut at the last
 * whitespace in the final eighth of the window, else hard-cut at `max` − 1, and
 * append '…'. The result is ≤ `max` UTF-16 units (so ≤ `max` code points for a
 * CHECK) and never ends in half a surrogate pair.
 */
export function truncateSummary(text: string, max: number = THREAD_SUMMARY_MAX_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;

  const softCutMin = Math.floor(max * 0.875);
  const window = trimmed.slice(0, max);
  let cut = -1;
  for (let i = window.length - 1; i >= softCutMin; i -= 1) {
    if (/\s/.test(window[i]!)) { cut = i; break; }
  }
  let head: string;
  if (cut >= 0) {
    head = trimmed.slice(0, cut).trimEnd();
  } else {
    let end = max - 1;
    if (isHighSurrogate(trimmed.charCodeAt(end - 1))) end -= 1;
    head = trimmed.slice(0, end);
  }
  return `${head}${ELLIPSIS}`;
}

function isClosingLine(sentence: string): boolean {
  const s = sentence.trim();
  return ENDS_IN_QUESTION.test(s) || OPENS_AN_OFFER.test(s);
}

/** The reply on one line, without the questions and offers it closes on; '' when nothing else is left. */
function withoutClosingLines(content: string): string {
  const paragraphs = content.trim().split(/\n\s*\n/);
  while (paragraphs.length > 0) {
    const sentences = paragraphs[paragraphs.length - 1]!.trim().split(SENTENCE_BREAK);
    while (sentences.length > 0 && isClosingLine(sentences[sentences.length - 1]!)) sentences.pop();
    if (sentences.length > 0) {
      paragraphs[paragraphs.length - 1] = sentences.join(' ');
      break;
    }
    paragraphs.pop();
  }
  return paragraphs.join(' ').replace(/\s+/g, ' ').trim();
}

function toolCounts(messages: SessionMessage[]): string {
  const counts = new Map<string, number>();
  for (const m of messages) {
    if (m.role !== 'tool_use' || !m.toolName) continue;
    const name = m.toolName.replace(/^mcp__.+?__/, '');
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ');
}

export type SessionMessage = { role: string; content: string | null; toolName?: string | null };

/**
 * Pure and deterministic, messages oldest first. At most
 * THREAD_SUMMARY_MAX_CHARS:
 *
 *   Asked: <the last user message>
 *   Checked: <tool> ×<n>, <tool>
 *   Last answer: <the newest reply that says anything besides a question or offer>
 *
 * Absent parts are left out. Null when the session neither answered anything
 * nor ran a tool, so a stored summary survives a session that concluded nothing.
 */
export function digestFromMessages(messages: SessionMessage[]): string | null {
  let answer = '';
  let asked = '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    const content = m.content?.trim() ?? '';
    if (content === '') continue;
    if (asked === '' && m.role === 'user') asked = content.replace(/\s+/g, ' ');
    if (answer === '' && m.role === 'assistant') answer = withoutClosingLines(content);
    if (asked !== '' && answer !== '') break;
  }
  const checked = toolCounts(messages);
  if (answer === '' && checked === '') return null;

  const lines: string[] = [];
  if (asked !== '') lines.push(`Asked: ${truncateSummary(asked, DIGEST_ASKED_MAX_CHARS)}`);
  if (checked !== '') lines.push(`Checked: ${truncateSummary(checked, DIGEST_CHECKED_MAX_CHARS)}`);
  if (answer !== '') {
    const used = lines.reduce((sum, line) => sum + line.length + 1, 0);
    const label = 'Last answer: ';
    lines.push(`${label}${truncateSummary(answer, THREAD_SUMMARY_MAX_CHARS - used - label.length)}`);
  }
  return lines.join('\n');
}

/**
 * Close-out of one Wisp session. A no-op when the session is not attached to a
 * thread, concluded nothing, or lost the claim (`claimThreadSummary`). System
 * context for the reads and writes, because callers include the SDK background
 * processor and the eviction sweep, where no request context exists; none is
 * held across the model call. A failed model step is reported here and leaves
 * the digest; the caller's close is never affected by it.
 */
export async function finalizeWispSessionSummary(sessionId: string): Promise<{ updated: boolean }> {
  const claimed = await inSystemContext(async () => {
    const [link] = await db
      .select({ threadId: wispThreadSessions.threadId })
      .from(wispThreadSessions)
      .where(eq(wispThreadSessions.sessionId, sessionId))
      .limit(1);
    if (!link) return null;

    const newestFirst = await db
      .select({
        role: aiMessages.role,
        content: sql<string | null>`left(${aiMessages.content}, ${SESSION_MESSAGE_MAX_CHARS})`,
        toolName: aiMessages.toolName,
      })
      .from(aiMessages)
      .where(and(
        eq(aiMessages.sessionId, sessionId),
        inArray(aiMessages.role, ['user', 'assistant', 'tool_use']),
      ))
      .orderBy(desc(aiMessages.createdAt))
      .limit(SESSION_MESSAGE_LIMIT);
    const messages: SessionMessage[] = [...newestFirst].reverse();
    const digest = digestFromMessages(messages);
    if (digest === null) return null;

    const [thread] = await db
      .select({ summary: wispThreads.summary })
      .from(wispThreads)
      .where(eq(wispThreads.id, link.threadId))
      .limit(1);
    if (!thread) return null;

    if (!(await claimThreadSummary(link.threadId, sessionId, digest))) return null;
    return { threadId: link.threadId, previousSummary: thread.summary, messages };
  });
  if (!claimed) return { updated: false };

  try {
    // Lazy: keeps the model and billing graph out of this module's eager imports (threads.ts imports it).
    const { refineThreadSummary } = await import('./threadSummaryRefine');
    await refineThreadSummary({ sessionId, ...claimed });
  } catch (err) {
    console.error(`[wisp] thread summary model step failed for session ${sessionId}; the digest stays`, err);
    captureException(err, undefined, { op: 'wisp.thread_summary.refine' });
  }
  return { updated: true };
}
