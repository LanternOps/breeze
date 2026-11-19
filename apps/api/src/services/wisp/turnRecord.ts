/**
 * #10428 (W05): what one Wisp chat turn said and did, for the turn-end hooks
 * (wisp/turnEnd.ts). A leaf module with no imports, so the session manager and
 * the SDK post-tool hook can record into it without loading the Wisp graph.
 *
 * It lives on the ActiveSession only for the turn in flight: set when a turn
 * wins the session's slot, appended to by `createSessionPostToolUse` for Wisp
 * sessions only, and read synchronously at the turn's `result`.
 */

export type WispTurnToolOutcome = {
  toolName: string;
  input: Record<string, unknown>;
  isError: boolean;
  /** Capped at WISP_TURN_TOOL_OUTPUT_MAX_CHARS. */
  output: string;
};

export type WispCurrentTurn = {
  /** The technician's own text for this turn (never the check-in block, the continuation summary or run results). */
  userMessage: string;
  startedAt: Date;
  toolOutcomes: WispTurnToolOutcome[];
  /**
   * #10427 (W08): the reply text streamed this turn, for the promise linter.
   * Appended by the session manager's `text_delta` handler; capped at
   * WISP_TURN_ASSISTANT_TEXT_MAX_CHARS.
   */
  assistantText: string;
  /** #10427: a promise correction went out for this turn (at most one per turn). */
  correctionPublished: boolean;
};

/** A turn that runs more tools than this keeps the first ones; the turn-end hooks need only a few. */
export const WISP_TURN_TOOL_OUTCOMES_MAX = 64;
export const WISP_TURN_TOOL_OUTPUT_MAX_CHARS = 4_000;
/** A reply longer than this is linted on its first part only. */
export const WISP_TURN_ASSISTANT_TEXT_MAX_CHARS = 32_000;
/** A larger tool input (a script body) is not kept; the hooks need only small ones (`remember` is ≤ 8 KiB). */
export const WISP_TURN_TOOL_INPUT_MAX_CHARS = 16_384;

function boundedInput(input: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.stringify(input).length <= WISP_TURN_TOOL_INPUT_MAX_CHARS ? input : { truncated: true };
  } catch {
    return { truncated: true };
  }
}

export function beginWispTurn(userMessage: string, now: Date = new Date()): WispCurrentTurn {
  return { userMessage, startedAt: now, toolOutcomes: [], assistantText: '', correctionPublished: false };
}

/** Append streamed reply text; a no-op past the cap. */
export function appendWispAssistantText(turn: WispCurrentTurn, text: string): void {
  const room = WISP_TURN_ASSISTANT_TEXT_MAX_CHARS - turn.assistantText.length;
  if (room <= 0 || text === '') return;
  turn.assistantText += text.length > room ? text.slice(0, room) : text;
}

/** Append one tool outcome; a no-op past the cap. */
export function recordWispToolOutcome(turn: WispCurrentTurn, outcome: WispTurnToolOutcome): void {
  if (turn.toolOutcomes.length >= WISP_TURN_TOOL_OUTCOMES_MAX) return;
  turn.toolOutcomes.push({
    ...outcome,
    input: boundedInput(outcome.input),
    output: outcome.output.length > WISP_TURN_TOOL_OUTPUT_MAX_CHARS
      ? outcome.output.slice(0, WISP_TURN_TOOL_OUTPUT_MAX_CHARS)
      : outcome.output,
  });
}
