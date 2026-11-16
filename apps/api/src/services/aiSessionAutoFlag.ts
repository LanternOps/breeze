/**
 * The flag the platform puts on a chat session when one of its tool calls
 * fails (`Tool failed: <tool> — <error>` from postToolUse, `Tool rejected
 * before execution: …` from the dropped-call fallback in
 * streamingSessionManager.ts; both read back by the quality report through
 * AUTO_FLAG_REASON_PREFIXES in aiModels/qualityQueries.ts).
 *
 * #11968: a call refused because its input did not fit the tool (our schema
 * refusal `Invalid input: …`, a coordinator `invalid_params`, or the MCP SDK's
 * `Input validation error` before our handler runs) is one the model can
 * correct, and usually does on its next call. Flagging the session on the
 * refusal itself marked whole sessions for a failure the model had already
 * recovered from. So that refusal is held until the turn ends: a later
 * successful call to the same tool in the turn drops it, and whatever is still
 * held when the turn ends is written then. Any other failure flags at once.
 *
 * Known trade-offs, accepted because these refusals are model input mistakes
 * rather than platform failures:
 *  - A success is matched by tool name only (the corrected retry carries
 *    different arguments by design). So a later success of the same tool on
 *    another target or action also drops the hold, and a coordinator
 *    `invalid_params` the model could not fix is dropped only if a later call
 *    to that tool succeeds anyway.
 *  - Calls are matched in arrival order, so a refusal whose parallel sibling
 *    succeeded first is still flagged.
 *  - The hold lives in process memory. If the API process dies mid-turn, an
 *    uncorrected refusal is not flagged.
 *
 * Only the first flag ever lands (`flagged_at IS NULL`), so a session keeps
 * the reason it was first flagged for.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db, withDbAccessContext } from '../db';
import { aiSessions } from '../db/schema';
import { captureException } from './sentry';

/**
 * One platform-written flag. Each writer spells its reason as a template
 * literal on a flagReason key, which is how autoFlagReasons.contract.test.ts
 * finds it and checks its prefix.
 */
export interface SessionAutoFlag {
  flagReason: string;
}

/** A refusal held until the end of the turn, keyed by tool name. */
export interface DeferredToolFailureFlag extends SessionAutoFlag {
  /** When the refused call came back; written as `flagged_at` if it is never corrected. */
  failedAt: Date;
}

/** The session state this module reads and writes. */
export interface AutoFlagSession {
  breezeSessionId: string;
  orgId: string;
  /** Refusals held this turn; cleared when the turn's flags are flushed. */
  deferredToolFailureFlags?: Map<string, DeferredToolFailureFlag>;
}

/**
 * True for a refusal the model can fix by changing its arguments: the schema
 * refusal `validateToolInput` writes (aiToolSchemas.ts) and the coordinator's
 * `invalid_params` (wisp/coordinator.ts). Read from the tool result's `error`
 * field only, never from free text, so no other failure is softened by
 * accident.
 */
export function isCorrectableInputRefusal(error: unknown): boolean {
  return typeof error === 'string' && (error === 'invalid_params' || error.startsWith('Invalid input: '));
}

/**
 * The MCP SDK's own refusal of arguments that do not match the tool's
 * advertised input schema (@modelcontextprotocol/sdk server/mcp.js, JSON-RPC
 * -32602), which reaches us only as the text of a dropped tool_result.
 */
export function isMcpInputValidationErrorText(text: string): boolean {
  return text.includes('Input validation error: Invalid arguments for tool ');
}

/**
 * Hold a correctable refusal's flag until the turn ends. The first refusal per
 * tool is kept; a later successful call to the tool drops it.
 */
export function holdToolFailureFlag(session: AutoFlagSession, toolName: string, flag: SessionAutoFlag): void {
  const deferred = (session.deferredToolFailureFlags ??= new Map());
  if (!deferred.has(toolName)) deferred.set(toolName, { flagReason: flag.flagReason, failedAt: new Date() });
}

/**
 * Flag the session now (first flag only). Never throws: a failed write is
 * reported and logged.
 */
export async function flagSessionNow(session: AutoFlagSession, flag: SessionAutoFlag): Promise<void> {
  await writeSessionAutoFlag(session, flag.flagReason, new Date());
}

/**
 * Record one tool call's outcome for the session's auto-flag. A success drops
 * any refusal held for the same tool; a correctable refusal is held (the first
 * one per tool is kept); any other failure flags the session now.
 */
export async function recordToolOutcomeForAutoFlag(
  session: AutoFlagSession,
  toolName: string,
  outcome: { isError: boolean; errorCode: unknown; errorMsg: string },
): Promise<void> {
  if (!outcome.isError) {
    session.deferredToolFailureFlags?.delete(toolName);
    return;
  }
  const flag: SessionAutoFlag = { flagReason: `Tool failed: ${toolName} — ${outcome.errorMsg}` };
  if (isCorrectableInputRefusal(outcome.errorCode)) {
    holdToolFailureFlag(session, toolName, flag);
    return;
  }
  await flagSessionNow(session, flag);
}

/**
 * End of turn: flag the session for the first refusal the model did not
 * correct, and clear what was held. A no-op when nothing is held. Never throws.
 */
export async function flushDeferredToolFailureFlags(session: AutoFlagSession): Promise<void> {
  const deferred = session.deferredToolFailureFlags;
  if (!deferred || deferred.size === 0) return;
  const first = deferred.values().next().value as DeferredToolFailureFlag;
  deferred.clear();
  await writeSessionAutoFlag(session, first.flagReason, first.failedAt);
}

async function writeSessionAutoFlag(session: AutoFlagSession, flagReason: string, flaggedAt: Date): Promise<void> {
  try {
    await withDbAccessContext(
      { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
      () =>
        db.update(aiSessions)
          .set({ flaggedAt, flagReason })
          .where(and(
            eq(aiSessions.id, session.breezeSessionId),
            isNull(aiSessions.flaggedAt),
          )),
    );
  } catch (err) {
    captureException(err);
    console.error('[AI-SDK] Failed to auto-flag session:', session.breezeSessionId, err instanceof Error ? err.message : err);
  }
}
