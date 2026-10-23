import { z } from 'zod';
import { AI_OPERATOR_TASK_STATES } from '../types/aiOperator';
import { identityOffboardingInputSchema } from './aiOperatorIdentity';

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

/**
 * Where a recipe's frozen planning facts live (Recipe Library W06 R1a-0,
 * plan Amendment A.4 "Seal semantics"). `stepId` is the
 * `ai_operator_task_steps.id` of the recipe's `planningSnapshotStepKey` row,
 * whose own `checkpoint` holds the full `{ version, capturedAt, facts }`
 * envelope; `digest` is that envelope's facts digest (sha-256 hex). Integrity
 * metadata only — it is never part of the plan's effect seal.
 */
export const planningSnapshotRefSchema = z.object({
  stepId: z.string().uuid(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type PlanningSnapshotRef = z.infer<typeof planningSnapshotRefSchema>;

/**
 * Every checkpoint field common to every recipe's arm: today's field list minus
 * `version` (each arm states it first), `recipeInput` and `criterion` (both are
 * per-recipe), plus the two R1a-0 fields.
 *
 * The two R1a-0 fields are `.optional()` with NO default, on purpose: a
 * defaulted field would serialize into every re-written `service_recovery`
 * row and change its stored bytes (pinned by e4Characterization 1a-3).
 */
export const taskCheckpointBaseSchema = z.object({
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
  /**
   * When a `wait` step may resume (recipe spec §6.1's `wait` row, §6.3's
   * `wait_cutoff`). ISO-8601. Written by the step that transitions INTO the
   * wait, read by the coordinator's generic `advanceWait`.
   */
  waitUntil: z.string().datetime().optional(),
  /**
   * The step key the coordinator moves to when the current `wait` or
   * `human_work` step settles.
   *
   * NOT derivable from `permittedNextSteps`: that map says what the MODEL may
   * propose, and a human-work or timed wait has no model output at all. The
   * recipe's spine owns the successor, so the step that enters the wait states
   * it. Absent is a recipe bug and is refused loudly, never guessed.
   */
  resumeStepKey: z.string().min(1).max(128).optional(),
  /**
   * The frozen planning snapshot `buildPlan` reads its facts from (R1a-0).
   * Present exactly when the task's recipe declares `planningSnapshotStepKey`;
   * either mismatch is a fail-closed snapshot failure, never a `{}` rebuild.
   */
  planningSnapshot: planningSnapshotRefSchema.optional(),
  /**
   * ISO-8601. Once the plan is approved and re-sealed, the effect walk starts
   * no NEW dispatch before this instant (wait reason `maintenance_window`).
   * Already-dispatched effects are still observed while it holds.
   */
  dispatchNotBefore: z.string().datetime().optional(),
});

/**
 * The `service_recovery` arm: field-for-field the pre-R1a-0
 * `taskCheckpointSchema`.
 *
 * Built as an explicit object, NOT `taskCheckpointBaseSchema.extend(...)`:
 * key order is part of the stored-bytes promise. `extend` would serialize
 * `version, findings, …, recipeInput, criterion`; stored rows are
 * `version, recipeInput, criterion, findings, …`. The two R1a-0 fields come
 * last and, having no default, never serialize for this arm unless set.
 */
export const serviceRecoveryCheckpointSchema = z.object({
  version: z.literal(TASK_CHECKPOINT_VERSION),
  recipeInput: serviceRecoveryInputSchema,
  criterion: taskCriterionSchema,
  ...taskCheckpointBaseSchema.shape,
}).strict();
export type ServiceRecoveryCheckpoint = z.infer<typeof serviceRecoveryCheckpointSchema>;

/**
 * The `identity_offboarding` arm (Recipe Library W06 R1a).
 *
 * No `criterion`: this recipe is verified by its `verify_outcome` probe step,
 * not by a typed criterion. Discovery facts live on the `discover` STEP row,
 * pinned by the base's `planningSnapshot` ref (R1a-0); only the bounded
 * manual-work cursor lives here. A new arm, so `extend` and its key order are
 * fine — no stored row predates it.
 */
export const identityOffboardingCheckpointSchema = taskCheckpointBaseSchema.extend({
  version: z.literal(TASK_CHECKPOINT_VERSION),
  recipeInput: identityOffboardingInputSchema,
  /** Next manual-work item index the `manual_work` step binds a step row to (D-R1-5). */
  manualWorkCursor: z.number().int().min(0).max(64).default(0),
  /**
   * Provider lookups that FAILED at admission while another account was found
   * (a broken connection, an address resolving to someone else). Frozen so the
   * gap is never silent: each becomes a manual item, and any of them keeps the
   * verdict from `passed` — Breeze did not check that provider.
   */
  admissionProblems: z.array(z.string().min(1).max(500)).max(10).default([]),
}).strict();
export type IdentityOffboardingCheckpoint = z.infer<typeof identityOffboardingCheckpointSchema>;

/**
 * One arm per recipe shape. A stored row's arm is fixed by its shape: a
 * service-recovery row cannot lose its criterion, and an identity row cannot
 * grow one. Both arms and both `recipeInput` schemas are `.strict()`, so
 * neither arm can absorb the other's row. The service-recovery arm stays
 * FIRST: a stored SR row still resolves to it, byte-identically (1a-3).
 */
export const taskCheckpointSchema = z.union([
  serviceRecoveryCheckpointSchema,
  identityOffboardingCheckpointSchema,
]);
export type TaskCheckpoint = z.infer<typeof taskCheckpointSchema>;

/** Narrow to the `service_recovery` arm. Never cast a checkpoint; narrow it. */
export function isServiceRecoveryCheckpoint(c: TaskCheckpoint): c is ServiceRecoveryCheckpoint {
  return 'criterion' in c;
}

/** Narrow to the `identity_offboarding` arm. Never cast a checkpoint; narrow it. */
export function isIdentityOffboardingCheckpoint(c: TaskCheckpoint): c is IdentityOffboardingCheckpoint {
  return !('criterion' in c) && 'manualWorkCursor' in c;
}

// ---- W08 (#5246): admission request ----

/**
 * The record a task may cite as the reason it was delegated (spec §12,
 * "optional source record"). Provenance only — it never widens authority and
 * never selects a target: the target is `deviceId`, which the server
 * re-resolves and re-authorizes on its own.
 */
export const OPERATOR_TASK_SOURCE_KINDS = ['alert', 'device'] as const;
export type OperatorTaskSourceKind = (typeof OPERATOR_TASK_SOURCE_KINDS)[number];

/**
 * Body validator for `POST /api/v1/ai/operator/tasks` (#5205 W08, spec §12).
 *
 * `.strict()` is load-bearing, not tidiness. Spec §12: "Requests cannot supply
 * a principal, effective policy, approval result, or trusted continuation
 * token." Every one of those would arrive as an extra property — `task`,
 * `policySnapshot`, `approval`, `principal`, `agentId` — and `.strict()` is
 * what turns each into a 400 instead of a silently ignored field that a later
 * refactor might start honouring. There is deliberately no `agentId` here
 * either: §5.1 says the SERVER resolves the agent, so letting a client name
 * one would be a client-chosen principal by another door.
 *
 * `mode` is a literal `'live'`; trials are P3-5, and admitting one through
 * this route would produce a live task labelled as a trial.
 */
export const createOperatorTaskSchema = z.object({
  mode: z.literal('live'),
  /**
   * The workflow the client is admitting. NOT a literal: the server validates
   * it against the recipe registry so an unknown key is refused with a 400
   * that names the supported workflows, which a zod literal mismatch cannot
   * do. `apps/api` owns the registry; `packages/shared` cannot import it.
   * The 128 cap mirrors `ai_operator_tasks_workflow_key_len_chk`.
   */
  recipeKey: z.string().min(1).max(128),
  /**
   * The recipe version the CLIENT reviewed. Checked against the server's
   * released version and refused (422) on mismatch rather than silently
   * upgraded — spec §5.1: the operator approves a specific reviewed workflow,
   * and a cached catalog is never authority.
   */
  recipeVersion: z.number().int().min(1),
  orgId: z.string().guid(),
  /**
   * OPTIONAL since R1a. `service_recovery` still sends it and the route still
   * folds it into that recipe's input, so the shipped web client is unchanged;
   * a contact-targeted recipe sends none. The route — not this schema —
   * resolves the recipe and parses `inputs` with `recipe.inputSchema`, which
   * is where per-recipe strictness lives now.
   */
  deviceId: z.string().guid().optional(),
  /**
   * Recipe-specific inputs, validated by the RECIPE (R1a). Deliberately not a
   * discriminated union on `recipeKey`: that would make an unknown key a
   * generic zod 400 and undo E1's decision 6, whose whole point is a refusal
   * that names `RECIPE_KEYS`. The outer object stays `.strict()`, and every
   * recipe's own `inputSchema` is `.strict()` too, so nothing is loosened —
   * the check moves one layer in. For every key other than a contact-targeted
   * recipe, the route re-applies `deviceTargetedTaskFieldsSchema` (the shipped
   * `deviceId` + `inputs` shapes, byte-for-byte) and returns the same 400.
   */
  inputs: z.record(z.string(), z.unknown()),
  sourceKind: z.enum(OPERATOR_TASK_SOURCE_KINDS).optional(),
  sourceId: z.string().guid().optional(),
  /**
   * Required, not optional. A caller with no key gets no idempotency, and the
   * effect this admits (a service restart on a customer machine) is the kind
   * you cannot take back — so admission is refused without one rather than
   * defaulting to at-least-once.
   */
  clientIdempotencyKey: z.string().min(8).max(200),
}).strict()
  // A source id without its kind (or the reverse) is a half-formed citation;
  // accepting it would record provenance that cannot be resolved.
  .refine((v) => (v.sourceKind === undefined) === (v.sourceId === undefined), {
    message: 'sourceKind and sourceId must be provided together',
    path: ['sourceId'],
  });
export type CreateOperatorTaskInput = z.infer<typeof createOperatorTaskSchema>;

/**
 * The two fields `createOperatorTaskSchema` loosened in R1a, exactly as they
 * shipped before it: a required device and the strict `{ serviceName }`
 * input. The route parses every non-contact-targeted body with this (and the
 * shared 400 formatter), so `service_recovery` — and an unknown key, which
 * main also validated against this shape before naming the supported
 * workflows — refuses the same bodies with the same messages as before.
 */
export const deviceTargetedTaskFieldsSchema = z.object({
  deviceId: z.string().guid(),
  inputs: z.object({
    serviceName: z.string().min(1).max(255),
  }).strict(),
});

// ---- R1a: draft request ----

/**
 * Body validator for `POST /api/v1/ai/operator/task-drafts` (spec §12:
 * "Interpret/validate objective and scope; returns typed reviewed proposal, no
 * operational execution"). `createOperatorTaskSchema`'s shape minus the fields
 * that only make sense once the operator commits (`mode`, the idempotency key
 * and the source citation).
 */
export const operatorTaskDraftSchema = z.object({
  recipeKey: z.string().min(1).max(128),
  recipeVersion: z.number().int().min(1),
  orgId: z.string().guid(),
  deviceId: z.string().guid().optional(),
  inputs: z.record(z.string(), z.unknown()),
}).strict();
export type OperatorTaskDraftInput = z.infer<typeof operatorTaskDraftSchema>;
