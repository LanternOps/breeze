/**
 * Approval-handoff tool outcomes — the API half of the contract (#5107).
 *
 * The WIRE literal and its predicate live in `@breeze/shared`
 * (`utils/aiToolHandoff.ts`) because the web client renders them too; this
 * module adds only what is API-side (the text the model reads) and re-exports
 * the rest so the SDK files have one import. Keep it otherwise a LEAF — no
 * schema, no db, no service imports: the SDK suites mock `../db/schema`
 * partially and widening this graph breaks them with "No <x> export is defined
 * on the mock".
 *
 * ## Why this exists
 *
 * When a human approves a tier-3 action intent, the live chat session is NOT
 * always the side that executes it: the durable release worker
 * (`jobs/intentReleaseWorker.ts`) also consumes the `intent_approved` outbox
 * and races the session for the `approved -> executing` CAS. Two exits in
 * `createSessionPreToolUse` therefore hand the action off to that worker:
 *
 *   1. the tool is in `DURABLE_RELEASE_ONLY_TOOLS`, so the session declines
 *      the CAS on purpose, and
 *   2. the session attempted the CAS and LOST it to the worker.
 *
 * Both used to be reported to the model and the UI as `{ error: ... }` with
 * `isError: true`, so a user who had just approved on their phone read
 * `MANAGE_SERVICES · FAILED` in deny-red. That is not a failure: the action is
 * authorized and running, just somewhere else.
 *
 * These outcomes carry `status: 'approved_executing'` and are published with
 * `isError: false`. Clients switch on the STATUS FIELD — never on the message
 * text — so this stays a machine-readable contract rather than a string sniff.
 *
 * It is deliberately NOT a success either: the action has not completed and
 * this session will never observe its outcome (a completion event from the
 * worker back into the session is tracked separately, see #5107's out-of-scope
 * note). Anything that records a terminal result must therefore say which of
 * the two it is — see the audit event in `aiAgentSdk.ts`'s postToolUse, which
 * stamps `toolOutcome: 'approved_executing'` instead of claiming the tool ran.
 */

import {
  AI_TOOL_APPROVED_EXECUTING,
  isAiToolHandoffOutput,
  type AiToolHandoffStatus,
} from '@breeze/shared/utils/aiToolHandoff';

/** The one non-failure, non-success tool outcome. */
export const APPROVED_EXECUTING_STATUS = AI_TOOL_APPROVED_EXECUTING;

export type ToolHandoffStatus = AiToolHandoffStatus;

/**
 * The tool-result text the MODEL reads. It has to say three things: approved,
 * executing, and the outcome arrives separately — otherwise the model narrates
 * a failure (or, worse, retries the call).
 */
export const APPROVED_EXECUTING_MESSAGE =
  'Approved. This action is authorized and is being carried out by the approval worker now. ' +
  'It has not failed and must not be retried. Tell the user it is approved and running; ' +
  'its outcome is reported separately and is not available in this turn.';

/** The JSON payload published as the tool result for a handoff outcome. */
export interface ToolHandoffResult {
  status: ToolHandoffStatus;
  message: string;
}

export function buildToolHandoffResult(
  status: ToolHandoffStatus = APPROVED_EXECUTING_STATUS,
  message: string = APPROVED_EXECUTING_MESSAGE,
): ToolHandoffResult {
  return { status, message };
}

/**
 * True iff a parsed tool-result payload is an approval handoff. Re-exported
 * from `@breeze/shared` under the API's own name so callers here do not have
 * to know which side of the wire the predicate came from.
 */
export const isToolHandoffResult = isAiToolHandoffOutput;
