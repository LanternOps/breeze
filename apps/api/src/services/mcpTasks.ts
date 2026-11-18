/**
 * B-W06 (#6160): the MCP Tasks extension (SEP-2663, `2026-07-28`) as a
 * read-only view of an `mcp_api` action intent.
 *
 * - The task id IS the intent id (D-B48). It is a name, never a capability:
 *   every `tasks/*` call re-runs auth and `loadOwnedMcpIntent`.
 * - `toMcpTask` is the ONE projection (D-B49). It takes status only from
 *   `toMcpActionStatus` output — never raw `intent.status` — and renders a
 *   terminal outcome with the same `buildTerminalActionResult` bytes the
 *   URL-elicitation continuation uses. Tasks `failed` and `input_required` are
 *   never produced: a failed/rejected/expired action is a tool-level outcome
 *   (`completed` + `isError`), and the approval prompt is the pre-task MRTR
 *   exchange (Gate B 3).
 * - Polling only, with a per-credential request budget (D-B52).
 *
 * Pure: no DB, no env. Callers pass the knobs in.
 */
import type { ActionIntent } from '../db/schema/actionIntents';
import { MCP_TASKS_EXTENSION_ID } from './mcpClientExtensions';
import { buildTerminalActionResult, toMcpActionStatus } from './mcpActionStatus';

export { MCP_TASKS_EXTENSION_ID };

/** The full SEP-2663 status union; only working | completed | cancelled are produced. */
export type McpTaskStatus = 'working' | 'input_required' | 'completed' | 'cancelled' | 'failed';

export type McpTask = {
  taskId: string;
  status: McpTaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number;
  pollIntervalMs?: number;
  /** `completed` only: the CallToolResult (buildTerminalActionResult). */
  result?: ReturnType<typeof buildTerminalActionResult>;
};

export type McpTaskKnobs = {
  pendingPollMs: number;
  runningPollMs: number;
  ttlGraceMs: number;
  /** The caller origin's live `mcp_api` intents (countLiveMcpIntentsForOrigin). */
  liveCount: number;
  /** mcpMessageRateLimitPerMinute(). */
  perMinuteLimit: number;
};

export type McpTaskIntentRow = Pick<
  ActionIntent,
  | 'id' | 'status' | 'actionName' | 'approvalScope' | 'createdAt' | 'expiresAt' | 'decidedAt'
  | 'executionStartedAt' | 'executedAt' | 'statusChangedAt' | 'result' | 'errorCode'
>;

/**
 * D-B49/D-B56: tools whose handler returns once the work is QUEUED (or, for
 * run_script, after a bounded device wait that may time out). Their task
 * completes with a job handle; the status message names the existing polling
 * tool. Closed on purpose: a new entry is a reviewed decision.
 */
export const MCP_TASK_FOLLOW_UP_TOOLS: Readonly<Record<string, { pollTool: string; when?: (resultText: string) => boolean }>> =
  Object.freeze({
    execute_dr_plan: { pollTool: 'get_dr_execution_status' },
    trigger_backup: { pollTool: 'get_backup_status' },
    manage_patches: { pollTool: 'manage_patches (action "device_history")' },
    run_script: { pollTool: 'get_script_execution', when: (text: string) => text.includes('"status":"timeout"') },
  });

/** Unknown, foreign and malformed task ids all answer this (no existence oracle). */
export const MCP_TASK_NOT_FOUND = { reason: 'not_found' } as const;

/** A task id longer than this is never looked up (or audited). Intent ids are 36. */
export const MCP_TASK_ID_MAX_CHARS = 64;

/**
 * D-B52: `max(base, ceil(liveCount × 60000 / floor(perMinuteLimit / 2)))` — every
 * live task of one credential polling at its interval uses at most half of the
 * credential's per-minute message budget.
 */
export function budgetedPollIntervalMs(base: number, liveCount: number, perMinuteLimit: number): number {
  const share = Math.max(1, Math.floor(perMinuteLimit / 2));
  const live = Math.max(0, liveCount);
  return Math.max(base, Math.ceil((live * 60_000) / share));
}

function latest(...dates: Array<Date | null | undefined>): Date {
  let best: Date | undefined;
  for (const d of dates) if (d && (!best || d.getTime() > best.getTime())) best = d;
  return best!;
}

export function toMcpTask(intent: McpTaskIntentRow, appBaseUrl: string, knobs: McpTaskKnobs): McpTask {
  const status = toMcpActionStatus(intent, appBaseUrl);
  // The fallback is only for rows that predate the status_changed_at migration.
  const lastUpdated = intent.statusChangedAt
    ?? latest(intent.createdAt, intent.decidedAt, intent.executionStartedAt, intent.executedAt);
  const times = {
    createdAt: intent.createdAt.toISOString(),
    lastUpdatedAt: lastUpdated.toISOString(),
    // The approval window plus a grace for release and execution: the client's backstop.
    ttlMs: (intent.expiresAt.getTime() - intent.createdAt.getTime()) + knobs.ttlGraceMs,
  };
  const poll = (base: number) => budgetedPollIntervalMs(base, knobs.liveCount, knobs.perMinuteLimit);

  switch (status.status) {
    case 'pending_approval':
      return {
        taskId: intent.id,
        status: 'working',
        statusMessage: `Waiting for approval in the Breeze mobile or web app: ${status.approvalUrl}`,
        ...times,
        pollIntervalMs: poll(knobs.pendingPollMs),
      };
    case 'in_progress':
      return { taskId: intent.id, status: 'working', statusMessage: 'Approved — running.', ...times, pollIntervalMs: poll(knobs.runningPollMs) };
    case 'cancelled':
      return { taskId: intent.id, status: 'cancelled', ...times };
    case 'completed': {
      const followUp = Object.prototype.hasOwnProperty.call(MCP_TASK_FOLLOW_UP_TOOLS, status.toolName)
        ? MCP_TASK_FOLLOW_UP_TOOLS[status.toolName]
        : undefined;
      const message = followUp && (!followUp.when || followUp.when(status.result ?? ''))
        ? `Started. The device operation may still be running — check it with ${followUp.pollTool}.`
        : undefined;
      return {
        taskId: intent.id,
        status: 'completed',
        ...(message ? { statusMessage: message } : {}),
        ...times,
        result: buildTerminalActionResult(status),
      };
    }
    default:
      // failed | rejected | expired: a tool-level error outcome, never Tasks `failed`.
      return { taskId: intent.id, status: 'completed', ...times, result: buildTerminalActionResult(status) };
  }
}

/** SEP-2663 CreateTaskResult: the task envelope on `tools/call`, never with a result. */
export function buildCreateTaskResult(task: McpTask): Record<string, unknown> {
  const { result: _result, ...envelope } = task;
  return { resultType: 'task', ...envelope };
}

/** `-32021` data for a `tasks/*` request that did not declare the extension. */
export function buildTasksExtensionRequiredData(): {
  requiredCapabilities: { extensions: { [MCP_TASKS_EXTENSION_ID]: Record<string, never> } };
} {
  return { requiredCapabilities: { extensions: { [MCP_TASKS_EXTENSION_ID]: {} } } };
}
