/**
 * Action-status projection and the two server-intrinsic tools for Tier-3
 * action intents over MCP (B-W04 #6158, D-B31 / D-B36).
 *
 * `toMcpActionStatus` is the ONE safe way an intent row reaches an MCP client:
 * it maps the status, compacts the result exactly as the direct path does, and
 * withholds secret-bearing results. Nothing renders an intent to a client
 * without going through it. Pure: no DB, no env.
 *
 * `get_action_status` / `cancel_action` are intrinsic like `whoami`: they need
 * the MCP principal (ownership is checked against it), which registry tool
 * handlers never receive. Both are domain `core`.
 */
import type { ActionIntent, ActionIntentStatus } from '../db/schema/actionIntents';
import { compactToolResultForChat, shrinkToJsonBudget } from './aiToolOutput';
import { isSecretBearingTool } from './actionIntents/secretBearingTools';
import { hasSealedTemporaryPassword } from './actionIntents/resultSecrets';

export const MCP_GET_ACTION_STATUS_TOOL_NAME = 'get_action_status';
export const MCP_CANCEL_ACTION_TOOL_NAME = 'cancel_action';

const ACTION_ID_SCHEMA = {
  type: 'object' as const,
  properties: {
    actionId: {
      type: 'string',
      format: 'uuid',
      description: 'The actionId returned by a pending_approval result.',
    },
  },
  required: ['actionId'],
  additionalProperties: false,
};

export const MCP_GET_ACTION_STATUS_TOOL_LIST_ENTRY: Record<string, unknown> = {
  title: 'Get action status',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: { 'app.breeze/domain': 'core' },
  name: MCP_GET_ACTION_STATUS_TOOL_NAME,
  description:
    'Returns the current status of an action that was filed for human approval in the Breeze mobile or web app (the actionId from a pending_approval result). Poll this instead of re-issuing the original call; only status completed means it happened.',
  inputSchema: ACTION_ID_SCHEMA,
};

export const MCP_CANCEL_ACTION_TOOL_LIST_ENTRY: Record<string, unknown> = {
  title: 'Cancel action',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: { 'app.breeze/domain': 'core' },
  name: MCP_CANCEL_ACTION_TOOL_NAME,
  description:
    'Cancels an action that is still waiting for approval or approved but not yet running. Returns cancelled, or not_cancellable with the current status.',
  inputSchema: ACTION_ID_SCHEMA,
};

export type McpActionPublicStatus =
  | 'pending_approval' | 'in_progress' | 'completed' | 'failed' | 'rejected' | 'expired' | 'cancelled';

export type McpActionStatus = {
  actionId: string;
  status: McpActionPublicStatus;
  toolName: string;
  approvalScope: 'four_eyes' | 'supervised';
  expiresAt: string;
  approvalUrl: string;
  result?: string;
  resultWithheld?: 'secret_bearing';
  errorCode?: string;
  outcomeUncertain?: true;
};

export function mapIntentStatus(s: ActionIntentStatus): McpActionPublicStatus {
  switch (s) {
    case 'approved':
    case 'executing':
      return 'in_progress';
    default:
      return s;
  }
}

/**
 * A `failed` intent may still have had effects: the worker stamps `executedAt`
 * when it failed after dispatch, and the stale-executing reaper writes
 * `execution_lost`. The model must not treat those as "did not happen".
 */
export function isIntentOutcomeUncertain(
  intent: Pick<ActionIntent, 'status' | 'errorCode' | 'executedAt'>,
): boolean {
  return intent.status === 'failed' && (Boolean(intent.executedAt) || intent.errorCode === 'execution_lost');
}

export function mcpApprovalUrl(appBaseUrl: string, intentId: string): string {
  return `${appBaseUrl.replace(/\/+$/, '')}/approvals#intent-${intentId}`;
}

/**
 * Keyed on the tool name too: a burned/expired secret no longer carries the
 * result marker (and may have been nulled), but the tool still produced one.
 * The reveal stays web-only. Shared by every path here that renders an intent
 * result to a model, so the withholding rule cannot drift between them.
 */
export function isIntentResultWithheld(actionName: string, result: Record<string, unknown> | null): boolean {
  return isSecretBearingTool(actionName) || (result !== null && hasSealedTemporaryPassword(result));
}

/**
 * #11966: the executed steps of an AI agent run, for `get_ai_agent_run`.
 * Without them the chat read only step statuses and told the user the output
 * was not stored, although `action_intents.result` held it.
 *
 * Each result is compacted under the STEP's own tool name, so that tool's
 * device-text fencing, redaction and error scrub apply exactly as they do when
 * `get_action_status` shows the same result. The list is bounded to fit the
 * tool-result budget beside the trace: at most STEP_RESULTS_MAX steps, each
 * summary at most STEP_RESULT_MAX_CHARS, all entries within the caller's
 * budget. Every cut is stated: `resultTruncated` beside the stored size, or
 * `stepResultsOmitted` with how many steps were left out and why.
 */
export type ChatIntentStepInput = Pick<
  ActionIntent,
  'id' | 'status' | 'actionName' | 'result' | 'errorCode' | 'executedAt' | 'createdAt'
>;

export type ChatIntentStepResult = {
  intentId: string;
  actionName: string;
  status: 'completed' | 'failed';
  errorCode?: string;
  outcomeUncertain?: true;
  /** The compacted result JSON; null when withheld or not stored (see the two fields below). */
  resultSummary: string | null;
  /** Size of the stored result JSON, so a reader can see how much a cut summary left out. */
  resultChars?: number;
  /** The stored result did not fit the summary budget, so `resultSummary` is cut. */
  resultTruncated?: true;
  resultWithheld?: 'secret_bearing';
  resultMissing?: 'not_recorded' | 'exceeded_storage_cap';
};

export type ChatIntentStepResults = {
  stepResults: ChatIntentStepResult[];
  /** Executed steps left out; `trace.intents` still lists every step with its status. */
  stepResultsOmitted?: { count: number; reason: string };
};

export const STEP_RESULTS_MAX = 6;
/** One summary's ceiling; also the budget each result is compacted to before any further cut. */
export const STEP_RESULT_MAX_CHARS = 1_500;
/** The default room for all step entries together, each entry's fields included. */
export const STEP_RESULTS_BUDGET_CHARS = 3_000;
const STEP_RESULT_MIN_CHARS = 250;
/** Upper bound on one entry's fields besides `resultSummary` (ids, names, flags, JSON punctuation). */
const STEP_RESULT_ENTRY_OVERHEAD_CHARS = 250;

/** What the release worker and the inline chat path store for a result over MAX_RESULT_BYTES. */
function isStorageCapMarker(result: Record<string, unknown>): boolean {
  return Object.keys(result).length === 1 && result.truncated === true;
}

/** A step that failed before dispatch has no executedAt; it sorts by when it was filed. */
function stepTime(row: ChatIntentStepInput): number {
  return (row.executedAt ?? row.createdAt).getTime();
}

function toStepResult(row: ChatIntentStepInput, summaryChars: number): ChatIntentStepResult {
  const out: ChatIntentStepResult = {
    intentId: row.id,
    actionName: row.actionName,
    status: row.status === 'failed' ? 'failed' : 'completed',
    resultSummary: null,
  };
  if (row.status === 'failed') {
    if (row.errorCode) out.errorCode = row.errorCode;
    if (isIntentOutcomeUncertain(row)) out.outcomeUncertain = true;
  }
  if (isIntentResultWithheld(row.actionName, row.result)) {
    out.resultWithheld = 'secret_bearing';
  } else if (row.result === null) {
    out.resultMissing = 'not_recorded';
  } else if (isStorageCapMarker(row.result)) {
    out.resultMissing = 'exceeded_storage_cap';
  } else {
    const raw = JSON.stringify(row.result);
    // Compacted at a fixed budget, then cut from the end: a compactor run at a
    // small budget falls back to a digest of field names and loses the
    // content, while the head of a compacted result is the content itself.
    const compacted = compactToolResultForChat(row.actionName, raw, STEP_RESULT_MAX_CHARS);
    // Measured as escaped JSON: that is what the summary costs in the tool output.
    out.resultSummary = JSON.stringify(compacted).length > summaryChars
      ? shrinkToJsonBudget(compacted, summaryChars)
      : compacted;
    out.resultChars = raw.length;
    if (JSON.stringify(raw).length > summaryChars) out.resultTruncated = true;
  }
  return out;
}

/**
 * `budgetChars` is the room for every entry together. The caller sizes it to
 * what the rest of its output leaves, so adding step results never pushes an
 * output that fit into the compactor's digest fallback.
 */
export function toChatIntentStepResults(
  rows: readonly ChatIntentStepInput[],
  budgetChars: number = STEP_RESULTS_BUDGET_CHARS,
): ChatIntentStepResults {
  const executed = rows
    .filter((row) => row.status === 'completed' || row.status === 'failed')
    .sort((a, b) => stepTime(a) - stepTime(b) || a.createdAt.getTime() - b.createdAt.getTime());
  const fitting = Math.floor(Math.max(0, budgetChars) / (STEP_RESULT_MIN_CHARS + STEP_RESULT_ENTRY_OVERHEAD_CHARS));
  const shownCount = Math.min(STEP_RESULTS_MAX, executed.length, fitting);
  const summaryChars = shownCount === 0 ? 0 : Math.min(
    STEP_RESULT_MAX_CHARS,
    Math.floor(budgetChars / shownCount) - STEP_RESULT_ENTRY_OVERHEAD_CHARS,
  );
  const out: ChatIntentStepResults = {
    stepResults: executed.slice(0, shownCount).map((row) => toStepResult(row, summaryChars)),
  };
  const omitted = executed.length - shownCount;
  if (omitted > 0) {
    out.stepResultsOmitted = {
      count: omitted,
      reason: shownCount < Math.min(STEP_RESULTS_MAX, executed.length)
        ? `The run trace left room for ${shownCount} step results; the run page in the Breeze app shows every step.`
        : `Only the first ${STEP_RESULTS_MAX} executed steps carry a result here; the run page in the Breeze app shows every step.`,
    };
  }
  return out;
}

export function toMcpActionStatus(
  intent: Pick<
    ActionIntent,
    'id' | 'status' | 'actionName' | 'approvalScope' | 'expiresAt' | 'result' | 'errorCode' | 'executedAt'
  >,
  appBaseUrl: string,
): McpActionStatus {
  const status = mapIntentStatus(intent.status);
  const out: McpActionStatus = {
    actionId: intent.id,
    status,
    toolName: intent.actionName,
    approvalScope: intent.approvalScope === 'supervised' ? 'supervised' : 'four_eyes',
    expiresAt: intent.expiresAt.toISOString(),
    approvalUrl: mcpApprovalUrl(appBaseUrl, intent.id),
  };
  if (status === 'completed') {
    if (isIntentResultWithheld(intent.actionName, intent.result)) {
      out.resultWithheld = 'secret_bearing';
    } else if (intent.result) {
      out.result = compactToolResultForChat(intent.actionName, JSON.stringify(intent.result));
    }
  }
  if (status === 'failed') {
    if (intent.errorCode) out.errorCode = intent.errorCode;
    if (isIntentOutcomeUncertain(intent)) out.outcomeUncertain = true;
  }
  return out;
}

const NEXT = 'Call get_action_status with this actionId; do not re-issue the call.';

/**
 * B-W06 (#6160, D-B49): the ONE terminal rendering of an action outcome as a
 * CallToolResult, extracted verbatim from the URL-elicitation continuation.
 * `completed` → the (compacted) result text, or the status JSON when there is
 * none (withheld, or nulled by retention); anything else → the status JSON
 * with `isError: true`. `structuredContent` is the status wrapper, exactly as
 * before. Shared by the continuation and the Tasks projection.
 */
export function buildTerminalActionResult(status: McpActionStatus): {
  content: [{ type: 'text'; text: string }];
  structuredContent: McpActionStatus;
  isError?: true;
} {
  if (status.status === 'completed') {
    return { content: [{ type: 'text', text: status.result ?? JSON.stringify(status) }], structuredContent: status };
  }
  return { content: [{ type: 'text', text: JSON.stringify(status) }], structuredContent: status, isError: true };
}

/** A normal (non-error) result: the call was filed, not refused. */
export function buildPendingApprovalResult(status: McpActionStatus): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: McpActionStatus & { next: string };
} {
  return {
    content: [
      {
        type: 'text',
        text: `"${status.toolName}" is waiting for approval in the Breeze mobile or web app and has NOT run yet. Call get_action_status with actionId ${status.actionId} to learn the outcome; do not re-issue the call.`,
      },
    ],
    structuredContent: { ...status, next: NEXT },
  };
}

/**
 * B-W04 (#6158, D-B32, PR B): the `2026-07-28` MRTR result for a client that
 * declared URL-mode elicitation — exactly one `elicitation/create` in URL mode
 * pointing at the Breeze approval page (never form mode), plus the sealed
 * `requestState` the retry must carry. The URL carries only the intent id and
 * is not pre-authenticated: the page needs a Breeze login.
 */
export function buildApprovalInputRequiredResult(status: McpActionStatus, requestState: string): Record<string, unknown> {
  const who = status.approvalScope === 'supervised'
    ? 'You must approve it yourself'
    : 'Another person who can approve actions in this organization must approve it';
  return {
    resultType: 'input_required',
    inputRequests: {
      breeze_approval: {
        method: 'elicitation/create',
        params: {
          mode: 'url',
          message: `"${status.toolName}" needs approval before it runs. ${who} in the Breeze app; this opens Breeze in your browser. Declining cancels the request.`,
          url: status.approvalUrl,
        },
      },
    },
    requestState,
  };
}
