/**
 * AI Operator task DTOs (#5205 W07, read side — P3-1e). What `GET
 * /ai/operator/tasks` (org-scoped keyset list) and `GET
 * /ai/operator/tasks/:id` (detail) actually put on the wire.
 *
 * These mirror the `AI_AGENT_RUN_*` precedent in `aiAgentRuns.ts`: a task,
 * operation or event DTO is assembled by a named-field mapper in
 * `apps/api/src/services/aiOperator/taskReadService.ts`, never `{ ...row }`.
 * Per baseline spec §8.3 ("Field-level projection rules") the safe surface
 * may carry ids, `workflow_key`/`version`, state/phase/wait-reason, deadline,
 * `next_wake_at`, bounded `objective` text, a target display label, and
 * execution-reference **ids** — and must NEVER carry `checkpoint`, `criteria`,
 * raw model/tool text, `toolInput`/`toolOutput`, `args`, or the raw
 * device-command `result` payload.
 *
 * `AI_OPERATOR_TASK_LEAK_TRIPWIRE_KEYS` is the single source both here and in
 * the route-level serialization test use to assert none of those keys ever
 * reaches `JSON.stringify(response)` for a task/operation DTO — same
 * "impossible by construction" contract as `AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS`.
 */
export const AI_OPERATOR_TASK_LEAK_TRIPWIRE_KEYS = [
  'checkpoint', 'criteria', 'args', 'toolInput', 'toolOutput', 'result',
] as const;

export const AI_OPERATOR_TASK_DTO_SCHEMA_VERSION = 1 as const;

/**
 * Mirrors `AI_OPERATOR_TASK_STATES` in
 * `apps/api/src/db/schema/aiOperatorTasks.ts` (the CHECK-constrained source
 * of truth for the column). Kept as a separate literal list here — same
 * pattern as `AI_AGENT_RUN_STATUSES` vs. the `ai_agent_runs.status` column —
 * because `packages/shared` cannot import from `apps/api/src/db`. If the
 * schema's list changes, update both.
 */
export const AI_OPERATOR_TASK_STATES = [
  'queued', 'running', 'waiting', 'paused', 'stopping',
  'completed', 'partial', 'handed_off', 'cancelled', 'failed', 'expired',
] as const;
export type AiOperatorTaskState = (typeof AI_OPERATOR_TASK_STATES)[number];

export const AI_OPERATOR_TASK_PHASES = ['investigate', 'plan', 'execute', 'verify', 'document'] as const;
export type AiOperatorTaskPhase = (typeof AI_OPERATOR_TASK_PHASES)[number];

export const AI_OPERATOR_WAIT_REASONS = [
  'approval', 'information', 'execution', 'device', 'maintenance_window', 'verification_window',
] as const;
export type AiOperatorWaitReason = (typeof AI_OPERATOR_WAIT_REASONS)[number];

export const AI_OPERATOR_TASK_OUTCOMES = [
  'verified_resolved', 'investigation_complete', 'report_delivered',
  'no_action_needed', 'trial_complete', 'unresolved', 'unknown_effect',
] as const;
export type AiOperatorTaskOutcome = (typeof AI_OPERATOR_TASK_OUTCOMES)[number];

export const AI_OPERATOR_TARGET_DETACH_REASONS = [
  'device_moved', 'device_deleted', 'org_merged', 'scope_invalidated',
] as const;
export type AiOperatorTargetDetachReason = (typeof AI_OPERATOR_TARGET_DETACH_REASONS)[number];

export const AI_OPERATOR_WAIT_DEPENDENCY_KINDS = [
  'intent', 'operation', 'run', 'device_command', 'user_answer', 'verification',
] as const;
export type AiOperatorWaitDependencyKind = (typeof AI_OPERATOR_WAIT_DEPENDENCY_KINDS)[number];

export const AI_OPERATOR_EXECUTION_REF_KINDS = [
  'device_command', 'script_execution', 'patch_job_target', 'playbook_execution',
  'ticket_comment', 'report_delivery',
] as const;
export type AiOperatorExecutionRefKind = (typeof AI_OPERATOR_EXECUTION_REF_KINDS)[number];

export const AI_OPERATOR_OPERATION_DISPATCH_STATES = [
  'reserved', 'dispatched', 'dispatch_failed', 'abandoned',
] as const;
export type AiOperatorOperationDispatchState = (typeof AI_OPERATOR_OPERATION_DISPATCH_STATES)[number];

export const AI_OPERATOR_OPERATION_RESULT_STATES = [
  'pending', 'succeeded', 'failed', 'unknown', 'superseded',
] as const;
export type AiOperatorOperationResultState = (typeof AI_OPERATOR_OPERATION_RESULT_STATES)[number];

/**
 * Server-computed "what happens next" for the task detail header and the
 * Needs-Attention style workspace lists (spec §5.2). Purely derived from
 * state/phase/waitReason/outcome — never stored — so the read service and
 * this type are the only place the mapping needs to change.
 */
export const AI_OPERATOR_TASK_NEXT_ACTIONS = [
  'approve_in_inbox',
  'answer_question',
  'waiting_for_device',
  'waiting_for_maintenance_window',
  'waiting_for_verification_window',
  'waiting_for_execution',
  'queued',
  'in_progress',
  'paused',
  'stopping',
  'handed_off',
  'none',
] as const;
export type AiOperatorTaskNextAction = (typeof AI_OPERATOR_TASK_NEXT_ACTIONS)[number];

export interface AiOperatorTaskAgentDto {
  id: string;
  kind: string;
  name: string;
}

/** Matches `ai_operator_tasks.mode` (`text` + CHECK) — `'trial'` is reserved
 *  for P3-4; the thin slice only ever admits `'live'`. */
export type AiOperatorTaskMode = 'live' | 'trial';

/** Matches `ai_operator_tasks.origin_kind` (`text` NOT NULL). */
export type AiOperatorTaskOriginKind =
  | 'manual' | 'alert' | 'ticket' | 'schedule' | 'anomaly' | 'sweep' | 'chat';

export interface AiOperatorTaskTargetDto {
  deviceId: string | null;
  label: string | null;
  detachedAt: string | null;
  detachedReason: AiOperatorTargetDetachReason | null;
}

export interface AiOperatorWaitDependencyDto {
  kind: AiOperatorWaitDependencyKind;
  id: string;
}

/**
 * One `ai_operator_operations` row, safely projected. NEVER carries the raw
 * `result` jsonb column (baseline §8.3, §8.4 — `result` is `excludedOpen` in
 * the export policy) — `resultState` is the whole story a caller gets about
 * what happened; a free-text summary was deliberately not added because
 * there is no verified-safe way to excerpt an arbitrary per-execution-kind
 * jsonb payload without risking a leak.
 */
export interface AiOperatorTaskOperationDto {
  operationKey: string;
  attemptOrdinal: number;
  intentId: string | null;
  dispatchState: AiOperatorOperationDispatchState;
  resultState: AiOperatorOperationResultState;
  executionRef: { kind: AiOperatorExecutionRefKind; id: string } | null;
  dispatchedAt: string | null;
  resultAt: string | null;
}

/** One linked `ai_agent_runs` row — id + display fields only, with a link
 *  the client resolves against the existing `/ai-agents/runs/:id` page. */
export interface AiOperatorTaskRunLinkDto {
  id: string;
  status: string;
  attemptOrdinal: number | null;
  promptVersion: string | null;
  resolvedModel: string | null;
}

export interface AiOperatorTaskDto {
  schemaVersion: typeof AI_OPERATOR_TASK_DTO_SCHEMA_VERSION;
  id: string;
  orgId: string;
  // Non-null: unlike `ai_agent_runs.agent_id` (a live FK resolved via LEFT
  // JOIN, with the dual-ownership partner-wide visibility gap that route's
  // comments document), `ai_operator_tasks.agent_kind`/`agent_name` are
  // frozen NOT NULL columns copied onto the task row at admission (spec
  // §11.3) precisely so a later-repointed, renamed, or re-kinded agent can
  // never rewrite what the task's evidence says it was run by. No join, no
  // RLS-visibility gap, never null.
  agent: AiOperatorTaskAgentDto;
  workflowKey: string;
  workflowVersion: number;
  mode: AiOperatorTaskMode;
  originKind: AiOperatorTaskOriginKind;
  objective: string;
  target: AiOperatorTaskTargetDto;
  state: AiOperatorTaskState;
  phase: AiOperatorTaskPhase | null;
  waitReason: AiOperatorWaitReason | null;
  waitDependency: AiOperatorWaitDependencyDto | null;
  revision: number;
  attemptOrdinal: number;
  currentStepKey: string | null;
  deadlineAt: string | null;
  nextWakeAt: string | null;
  outcome: AiOperatorTaskOutcome | null;
  outcomeDetail: string | null;
  handoffSummary: string | null;
  accountingRootTaskId: string | null;
  successorOfTaskId: string | null;
  createdAt: string;
  updatedAt: string;
  operations: AiOperatorTaskOperationDto[];
  runs: AiOperatorTaskRunLinkDto[];
  nextAction: AiOperatorTaskNextAction;
}

/** Lighter list-item projection for `GET /ai/operator/tasks` — no
 *  operations/runs (that's what the detail route is for). */
export type AiOperatorTaskListItemDto = Omit<AiOperatorTaskDto, 'operations' | 'runs'>;
