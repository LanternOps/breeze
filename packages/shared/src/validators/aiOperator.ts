import { z } from 'zod';
import { AI_OPERATOR_TASK_STATES } from '../types/aiOperator';

/**
 * AI Operator task context carried into `createActionIntent` (#5205 W04,
 * sub-issue #5209).
 *
 * INTERNAL ONLY — this is TRUSTED input. It is the identity under which an
 * operation reserves its `ai_operator_operations` row and from which the
 * intent's `idempotency_key` is derived, so accepting it from an HTTP body
 * would let a caller (a) mint an intent that a task it does not own is then
 * obliged to reconcile, and (b) choose the single ON CONFLICT arbiter's key
 * material directly. Every HTTP intent surface must therefore build its
 * `CreateActionIntentInput` WITHOUT this field; the coordinator (W06) is the
 * only producer.
 *
 * The schema exists so that the one internal seam that does construct it
 * validates shape and bounds at the boundary rather than trusting a
 * hand-built object literal. The `max()` bounds mirror the CHECK constraints
 * on `ai_operator_operations.task_step_key` (128) and `.operation_key` (200)
 * declared in 2026-10-14-100000-ai-operator-thin-slice.sql, so an over-long
 * key is a typed rejection at the seam instead of a 23514 mid-transaction.
 */
export const actionIntentTaskContextSchema = z.object({
  taskId: z.string().uuid(),
  taskStepKey: z.string().min(1).max(128),
  operationKey: z.string().min(1).max(200),
  /**
   * The reasoning attempt this proposal came from. Recorded on the operation
   * row for lineage; it is deliberately NOT part of the operation identity —
   * a continuation run re-proposing the SAME operation must converge on the
   * existing row, which is precisely what makes attempt 2 attach instead of
   * duplicating (spec §6.5).
   */
  attemptOrdinal: z.number().int().min(0),
}).strict();

export type ActionIntentTaskContext = z.infer<typeof actionIntentTaskContextSchema>;

// ---- W07 (#5254): read-side list query ----

/**
 * Query validator for `GET /ai/operator/tasks` (#5205 W07). Mirrors the
 * shape of the org-wide `GET /ai/agents/runs` query
 * (`apps/api/src/routes/aiAgents.ts`) — keyset `cursor`, clamped `limit`,
 * plus this route's own filters (`deviceId`, `state`).
 */
export const operatorTaskListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  deviceId: z.string().guid().optional(),
  state: z.enum(AI_OPERATOR_TASK_STATES).optional(),
});
export type OperatorTaskListQuery = z.infer<typeof operatorTaskListQuerySchema>;

// ---- W06 (#5211): submit_task_step, recipe inputs, criteria, checkpoint ----

/**
 * `submit_task_step` payload (spec §6.2). The versioned, bounded finding /
 * next-step proposal a task-linked reasoning run submits as its LAST action.
 *
 * IT EXECUTES NOTHING. The tool handler validates and acknowledges; server
 * code in `recipes/serviceRecovery.ts` then decides whether the proposed
 * `nextStep.key` is permitted for this recipe and whether its inputs parse
 * against that step's own schema. A key the recipe does not permit, or inputs
 * that do not parse, end the run with a classified failure and hand the task
 * off — the model never widens its own permissions by naming a step.
 *
 * Every string is bounded because this payload is persisted into the task
 * checkpoint, and the checkpoint has a 64 KiB `pg_column_size` CHECK
 * (`ai_operator_tasks_checkpoint_size_chk`). Bounding here turns an oversize
 * model response into a typed tool-level rejection the model can retry,
 * instead of a 23514 that kills the whole transaction.
 */
export const SUBMIT_TASK_STEP_VERSION = 1 as const;

/** Where a finding came from. Mirrors the outbox/execution reference vocabulary. */
export const TASK_STEP_FINDING_SOURCE_KINDS = [
  'device', 'alert', 'service_state', 'device_command', 'operation', 'run', 'other',
] as const;
export type TaskStepFindingSourceKind = (typeof TASK_STEP_FINDING_SOURCE_KINDS)[number];

export const taskStepFindingSchema = z.object({
  /** One bounded factual observation. Never chain-of-thought, never raw tool output. */
  text: z.string().min(1).max(500),
  sourceKind: z.enum(TASK_STEP_FINDING_SOURCE_KINDS),
  /**
   * The id of the record the finding came from, as a STRING (not `.uuid()`):
   * a service name or a metric key is a legitimate source id and is not a
   * uuid. Server code never dereferences this as authorization — it is
   * provenance for a human reader (spec §6.2's "structured findings with
   * provenance").
   */
  sourceId: z.string().min(1).max(200).nullable(),
  /** When the underlying fact was observed, so staleness is visible. */
  observedAt: z.string().datetime(),
}).strict();
export type TaskStepFinding = z.infer<typeof taskStepFindingSchema>;

export const taskStepNextStepSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('step'),
    /** Validated against the RECIPE's permitted keys server-side, not here. */
    key: z.string().min(1).max(128),
    /** Validated against that step's own input schema server-side. */
    inputs: z.record(z.string(), z.unknown()).default({}),
  }).strict(),
  z.object({
    kind: z.literal('handoff'),
    reason: z.string().min(1).max(200),
    summary: z.string().min(1).max(2000),
  }).strict(),
  z.object({
    kind: z.literal('question'),
    text: z.string().min(1).max(1000),
  }).strict(),
]);
export type TaskStepNextStep = z.infer<typeof taskStepNextStepSchema>;

export const submitTaskStepSchema = z.object({
  version: z.literal(SUBMIT_TASK_STEP_VERSION),
  findings: z.array(taskStepFindingSchema).max(20).default([]),
  nextStep: taskStepNextStepSchema,
}).strict();
export type SubmitTaskStepPayload = z.infer<typeof submitTaskStepSchema>;

/**
 * Service-recovery recipe input (baseline §2.2), frozen at admission.
 *
 * `serviceName` is part of the argument digest, so changing it is a NEW
 * operation and a NEW approval (spec §7.1). `maxRestartAttempts` is capped at
 * 2 by the recipe even though spec §7.2 allows 3 mutation attempts per target
 * — the recipe is deliberately the narrower of the two bounds.
 */
export const serviceRecoveryInputSchema = z.object({
  deviceId: z.string().uuid(),
  serviceName: z.string().min(1).max(255),
  /** The alert whose recovery is HALF the success criterion. Null is allowed
   *  and changes the achievable outcome — see `serviceRecovery.ts`. */
  triggeringAlertId: z.string().uuid().nullable(),
  maxRestartAttempts: z.number().int().min(1).max(2).default(1),
}).strict();
export type ServiceRecoveryInput = z.infer<typeof serviceRecoveryInputSchema>;

/**
 * A typed verification criterion (spec §8.1). Named adapter + version, exact
 * target, expected condition, and an EXPLICIT `freshnessSeconds` — because no
 * freshness bound exists in the codebase today (baseline C9: `VERIFY_READ_TIMEOUT_MS`
 * is a read deadline and `FIX_HOLD_MINUTES` is a recurrence hold; neither is a
 * staleness window).
 */
export const taskCriterionSchema = z.object({
  adapter: z.literal('service_running'),
  adapterVersion: z.literal(1),
  deviceId: z.string().uuid(),
  serviceName: z.string().min(1).max(255),
  /** Evidence older than this is `inconclusive`, never `passed`. */
  freshnessSeconds: z.number().int().min(30).max(3600).default(120),
  /** Null when the task has no triggering alert — see `evaluateCriterion`. */
  alertId: z.string().uuid().nullable(),
  /**
   * Whether this recipe accepts `verified_resolved` for a criterion that has
   * NO recurrence signal (no alert). False means the best achievable outcome
   * without an alert is `investigation_complete` (spec §8.1, C11).
   */
  resolvableWithoutAlert: z.boolean().default(false),
}).strict();
export type TaskCriterion = z.infer<typeof taskCriterionSchema>;

export const TASK_VERIFICATION_RESULTS = ['passed', 'failed', 'inconclusive', 'not_applicable'] as const;
export type TaskVerificationResult = (typeof TASK_VERIFICATION_RESULTS)[number];

/**
 * The bounded factual checkpoint persisted on `ai_operator_tasks.checkpoint`
 * and rehydrated into a continuation run's prompt (spec §6.2).
 *
 * DELIBERATELY NOT A FREE CONTAINER. Chain-of-thought and raw tool output are
 * never persisted here, and nothing read out of it is ever re-injected as an
 * INSTRUCTION — `taskContext.ts` renders it as a fenced factual block. The
 * schema is versioned so a checkpoint written by an older release parses (or
 * is explicitly rejected) rather than being trusted structurally.
 */
export const TASK_CHECKPOINT_VERSION = 1 as const;

export const taskCheckpointSchema = z.object({
  version: z.literal(TASK_CHECKPOINT_VERSION),
  recipeInput: serviceRecoveryInputSchema,
  criterion: taskCriterionSchema,
  findings: z.array(taskStepFindingSchema).max(50).default([]),
  /** Criteria the coordinator has proven satisfied, by adapter name. */
  satisfiedCriteria: z.array(z.string().max(64)).max(10).default([]),
  unsatisfiedCriteria: z.array(z.string().max(64)).max(10).default([]),
  /** How many mutation attempts this target has consumed across ALL runs. */
  mutationAttempts: z.number().int().min(0).max(10).default(0),
  /** The last verification verdict, so a continuation run knows why it exists. */
  lastVerification: z.object({
    result: z.enum(TASK_VERIFICATION_RESULTS),
    detail: z.string().max(500),
    at: z.string().datetime(),
  }).strict().nullable().default(null),
  /** The operation key most recently reserved for this task, for lineage. */
  lastOperationKey: z.string().max(200).nullable().default(null),
  /** The fix watch opened for the alert half of the criterion, if any. */
  fixWatchId: z.string().uuid().nullable().default(null),
}).strict();
export type TaskCheckpoint = z.infer<typeof taskCheckpointSchema>;
