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
 * of truth for the column). Kept as a separate, hand-duplicated literal list
 * here — NOT the same pattern as `AI_AGENT_RUN_STATUSES` (review correction,
 * PR #5254): that one is declared exactly once, in `aiAgents.ts` in this same
 * file, and `apps/api/src/db/schema/aiAgents.ts` type-imports it directly
 * (`import type { AiAgentRunStatus } from '@breeze/shared'`) — a type-only
 * import, so `packages/shared` cannot import from `apps/api/src/db` is not
 * actually what blocks doing the same thing here; nothing did. The six/seven
 * unions in this file duplicate what `db/schema/aiOperatorTasks.ts` already
 * exports (W03, already merged) instead of that schema file importing from
 * here, which the `ai_agent_runs` precedent shows is possible. Consolidating
 * onto one declaration (schema imports from shared, matching `aiAgents.ts`)
 * is a reasonable follow-up; not done in this read-only wave to avoid editing
 * an already-shipped, unrelated-wave schema file. `enumParity.test.ts`
 * (`apps/api/src/services/aiOperator/`) mechanically asserts the two copies
 * stay equal in the meantime — if the schema's list changes, that test fails
 * until this one is updated to match.
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
  'reserved', 'dispatched', 'dispatch_failed', 'cancelled', 'abandoned',
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

/**
 * The fields common to both the list item and the detail DTO — everything
 * `GET /ai/operator/tasks` and `GET /ai/operator/tasks/:id` agree on.
 *
 * This is the PRIMARY declaration (review fix, PR #5254): `AiOperatorTaskDto`
 * below is `extends AiOperatorTaskListItemDto`, adding only `operations`/
 * `runs`. Declaring it the other way around — `AiOperatorTaskListItemDto =
 * Omit<AiOperatorTaskDto, 'operations' | 'runs'>` — silently includes any
 * FUTURE field added directly to the detail DTO on the list DTO too, with no
 * compiler signal that a detail-only addition (e.g. a heavier per-row
 * evidence blob) needs an explicit decision about whether it belongs on a
 * paginated list of up to 50 rows. Extending forward from this base makes
 * that decision visible: a field belongs on the list only if it's declared
 * here, and a detail-only field requires touching `AiOperatorTaskDto`
 * explicitly. This also matches how `mapOperatorTask`
 * (`apps/api/src/services/aiOperator/taskReadService.ts`) actually builds the
 * two DTOs at runtime — base fields via `mapOperatorTaskListItem_`, with
 * `operations`/`runs` appended for the detail shape — so the type and the
 * implementation now agree on which one is primary.
 */
export interface AiOperatorTaskListItemDto {
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
  nextAction: AiOperatorTaskNextAction;
}

/** The full task detail DTO — the list-item fields plus safely-projected
 *  `operations`/`runs`, and (wave E2) `targets`/`steps`/`events`.
 *
 *  ADDITIVE ONLY. `AI_OPERATOR_TASK_DTO_SCHEMA_VERSION` stays 1: every field
 *  the pre-E2 client reads is still present with the same shape, including
 *  the inline `target` projection, which recipe spec §5.5 keeps until P3-5
 *  removes the inline columns. A client that ignores the three new arrays
 *  behaves exactly as before. */
export interface AiOperatorTaskDto extends AiOperatorTaskListItemDto {
  operations: AiOperatorTaskOperationDto[];
  runs: AiOperatorTaskRunLinkDto[];
  targets: AiOperatorTaskTargetRowDto[];
  steps: AiOperatorTaskStepDto[];
  events: AiOperatorTaskEventDto[];
}

// ---------------------------------------------------------------------------
// Task graph — wave E2 (recipe spec §5.1, §5.2, §5.3).
//
// Same hand-duplication caveat as the six unions at the top of this file:
// `packages/shared` cannot import `apps/api/src/db/schema`, so each list below
// is mirrored by an identically-named export in
// `apps/api/src/db/schema/aiOperatorTaskGraph.ts` and pinned byte-for-byte by
// `apps/api/src/services/aiOperator/enumParity.test.ts`. If you change one,
// that test fails until you change the other.
// ---------------------------------------------------------------------------

/** `ai_operator_task_targets.target_kind`. The DB/wire spelling of E1's
 *  recipe-facing `TargetKind` (`services/aiOperator/recipes/types.ts`);
 *  enumParity.test.ts asserts the two are equal. */
export const AI_OPERATOR_TARGET_KINDS = ['device', 'ticket', 'contact'] as const;
export type AiOperatorTargetKind = (typeof AI_OPERATOR_TARGET_KINDS)[number];

/**
 * `ai_operator_task_targets.state`.
 *
 * `detached` is a STATE, not merely a stamp: a detached target has lost its
 * pointer and can never be acted on again, and the coordinator must be able
 * to see that with one column read rather than by inferring it from a null
 * pointer (which is also what an unresolved onboarding target looks like
 * before its account exists).
 */
export const AI_OPERATOR_TARGET_STATES = [
  'pending', 'active', 'succeeded', 'failed', 'skipped', 'detached',
] as const;
export type AiOperatorTargetState = (typeof AI_OPERATOR_TARGET_STATES)[number];

/** `ai_operator_task_steps.step_kind` — recipe spec §5.3 / §6.1's execution
 *  table. `human_work` has no writer until wave E3; the value ships now so
 *  E3 needs no CHECK-constraint churn (same pattern as `mode = 'trial'`). */
export const AI_OPERATOR_STEP_KINDS = [
  'reason', 'effect', 'probe', 'wait', 'human_work', 'document',
] as const;
export type AiOperatorStepKind = (typeof AI_OPERATOR_STEP_KINDS)[number];

/** `ai_operator_task_steps.state`. `waiting` mirrors the task's own typed
 *  wait: a step that yielded is not the same as a step that has not started. */
export const AI_OPERATOR_STEP_STATES = [
  'pending', 'running', 'waiting', 'succeeded', 'failed', 'skipped',
] as const;
export type AiOperatorStepState = (typeof AI_OPERATOR_STEP_STATES)[number];

/** `ai_operator_task_target_accounts.provider` (recipe spec §5.2). */
export const AI_OPERATOR_ACCOUNT_PROVIDERS = ['m365', 'google'] as const;
export type AiOperatorAccountProvider = (typeof AI_OPERATOR_ACCOUNT_PROVIDERS)[number];

/**
 * `ai_operator_task_events.event_type`.
 *
 * Named for what HAPPENED, matching `TASK_TRANSITION_EVENTS`'
 * (`services/aiOperator/taskTransitions.ts`) own convention. Deliberately NOT
 * the same list: a transition event is "what may move the task", an event row
 * is "what was recorded", and several rows here (`operation_*`,
 * `verification_recorded`) correspond to no state change at all.
 */
export const AI_OPERATOR_TASK_EVENT_TYPES = [
  'task_admitted',
  'lease_claimed',
  'step_opened',
  'step_settled',
  'wait_entered',
  'wait_resolved',
  'target_attached',
  'target_detached',
  'target_account_frozen',
  'operation_reserved',
  'operation_settled',
  'verification_recorded',
  'plan_revision_bumped',
  /**
   * A human cleared the tick on an `operator_task` checklist item AFTER the
   * step that created it had already settled (recipe spec §6.5: "Un-checking
   * an item after the task advanced writes an event and does not rewind").
   *
   * Its own value rather than a reused `step_settled`: this table is APPEND-ONLY
   * evidence, and recording a settle that did not happen is a false entry in
   * the record a technician reads to understand what the Operator did.
   */
  'human_work_unticked',
  'task_settled',
] as const;
export type AiOperatorTaskEventType = (typeof AI_OPERATOR_TASK_EVENT_TYPES)[number];

/**
 * `ai_operator_task_events.actor_kind`.
 *
 * `coordinator` and `reconciler` are distinct on purpose: "the reconciler
 * settled this" and "the coordinator settled this" are different operational
 * stories, and conflating them is how a polling fallback masquerades as the
 * event path. Spec §7.1: database context has no synthetic human user id, so
 * a machine actor NEVER carries an `actorUserId`.
 */
export const AI_OPERATOR_EVENT_ACTOR_KINDS = [
  'coordinator', 'reconciler', 'user', 'agent', 'system',
] as const;
export type AiOperatorEventActorKind = (typeof AI_OPERATOR_EVENT_ACTOR_KINDS)[number];

/** One frozen provider account behind a `contact` target (recipe spec §5.2).
 *  `externalId` is the immutable Entra object id / Google user id, never the
 *  UPN — a rename mid-task cannot retarget an effect. */
export interface AiOperatorTaskTargetAccountDto {
  provider: AiOperatorAccountProvider;
  /** The m365_connections / google_workspace_connections row, or null once the
   *  connection has been removed or the org merged away. */
  connectionId: string | null;
  externalId: string;
  principalLabel: string;
}

/** One `ai_operator_task_targets` row, safely projected. */
export interface AiOperatorTaskTargetRowDto {
  id: string;
  targetKind: AiOperatorTargetKind;
  deviceId: string | null;
  ticketId: string | null;
  contactId: string | null;
  /** The label frozen at admission — survives detach, which is the point. */
  label: string;
  ordinal: number;
  state: AiOperatorTargetState;
  detachedAt: string | null;
  detachedReason: AiOperatorTargetDetachReason | null;
  accounts: AiOperatorTaskTargetAccountDto[];
}

/** One `ai_operator_task_steps` row, safely projected. NEVER carries the
 *  step's `checkpoint` jsonb (`excludedOpen`), same rule as
 *  `AiOperatorTaskOperationDto` and `result`. */
export interface AiOperatorTaskStepDto {
  id: string;
  stepKey: string;
  stepKind: AiOperatorStepKind;
  targetId: string | null;
  attemptOrdinal: number;
  state: AiOperatorStepState;
  planRevision: number | null;
  expectedCriterion: string | null;
  dependency: AiOperatorWaitDependencyDto | null;
  detail: string | null;
  startedAt: string | null;
  settledAt: string | null;
}

/** One `ai_operator_task_events` row, safely projected. `detail` is the
 *  BOUNDED text column, not a container — there is no jsonb on this table. */
export interface AiOperatorTaskEventDto {
  id: string;
  transitionSeq: number;
  eventType: AiOperatorTaskEventType;
  actorKind: AiOperatorEventActorKind;
  actorUserId: string | null;
  stepKey: string | null;
  targetId: string | null;
  detail: string | null;
  createdAt: string;
}
