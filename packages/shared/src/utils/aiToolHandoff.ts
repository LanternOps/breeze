/**
 * The post-approval tool outcomes, shared by the API that publishes them and
 * the clients that render them (#5107, extended by #6022).
 *
 * When a human approves a tier-3 action intent, the live chat session is not
 * always the side that runs it — the durable release worker may win the
 * `approved -> executing` CAS, or the tool may be worker-only by policy. The
 * session then reports "I did not run this", which used to reach the chat as
 * an ERROR: a user who had just tapped Approve on their phone read
 * `MANAGE_SERVICES · FAILED` in deny-red.
 *
 * #5107 fixed that with ONE status, `approved_executing`, published with
 * `isError: false`. It also left the session with no way to learn what the
 * worker eventually did — so when the worker's execution FAILED (issue #6022:
 * the #5934 autoInstall guardrail refused the call, leaving the intent
 * `failed` / `tool_returned_error`), the chat still said "Approved · running"
 * and the model told the operator the action had succeeded. The operator was
 * told the opposite of the truth.
 *
 * The session now reads the intent's terminal outcome back within a bounded
 * budget, so the same channel carries three distinct outcomes:
 *
 *   - `approved_executing` — no terminal outcome observed inside the budget.
 *     Authorized and still running; the turn does NOT know whether it worked.
 *   - `approved_completed` — the worker ran it and it completed.
 *   - `approved_failed`   — the worker ran it and it did NOT take effect.
 *
 * Clients switch on the STATUS FIELD — never on the message text, which is
 * what the mobile DENIED heuristic still has to do for rejections and what
 * this contract exists to avoid. `approved_failed` is the one status published
 * with `isError: true`; use `aiToolHandoffIsError` rather than re-deriving it,
 * because a client that treats the handoff marker as "not an error" (as
 * `AiToolCallCard` did) would otherwise paint a real failure as running.
 *
 * `apps/mobile` mirrors these literals in
 * `screens/chat/components/toolIndicatorLogic.ts` rather than importing them —
 * the mobile app has no `@breeze/shared` dependency on purpose.
 */

/** Approved by a human; still being executed by the durable approval worker. */
export const AI_TOOL_APPROVED_EXECUTING = 'approved_executing' as const;

/** Approved by a human; the durable approval worker ran it to completion. */
export const AI_TOOL_APPROVED_COMPLETED = 'approved_completed' as const;

/**
 * Approved by a human, then terminated without taking effect — the worker's
 * execution failed, or the intent was rejected/expired/cancelled before it
 * ran. Published with `isError: true`.
 */
export const AI_TOOL_APPROVED_FAILED = 'approved_failed' as const;

export const AI_TOOL_HANDOFF_STATUSES = [
  AI_TOOL_APPROVED_EXECUTING,
  AI_TOOL_APPROVED_COMPLETED,
  AI_TOOL_APPROVED_FAILED,
] as const;

export type AiToolHandoffStatus = (typeof AI_TOOL_HANDOFF_STATUSES)[number];

export interface AiToolHandoffOutput {
  status: AiToolHandoffStatus;
  message?: string;
}

/**
 * True iff a tool result payload is a post-approval handoff outcome.
 *
 * Deliberately shape-based, not text-based: a tool whose output merely
 * mentions the phrase must not be re-coloured.
 */
export function isAiToolHandoffOutput(output: unknown): output is AiToolHandoffOutput {
  return (
    typeof output === 'object' &&
    output !== null &&
    AI_TOOL_HANDOFF_STATUSES.includes((output as { status?: AiToolHandoffStatus }).status as AiToolHandoffStatus)
  );
}

/**
 * Whether a handoff outcome is a failure. The ONE place that decides it, so
 * the API's `isError` and every client's colouring cannot disagree (#6022).
 */
export function aiToolHandoffIsError(status: AiToolHandoffStatus): boolean {
  return status === AI_TOOL_APPROVED_FAILED;
}
