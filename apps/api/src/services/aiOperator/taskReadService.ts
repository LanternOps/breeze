/**
 * Wave W07 of #5205 (P3-1e, read side) — builds the safe
 * `GET /ai/operator/tasks` / `GET /ai/operator/tasks/:id` DTOs out of already
 * loaded `ai_operator_tasks` / `ai_operator_operations` / `ai_agent_runs`
 * rows.
 *
 * SAFE PROJECTION IS THE POINT OF THIS FILE — same posture as
 * `services/aiAgents/runTrace.ts`'s header comment. Every mapper below is a
 * NAMED-FIELD function, never `{ ...row }`: `ai_operator_tasks.checkpoint`,
 * `frozen_scope`, `frozen_criteria`, `frozen_authority`, and
 * `ai_operator_operations.result` are never read here, so a DTO built by
 * these functions cannot carry them even by accident. Pure and synchronous —
 * every DB read happens in the route handler, which hands this module
 * already-loaded rows, so it is unit-testable against fixtures with no DB.
 */

import {
  AI_OPERATOR_TASK_DTO_SCHEMA_VERSION,
  type AiOperatorExecutionRefKind,
  type AiOperatorOperationDispatchState,
  type AiOperatorOperationResultState,
  type AiOperatorTargetDetachReason,
  type AiOperatorTaskDto,
  type AiOperatorTaskListItemDto,
  type AiOperatorTaskMode,
  type AiOperatorTaskNextAction,
  type AiOperatorTaskOperationDto,
  type AiOperatorTaskOriginKind,
  type AiOperatorTaskOutcome,
  type AiOperatorTaskPhase,
  type AiOperatorTaskRunLinkDto,
  type AiOperatorTaskState,
  type AiOperatorWaitDependencyDto,
  type AiOperatorWaitDependencyKind,
  type AiOperatorWaitReason,
} from '@breeze/shared';

/**
 * Server-computed "what happens next" — spec §5.2's task-detail header
 * requirement ("current phase, and the next required action"). Purely a
 * function of `state`/`waitReason`; never stored, never client-derived. The
 * exhaustive `switch`es (no `default` on the outer state switch) mean an
 * unhandled `AiOperatorTaskState` addition fails to compile here, not at
 * runtime.
 */
export function computeOperatorTaskNextAction(
  state: AiOperatorTaskState,
  waitReason: AiOperatorWaitReason | null,
): AiOperatorTaskNextAction {
  switch (state) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'in_progress';
    case 'paused':
      return 'paused';
    case 'stopping':
      return 'stopping';
    case 'handed_off':
      return 'handed_off';
    case 'completed':
    case 'partial':
    case 'cancelled':
    case 'failed':
    case 'expired':
      return 'none';
    case 'waiting':
      switch (waitReason) {
        case 'approval':
          return 'approve_in_inbox';
        case 'information':
          return 'answer_question';
        case 'device':
          return 'waiting_for_device';
        case 'maintenance_window':
          return 'waiting_for_maintenance_window';
        case 'verification_window':
          return 'waiting_for_verification_window';
        case 'execution':
          return 'waiting_for_execution';
        case null:
        case undefined:
          // Defensive only: the coordinator always sets a waitReason when it
          // transitions a task into `waiting` — a null here is a data bug,
          // not a state the read side should throw on.
          return 'waiting_for_execution';
        default:
          return 'waiting_for_execution';
      }
  }
}

export interface OperatorTaskRowInput {
  id: string;
  orgId: string;
  agentId: string;
  // NOT NULL frozen columns (spec §11.3) — see `AiOperatorTaskDto.agent`'s
  // docstring in `@breeze/shared` for why these are never null and never
  // joined from the live `ai_agents` row.
  agentKind: string;
  agentName: string;
  workflowKey: string;
  workflowVersion: number;
  mode: AiOperatorTaskMode;
  originKind: AiOperatorTaskOriginKind;
  objective: string;
  deviceId: string | null;
  targetLabel: string | null;
  targetDetachedAt: Date | null;
  targetDetachedReason: AiOperatorTargetDetachReason | null;
  state: AiOperatorTaskState;
  phase: AiOperatorTaskPhase | null;
  waitReason: AiOperatorWaitReason | null;
  waitDependencyKind: AiOperatorWaitDependencyKind | null;
  waitDependencyId: string | null;
  revision: number;
  attemptOrdinal: number;
  currentStepKey: string | null;
  deadlineAt: Date | null;
  nextWakeAt: Date | null;
  outcome: AiOperatorTaskOutcome | null;
  outcomeDetail: string | null;
  handoffSummary: string | null;
  accountingRootTaskId: string | null;
  successorOfTaskId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OperatorOperationRowInput {
  operationKey: string;
  attemptOrdinal: number;
  intentId: string | null;
  dispatchState: AiOperatorOperationDispatchState;
  resultState: AiOperatorOperationResultState;
  executionRefKind: AiOperatorExecutionRefKind | null;
  executionRefId: string | null;
  dispatchedAt: Date | null;
  resultAt: Date | null;
}

export interface OperatorRunLinkRowInput {
  id: string;
  status: string;
  taskAttemptOrdinal: number | null;
  promptVersion: string | null;
  resolvedModel: string | null;
}

/** Named-field mapper — never `{ ...row }`. */
function mapWaitDependency(row: OperatorTaskRowInput): AiOperatorWaitDependencyDto | null {
  if (!row.waitDependencyKind || !row.waitDependencyId) return null;
  return { kind: row.waitDependencyKind, id: row.waitDependencyId };
}

/** Named-field mapper — never `{ ...row }`. Deliberately excludes
 *  `ai_operator_operations.result` (baseline §8.3/§8.4, `excludedOpen`). */
export function mapOperatorOperation(row: OperatorOperationRowInput): AiOperatorTaskOperationDto {
  return {
    operationKey: row.operationKey,
    attemptOrdinal: row.attemptOrdinal,
    intentId: row.intentId,
    dispatchState: row.dispatchState,
    resultState: row.resultState,
    executionRef:
      row.executionRefKind && row.executionRefId
        ? { kind: row.executionRefKind, id: row.executionRefId }
        : null,
    dispatchedAt: row.dispatchedAt ? row.dispatchedAt.toISOString() : null,
    resultAt: row.resultAt ? row.resultAt.toISOString() : null,
  };
}

/** Named-field mapper — id + display fields only; the client links onward to
 *  the existing `/ai-agents/runs/:id` detail page/route for the trace. */
export function mapOperatorRunLink(row: OperatorRunLinkRowInput): AiOperatorTaskRunLinkDto {
  return {
    id: row.id,
    status: row.status,
    attemptOrdinal: row.taskAttemptOrdinal,
    promptVersion: row.promptVersion,
    resolvedModel: row.resolvedModel,
  };
}

/**
 * The shared field set between the list and detail DTOs — named-field
 * mapper, never `{ ...row }` — so `checkpoint`, `frozen_scope`,
 * `frozen_criteria`, and `frozen_authority` (every jsonb column on
 * `ai_operator_tasks`) have no path onto the wire even if a future column is
 * added to the row type above.
 */
function mapOperatorTaskListItem_(row: OperatorTaskRowInput): AiOperatorTaskListItemDto {
  return {
    schemaVersion: AI_OPERATOR_TASK_DTO_SCHEMA_VERSION,
    id: row.id,
    orgId: row.orgId,
    agent: { id: row.agentId, kind: row.agentKind, name: row.agentName },
    workflowKey: row.workflowKey,
    workflowVersion: row.workflowVersion,
    mode: row.mode,
    originKind: row.originKind,
    objective: row.objective,
    target: {
      deviceId: row.deviceId,
      label: row.targetLabel,
      detachedAt: row.targetDetachedAt ? row.targetDetachedAt.toISOString() : null,
      detachedReason: row.targetDetachedReason,
    },
    state: row.state,
    phase: row.phase,
    waitReason: row.waitReason,
    waitDependency: mapWaitDependency(row),
    nextAction: computeOperatorTaskNextAction(row.state, row.waitReason),
    revision: row.revision,
    attemptOrdinal: row.attemptOrdinal,
    currentStepKey: row.currentStepKey,
    deadlineAt: row.deadlineAt ? row.deadlineAt.toISOString() : null,
    nextWakeAt: row.nextWakeAt ? row.nextWakeAt.toISOString() : null,
    outcome: row.outcome,
    outcomeDetail: row.outcomeDetail,
    handoffSummary: row.handoffSummary,
    accountingRootTaskId: row.accountingRootTaskId,
    successorOfTaskId: row.successorOfTaskId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * List-item projection for `GET /ai/operator/tasks` — no `operations`/`runs`
 * (that's what the detail route joins). Built from the same shared mapper the
 * detail DTO uses, so the two routes cannot drift on what a "task" looks
 * like.
 */
export function mapOperatorTaskListItem(row: OperatorTaskRowInput): AiOperatorTaskListItemDto {
  return mapOperatorTaskListItem_(row);
}

/**
 * The full task detail DTO: the shared list fields plus safely-projected
 * `operations`/`runs`.
 */
export function mapOperatorTask(
  row: OperatorTaskRowInput,
  operations: OperatorOperationRowInput[],
  runs: OperatorRunLinkRowInput[],
): AiOperatorTaskDto {
  return {
    ...mapOperatorTaskListItem_(row),
    operations: operations.map(mapOperatorOperation),
    runs: runs.map(mapOperatorRunLink),
  };
}
