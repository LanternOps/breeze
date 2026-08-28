/**
 * Wave 6 PR 1 (#3828) — builds the stitched `GET /ai/agents/runs/:runId`
 * detail DTO out of the run row, its `AgentRunOutcome` (runLoop.ts), the
 * execution-ledger rows, and any linked action-intent rows.
 *
 * SAFE PROJECTION IS THE POINT OF THIS FILE. `OutcomeProposedAction.args`
 * (the raw tool input the model proposed) and `ai_tool_executions.toolInput`/
 * `toolOutput` are read from their source objects here — and deliberately
 * never assigned onto the returned DTO. `AiAgentRunTraceEntryDto`
 * (@breeze/shared) has no field that could carry them even by accident; see
 * its header for the full rationale. Pure and synchronous — every DB read
 * happens in the route handler, which hands this function already-loaded
 * rows, so this file is unit-testable against fixtures with no DB.
 */

import type {
  ActionIntentApprovalScope,
  ActionIntentStatus,
} from '../../db/schema/actionIntents';
import type {
  AgentRunOutcome,
  OutcomeExecutedAction,
  OutcomeProposedAction,
} from './runLoop';
import {
  AI_AGENT_RUN_DTO_SCHEMA_VERSION,
  type AiAgentKind,
  type AiAgentMode,
  type AiAgentRunDetailDto,
  type AiAgentRunIntentSummaryDto,
  type AiAgentRunLedgerEntryDto,
  type AiAgentRunStatus,
  type AiAgentRunTraceEntryDto,
  type AiAgentTriggerKind,
  type AiToolStatus,
} from '@breeze/shared';

export interface RunTraceRunInput {
  id: string;
  agentId: string;
  orgId: string;
  deviceId: string | null;
  alertId: string | null;
  triggerKind: AiAgentTriggerKind;
  modeAtStart: Exclude<AiAgentMode, 'off'>;
  status: AiAgentRunStatus;
  summary: string | null;
  /**
   * The raw `ai_agent_runs.outcome` jsonb column — typed `Record<string,
   * unknown>` at the schema layer (see aiAgents.ts) because Postgres jsonb
   * carries no compile-time shape. Treated here as a `Partial<AgentRunOutcome>`
   * (we are the only writer, via `runLoop.ts`'s `finishRun`), tolerantly: a
   * run enqueued before wave 4's `execution`/`verification` fields, or before
   * `runVerdict` existed at all (wave 3-era rows), reads back with those keys
   * simply absent — `AgentRunOutcome`'s own optionality already models that,
   * so no extra normalization pass is needed beyond defensive `?? []`/`?? null`
   * defaults against a maximally-corrupt row.
   */
  outcome: Record<string, unknown>;
  turnCount: number;
  costCents: number;
  errorCode: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface RunTraceAgentInput {
  name: string;
  kind: AiAgentKind;
}

export interface RunTraceDeviceInput {
  hostname: string;
}

/** The safe-projected subset of one `ai_tool_executions` row. */
export interface RunTraceLedgerRowInput {
  toolName: string;
  status: AiToolStatus;
  durationMs: number | null;
  createdAt: Date;
  completedAt: Date | null;
  errorMessage: string | null;
}

/** The safe-projected subset of one linked `action_intents` row. */
export interface RunTraceIntentRowInput {
  id: string;
  status: ActionIntentStatus;
  actionName: string;
  approvalScope: ActionIntentApprovalScope;
  decidedVia: string | null;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function mapExecuted(action: OutcomeExecutedAction): AiAgentRunTraceEntryDto {
  return {
    kind: 'executed',
    tool: action.tool,
    action: action.action,
    result: action.result,
    durationMs: action.durationMs,
    execution: action.execution,
    verification: action.verification,
    verifyDetail: action.verifyDetail,
    actOpKey: action.actOpKey,
    actTargetName: action.actTargetName,
  };
}

/**
 * `action.args` — the raw tool input the model proposed — is intentionally
 * never read here. Every field below is display-safe by construction (see
 * `OutcomeProposedAction`'s own docstring in runLoop.ts).
 */
function mapProposed(action: OutcomeProposedAction): AiAgentRunTraceEntryDto {
  return {
    kind: 'proposed',
    tool: action.tool,
    action: action.action,
    intentId: action.intentId,
    intentError: action.intentError,
    downgradeReason: action.downgradeReason,
  };
}

function mapDenied(action: { tool: string; reason: string }): AiAgentRunTraceEntryDto {
  return { kind: 'denied', tool: action.tool, reason: action.reason };
}

/**
 * Concatenation order: executed, then proposed, then denied. `AgentRunOutcome`
 * stores these as three separate arrays (runLoop.ts pushes into whichever one
 * applies as a turn resolves) with no shared timestamp to interleave by, so
 * there is no true chronological merge to recover — this order groups the
 * timeline into "what happened" / "what's waiting" / "what was refused",
 * which is also the reading order the run-detail UI wants (Task 4).
 */
function buildTraceEntries(outcome: Partial<AgentRunOutcome>): AiAgentRunTraceEntryDto[] {
  return [
    ...asArray<OutcomeExecutedAction>(outcome.executedActions).map(mapExecuted),
    ...asArray<OutcomeProposedAction>(outcome.proposedActions).map(mapProposed),
    ...asArray<{ tool: string; reason: string }>(outcome.deniedActions).map(mapDenied),
  ];
}

function mapLedgerRow(row: RunTraceLedgerRowInput): AiAgentRunLedgerEntryDto {
  return {
    toolName: row.toolName,
    status: row.status,
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    errorMessage: row.errorMessage,
  };
}

function mapIntentRow(row: RunTraceIntentRowInput): AiAgentRunIntentSummaryDto {
  return {
    id: row.id,
    status: row.status,
    actionName: row.actionName,
    approvalScope: row.approvalScope,
    decidedVia: row.decidedVia,
  };
}

export function buildRunTrace(
  run: RunTraceRunInput,
  agent: RunTraceAgentInput,
  device: RunTraceDeviceInput | null,
  ledgerRows: RunTraceLedgerRowInput[],
  intents: RunTraceIntentRowInput[],
): AiAgentRunDetailDto {
  const outcome = run.outcome as Partial<AgentRunOutcome>;
  return {
    schemaVersion: AI_AGENT_RUN_DTO_SCHEMA_VERSION,
    id: run.id,
    agentId: run.agentId,
    agentName: agent.name,
    agentKind: agent.kind,
    orgId: run.orgId,
    deviceId: run.deviceId,
    deviceHostname: device?.hostname ?? null,
    alertId: run.alertId,
    triggerKind: run.triggerKind,
    modeAtStart: run.modeAtStart,
    status: run.status,
    summary: run.summary,
    runVerdict: outcome.runVerdict ?? null,
    turnCount: run.turnCount,
    costCents: run.costCents,
    errorCode: run.errorCode,
    queuedAt: run.queuedAt.toISOString(),
    startedAt: run.startedAt ? run.startedAt.toISOString() : null,
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    budgetExceeded: outcome.budgetExceeded ?? false,
    wallClockExceeded: outcome.wallClockExceeded ?? false,
    maxTurnsExceeded: outcome.maxTurnsExceeded ?? false,
    trace: buildTraceEntries(outcome),
    ledger: ledgerRows.map(mapLedgerRow),
    intents: intents.map(mapIntentRow),
  };
}
