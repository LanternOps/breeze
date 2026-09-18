/**
 * Approval-handoff tool outcomes — the API half of the contract (#5107).
 *
 * The WIRE literal and its predicate live in `@breeze/shared`
 * (`utils/aiToolHandoff.ts`) because the web client renders them too; this
 * module adds only what is API-side (the text the model reads) and re-exports
 * the rest so the SDK files have one import. Keep it otherwise a LEAF — no
 * schema, no db, no service imports: the SDK suites mock `../db/schema`
 * partially and widening this graph breaks them with "No <x> export is defined
 * on the mock". (`@breeze/shared` is exempt: it carries no db/schema, and
 * `aiAgentSdkTools.ts` already pulls the same barrel.)
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
 * These outcomes carry a `status` and are published with `isError` derived
 * from it. Clients switch on the STATUS FIELD — never on the message text — so
 * this stays a machine-readable contract rather than a string sniff.
 *
 * ## #6022 — the outcome read-back
 *
 * #5107 shipped ONE status, `approved_executing`, whose message promised the
 * outcome was "reported separately". Nothing reported it. When the worker's
 * execution then FAILED — the #5934 autoInstall guardrail refusing the call,
 * leaving the intent `failed` / `tool_returned_error` — the chat still read
 * "Approved · running" and the model told the operator the install-arming had
 * succeeded. The operator was told the opposite of the truth (#6022).
 *
 * The two handoff exits now READ the intent's terminal outcome back within a
 * bounded budget (`waitForIntentTerminalOutcome`, called from `aiAgentSdk.ts`)
 * and map it here via `describeIntentOutcome`, producing one of three
 * statuses: `approved_executing` (no terminal outcome observed inside the
 * budget), `approved_completed`, or `approved_failed`. The read-back is
 * strictly an OBSERVER: it never releases, retries, cancels or terminalizes
 * the intent, so the coordination invariant (the CAS winner is the only
 * executor) is untouched. A late outcome — the worker still running when the
 * budget expires — stays unreported in this turn and is left to the durable
 * next-turn reconciliation tracked separately; `approved_executing` now says
 * so honestly instead of promising a report that never comes.
 *
 * Anything that records a terminal result must say which outcome it is — see
 * the audit event in `aiAgentSdk.ts`'s postToolUse, which stamps `toolOutcome`
 * with the handoff status instead of claiming the tool ran here.
 */

// Package ROOT, not `@breeze/shared/utils/aiToolHandoff`. The deep subpath is
// absent from packages/shared's `exports` map, so Node refuses to resolve it —
// and this is a VALUE import, which is why it fails at runtime rather than
// being erased the way the neighbouring `import type ... from
// '@breeze/shared/types/ai'` deep paths are. The unit job resolves the package
// from source and never noticed; the integration config goes through the
// exports map and three suites died at module load.
import {
  AI_TOOL_APPROVED_COMPLETED,
  AI_TOOL_APPROVED_EXECUTING,
  AI_TOOL_APPROVED_FAILED,
  aiToolHandoffIsError,
  isAiToolHandoffOutput,
  type AiToolHandoffStatus,
} from '@breeze/shared';

/** Approved and still running — the one non-failure, non-success outcome. */
export const APPROVED_EXECUTING_STATUS = AI_TOOL_APPROVED_EXECUTING;
/** Approved, and the worker ran it to completion. */
export const APPROVED_COMPLETED_STATUS = AI_TOOL_APPROVED_COMPLETED;
/** Approved, then terminated without taking effect. */
export const APPROVED_FAILED_STATUS = AI_TOOL_APPROVED_FAILED;

export type ToolHandoffStatus = AiToolHandoffStatus;

/** Re-exported so `isError` is decided in exactly one place (#6022). */
export const handoffIsError = aiToolHandoffIsError;

/**
 * The tool-result text the MODEL reads. It has to say three things: approved,
 * executing, and the outcome arrives separately — otherwise the model narrates
 * a failure (or, worse, retries the call).
 */
export const APPROVED_EXECUTING_MESSAGE =
  'Approved. This action is authorized and is being carried out by the approval worker now. ' +
  'It must not be retried. Its outcome is NOT yet confirmed and is not available in this turn: ' +
  'tell the user it is approved and still running, and do not claim that it succeeded or took effect.';

/**
 * The tool-result text for an action the worker ran to completion.
 *
 * Deliberately claims completion and NOTHING else. The intent's stored
 * `result` can hold sealed secret material (`actionIntents/resultSecrets.ts`),
 * so this read-back path never splices it into the transcript — the reveal-once
 * endpoint owns that.
 */
export const APPROVED_COMPLETED_MESSAGE =
  'Approved. The approval worker carried this action out and it COMPLETED successfully. ' +
  'The detailed result is not available in this turn — report only that it completed.';

/** The JSON payload published as the tool result for a handoff outcome. */
export interface ToolHandoffResult {
  status: ToolHandoffStatus;
  message: string;
}

/**
 * The pre-tool-use decision for an approval handoff.
 *
 * The ONLY way to build one. `error` and `handoff` are separate fields on
 * `PreToolUseCallback`'s denial variant and must always be set together — a
 * handoff paired with a real failure string, or a failure that accidentally
 * carries `handoff`, would both be published with the wrong `isError`. Pairing
 * them here makes that unrepresentable at the two call sites rather than
 * relying on each remembering the convention.
 */
export function approvedExecutingDenial(): {
  allowed: false;
  error: string;
  handoff: ToolHandoffStatus;
} {
  return {
    allowed: false,
    error: APPROVED_EXECUTING_MESSAGE,
    handoff: APPROVED_EXECUTING_STATUS,
  };
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

/**
 * The intent statuses that are TERMINAL — the intent will never move again, so
 * whatever it says now is the truth to report.
 *
 * Mirrors `actionIntentStatusEnum` (`db/schema/actionIntents.ts`) minus the
 * live states. Duplicated as plain strings on purpose: this module is a LEAF
 * (see the header) and must not import the schema, which the SDK suites mock
 * partially. `actionIntents/terminalOutcome.test.ts` pins the two together.
 */
export const TERMINAL_INTENT_STATUSES = [
  'completed',
  'failed',
  'rejected',
  'expired',
  'cancelled',
] as const;

export type TerminalIntentStatus = (typeof TERMINAL_INTENT_STATUSES)[number];

export function isTerminalIntentStatus(status: string | null | undefined): status is TerminalIntentStatus {
  return TERMINAL_INTENT_STATUSES.includes(status as TerminalIntentStatus);
}

/** The columns of an `action_intents` row this mapping needs. */
export interface IntentOutcomeSnapshot {
  status: string;
  errorCode: string | null;
  result: Record<string, unknown> | null;
}

export interface HandoffOutcome {
  handoff: ToolHandoffStatus;
  message: string;
}

/** Keeps a runaway tool error from crowding out the rest of the turn. */
const MAX_REASON_CHARS = 400;

function truncate(reason: string): string {
  return reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS)}…` : reason;
}

/**
 * The model-readable reason a terminal intent did not take effect.
 *
 * Most-specific-first: the tool's own error string (where #6022's guardrail
 * refusal lives), then a sentence derived from a never-ran status, then the
 * intent's `error_code`. Only a STRING `result.error` is used — `result` is
 * free-form jsonb that can hold sealed secret material
 * (`actionIntents/resultSecrets.ts`), so nothing else in it is ever spliced
 * into the transcript.
 */
export function intentTerminalReason(snapshot: IntentOutcomeSnapshot): string {
  const resultError = snapshot.result?.error;
  if (typeof resultError === 'string' && resultError.trim().length > 0) {
    return truncate(resultError.trim());
  }
  switch (snapshot.status) {
    case 'rejected':
      return 'the approval was rejected, so it did not run';
    case 'expired':
      return 'the approval expired, so it did not run';
    case 'cancelled':
      return 'the action was cancelled, so it did not run';
    default:
      break;
  }
  if (snapshot.errorCode && snapshot.errorCode.trim().length > 0) {
    return truncate(snapshot.errorCode.trim());
  }
  return 'the approval worker reported that it failed';
}

/**
 * Map an intent's terminal snapshot onto the outcome the chat turn publishes.
 *
 * `null` (unreadable row) and any non-terminal status both stay
 * `approved_executing`: a read that did not resolve is NOT evidence that the
 * action failed, and reporting a failure the platform never observed would be
 * the same class of lie as #6022, just pointing the other way.
 */
export function describeIntentOutcome(snapshot: IntentOutcomeSnapshot | null): HandoffOutcome {
  if (!snapshot || !isTerminalIntentStatus(snapshot.status)) {
    return { handoff: APPROVED_EXECUTING_STATUS, message: APPROVED_EXECUTING_MESSAGE };
  }

  if (snapshot.status === 'completed') {
    return { handoff: APPROVED_COMPLETED_STATUS, message: APPROVED_COMPLETED_MESSAGE };
  }

  return {
    handoff: APPROVED_FAILED_STATUS,
    message:
      `Approved, but the action FAILED and did NOT take effect. Reason: ${intentTerminalReason(snapshot)}. ` +
      'You must tell the user it did not succeed and report this reason to them. ' +
      'Do not claim it succeeded, and do not retry it without addressing the reason.',
  };
}

/**
 * Pair an outcome with its denial marker — the same "wrong pairing is
 * unrepresentable" discipline as `approvedExecutingDenial`, extended to the
 * terminal outcomes so no call site can publish `approved_failed` with the
 * wrong `isError`.
 */
export function handoffDenialForOutcome(outcome: HandoffOutcome): {
  allowed: false;
  error: string;
  handoff: ToolHandoffStatus;
} {
  return { allowed: false, error: outcome.message, handoff: outcome.handoff };
}
