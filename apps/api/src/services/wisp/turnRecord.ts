/**
 * #10428 (W05): what one Wisp chat turn said and did, for the turn-end hooks
 * (wisp/turnEnd.ts). A leaf module with no imports, so the session manager and
 * the SDK post-tool hook can record into it without loading the Wisp graph.
 *
 * It lives on the ActiveSession only for the turn in flight: set when a turn
 * wins the session's slot, appended to by `createSessionPostToolUse` for Wisp
 * sessions only, and read synchronously at the turn's `result` (W08 adds the
 * assistant text).
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
};

/** A turn that runs more tools than this keeps the first ones; the turn-end hooks need only a few. */
export const WISP_TURN_TOOL_OUTCOMES_MAX = 64;
export const WISP_TURN_TOOL_OUTPUT_MAX_CHARS = 4_000;

export function beginWispTurn(userMessage: string, now: Date = new Date()): WispCurrentTurn {
  return { userMessage, startedAt: now, toolOutcomes: [] };
}

/** Append one tool outcome; a no-op past the cap. */
export function recordWispToolOutcome(turn: WispCurrentTurn, outcome: WispTurnToolOutcome): void {
  if (turn.toolOutcomes.length >= WISP_TURN_TOOL_OUTCOMES_MAX) return;
  turn.toolOutcomes.push({
    ...outcome,
    output: outcome.output.length > WISP_TURN_TOOL_OUTPUT_MAX_CHARS
      ? outcome.output.slice(0, WISP_TURN_TOOL_OUTPUT_MAX_CHARS)
      : outcome.output,
  });
}
