/**
 * #10428 (W05) — the Wisp turn-end hooks, the one place the session manager's
 * `result` handler calls into for Wisp work at the end of a chat turn.
 *
 * Two halves, so nothing slow ever sits in front of `done`:
 *  - `runWispTurnEndBeforeDone` (awaited): deterministic and cheap. The
 *    standing-instruction prefilter over the technician's own message and, on
 *    a hit, a `pending` capture status whose id rides on `done`
 *    (`wispInstructionCapture`) so the chip knows to poll. Bounded by a short
 *    timeout; never throws. W08 adds its promise-linter correction here.
 *  - `scheduleWispTurnEndAfterDone` (fire-and-forget, after `done`): the grant
 *    spend notice (#10414; budget.chatNeverBlocks.contract.test.ts) and the
 *    extraction itself (instructionExtractor.ts). Everything it needs is
 *    snapshotted synchronously, because the next turn may start at once.
 *
 * Non-Wisp sessions never reach here, and with `wispEnabled()` off the capture
 * does nothing, so ordinary chat is unchanged.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { wispEnabled } from '../../config/env';
import { db } from '../../db';
import { aiMessages } from '../../db/schema/ai';
import { safeErrorMessage } from '../aiModels/safeDbError';
import { captureException } from '../sentry';
import type { ActiveSession } from '../streamingSessionManager';
import { maybeNotifyChatCrossedBudget } from './chatSpendCheck';
import { inSystemContext } from './grantAuthority';
import { beginInstructionCapture } from './instructionCaptureStatus';
import { prefilterInstruction } from './instructionPrefilter';
import type { WispTurnToolOutcome } from './turnRecord';

/** What `done` carries for a Wisp turn. */
export type WispDoneExtras = { wispInstructionCapture?: { captureId: string } };

/** The before-`done` work gives up after this long rather than hold the reply back. */
export const WISP_TURN_END_BEFORE_DONE_TIMEOUT_MS = 1_500;

/** The "already saved" clauses handed to the extractor (a turn rarely remembers more than one). */
const ALREADY_REMEMBERED_MAX = 10;

type Session = Pick<ActiveSession, 'breezeSessionId' | 'orgId' | 'auth' | 'wispGrant' | 'turnUserMessageId' | 'currentTurn'>;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function runWispTurnEndBeforeDone(session: Session): Promise<WispDoneExtras> {
  if (!session.wispGrant || !wispEnabled()) return {};
  const turn = session.currentTurn;
  if (!turn) return {};
  try {
    if (!prefilterInstruction(turn.userMessage).hit) return {};
    const captureId = randomUUID();
    const begun = await withTimeout(
      beginInstructionCapture({ captureId, userId: session.auth.user.id, sessionId: session.breezeSessionId }),
      WISP_TURN_END_BEFORE_DONE_TIMEOUT_MS,
      false,
    );
    return begun ? { wispInstructionCapture: { captureId } } : {};
  } catch (err) {
    console.warn('[wisp] turn-end instruction capture not started', { sessionId: session.breezeSessionId, error: safeErrorMessage(err) });
    return {};
  }
}

/**
 * The standing instructions the model saved itself this turn with a successful
 * `remember`. The extractor skips those clauses and keeps the rest (per clause,
 * not per turn).
 */
export function rememberedStandingInstructions(outcomes: readonly WispTurnToolOutcome[]): string[] {
  const out: string[] = [];
  for (const outcome of outcomes) {
    if (outcome.isError || outcome.toolName.replace(/^mcp__[a-z0-9_-]+?__/i, '') !== 'remember') continue;
    if (outcome.input.blockType !== 'standing_instruction') continue;
    try {
      const parsed: unknown = JSON.parse(outcome.output);
      if (parsed !== null && typeof parsed === 'object' && 'error' in parsed) continue;
    } catch {
      // Not JSON: a tool that answered in prose still ran.
    }
    const content = outcome.input.content;
    const text = content !== null && typeof content === 'object' && typeof (content as { text?: unknown }).text === 'string'
      ? (content as { text: string }).text
      : JSON.stringify(content ?? outcome.input.subjectKey ?? '');
    if (text.trim() !== '') out.push(text);
    if (out.length >= ALREADY_REMEMBERED_MAX) break;
  }
  return out;
}

/**
 * The assistant reply just before this turn's user message, for referents
 * ("reboot those"). Read by the anchor the route persisted; no anchor, no
 * reply (never a guess at which message came first).
 */
async function loadPreviousAssistantReply(sessionId: string, userMessageId: string | null): Promise<string | null> {
  if (!userMessageId) return null;
  const [row] = await inSystemContext(() => db
    .select({ content: aiMessages.content })
    .from(aiMessages)
    .where(and(
      eq(aiMessages.sessionId, sessionId),
      eq(aiMessages.role, 'assistant'),
      lt(aiMessages.createdAt, sql`(SELECT m.created_at FROM ai_messages m WHERE m.id = ${userMessageId} AND m.session_id = ${sessionId})`),
    ))
    .orderBy(desc(aiMessages.createdAt))
    .limit(1));
  return row?.content ?? null;
}

function report(op: string, err: unknown, orgId: string): void {
  console.warn(`[wisp] ${op} failed`, { error: safeErrorMessage(err) });
  captureException(err, undefined, { op, org_id: orgId });
}

export function scheduleWispTurnEndAfterDone(session: Session, extras: WispDoneExtras): void {
  const grant = session.wispGrant;
  if (!grant) return;
  const orgId = session.orgId;

  // #10414: a settled Wisp chat turn counts toward the grant's daily budget and
  // is never refused by it; tell the grantor (once per window) if spend has
  // reached the budget. Never awaited.
  void maybeNotifyChatCrossedBudget(grant.grantId).catch((err: unknown) => report('wisp.chat_spend_check', err, orgId));

  const captureId = extras.wispInstructionCapture?.captureId;
  const turn = session.currentTurn;
  if (!captureId || !turn) return;

  // Snapshot now: the next turn may replace currentTurn and the anchor at once.
  const snapshot = {
    captureId,
    grantId: grant.grantId,
    revisionId: grant.revisionId,
    sessionId: session.breezeSessionId,
    userId: session.auth.user.id,
    orgId,
    userMessage: prefilterInstruction(turn.userMessage).text,
    alreadyRemembered: rememberedStandingInstructions(turn.toolOutcomes),
    sourceMessageId: session.turnUserMessageId ?? null,
  };
  void (async () => {
    const previousReply = await loadPreviousAssistantReply(snapshot.sessionId, snapshot.sourceMessageId).catch((err: unknown) => {
      console.warn('[wisp] previous reply not read for instruction capture', { error: safeErrorMessage(err) });
      return null;
    });
    // Loaded lazily: the model-call graph is needed only on a prefilter hit.
    const { extractStandingInstructions } = await import('./instructionExtractor');
    await extractStandingInstructions({ ...snapshot, previousReply });
  })().catch((err: unknown) => report('wisp.instruction_capture', err, orgId));
}
