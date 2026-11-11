/**
 * #10428 (W05) — the Wisp turn-end hooks, the one place the session manager's
 * `result` handler calls into for Wisp work at the end of a chat turn.
 *
 * Two halves, so nothing slow ever sits in front of `done`:
 *  - `runWispTurnEndBeforeDone` (awaited): deterministic and cheap. The
 *    promise linter (#10427): a reply that promised a follow-up, a dispatch or
 *    a concern change no tool result backs gets one server-written correction
 *    message, persisted and streamed before `done`. Then the
 *    standing-instruction prefilter over the technician's own message and, on
 *    a hit, a `pending` capture status whose id rides on `done`
 *    (`wispInstructionCapture`) so the chip knows to poll. The Redis write is
 *    bounded by a short timeout; failures are swallowed (reported), never
 *    thrown.
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
import type { AiStreamEvent } from '@breeze/shared';
import { wispEnabled } from '../../config/env';
import { db, withDbAccessContext } from '../../db';
import { aiMessages } from '../../db/schema/ai';
import { safeErrorMessage } from '../aiModels/safeDbError';
import { captureException } from '../sentry';
import type { ActiveSession } from '../streamingSessionManager';
import { incWispPromiseCorrection } from '../wispMetrics';
import { maybeNotifyChatCrossedBudget } from './chatSpendCheck';
import { inSystemContext } from './grantAuthority';
import { beginInstructionCapture, finishInstructionCapture } from './instructionCaptureStatus';
import { prefilterInstruction } from './instructionPrefilter';
import { turnEvidenceFrom } from './dispatchEvidence';
import { lintTurnPromises } from './promiseLinter';
import type { WispTurnToolOutcome } from './turnRecord';

/** What `done` carries for a Wisp turn (the shared event's Wisp fields). */
export type WispDoneExtras = Pick<Extract<AiStreamEvent, { type: 'done' }>, 'wispInstructionCapture'>;

/** The before-`done` work gives up after this long rather than hold the reply back. */
export const WISP_TURN_END_BEFORE_DONE_TIMEOUT_MS = 1_500;

/** The "already saved" clauses handed to the extractor (a turn rarely remembers more than one). */
const ALREADY_REMEMBERED_MAX = 10;

type Session = Pick<ActiveSession, 'breezeSessionId' | 'orgId' | 'auth' | 'wispGrant' | 'turnUserMessageId' | 'currentTurn' | 'eventBus'>;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve(fallback);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * #10427: one complete server-written assistant message (the `publishRefusal`
 * precedent in streamingSessionManager.ts): persisted, then streamed as
 * `message_start` / `content_delta` / `message_end`. At most once per turn. A
 * persist that fails or is slow is reported and the correction still streams.
 */
export async function publishTurnCorrection(session: Session, text: string): Promise<void> {
  const turn = session.currentTurn;
  if (!turn || turn.correctionPublished) return;
  turn.correctionPublished = true;
  const orgId = session.orgId;
  // The failure handler is attached before the race, so a persist that fails
  // after the timeout has given up waiting is still reported, never dropped.
  const persisted = withDbAccessContext(
    { scope: 'organization', orgId, accessibleOrgIds: [orgId] },
    () => db.insert(aiMessages).values({ sessionId: session.breezeSessionId, role: 'assistant', content: text }),
  ).then(
    () => undefined,
    (err: unknown) => report('wisp.promise_correction.persist', err, orgId),
  );
  await withTimeout(persisted, WISP_TURN_END_BEFORE_DONE_TIMEOUT_MS, undefined, () => {
    report('wisp.promise_correction.persist_timeout', new Error('promise correction not persisted in time'), orgId);
  });
  session.eventBus.publish({ type: 'message_start', messageId: randomUUID() });
  session.eventBus.publish({ type: 'content_delta', delta: text });
  session.eventBus.publish({ type: 'message_end', inputTokens: 0, outputTokens: 0 });
}

/** #10427: lint the finished reply against this turn's tool results; never throws. */
async function correctUnbackedPromises(session: Session): Promise<void> {
  const turn = session.currentTurn;
  if (!turn || turn.correctionPublished || turn.assistantText.trim() === '') return;
  try {
    const { corrections, classes } = lintTurnPromises(turn.assistantText, turnEvidenceFrom(turn.toolOutcomes));
    if (corrections.length === 0) return;
    for (const cls of classes) incWispPromiseCorrection(cls);
    await publishTurnCorrection(session, corrections.join('\n'));
  } catch (err) {
    report('wisp.promise_correction', err, session.orgId);
  }
}

export async function runWispTurnEndBeforeDone(session: Session): Promise<WispDoneExtras> {
  if (!session.wispGrant || !wispEnabled()) return {};
  const turn = session.currentTurn;
  if (!turn) return {};
  await correctUnbackedPromises(session);
  try {
    if (!prefilterInstruction(turn.userMessage).hit) return {};
    const captureId = randomUUID();
    const begun = await withTimeout(
      beginInstructionCapture({ captureId, userId: session.auth.user.id, sessionId: session.breezeSessionId }),
      WISP_TURN_END_BEFORE_DONE_TIMEOUT_MS,
      false,
      () => console.warn('[wisp] turn-end instruction capture not started: Redis too slow', { sessionId: session.breezeSessionId }),
    );
    return begun ? { wispInstructionCapture: { captureId } } : {};
  } catch (err) {
    report('wisp.instruction_capture.begin', err, session.orgId);
    return {};
  }
}

/**
 * The standing instructions the model saved itself this turn with a successful
 * `remember`. The extractor's prompt asks it to skip those clauses and keep the
 * rest (per clause, not per turn); best-effort, not enforced.
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

function report(op: string, err: unknown, orgId: string, captureId?: string): void {
  console.warn(`[wisp] ${op} failed`, { captureId, error: safeErrorMessage(err) });
  captureException(err, undefined, { op, org_id: orgId, ...(captureId ? { capture_id: captureId } : {}) });
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
  if (!captureId) return;
  // Anything that stops the extraction from starting records `failed`, so the
  // chip stops polling instead of waiting out the status key's hour.
  const fail = (op: string, err: unknown) => {
    report(op, err, orgId, captureId);
    void finishInstructionCapture(captureId, 'failed').catch((finishErr: unknown) => {
      console.warn('[wisp] instruction capture status not recorded', { captureId, error: safeErrorMessage(finishErr) });
    });
  };
  if (!turn) {
    fail('wisp.instruction_capture.schedule', new Error('no turn record for a started capture'));
    return;
  }

  // Snapshot now: the next turn may replace currentTurn and the anchor at once.
  let snapshot;
  try {
    snapshot = {
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
  } catch (err) {
    fail('wisp.instruction_capture.schedule', err);
    return;
  }
  const work = snapshot;
  void (async () => {
    const previousReply = await loadPreviousAssistantReply(work.sessionId, work.sourceMessageId).catch((err: unknown) => {
      console.warn('[wisp] previous reply not read for instruction capture', { captureId, error: safeErrorMessage(err) });
      return null;
    });
    // Loaded lazily: the model-call graph is needed only on a prefilter hit.
    let extract;
    try {
      ({ extractStandingInstructions: extract } = await import('./instructionExtractor'));
    } catch (err) {
      fail('wisp.instruction_capture.load', err);
      return;
    }
    // Never throws; records its own outcome.
    await extract({ ...work, previousReply });
  })().catch((err: unknown) => report('wisp.instruction_capture', err, orgId, captureId));
}
