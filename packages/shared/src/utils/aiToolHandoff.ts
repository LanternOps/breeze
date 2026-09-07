/**
 * The approval-handoff tool outcome, shared by the API that publishes it and
 * the clients that render it (#5107).
 *
 * When a human approves a tier-3 action intent, the live chat session is not
 * always the side that runs it — the durable release worker may win the
 * `approved -> executing` CAS, or the tool may be worker-only by policy. The
 * session then reports "I did not run this", which used to reach the chat as
 * an ERROR: a user who had just tapped Approve on their phone read
 * `MANAGE_SERVICES · FAILED` in deny-red.
 *
 * That outcome is neither a failure nor a completion. It is published with
 * `isError: false` and this status on the tool result, and clients switch on
 * the STATUS FIELD — never on the message text, which is what the mobile
 * DENIED heuristic still has to do for rejections and what this contract
 * exists to avoid.
 *
 * `apps/mobile` mirrors this literal in
 * `screens/chat/components/toolIndicatorLogic.ts` rather than importing it —
 * the mobile app has no `@breeze/shared` dependency on purpose.
 */

/** Approved by a human; being executed by the durable approval worker. */
export const AI_TOOL_APPROVED_EXECUTING = 'approved_executing' as const;

export type AiToolHandoffStatus = typeof AI_TOOL_APPROVED_EXECUTING;

export interface AiToolHandoffOutput {
  status: AiToolHandoffStatus;
  message?: string;
}

/**
 * True iff a tool result payload is an approval handoff.
 *
 * Deliberately shape-based, not text-based: a tool whose output merely
 * mentions the phrase must not be re-coloured.
 */
export function isAiToolHandoffOutput(output: unknown): output is AiToolHandoffOutput {
  return (
    typeof output === 'object' &&
    output !== null &&
    (output as { status?: unknown }).status === AI_TOOL_APPROVED_EXECUTING
  );
}
