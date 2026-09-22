/**
 * The recipe contract (Operator Recipe Library spec §6.1).
 *
 * A recipe is DATA plus pure validators — the sentence `serviceRecovery.ts`
 * opens with, now stated once for every recipe. It owns the ordered step keys,
 * which next step the MODEL may propose from each, the input schemas, the
 * effect catalog its plan is built from, its own bounds, its gate class, and
 * its required capabilities. It owns NO I/O.
 *
 * WHAT IS DELIBERATELY NOT HERE: how a step RUNS. Spec §6.1's step-kind table
 * ("Step execution by kind is coordinator code, not recipe code") assigns that
 * to `taskCoordinator.ts`. Putting an executor on a recipe would give the
 * recipe two jobs and make "which key may the model propose" unauditable
 * without reading an execution path — the same argument `serviceRecovery.ts`
 * already makes for itself.
 *
 * PURITY IS MECHANICAL, NOT CONVENTIONAL. Every file in this directory is
 * scanned by `purity.test.ts` against a four-entry import allowlist. A recipe
 * that could reach the database could observe tenant state while claiming to
 * be a pure validator, and the registry's whole value is that a reviewer can
 * read one file and know what a workflow may do.
 */

import type { z } from 'zod';

/**
 * Spec §6.1's step-kind table, and (in E2) the `ai_operator_task_steps.
 * step_kind` CHECK list. Order is the spec's.
 */
export const STEP_KINDS = Object.freeze([
  'reason', 'effect', 'probe', 'wait', 'human_work', 'document',
] as const);
export type StepKind = (typeof STEP_KINDS)[number];

/** Spec §5.1's `ai_operator_task_targets.target_kind` CHECK list. */
export const TARGET_KINDS = Object.freeze(['device', 'ticket', 'contact'] as const);
export type TargetKind = (typeof TARGET_KINDS)[number];

/** Spec §9. `deterministic` recipes are graded by contract tests, not by an eval set. */
export const RECIPE_GATE_CLASSES = Object.freeze(['deterministic', 'model_chooses_effect'] as const);
export type RecipeGateClass = (typeof RECIPE_GATE_CLASSES)[number];

/**
 * `ai_operator_tasks.phase`. Mirrors `AI_OPERATOR_TASK_PHASES` in
 * `db/schema/aiOperatorTasks.ts`; it is restated here rather than imported
 * because a recipe may not import the db schema module (purity), and it is
 * asserted against the schema's copy by `index.test.ts`.
 */
export type TaskPhase = 'investigate' | 'plan' | 'execute' | 'verify' | 'document';

/** Where an effect lands. */
export type EffectProvider = 'breeze' | 'm365' | 'google';

/**
 * One step of a recipe.
 *
 * `phase` is on the step, not on the coordinator's call site: `writeLeasedStep`
 * needs the (step key, phase) pair, and two hardcoded literals at each call
 * site is how they drift.
 *
 * `inputSchema` is the schema for what the MODEL must supply when it proposes
 * this step through `submit_task_step`. Coordinator-driven steps have none.
 */
export interface StepDefinition {
  kind: StepKind;
  phase: TaskPhase;
  /** Absent means the model supplies nothing for this step. */
  inputSchema?: z.ZodTypeAny;
  /** True for a step no other step may follow. */
  terminal?: boolean;
}

/**
 * Bounds a recipe imposes on itself. Spec §6.7 and Operator spec §7.2: a
 * recipe is allowed to be STRICTER than the agent policy, never looser. The
 * field list is exactly what the coordinator reads today from
 * `SERVICE_RECOVERY_BOUNDS`.
 */
export interface RecipeBounds {
  /** Operator spec §7.2 "reasoning runs per task". */
  maxReasoningRuns: number;
  /** Mutation attempts per target. */
  maxMutationAttempts: number;
  /** Criterion freshness, seconds. */
  freshnessSeconds: number;
  /** How long to wait before re-observing a dispatched effect. */
  observeWakeAfterMs: number;
  /** How long to wait between polls of a still-holding verification watch. */
  verificationWakeAfterMs: number;
  /** Past this an unprovable effect hands off rather than being retried. */
  unknownEffectHorizonMs: number;
  /** Default task deadline. */
  deadlineMs: number;
}

/**
 * One thing an org must have before this recipe is `ready` (spec §4.1).
 *
 * Nothing EVALUATES these in E1 — readiness computation is R1. The shape is
 * fixed here so that R1 cannot quietly invent a second one, and so a recipe
 * author states its dependencies next to its steps.
 */
export interface CapabilityRequirement {
  /** Stable id, e.g. `m365.graph.group_membership_write`. */
  key: string;
  kind: 'provider_connection' | 'permission_grant' | 'tool_source' | 'agent_tool';
  /** Null for a capability that is not provider-specific. */
  provider: EffectProvider | null;
  /** The sentence shown as "setup required: …". Plain language, no ids. */
  detail: string;
  /** Tool names the admitting agent's allowlist must contain, if any. */
  toolNames?: readonly string[];
}

/**
 * One effect `buildPlan` produced, before any of it is dispatched (spec §6.4).
 *
 * `targetId` and the widened `provider` are additions to spec §6.4's five
 * fields: §6.4 was written for identity recipes, where the target IS the
 * provider account. A device effect has no provider account and must still be
 * able to name what it acts on.
 */
export interface PlannedEffect {
  /** Position in the recipe's safety ordering. Stable; part of the approval set. */
  ordinal: number;
  toolName: string;
  provider: EffectProvider;
  /** Device id / contact id. Null only for an effect with no Breeze-side target. */
  targetId: string | null;
  /** Entra object id / Google user id. Null for a non-provider effect. */
  accountExternalId: string | null;
  /** Canonicalized before hashing into `effect_set_digest` (E4). */
  canonicalArguments: Readonly<Record<string, unknown>>;
}

/**
 * Deterministic reads a recipe's discovery step gathered (spec §6.2 item 2).
 *
 * Open in E1 because nothing produces discovery facts before R1. R1 replaces
 * this with a typed per-recipe shape; until then `buildPlan` implementations
 * that need no facts ignore the parameter.
 */
export type DiscoveryFacts = Readonly<Record<string, unknown>>;

export type NextStepFailureReason = 'unsupported_step' | 'step_not_permitted' | 'invalid_inputs';

export type NextStepValidation =
  | { ok: true; key: string; inputs: Record<string, unknown> }
  | { ok: false; reason: NextStepFailureReason; detail: string };

/** Result of a recipe's optional cross-check against its frozen admission input. */
export type CrossCheckResult = { ok: true } | { ok: false; detail: string };

/**
 * A released recipe. Field names are spec §6.1's, verbatim, plus
 * `crossCheckStepInputs` (see the plan's decision 1).
 */
export interface RecipeDefinition<Input = unknown> {
  key: string;
  /** Frozen onto a task at admission and never upgraded (Operator spec P3-4). */
  version: number;
  /** Recorded on every task-linked run as `ai_agent_runs.prompt_version`. */
  promptVersion: string;
  /** Spec §9 — which release gate this recipe is graded by. */
  gateClass: RecipeGateClass;
  targetKinds: readonly TargetKind[];
  /** Spec §4.1 readiness inputs. Empty means "always available when the flag is on". */
  requires: readonly CapabilityRequirement[];
  /** Parses and freezes the admission input. */
  inputSchema: z.ZodType<Input>;
  /** Every step of the recipe, keyed by step key. */
  steps: Readonly<Record<string, StepDefinition>>;
  /**
   * What the MODEL may propose from each step. Sparse on purpose: a step key
   * absent from this map, or mapped to `[]`, means the model proposes nothing
   * from there and the coordinator drives it from authoritative rows.
   */
  permittedNextSteps: Readonly<Record<string, readonly string[]>>;
  bounds: RecipeBounds;
  /** Pure. Same input + same facts must always produce the same ordered list. */
  buildPlan(input: Input, facts: DiscoveryFacts): PlannedEffect[];
  /** Delegates to `buildTaskOperationKey`; never formats its own string. */
  operationKey(args: {
    stepKey: string;
    targetId: string | null;
    planRevision: number;
    ordinal: number;
  }): string;
  /**
   * Optional pure cross-check of a model-proposed step's inputs against the
   * value frozen at admission (Operator spec §7.1: "existing approvals only
   * authorize their pinned arguments"). Runs AFTER `inputSchema` parses.
   */
  crossCheckStepInputs?(
    stepKey: string,
    inputs: Record<string, unknown>,
    frozenInput: Input,
  ): CrossCheckResult;
}

/** The registry's value type: a recipe whose Input is not statically known. */
export type AnyRecipeDefinition = RecipeDefinition<never>;
