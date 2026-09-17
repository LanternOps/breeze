---
tracking_issue: PENDING
---

# Operator Recipe Library — Wave E1: Recipe Registry and Coordinator Dispatch Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `service_recovery` stops being hardcoded into the Operator's admission, coordinator and route. A code-owned recipe registry (`services/aiOperator/recipes/index.ts`) resolves a `RecipeDefinition` by `(workflow_key, workflow_version)`; `taskService.admitServiceRecoveryTask`, `taskCoordinator.advanceTask` and `POST /api/v1/ai/operator/tasks` all read the recipe's key, version, bounds, prompt version, step table and permitted-next-step table from that definition instead of importing service-recovery constants. `service_recovery` is ported to a `RecipeDefinition` with every existing export and every existing behaviour byte-identical — the unmodified `recipes/serviceRecovery.test.ts` is the regression proof. An unknown workflow key is refused at admission with a 400 naming the supported keys, and an unknown key on an already-admitted task hands the task off through the existing settle path instead of throwing.

**Architecture:** A new pure module `recipes/types.ts` defines `RecipeDefinition`, `StepDefinition`, `StepKind`, `RecipeBounds`, `CapabilityRequirement`, `PlannedEffect`, `TargetKind`, `DiscoveryFacts`, `EffectProvider` and `NextStepValidation`. A new pure module `recipes/validateNextStep.ts` holds the ONE generic next-step validator, driven by `recipe.permittedNextSteps` + `recipe.steps[k].inputSchema` + an optional per-recipe `crossCheckStepInputs` hook; `serviceRecovery.validateNextStep` keeps its exported signature and delegates to it, so the shipped unit suite passes unmodified. `recipes/index.ts` holds `RECIPES`, `RECIPE_KEYS`, `getRecipe(workflowKey, workflowVersion)`, `getRecipeByKey(workflowKey)` and `resolveAdmissionRecipe(workflowKey, workflowVersion)`. Recipes stay pure — a `recipes/purity.test.ts` scans every import in `recipes/*.ts` against a four-entry allowlist. The coordinator gains a per-recipe step-advancer table (`RECIPE_ADVANCERS`) because step execution is coordinator code, never recipe code (spec §6.1), and a pure `resolveTaskRecipe(task)` that the unknown-recipe handoff branch uses.

**Tech Stack:** TypeScript, Zod, Hono, Drizzle ORM, Vitest (unit + `vitest.integration.config.ts` against real Postgres). **No schema change, no migration, no new env var, no UI in this wave.**

**Spec:** docs/superpowers/specs/ai-mcp/2026-09-17-operator-recipe-library-design.md — §6.1 (registry, `RecipeDefinition` interface, step-kind table, "Recipes stay pure: no I/O, no imports from services", "`service_recovery` is ported first, behavior-identical, as the refactor's regression proof"), §10 row **E1** ("Recipe registry + coordinator dispatch refactor; port `service_recovery`. No schema."), §2 (what exists: "Recipe registry: None. `workflow_key` is stored and never dispatched on. `taskCoordinator.ts` imports service-recovery constants directly and switches on the step-key string; `taskService.ts` hardcodes the workflow key at admission"), §4 (Recipe/Library/Target/Step/Plan vocabulary), §5.1 (`TargetKind` values `device|ticket|contact`), §6.4 (`PlannedEffect` fields), §9 (`gateClass`). Builds on docs/superpowers/specs/ai-mcp/2026-09-07-ai-operator-completion-design.md §6.2, §6.5, §7.1 (P3-4: "freeze recipe versions for admitted tasks"), §12.

**Feature tracking:** parent issue and wave sub-issue assigned by `register_feature` after all wave plans exist; branch `feature/<parent#>-operator-recipe-library/wave-<subissue#>`.

## Global Constraints

- **Rigor: high.** This is the AI Operator's agent execution path — the code that decides whether a customer machine gets a command dispatched to it. Red test first for every task. Task 10's full unit + integration suite run against a live test stack is mandatory before the PR opens.
- **Behaviour-identical port.** `recipes/serviceRecovery.test.ts` (209 lines, 24 assertions) is **not modified by this wave**. If a step of this plan requires editing it, the port is wrong — fix the port. Same for `apps/api/src/__tests__/integration/aiOperatorServiceRecoveryE2E.integration.test.ts`.
- **Every export of `recipes/serviceRecovery.ts` survives**, with the same name, signature and semantics: `SERVICE_RECOVERY_WORKFLOW_KEY`, `SERVICE_RECOVERY_WORKFLOW_VERSION`, `SERVICE_RECOVERY_PROMPT_VERSION`, `SERVICE_RECOVERY_STEP_KEYS`, `ServiceRecoveryStepKey`, `isServiceRecoveryStepKey`, `SERVICE_RECOVERY_PERMITTED_NEXT_STEPS`, `SERVICE_RECOVERY_STEP_INPUT_SCHEMAS`, `SERVICE_RECOVERY_BOUNDS`, `SERVICE_RECOVERY_RESOLVABLE_WITHOUT_ALERT`, `parseServiceRecoveryInput`, `buildServiceRecoveryCriterion`, `NextStepValidation`, `validateNextStep`, `serviceRecoveryOperationKey`, `taskRunDedupeKey`. The file gains exactly one export: `serviceRecoveryRecipe`.
- **Recipes are pure.** Files under `apps/api/src/services/aiOperator/recipes/` may import only: `zod`, `@breeze/shared`, `../operationKey` (a pure string builder, no I/O), and other files inside `recipes/`. Enforced mechanically by `recipes/purity.test.ts` (Task 4), not by review. No `../../db`, no `../../config/env`, no service module, no `node:fs`, no network.
- **Step EXECUTION stays in the coordinator** (spec §6.1's step-kind table: "Step execution by kind is coordinator code, not recipe code"). The recipe says *what* the steps are and *which* the model may propose; `taskCoordinator.ts` says *how* each one runs. The advancer table added in Task 7 lives in `taskCoordinator.ts`, never in `recipes/`.
- **The three coordinator invariants in `taskCoordinator.ts:1-40` are preserved verbatim.** Do not reword, renumber or delete them: (1) it holds nothing while waiting; (2) it never trusts the wake payload; (3) `revision` is the plan revision, not a CAS counter. Task 7 adds a fourth paragraph *below* them describing recipe resolution; it does not touch the first three.
- **Unknown recipe never throws.** At admission it is a typed refusal (`unknown_recipe`) that the route renders as 400. On an already-admitted task it is `settle({ event: 'hand_off', outcome: 'unresolved', detail: … })` — the same settle path every other coordinator refusal uses. A throw would leave the BullMQ wake job retrying forever against a row that can never advance.
- **Version is frozen at admission.** `getRecipe(key, version)` returns `null` on a version mismatch; it never upgrades a task to a newer recipe. Operator spec P3-4.
- **Feature flags unchanged:** `AI_OPERATOR_TASKS_ENABLED` and `AI_OPERATOR_RECIPE_SERVICE_RECOVERY_ENABLED` keep their current meaning and their current check sites (`taskService.ts:104-113`, `routes/aiOperatorTasks.ts` readiness block). **No new env var is introduced by this wave**, so `envComposeParity.test.ts`, `.env.example`, `deploy/.env.example` and both compose files are untouched.
- **No tenancy work.** No new table, no new column, no migration file, no cascade/export/merge registration. `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_TENANT_EXPORT_POLICY` and `orgMergeRegistry.ts` are **not** edited — there is nothing new to register. (E2 is the wave that adds tables; it carries that ceremony.)
- **Tests:** file beside source. One file: `cd apps/api && npx vitest run src/path/file.test.ts` — never `pnpm --filter … test -- --run` (pnpm forwards the literal `--` and vitest runs the whole 1,470-file suite in watch mode). Integration: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/<file>` with a live stack (`pnpm test-stack up` at repo root writes `.env.test`; `pnpm test-stack down` when finished — nothing does this for you). Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`. **A 0-test run is a stall, not green** — always check the reported file/test counts.
- **Commits:** one commit per task, end every commit message with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. Final task opens the PR with `Closes #<wave sub-issue>` and **STOPS** — never merge, never `--admin`.

---

## Decisions recorded for the orchestrator (deviations / additions vs spec §6.1)

1. **`RecipeDefinition` gains `crossCheckStepInputs?`** beyond the spec's field list. `serviceRecovery.validateNextStep` today does one thing the spec's `inputSchema` + `permittedNextSteps` pair cannot express: it cross-checks the model's `serviceName` against the value frozen at admission (`serviceRecovery.ts:217-226`, spec-ref §7.1 "existing approvals only authorize their pinned arguments"). Dropping that check to fit the interface would be a real authorization regression. It is an optional pure hook, so recipes that need no cross-check omit it.
2. **`RecipeDefinition` gains `stepPhase` via `StepDefinition.phase`.** `writeLeasedStep` (`taskCoordinator.ts:846-880`) takes both a step key and an `ai_operator_tasks.phase` value, currently passed as two hardcoded literals. Putting `phase` on `StepDefinition` removes the second literal and makes the step table the single source of the pair.
3. **`PlannedEffect` is a superset of spec §6.4's five fields.** §6.4 lists `{ ordinal, toolName, provider, accountExternalId, canonicalArguments }` — written for identity recipes where the target IS the provider account. `service_recovery`'s effect targets a device and has no provider account, so `targetId: string | null` is added and `provider` widens to `'breeze' | 'm365' | 'google'`. Without it `buildPlan` for the ported recipe could not name its own target.
4. **`DiscoveryFacts` is an open readonly record in this wave.** `buildPlan(input, facts)` is in the spec's interface, but nothing produces discovery facts until R1 (spec §6.2 item 2). It is typed as `Readonly<Record<string, unknown>>` with a comment naming R1 as the wave that gives it a real shape; `serviceRecoveryRecipe.buildPlan` ignores it.
5. **`RECIPES` is keyed by `key`, not `key@version`.** Spec §6.1 says `Record<string, RecipeDefinition>`. One released version per key is what exists; `getRecipe` returns `null` on a version mismatch and `getRecipeByKey` exists so the route can tell "no such recipe" (400) from "wrong version" (422, the shipped behaviour and its shipped test). When a second version of one key ships, the map value becomes an array and both accessors absorb it — no call site changes.
6. **`createOperatorTaskSchema.recipeKey` relaxes from `z.literal('service_recovery')` to `z.string().min(1).max(128)`.** The literal makes zod answer an unknown key with a generic 400 body that names no supported key. The wave brief requires the 400 to list them, which only the registry can do. Every other `.strict()` protection on that schema is unchanged. Verified no consumer breaks: the only producers are `apps/web/src/components/aiOperator/DelegateToOperatorButton.tsx:101` and its test, both sending `'service_recovery'`. The 128 cap mirrors `ai_operator_tasks_workflow_key_len_chk` (`apps/api/migrations/2026-10-14-100000-ai-operator-thin-slice.sql:101`).
7. **`admitServiceRecoveryTask` keeps its name.** A generic `admitTask` with one recipe in the registry would be speculative and untestable; it arrives with R1, which has a second recipe to prove it against. The function gains optional `workflowKey`/`workflowVersion` inputs and resolves the recipe through `resolveAdmissionRecipe`, which is the refactor the brief asks for. Two shipped test files mock it by name (`routes/aiOperatorTasks.test.ts`, `__tests__/integration/aiOperatorAdmission.integration.test.ts`); renaming it in this wave would churn them for no gain.

---

## Files

**apps/api — new**
- `src/services/aiOperator/recipes/types.ts` — the recipe contract (pure types + the `StepKind`/`TargetKind`/`EffectProvider` unions).
- `src/services/aiOperator/recipes/validateNextStep.ts` — the one generic next-step validator.
- `src/services/aiOperator/recipes/validateNextStep.test.ts`
- `src/services/aiOperator/recipes/index.ts` — `RECIPES`, `RECIPE_KEYS`, `getRecipe`, `getRecipeByKey`, `resolveAdmissionRecipe`.
- `src/services/aiOperator/recipes/index.test.ts`
- `src/services/aiOperator/recipes/purity.test.ts`
- `src/services/aiOperator/recipes/types.test.ts`
- `src/services/aiOperator/taskCoordinator.recipeResolution.test.ts`
- `src/__tests__/integration/aiOperatorRecipeRegistry.integration.test.ts`

**apps/api — modified**
- `src/services/aiOperator/recipes/serviceRecovery.ts` — adds `serviceRecoveryRecipe`; `validateNextStep` delegates to the generic validator. All other exports untouched.
- `src/services/aiOperator/taskService.ts:41-47, 51-56, 68-89, 101-113, 177, 189-190` — registry resolution at admission, `unknown_recipe` refusal.
- `src/services/aiOperator/taskCoordinator.ts:56-61, 302-385, 394-451, 561-566, 640-655, 720-728, 795-812, 846-880` — recipe resolution, per-recipe advancer table, bounds/prompt-version/validator via the recipe.
- `src/routes/aiOperatorTasks.ts:52-55, 229-242` — unknown key → 400 with supported keys; version mismatch stays 422.
- `src/routes/aiOperatorTasks.test.ts` — one new 400 case (existing cases untouched).

**packages/shared — modified**
- `src/validators/aiOperator.ts:236` — `recipeKey` literal → bounded string (decision 6).

**Not modified (assert this before opening the PR)**
- `src/services/aiOperator/recipes/serviceRecovery.test.ts`
- `src/__tests__/integration/aiOperatorServiceRecoveryE2E.integration.test.ts`
- any migration, cascade list, export-policy registry, `.env.example`, or compose file.

---

### Task 1: The recipe contract — `recipes/types.ts`

**Files:**
- Create: `apps/api/src/services/aiOperator/recipes/types.ts`
- Create: `apps/api/src/services/aiOperator/recipes/types.test.ts`

**Interfaces:**
- Consumes: `zod` (`z.ZodType`, `z.ZodTypeAny`).
- Produces: `StepKind`, `TargetKind`, `EffectProvider`, `RecipeGateClass`, `TaskPhase`, `StepDefinition`, `RecipeBounds`, `CapabilityRequirement`, `PlannedEffect`, `DiscoveryFacts`, `NextStepValidation`, `NextStepFailureReason`, `CrossCheckResult`, `RecipeDefinition<Input>`, `AnyRecipeDefinition`, and the runtime arrays `STEP_KINDS`, `TARGET_KINDS`, `RECIPE_GATE_CLASSES`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiOperator/recipes/types.test.ts
/**
 * Operator Recipe Library spec §6.1: the recipe contract. These are the
 * runtime halves of the unions the spec fixes — §6.1's `StepKind`, §5.1's
 * `target_kind` CHECK list, §9's gate classes. They are asserted as VALUES,
 * not only as types, because a type-only union cannot be diffed against the
 * database CHECK constraint that E2 will add for the same list, and the
 * aiOperator family has already paid for hand-duplicated unions drifting
 * (see `enumParity.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { RECIPE_GATE_CLASSES, STEP_KINDS, TARGET_KINDS } from './types';

describe('recipe contract unions (spec §6.1, §5.1, §9)', () => {
  it('STEP_KINDS is exactly the spec §6.1 step-kind table, in its order', () => {
    expect(STEP_KINDS).toEqual(['reason', 'effect', 'probe', 'wait', 'human_work', 'document']);
  });

  it('TARGET_KINDS is exactly the spec §5.1 target_kind CHECK list', () => {
    expect(TARGET_KINDS).toEqual(['device', 'ticket', 'contact']);
  });

  it('RECIPE_GATE_CLASSES is exactly the spec §9 gate classes', () => {
    expect(RECIPE_GATE_CLASSES).toEqual(['deterministic', 'model_chooses_effect']);
  });

  it('every union is frozen at runtime so a caller cannot widen it by push()', () => {
    expect(Object.isFrozen(STEP_KINDS)).toBe(true);
    expect(Object.isFrozen(TARGET_KINDS)).toBe(true);
    expect(Object.isFrozen(RECIPE_GATE_CLASSES)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it red**

Run: `cd apps/api && npx vitest run src/services/aiOperator/recipes/types.test.ts`
Expected: FAIL — `Failed to resolve import "./types"` / `Cannot find module './types'`.

- [ ] **Step 3: Implement `recipes/types.ts`**

```ts
// apps/api/src/services/aiOperator/recipes/types.ts
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
```

- [ ] **Step 4: Run it green**

Run: `cd apps/api && npx vitest run src/services/aiOperator/recipes/types.test.ts`
Expected: PASS — 1 file, 4 tests.

- [ ] **Step 5: Commit**

```
git add apps/api/src/services/aiOperator/recipes/types.ts apps/api/src/services/aiOperator/recipes/types.test.ts
git commit -m "$(cat <<'EOF'
feat(ai-operator): recipe contract types for the recipe registry (E1)

Operator Recipe Library spec §6.1: RecipeDefinition and its supporting
types, as pure declarations with no I/O. Step EXECUTION stays in the
coordinator per the spec's step-kind table.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The one generic next-step validator — `recipes/validateNextStep.ts`

**Files:**
- Create: `apps/api/src/services/aiOperator/recipes/validateNextStep.ts`
- Create: `apps/api/src/services/aiOperator/recipes/validateNextStep.test.ts`

**Interfaces:**
- Consumes: `RecipeDefinition`, `NextStepValidation` (`./types`).
- Produces: `export function validateRecipeNextStep<Input>(recipe: RecipeDefinition<Input>, currentStepKey: string, proposed: { key: string; inputs: Record<string, unknown> }, frozenInput: Input): NextStepValidation`.

**Behaviour contract (must match `serviceRecovery.ts:170-229` exactly — these strings are the regression surface):**
- proposed key not in `recipe.steps` → `unsupported_step`, detail `` `'<key>' is not a step of <recipe.key>` ``
- current key not in `recipe.steps` → `unsupported_step`, detail `` `current step '<key>' is not a step of <recipe.key>` ``
- proposed key not in `recipe.permittedNextSteps[current]` (or the entry is absent) → `step_not_permitted`, detail `` `'<proposed>' is not reachable from '<current>'` ``
- step has no `inputSchema` → `{ ok: true, key, inputs: {} }`
- schema parse failure → `invalid_inputs`, detail = zod issues `` `${path}: ${message}` `` joined by `'; '`, sliced to 400
- `crossCheckStepInputs` returns `{ ok: false }` → `invalid_inputs` with its detail
- otherwise `{ ok: true, key, inputs: parsed.data }`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiOperator/recipes/validateNextStep.test.ts
/**
 * The ONE next-step validator, spec §6.1. Before E1 this logic was written
 * once per recipe inside `serviceRecovery.ts`; a second recipe would have
 * copied it, and the copies would eventually disagree about whether an
 * unreachable step is a refusal or a coercion. The failure mode of
 * disagreeing is a model-proposed step that one recipe refuses and another
 * silently runs.
 *
 * Tested against a synthetic recipe, not against service_recovery: the real
 * recipe's own suite (`serviceRecovery.test.ts`, unmodified by E1) is the
 * regression proof that the delegation preserved its behaviour.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validateRecipeNextStep } from './validateNextStep';
import type { RecipeDefinition } from './types';

interface FixtureInput { widget: string }

const fixture: RecipeDefinition<FixtureInput> = {
  key: 'fixture_recipe',
  version: 1,
  promptVersion: 'fixture_recipe/v1',
  gateClass: 'deterministic',
  targetKinds: ['device'],
  requires: [],
  inputSchema: z.object({ widget: z.string() }),
  steps: {
    alpha: { kind: 'reason', phase: 'investigate' },
    beta: { kind: 'effect', phase: 'execute', inputSchema: z.object({ widget: z.string().min(1) }).strict() },
    omega: { kind: 'document', phase: 'document', terminal: true },
  },
  permittedNextSteps: { alpha: ['beta'], beta: [], omega: [] },
  bounds: {
    maxReasoningRuns: 4, maxMutationAttempts: 2, freshnessSeconds: 120,
    observeWakeAfterMs: 1000, verificationWakeAfterMs: 1000,
    unknownEffectHorizonMs: 1000, deadlineMs: 1000,
  },
  buildPlan: () => [],
  operationKey: () => 'fixture',
  crossCheckStepInputs: (stepKey, inputs, frozen) =>
    stepKey === 'beta' && inputs.widget !== frozen.widget
      ? { ok: false, detail: `widget '${String(inputs.widget)}' does not match the widget frozen at admission` }
      : { ok: true },
};

const FROZEN: FixtureInput = { widget: 'sprocket' };

describe('validateRecipeNextStep', () => {
  it('permits a reachable step with valid inputs and returns the PARSED inputs', () => {
    const result = validateRecipeNextStep(fixture, 'alpha', { key: 'beta', inputs: { widget: 'sprocket' } }, FROZEN);
    expect(result).toEqual({ ok: true, key: 'beta', inputs: { widget: 'sprocket' } });
  });

  it('refuses a key that is not a step of the recipe, naming the recipe', () => {
    const result = validateRecipeNextStep(fixture, 'alpha', { key: 'nope', inputs: {} }, FROZEN);
    expect(result).toEqual({
      ok: false, reason: 'unsupported_step', detail: "'nope' is not a step of fixture_recipe",
    });
  });

  it('refuses an unknown CURRENT step key', () => {
    const result = validateRecipeNextStep(fixture, 'nope', { key: 'beta', inputs: { widget: 'sprocket' } }, FROZEN);
    expect(result).toEqual({
      ok: false, reason: 'unsupported_step', detail: "current step 'nope' is not a step of fixture_recipe",
    });
  });

  it('refuses a real step that is not reachable from the current one', () => {
    const result = validateRecipeNextStep(fixture, 'alpha', { key: 'omega', inputs: {} }, FROZEN);
    expect(result).toEqual({
      ok: false, reason: 'step_not_permitted', detail: "'omega' is not reachable from 'alpha'",
    });
  });

  it('treats a step key ABSENT from permittedNextSteps as permitting nothing', () => {
    const noEntry: RecipeDefinition<FixtureInput> = { ...fixture, permittedNextSteps: {} };
    const result = validateRecipeNextStep(noEntry, 'alpha', { key: 'beta', inputs: { widget: 'sprocket' } }, FROZEN);
    expect(result).toMatchObject({ ok: false, reason: 'step_not_permitted' });
  });

  it('refuses inputs that do not parse, and reports the zod path and message', () => {
    const result = validateRecipeNextStep(fixture, 'alpha', { key: 'beta', inputs: { widget: 12345 } }, FROZEN);
    expect(result).toMatchObject({ ok: false, reason: 'invalid_inputs' });
    expect((result as { detail: string }).detail).toContain('widget');
  });

  it('refuses inputs that parse but fail the recipe cross-check against the frozen input', () => {
    const result = validateRecipeNextStep(fixture, 'alpha', { key: 'beta', inputs: { widget: 'other' } }, FROZEN);
    expect(result).toMatchObject({ ok: false, reason: 'invalid_inputs' });
    expect((result as { detail: string }).detail).toContain('frozen');
  });

  it('returns empty inputs for a permitted step that declares no inputSchema', () => {
    const openRecipe: RecipeDefinition<FixtureInput> = {
      ...fixture, permittedNextSteps: { alpha: ['omega'] },
    };
    const result = validateRecipeNextStep(openRecipe, 'alpha', { key: 'omega', inputs: { ignored: true } }, FROZEN);
    expect(result).toEqual({ ok: true, key: 'omega', inputs: {} });
  });

  it('bounds the invalid_inputs detail at 400 characters', () => {
    const longKeyRecipe: RecipeDefinition<FixtureInput> = {
      ...fixture,
      steps: {
        ...fixture.steps,
        beta: { kind: 'effect', phase: 'execute', inputSchema: z.object({ widget: z.string().min(500) }).strict() },
      },
    };
    const result = validateRecipeNextStep(
      longKeyRecipe, 'alpha', { key: 'beta', inputs: { widget: 'x'.repeat(10) } }, FROZEN,
    );
    expect((result as { detail: string }).detail.length).toBeLessThanOrEqual(400);
  });
});
```

- [ ] **Step 2: Run it red**

Run: `cd apps/api && npx vitest run src/services/aiOperator/recipes/validateNextStep.test.ts`
Expected: FAIL — cannot resolve `./validateNextStep`.

- [ ] **Step 3: Implement `recipes/validateNextStep.ts`**

```ts
// apps/api/src/services/aiOperator/recipes/validateNextStep.ts
/**
 * Validate a `submit_task_step` proposal of kind `'step'` against a recipe.
 *
 * ONE implementation for every recipe. An unsupported key, a key not
 * reachable from the current step, inputs that do not parse, and inputs that
 * contradict what was frozen at admission are ALL classified failures that end
 * the run and hand the task off (Operator spec §6.2) — never a silent coercion
 * onto some other step, and never a widening of what the model may do.
 *
 * Pure: no I/O, no clock, no randomness. The coordinator decides what to DO
 * with a refusal; this function only says which refusal it is.
 */

import type { RecipeDefinition, NextStepValidation } from './types';

/** Longest `invalid_inputs` detail written to `outcome_detail`. */
const MAX_DETAIL_CHARS = 400;

export function validateRecipeNextStep<Input>(
  recipe: RecipeDefinition<Input>,
  currentStepKey: string,
  proposed: { key: string; inputs: Record<string, unknown> },
  frozenInput: Input,
): NextStepValidation {
  const proposedStep = recipe.steps[proposed.key];
  if (!proposedStep) {
    return {
      ok: false,
      reason: 'unsupported_step',
      detail: `'${proposed.key}' is not a step of ${recipe.key}`,
    };
  }
  if (!recipe.steps[currentStepKey]) {
    return {
      ok: false,
      reason: 'unsupported_step',
      detail: `current step '${currentStepKey}' is not a step of ${recipe.key}`,
    };
  }

  // A step key with NO entry in `permittedNextSteps` permits nothing. Sparse
  // is the default, and the default has to be "the model may not", or adding
  // a step would silently make it model-proposable from everywhere.
  const permitted = recipe.permittedNextSteps[currentStepKey] ?? [];
  if (!permitted.includes(proposed.key)) {
    return {
      ok: false,
      reason: 'step_not_permitted',
      detail: `'${proposed.key}' is not reachable from '${currentStepKey}'`,
    };
  }

  const schema = proposedStep.inputSchema;
  if (!schema) {
    return { ok: true, key: proposed.key, inputs: {} };
  }

  const parsed = schema.safeParse(proposed.inputs);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'invalid_inputs',
      detail: parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')
        .slice(0, MAX_DETAIL_CHARS),
    };
  }

  const inputs = parsed.data as Record<string, unknown>;

  // The recipe's own cross-check against the FROZEN admission input. The model
  // proposing a different target or argument is not a typo to fix; it is an
  // attempt (however accidental) to act outside the approved scope.
  const crossCheck = recipe.crossCheckStepInputs?.(proposed.key, inputs, frozenInput);
  if (crossCheck && !crossCheck.ok) {
    return { ok: false, reason: 'invalid_inputs', detail: crossCheck.detail.slice(0, MAX_DETAIL_CHARS) };
  }

  return { ok: true, key: proposed.key, inputs };
}
```

- [ ] **Step 4: Run it green**

Run: `cd apps/api && npx vitest run src/services/aiOperator/recipes/validateNextStep.test.ts`
Expected: PASS — 1 file, 9 tests.

- [ ] **Step 5: Commit**

```
git add apps/api/src/services/aiOperator/recipes/validateNextStep.ts apps/api/src/services/aiOperator/recipes/validateNextStep.test.ts
git commit -m "$(cat <<'EOF'
feat(ai-operator): one generic recipe next-step validator (E1)

Driven by permittedNextSteps + steps[k].inputSchema + the recipe's optional
pure cross-check against its frozen admission input. Replaces per-recipe
copies before a second copy exists to disagree with the first.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Port `service_recovery` to a `RecipeDefinition`

**Files:**
- Modify: `apps/api/src/services/aiOperator/recipes/serviceRecovery.ts` (`:25-32` imports, `:159-229` validator, append `serviceRecoveryRecipe`)
- Create: `apps/api/src/services/aiOperator/recipes/serviceRecovery.recipe.test.ts`
- **Do NOT modify** `apps/api/src/services/aiOperator/recipes/serviceRecovery.test.ts`.

**Interfaces:**
- Consumes: `RecipeDefinition`, `PlannedEffect`, `DiscoveryFacts`, `NextStepValidation` (`./types`); `validateRecipeNextStep` (`./validateNextStep`); `buildTaskOperationKey` (`../operationKey`); `serviceRecoveryInputSchema`, `taskCriterionSchema`, `ServiceRecoveryInput` (`@breeze/shared`).
- Produces: `export const serviceRecoveryRecipe: RecipeDefinition<ServiceRecoveryInput>`. Every pre-existing export keeps its name and signature. `NextStepValidation` is re-exported from `./types` so `import { type NextStepValidation } from './serviceRecovery'` keeps compiling.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiOperator/recipes/serviceRecovery.recipe.test.ts
/**
 * The ported recipe object (spec §6.1, wave E1). `serviceRecovery.test.ts`
 * proves the BEHAVIOUR is unchanged; this file proves the recipe object
 * actually carries what the coordinator, the admission path and the route
 * will now read from it instead of from module constants.
 */
import { describe, expect, it } from 'vitest';
import {
  SERVICE_RECOVERY_BOUNDS,
  SERVICE_RECOVERY_PERMITTED_NEXT_STEPS,
  SERVICE_RECOVERY_PROMPT_VERSION,
  SERVICE_RECOVERY_STEP_KEYS,
  SERVICE_RECOVERY_WORKFLOW_KEY,
  SERVICE_RECOVERY_WORKFLOW_VERSION,
  parseServiceRecoveryInput,
  serviceRecoveryOperationKey,
  serviceRecoveryRecipe,
} from './serviceRecovery';

const DEVICE_ID = '00000000-0000-4000-8000-000000000011';
const input = parseServiceRecoveryInput({
  deviceId: DEVICE_ID, serviceName: 'spooler',
  triggeringAlertId: '00000000-0000-4000-8000-000000000012',
});

describe('serviceRecoveryRecipe', () => {
  it('carries the shipped key, version and prompt version — the values already on live task rows', () => {
    expect(serviceRecoveryRecipe.key).toBe(SERVICE_RECOVERY_WORKFLOW_KEY);
    expect(serviceRecoveryRecipe.key).toBe('service_recovery');
    expect(serviceRecoveryRecipe.version).toBe(SERVICE_RECOVERY_WORKFLOW_VERSION);
    expect(serviceRecoveryRecipe.version).toBe(1);
    expect(serviceRecoveryRecipe.promptVersion).toBe(SERVICE_RECOVERY_PROMPT_VERSION);
  });

  it('is gateClass model_chooses_effect: the model proposes the execute step (spec §9)', () => {
    expect(serviceRecoveryRecipe.gateClass).toBe('model_chooses_effect');
  });

  it('targets a device and requires no provider capability', () => {
    expect(serviceRecoveryRecipe.targetKinds).toEqual(['device']);
    expect(serviceRecoveryRecipe.requires).toEqual([]);
  });

  it('declares exactly the shipped step keys, in order', () => {
    expect(Object.keys(serviceRecoveryRecipe.steps)).toEqual([...SERVICE_RECOVERY_STEP_KEYS]);
  });

  it('maps each step to the phase the coordinator writes for it today', () => {
    expect(serviceRecoveryRecipe.steps.investigate).toMatchObject({ kind: 'reason', phase: 'investigate' });
    expect(serviceRecoveryRecipe.steps.execute).toMatchObject({ kind: 'effect', phase: 'execute' });
    expect(serviceRecoveryRecipe.steps.observe).toMatchObject({ kind: 'probe', phase: 'execute' });
    expect(serviceRecoveryRecipe.steps.verify).toMatchObject({ kind: 'probe', phase: 'verify' });
    expect(serviceRecoveryRecipe.steps.document).toMatchObject({ kind: 'document', phase: 'document', terminal: true });
  });

  it('reuses the shipped permitted-next-step table by identity, not a copy', () => {
    expect(serviceRecoveryRecipe.permittedNextSteps).toBe(SERVICE_RECOVERY_PERMITTED_NEXT_STEPS);
  });

  it('reuses the shipped bounds by identity, so the coordinator reads the same numbers', () => {
    expect(serviceRecoveryRecipe.bounds).toBe(SERVICE_RECOVERY_BOUNDS);
  });

  it('buildPlan returns the one manage_services restart effect, addressed at the frozen device', () => {
    expect(serviceRecoveryRecipe.buildPlan(input, {})).toEqual([
      {
        ordinal: 0,
        toolName: 'manage_services',
        provider: 'breeze',
        targetId: DEVICE_ID,
        accountExternalId: null,
        canonicalArguments: { deviceId: DEVICE_ID, action: 'restart', serviceName: 'spooler' },
      },
    ]);
  });

  it('buildPlan is pure: same input, same list, and the result is not shared between calls', () => {
    const a = serviceRecoveryRecipe.buildPlan(input, {});
    const b = serviceRecoveryRecipe.buildPlan(input, {});
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it('operationKey produces exactly what serviceRecoveryOperationKey produces', () => {
    expect(
      serviceRecoveryRecipe.operationKey({ stepKey: 'execute', targetId: DEVICE_ID, planRevision: 3, ordinal: 0 }),
    ).toBe(
      serviceRecoveryOperationKey({ stepKey: 'execute', deviceId: DEVICE_ID, planRevision: 3, ordinal: 0 }),
    );
  });

  it('crossCheckStepInputs refuses an execute whose serviceName is not the frozen one', () => {
    expect(serviceRecoveryRecipe.crossCheckStepInputs?.('execute', { serviceName: 'spooler' }, input))
      .toEqual({ ok: true });
    const refused = serviceRecoveryRecipe.crossCheckStepInputs?.('execute', { serviceName: 'other' }, input);
    expect(refused?.ok).toBe(false);
    expect((refused as { detail: string }).detail).toContain('frozen');
  });

  it('inputSchema is the shipped admission schema: it parses a valid input and rejects a bad deviceId', () => {
    expect(serviceRecoveryRecipe.inputSchema.parse({ deviceId: DEVICE_ID, serviceName: 'spooler' }))
      .toMatchObject({ deviceId: DEVICE_ID, serviceName: 'spooler' });
    expect(() => serviceRecoveryRecipe.inputSchema.parse({ deviceId: 'nope', serviceName: 'spooler' })).toThrow();
  });
});
```

- [ ] **Step 2: Run it red**

Run: `cd apps/api && npx vitest run src/services/aiOperator/recipes/serviceRecovery.recipe.test.ts`
Expected: FAIL — `serviceRecoveryRecipe` is not exported (`SyntaxError: The requested module './serviceRecovery' does not provide an export named 'serviceRecoveryRecipe'`).

- [ ] **Step 3: Rewrite the import block at `serviceRecovery.ts:25-32`**

Replace:

```ts
import { z } from 'zod';
import { buildTaskOperationKey } from '../operationKey';
import {
  serviceRecoveryInputSchema,
  taskCriterionSchema,
  type ServiceRecoveryInput,
  type TaskCriterion,
} from '@breeze/shared';
```

with:

```ts
import { z } from 'zod';
import { buildTaskOperationKey } from '../operationKey';
import { validateRecipeNextStep } from './validateNextStep';
import type {
  CrossCheckResult,
  DiscoveryFacts,
  NextStepValidation as RecipeNextStepValidation,
  PlannedEffect,
  RecipeDefinition,
} from './types';
import {
  serviceRecoveryInputSchema,
  taskCriterionSchema,
  type ServiceRecoveryInput,
  type TaskCriterion,
} from '@breeze/shared';
```

- [ ] **Step 4: Replace the `NextStepValidation` type and the body of `validateNextStep` (`serviceRecovery.ts:159-229`)**

Replace the whole block from `export type NextStepValidation =` through the closing brace of `validateNextStep` with:

```ts
/**
 * Re-exported from `./types` so the recipe keeps its published surface while
 * the type itself has exactly one definition. The old shape narrowed `key` to
 * `ServiceRecoveryStepKey`; the generic one widens it to `string`, which is
 * strictly more permissive for CALLERS and is what makes one validator serve
 * every recipe. The coordinator never indexes a recipe-specific table with it
 * (it indexes `recipe.steps`), so nothing downstream needed the narrowing.
 */
export type NextStepValidation = RecipeNextStepValidation;

/**
 * Cross-check an `execute` proposal against the FROZEN admission input.
 *
 * The model proposing a different service name is not a typo to fix, it is an
 * attempt (however accidental) to act outside the approved scope — Operator
 * spec §7.1: "Existing approvals only authorize their pinned arguments."
 */
function crossCheckServiceRecoveryInputs(
  stepKey: string,
  inputs: Record<string, unknown>,
  frozen: ServiceRecoveryInput,
): CrossCheckResult {
  if (stepKey !== 'execute') return { ok: true };
  const serviceName = (inputs as { serviceName?: unknown }).serviceName;
  if (serviceName !== frozen.serviceName) {
    return {
      ok: false,
      detail: `serviceName '${String(serviceName)}' does not match the service frozen at admission`,
    };
  }
  return { ok: true };
}

/**
 * Validate a `submit_task_step` `nextStep` of kind `'step'` against this
 * recipe. An unsupported key, a key not reachable from the current step, or
 * inputs that do not parse are ALL classified failures that end the run and
 * hand the task off (spec §6.2) — never a silent coercion onto some other
 * step, and never a widening of what the model may do.
 *
 * Kept as an exported function with its original signature: it is the shape
 * the shipped unit suite and the coordinator's call site were written against,
 * and E1 is a refactor, not a behaviour change. The logic itself now lives
 * once, in `validateRecipeNextStep`.
 */
export function validateNextStep(
  currentStepKey: string,
  proposed: { key: string; inputs: Record<string, unknown> },
  frozen: ServiceRecoveryInput,
): NextStepValidation {
  return validateRecipeNextStep(serviceRecoveryRecipe, currentStepKey, proposed, frozen);
}
```

> Note for the executor: `serviceRecoveryRecipe` is declared at the bottom of the file and referenced here. That is legal — `const` declarations are hoisted into scope and this function body runs only after module evaluation. Do **not** reorder the file to "fix" it.

- [ ] **Step 5: Append the recipe definition at the end of `serviceRecovery.ts`**

```ts
/**
 * `service_recovery` as a `RecipeDefinition` (Recipe Library spec §6.1, wave
 * E1). Every field reuses the module constant above it BY IDENTITY rather than
 * re-stating a value: a second copy of `deadlineMs` or of the permitted-step
 * table is how the registry and the constants would drift, and the whole
 * point of the port is that there is now exactly one source for each.
 *
 * `gateClass` is `model_chooses_effect` (spec §9): the model chooses whether to
 * propose `execute` at all, so this recipe is graded by the Operator spec §13
 * evaluation gate, not by the deterministic contract-test gate.
 */
export const serviceRecoveryRecipe: RecipeDefinition<ServiceRecoveryInput> = {
  key: SERVICE_RECOVERY_WORKFLOW_KEY,
  version: SERVICE_RECOVERY_WORKFLOW_VERSION,
  promptVersion: SERVICE_RECOVERY_PROMPT_VERSION,
  gateClass: 'model_chooses_effect',
  targetKinds: ['device'],
  // Nothing beyond the agent's own allowlist: the effect is a Breeze device
  // command, not a third-party provider call. Readiness for this recipe is the
  // feature flag, which is a deployment gate and not a per-org capability.
  requires: [],
  inputSchema: serviceRecoveryInputSchema,
  steps: {
    investigate: {
      kind: 'reason',
      phase: 'investigate',
    },
    execute: {
      kind: 'effect',
      phase: 'execute',
      inputSchema: SERVICE_RECOVERY_STEP_INPUT_SCHEMAS.execute,
    },
    // `observe` reads the dispatched device command back through the
    // authorized adapter — a probe, not a wait: it can conclude.
    observe: { kind: 'probe', phase: 'execute' },
    verify: { kind: 'probe', phase: 'verify' },
    document: { kind: 'document', phase: 'document', terminal: true },
  },
  permittedNextSteps: SERVICE_RECOVERY_PERMITTED_NEXT_STEPS,
  bounds: SERVICE_RECOVERY_BOUNDS,
  /**
   * One effect: restart the frozen service on the frozen device. `facts` is
   * unused — this recipe has no discovery step (R1's identity recipes do).
   *
   * A NEW array every call: a shared array would let one caller's mutation
   * become another task's plan.
   */
  buildPlan(input: ServiceRecoveryInput, _facts: DiscoveryFacts): PlannedEffect[] {
    return [
      {
        ordinal: 0,
        toolName: 'manage_services',
        provider: 'breeze',
        targetId: input.deviceId,
        accountExternalId: null,
        canonicalArguments: {
          deviceId: input.deviceId,
          action: 'restart',
          serviceName: input.serviceName,
        },
      },
    ];
  },
  operationKey(args) {
    return serviceRecoveryOperationKey({
      stepKey: args.stepKey as ServiceRecoveryStepKey,
      // `buildTaskOperationKey` already substitutes `'none'` for a null target.
      deviceId: args.targetId ?? 'none',
      planRevision: args.planRevision,
      ordinal: args.ordinal,
    });
  },
  crossCheckStepInputs: crossCheckServiceRecoveryInputs,
};
```

- [ ] **Step 6: Run both suites green — the shipped one UNMODIFIED**

Run: `cd apps/api && npx vitest run src/services/aiOperator/recipes/serviceRecovery.test.ts src/services/aiOperator/recipes/serviceRecovery.recipe.test.ts`
Expected: PASS — 2 files, 24 + 13 tests. If `serviceRecovery.test.ts` reports anything but its original 24 passing tests, the port changed behaviour: fix the port, not the test.

Then confirm the shipped suite is byte-identical:

Run: `git diff --stat -- apps/api/src/services/aiOperator/recipes/serviceRecovery.test.ts`
Expected: empty output.

- [ ] **Step 7: Commit**

```
git add apps/api/src/services/aiOperator/recipes/serviceRecovery.ts apps/api/src/services/aiOperator/recipes/serviceRecovery.recipe.test.ts
git commit -m "$(cat <<'EOF'
refactor(ai-operator): port service_recovery to a RecipeDefinition (E1)

Every shipped export keeps its name, signature and behaviour; validateNextStep
now delegates to the one generic validator. The unmodified
recipes/serviceRecovery.test.ts is the regression proof.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The purity guard — `recipes/purity.test.ts`

**Files:**
- Create: `apps/api/src/services/aiOperator/recipes/purity.test.ts`

**Interfaces:**
- Consumes: the source text of every `.ts` file in `recipes/` (`node:fs`, `node:path`).
- Produces: a contract test that fails the moment a recipe file imports anything outside the allowlist.

**Why the red step here is a mutation, not a missing module:** the shipped recipe already satisfies the rule, so a newly written guard passes on the first run — which proves nothing. The red step temporarily breaks the rule and watches the guard catch it. A guard that has never been seen failing is a guard nobody knows works.

- [ ] **Step 1: Write the test**

```ts
// apps/api/src/services/aiOperator/recipes/purity.test.ts
/**
 * Recipe Library spec §6.1: "Recipes stay pure: no I/O, no imports from
 * services."
 *
 * This is the guard for that sentence, and it is mechanical on purpose. The
 * registry's value to a reviewer is that reading ONE file tells you everything
 * a workflow may do; a recipe that could reach `../../db` could observe or
 * mutate tenant state while still presenting itself as a pure validator, and
 * nothing in a diff review reliably catches an added import (CLAUDE.md's
 * cascade-list history: review 0/5, contract tests 5/5).
 *
 * ALLOWED, and nothing else:
 *  - `zod`                — schema declarations, no I/O.
 *  - `@breeze/shared`     — pure types and validators; cannot import apps/api.
 *  - `../operationKey`    — a pure string builder. Recipes MUST delegate to it
 *                           rather than formatting their own key, because two
 *                           formatters eventually disagree and the failure mode
 *                           of disagreeing is a DUPLICATE operation row for one
 *                           real-world effect.
 *  - `./<sibling>`        — any other file inside `recipes/`.
 *
 * The extractor throws when it finds no files or no imports, so a directory
 * move cannot make this suite vacuously green.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RECIPES_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Exactly the non-sibling module specifiers a recipe file may import. */
const ALLOWED_EXTERNAL_IMPORTS: ReadonlySet<string> = new Set([
  'zod',
  '@breeze/shared',
  '../operationKey',
]);

function recipeSourceFiles(): string[] {
  const files = readdirSync(RECIPES_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort();
  if (files.length === 0) {
    throw new Error(`purity guard found no recipe source files in ${RECIPES_DIR} — the directory moved; fix this test`);
  }
  return files;
}

/** Every module specifier of a static `import`/`export … from` or a dynamic `import()`. */
function importSpecifiers(source: string): string[] {
  const statics = Array.from(
    source.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]{0,400}?from\s*['"]([^'"]+)['"]/g),
    (m) => m[1]!,
  );
  const bareSideEffect = Array.from(source.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g), (m) => m[1]!);
  const dynamic = Array.from(source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g), (m) => m[1]!);
  const required = Array.from(source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g), (m) => m[1]!);
  return [...statics, ...bareSideEffect, ...dynamic, ...required];
}

describe('recipes/ purity (Recipe Library spec §6.1)', () => {
  const files = recipeSourceFiles();

  it('finds the recipe source files it is supposed to be guarding', () => {
    expect(files).toContain('serviceRecovery.ts');
    expect(files).toContain('index.ts');
    expect(files).toContain('types.ts');
    expect(files).toContain('validateNextStep.ts');
  });

  it.each(files)('%s imports only zod, @breeze/shared, ../operationKey, or a recipes/ sibling', (file) => {
    const specifiers = importSpecifiers(readFileSync(join(RECIPES_DIR, file), 'utf8'));
    const forbidden = specifiers
      .filter((s) => !s.startsWith('./'))
      .filter((s) => !ALLOWED_EXTERNAL_IMPORTS.has(s))
      .sort();
    expect(
      forbidden,
      `${file} imports modules a recipe may not reach. A recipe is DATA plus pure validators and owns NO I/O `
        + '(spec §6.1). Move whatever needs this import into taskCoordinator.ts, which is where step EXECUTION lives.',
    ).toEqual([]);
  });

  it('the extractor actually sees imports (a silent regex break would pass every file)', () => {
    const specifiers = importSpecifiers(readFileSync(join(RECIPES_DIR, 'serviceRecovery.ts'), 'utf8'));
    expect(specifiers).toContain('zod');
    expect(specifiers).toContain('@breeze/shared');
    expect(specifiers).toContain('../operationKey');
  });
});
```

- [ ] **Step 2: Prove the guard discriminates — run it RED against a deliberate violation**

Temporarily add this line immediately after the existing `import { z } from 'zod';` in `apps/api/src/services/aiOperator/recipes/serviceRecovery.ts`:

```ts
import { db } from '../../../db';
```

Run: `cd apps/api && npx vitest run src/services/aiOperator/recipes/purity.test.ts`
Expected: FAIL — `serviceRecovery.ts imports modules a recipe may not reach` with `[ '../../../db' ]`.

- [ ] **Step 3: Revert the violation and run green**

Remove the temporary `import { db } …` line.

Run: `cd apps/api && npx vitest run src/services/aiOperator/recipes/purity.test.ts`
Expected: PASS — 1 file, 6 tests (1 + 4 parametrized + 1). Confirm the file is clean:

Run: `git diff -- apps/api/src/services/aiOperator/recipes/serviceRecovery.ts | grep -c "\.\./\.\./\.\./db"`
Expected: `0`.

- [ ] **Step 4: Commit**

```
git add apps/api/src/services/aiOperator/recipes/purity.test.ts
git commit -m "$(cat <<'EOF'
test(ai-operator): mechanical purity guard for recipes/ (E1)

Spec §6.1 "recipes stay pure: no I/O, no imports from services", enforced by
an import scan with a four-entry allowlist rather than by review.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The registry — `recipes/index.ts`

**Files:**
- Create: `apps/api/src/services/aiOperator/recipes/index.ts`
- Create: `apps/api/src/services/aiOperator/recipes/index.test.ts`

**Interfaces:**
- Consumes: `serviceRecoveryRecipe` (`./serviceRecovery`), `RecipeDefinition`/`AnyRecipeDefinition` (`./types`).
- Produces:
  - `export const RECIPES: Readonly<Record<string, RecipeDefinition<never>>>`
  - `export const RECIPE_KEYS: readonly string[]` — sorted, for error messages and the future library route.
  - `export function getRecipe(workflowKey: string, workflowVersion: number): RecipeDefinition<never> | null`
  - `export function getRecipeByKey(workflowKey: string): RecipeDefinition<never> | null`
  - `export type RecipeResolution = { ok: true; recipe: RecipeDefinition<never> } | { ok: false; reason: 'unknown_recipe' | 'version_mismatch'; detail: string; releasedVersion: number | null }`
  - `export function resolveAdmissionRecipe(workflowKey: string, workflowVersion: number): RecipeResolution`
  - re-exports of every type in `./types` and of `validateRecipeNextStep`, so consumers outside `recipes/` import from `./recipes` only.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiOperator/recipes/index.test.ts
/**
 * The recipe registry (Recipe Library spec §6.1). Before E1 `workflow_key` was
 * stored on every task row and never dispatched on: the coordinator imported
 * service-recovery constants directly and `taskService` hardcoded the key at
 * admission (spec §2). This is the lookup that replaces both.
 *
 * The structural invariants below are contract tests, not style checks. A
 * `permittedNextSteps` target that is not a step means the model can propose a
 * key the validator will accept and the coordinator cannot run — a task that
 * hands off for a reason no one can read.
 */
import { describe, expect, it } from 'vitest';
import {
  RECIPES,
  RECIPE_KEYS,
  getRecipe,
  getRecipeByKey,
  resolveAdmissionRecipe,
} from './index';
import { RECIPE_GATE_CLASSES, STEP_KINDS, TARGET_KINDS } from './types';
import { AI_OPERATOR_TASK_PHASES } from '../../../db/schema/aiOperatorTasks';

describe('RECIPES registry', () => {
  it('contains service_recovery and nothing E1 did not ship', () => {
    expect(RECIPE_KEYS).toEqual(['service_recovery']);
  });

  it('every map key equals its recipe own key, so a lookup can never return a different recipe', () => {
    for (const [key, recipe] of Object.entries(RECIPES)) {
      expect(recipe.key).toBe(key);
    }
  });

  it('RECIPE_KEYS is sorted and matches the map', () => {
    expect(RECIPE_KEYS).toEqual([...Object.keys(RECIPES)].sort());
  });

  it('is frozen: a caller cannot register a recipe at runtime', () => {
    expect(Object.isFrozen(RECIPES)).toBe(true);
  });
});

describe('registry structural invariants', () => {
  for (const [key, recipe] of Object.entries(RECIPES)) {
    describe(key, () => {
      it('declares at least one step and a positive integer version', () => {
        expect(Object.keys(recipe.steps).length).toBeGreaterThan(0);
        expect(Number.isInteger(recipe.version)).toBe(true);
        expect(recipe.version).toBeGreaterThan(0);
      });

      it('uses only declared step kinds, target kinds, gate classes and task phases', () => {
        expect(RECIPE_GATE_CLASSES).toContain(recipe.gateClass);
        for (const kind of recipe.targetKinds) expect(TARGET_KINDS).toContain(kind);
        for (const step of Object.values(recipe.steps)) {
          expect(STEP_KINDS).toContain(step.kind);
          expect(AI_OPERATOR_TASK_PHASES).toContain(step.phase);
        }
      });

      it('every permittedNextSteps key and target is a declared step', () => {
        for (const [from, targets] of Object.entries(recipe.permittedNextSteps)) {
          expect(Object.keys(recipe.steps), `'${from}' is not a step of ${key}`).toContain(from);
          for (const to of targets) {
            expect(Object.keys(recipe.steps), `'${to}' is not a step of ${key}`).toContain(to);
          }
        }
      });

      it('no step is reachable FROM a terminal step', () => {
        for (const [from, targets] of Object.entries(recipe.permittedNextSteps)) {
          if (recipe.steps[from]?.terminal) expect(targets).toEqual([]);
        }
      });

      it('declares bounds that are positive and self-consistent', () => {
        const b = recipe.bounds;
        for (const [name, value] of Object.entries(b)) {
          expect(value, `${key}.bounds.${name}`).toBeGreaterThan(0);
        }
        expect(b.deadlineMs).toBeGreaterThan(b.unknownEffectHorizonMs);
      });

      it('promptVersion is namespaced by the recipe key, so run evidence names its recipe', () => {
        expect(recipe.promptVersion.startsWith(`${key}/`)).toBe(true);
      });

      it('fits the workflow_key length CHECK (128, ai_operator_tasks_workflow_key_len_chk)', () => {
        expect(recipe.key.length).toBeLessThanOrEqual(128);
      });
    });
  }
});

describe('getRecipe / getRecipeByKey', () => {
  it('returns the recipe for a released (key, version) pair', () => {
    expect(getRecipe('service_recovery', 1)?.key).toBe('service_recovery');
  });

  it('returns null for an unknown key', () => {
    expect(getRecipe('identity_offboarding', 1)).toBeNull();
    expect(getRecipeByKey('identity_offboarding')).toBeNull();
  });

  it('returns null for a version that is not the released one — a task is NEVER upgraded', () => {
    expect(getRecipe('service_recovery', 2)).toBeNull();
    expect(getRecipe('service_recovery', 0)).toBeNull();
  });

  it('getRecipeByKey ignores version, so a caller can tell "no such recipe" from "wrong version"', () => {
    expect(getRecipeByKey('service_recovery')?.version).toBe(1);
  });
});

describe('resolveAdmissionRecipe', () => {
  it('resolves a released pair', () => {
    const resolved = resolveAdmissionRecipe('service_recovery', 1);
    expect(resolved).toMatchObject({ ok: true });
    expect((resolved as { recipe: { key: string } }).recipe.key).toBe('service_recovery');
  });

  it('refuses an unknown key with unknown_recipe and NAMES the supported keys', () => {
    const resolved = resolveAdmissionRecipe('identity_offboarding', 1);
    expect(resolved).toMatchObject({ ok: false, reason: 'unknown_recipe', releasedVersion: null });
    expect((resolved as { detail: string }).detail).toContain('identity_offboarding');
    expect((resolved as { detail: string }).detail).toContain('service_recovery');
  });

  it('refuses a wrong version with version_mismatch and reports the released version', () => {
    const resolved = resolveAdmissionRecipe('service_recovery', 99);
    expect(resolved).toMatchObject({ ok: false, reason: 'version_mismatch', releasedVersion: 1 });
    expect((resolved as { detail: string }).detail).toContain('99');
  });

  it('refuses a non-integer or negative version rather than coercing it', () => {
    expect(resolveAdmissionRecipe('service_recovery', 1.5)).toMatchObject({ ok: false, reason: 'version_mismatch' });
    expect(resolveAdmissionRecipe('service_recovery', -1)).toMatchObject({ ok: false, reason: 'version_mismatch' });
  });
});
```

- [ ] **Step 2: Run it red**

Run: `cd apps/api && npx vitest run src/services/aiOperator/recipes/index.test.ts`
Expected: FAIL — cannot resolve `./index`.

- [ ] **Step 3: Implement `recipes/index.ts`**

```ts
// apps/api/src/services/aiOperator/recipes/index.ts
/**
 * The recipe registry (Recipe Library spec §6.1).
 *
 * `taskService` admission and `taskCoordinator.advanceTask` look a recipe up
 * by `(workflow_key, workflow_version)`. Before this file existed the key was
 * stored on every task row and never dispatched on — the coordinator imported
 * service-recovery constants directly and admission hardcoded the key — which
 * is why a second recipe could not exist (spec §2).
 *
 * VERSION IS FROZEN FOR LIFE. `getRecipe` returns `null` on a version this
 * registry has not released; it never falls back to the newest one. Operator
 * spec P3-4 ("freeze recipe versions for admitted tasks"): a task was admitted,
 * reviewed and possibly approved against ONE released definition, and silently
 * advancing it under a different one would execute a plan nobody reviewed.
 *
 * One released version per key today, so `RECIPES` is keyed by key alone, as
 * spec §6.1 types it. When a key ships a second concurrent version the value
 * becomes an array and both accessors absorb it — no call site changes.
 */

import { serviceRecoveryRecipe } from './serviceRecovery';
import type { RecipeDefinition } from './types';

export * from './types';
export { validateRecipeNextStep } from './validateNextStep';

/** A registry entry. `never` erases the per-recipe Input at the lookup boundary. */
type RegisteredRecipe = RecipeDefinition<never>;

/**
 * Every released recipe, keyed by `workflow_key`.
 *
 * Frozen so nothing can register a recipe at runtime: a recipe is code that
 * was reviewed and released, and a runtime registration path would be a way to
 * run an unreviewed workflow.
 */
export const RECIPES: Readonly<Record<string, RegisteredRecipe>> = Object.freeze({
  [serviceRecoveryRecipe.key]: serviceRecoveryRecipe as unknown as RegisteredRecipe,
});

/** Sorted, for deterministic error messages and the future library route. */
export const RECIPE_KEYS: readonly string[] = Object.freeze([...Object.keys(RECIPES)].sort());

/** The released recipe for a key, ignoring version. */
export function getRecipeByKey(workflowKey: string): RegisteredRecipe | null {
  // `Object.hasOwn` rather than a truthiness check: a key of `'constructor'`
  // or `'toString'` would otherwise resolve to a prototype member.
  return Object.hasOwn(RECIPES, workflowKey) ? RECIPES[workflowKey]! : null;
}

/**
 * The recipe for an exact `(key, version)` pair, or `null`.
 *
 * Null covers BOTH "no such key" and "not that version" because every caller
 * that needs to tell them apart is at an admission boundary and uses
 * `resolveAdmissionRecipe` instead; the coordinator, which is the other
 * caller, treats both the same way (hand off).
 */
export function getRecipe(workflowKey: string, workflowVersion: number): RegisteredRecipe | null {
  const recipe = getRecipeByKey(workflowKey);
  if (!recipe) return null;
  return recipe.version === workflowVersion ? recipe : null;
}

export type RecipeResolution =
  | { ok: true; recipe: RegisteredRecipe }
  | {
    ok: false;
    reason: 'unknown_recipe' | 'version_mismatch';
    detail: string;
    /** The version this deployment has released for the key, or null when the key is unknown. */
    releasedVersion: number | null;
  };

/**
 * Resolve a recipe at ADMISSION, where the two failures are different answers
 * to the caller: an unknown key is a malformed request (400 — no such recipe
 * exists at any version), a version mismatch is a stale client that reviewed a
 * workflow this deployment has moved past (422 — reload and review the current
 * one). Operator spec §5.1: "the operator approves a specific reviewed
 * workflow, and a cached catalog is never authority."
 */
export function resolveAdmissionRecipe(
  workflowKey: string,
  workflowVersion: number,
): RecipeResolution {
  const recipe = getRecipeByKey(workflowKey);
  if (!recipe) {
    return {
      ok: false,
      reason: 'unknown_recipe',
      detail: `'${workflowKey}' is not a supported workflow. Supported workflows: ${RECIPE_KEYS.join(', ')}.`,
      releasedVersion: null,
    };
  }
  if (recipe.version !== workflowVersion) {
    return {
      ok: false,
      reason: 'version_mismatch',
      detail: `Workflow ${recipe.key} is at version ${recipe.version}; this request reviewed version `
        + `${workflowVersion}. Reload and review the current workflow.`,
      releasedVersion: recipe.version,
    };
  }
  return { ok: true, recipe };
}
```

- [ ] **Step 4: Run it green**

Run: `cd apps/api && npx vitest run src/services/aiOperator/recipes/index.test.ts`
Expected: PASS — 1 file, 20 tests.

Then re-run the purity guard, which now has a fourth file to scan:

Run: `cd apps/api && npx vitest run src/services/aiOperator/recipes/purity.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```
git add apps/api/src/services/aiOperator/recipes/index.ts apps/api/src/services/aiOperator/recipes/index.test.ts
git commit -m "$(cat <<'EOF'
feat(ai-operator): recipe registry with (key, version) lookup (E1)

RECIPES / getRecipe / getRecipeByKey / resolveAdmissionRecipe, plus structural
contract tests over every registered recipe. Version is frozen: an unreleased
version resolves to null, never to the newest definition.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Admission resolves the recipe through the registry

**Files:**
- Modify: `apps/api/src/services/aiOperator/taskService.ts` (`:41-47` imports, `:51-56` refusal union, `:68-89` input interface, `:101-127` body, `:177` deadline, `:189-190` insert)
- Create: `apps/api/src/services/aiOperator/taskService.recipeAdmission.test.ts`

**Interfaces:**
- Consumes: `resolveAdmissionRecipe` (`./recipes`).
- Produces: `AdmitTaskRefusal` gains `'unknown_recipe'` and `'recipe_version_mismatch'`; `AdmitServiceRecoveryTaskInput` gains `workflowKey?: string` and `workflowVersion?: number`.

**The refusal must be reached BEFORE any database work** — that is what makes it unit-testable without a db mock, and it is also correct: an unknown workflow cannot be admitted no matter what the org contains.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiOperator/taskService.recipeAdmission.test.ts
/**
 * Admission resolves its recipe through the registry (Recipe Library spec
 * §6.1, wave E1) instead of hardcoding `SERVICE_RECOVERY_WORKFLOW_KEY` into
 * the insert (`taskService.ts:189-190` before this wave).
 *
 * These cases are all refusals that must land BEFORE the database is touched,
 * so the suite needs no db: reaching Postgres to learn that a workflow does
 * not exist would hold a connection for a request that can never succeed, and
 * would make the refusal depend on tenant state it has nothing to do with.
 * `vi.mock('../../db')` throws on any use, which is what proves the ordering.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({
  db: new Proxy({}, { get() { throw new Error('admission touched the database before refusing'); } }),
  runOutsideDbContext: () => { throw new Error('admission opened a db context before refusing'); },
  withSystemDbAccessContext: () => { throw new Error('admission opened a db context before refusing'); },
}));

vi.mock('../../config/env', () => ({
  aiOperatorTasksEnabled: () => true,
  aiOperatorServiceRecoveryEnabled: () => true,
}));

import { admitServiceRecoveryTask } from './taskService';

const DEVICE_ID = '00000000-0000-4000-8000-000000000011';
const ORG_ID = '00000000-0000-4000-8000-000000000001';
const AGENT_ID = '00000000-0000-4000-8000-000000000002';

const base = {
  orgId: ORG_ID,
  agentId: AGENT_ID,
  objective: 'Restore the spooler service',
  originKind: 'manual' as const,
  requesterUserId: null,
  recipeInput: { deviceId: DEVICE_ID, serviceName: 'spooler' },
};

describe('admitServiceRecoveryTask recipe resolution', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('refuses an unknown workflow key with unknown_recipe, before any db work', async () => {
    const result = await admitServiceRecoveryTask({ ...base, workflowKey: 'identity_offboarding' });
    expect(result).toMatchObject({ ok: false, refusal: 'unknown_recipe' });
    expect((result as { detail: string }).detail).toContain('service_recovery');
  });

  it('refuses a workflow version this deployment has not released', async () => {
    const result = await admitServiceRecoveryTask({ ...base, workflowVersion: 99 });
    expect(result).toMatchObject({ ok: false, refusal: 'recipe_version_mismatch' });
    expect((result as { detail: string }).detail).toContain('99');
  });

  it('still refuses invalid recipe input before any db work', async () => {
    const result = await admitServiceRecoveryTask({ ...base, recipeInput: { deviceId: 'nope', serviceName: '' } });
    expect(result).toMatchObject({ ok: false, refusal: 'invalid_input' });
  });
});
```

- [ ] **Step 2: Run it red**

Run: `cd apps/api && npx vitest run src/services/aiOperator/taskService.recipeAdmission.test.ts`
Expected: FAIL — the first two cases get `admission touched the database before refusing` (or a `device_not_in_org` refusal), because nothing resolves the recipe yet.

- [ ] **Step 3: Update the imports at `taskService.ts:41-47`**

Replace:

```ts
import {
  SERVICE_RECOVERY_BOUNDS,
  SERVICE_RECOVERY_WORKFLOW_KEY,
  SERVICE_RECOVERY_WORKFLOW_VERSION,
  buildServiceRecoveryCriterion,
  parseServiceRecoveryInput,
} from './recipes/serviceRecovery';
```

with:

```ts
import {
  SERVICE_RECOVERY_WORKFLOW_KEY,
  SERVICE_RECOVERY_WORKFLOW_VERSION,
  buildServiceRecoveryCriterion,
  parseServiceRecoveryInput,
} from './recipes/serviceRecovery';
import { resolveAdmissionRecipe } from './recipes';
```

(`SERVICE_RECOVERY_BOUNDS` is dropped: the deadline now comes from the resolved recipe.)

- [ ] **Step 4: Extend the refusal union at `taskService.ts:51-56`**

```ts
export type AdmitTaskRefusal =
  | 'tasks_disabled'
  | 'recipe_disabled'
  /** The workflow key is not in the registry at ANY version — a 400 at the route. */
  | 'unknown_recipe'
  /** The key exists but not at the reviewed version — a 422 at the route. */
  | 'recipe_version_mismatch'
  | 'agent_not_found'
  | 'device_not_in_org'
  | 'invalid_input';
```

- [ ] **Step 5: Add the two optional inputs to `AdmitServiceRecoveryTaskInput` (`taskService.ts:68-89`), after `recipeInput`**

```ts
  /**
   * Which recipe to admit. Defaults to the service-recovery pair, because
   * every current caller admits that one; passing them explicitly is what lets
   * the route refuse an unknown key with the registry's own message instead of
   * a zod literal mismatch. The pair is resolved against the registry and the
   * RESOLVED values are what land on the row — a caller cannot write a key the
   * coordinator could not later dispatch on.
   */
  workflowKey?: string;
  workflowVersion?: number;
```

- [ ] **Step 6: Resolve the recipe at the top of the body, between the flag checks (`:107-113`) and the input parse (`:115`)**

Insert immediately after the `aiOperatorServiceRecoveryEnabled()` block closes:

```ts
  // Resolve BEFORE the input parse and before any db work. An unknown workflow
  // cannot be admitted regardless of what the org contains, and reaching
  // Postgres to discover that would hold a connection for a request that can
  // never succeed.
  const resolution = resolveAdmissionRecipe(
    input.workflowKey ?? SERVICE_RECOVERY_WORKFLOW_KEY,
    input.workflowVersion ?? SERVICE_RECOVERY_WORKFLOW_VERSION,
  );
  if (!resolution.ok) {
    return {
      ok: false,
      refusal: resolution.reason === 'unknown_recipe' ? 'unknown_recipe' : 'recipe_version_mismatch',
      detail: resolution.detail,
    };
  }
  const recipe = resolution.recipe;
```

- [ ] **Step 7: Read the deadline and the frozen pair from the recipe**

At `taskService.ts:177`, replace:

```ts
      const deadlineMs = input.deadlineMs ?? SERVICE_RECOVERY_BOUNDS.deadlineMs;
```

with:

```ts
      const deadlineMs = input.deadlineMs ?? recipe.bounds.deadlineMs;
```

At `taskService.ts:189-190`, replace:

```ts
        workflowKey: SERVICE_RECOVERY_WORKFLOW_KEY,
        workflowVersion: SERVICE_RECOVERY_WORKFLOW_VERSION,
```

with:

```ts
        // The RESOLVED pair, not the requested one: the row must always name a
        // recipe `getRecipe` can return, or the coordinator's first tick on it
        // would hand the task off (Operator spec P3-4, version frozen for life).
        workflowKey: recipe.key,
        workflowVersion: recipe.version,
```

- [ ] **Step 8: Run it green**

Run: `cd apps/api && npx vitest run src/services/aiOperator/taskService.recipeAdmission.test.ts`
Expected: PASS — 1 file, 3 tests.

- [ ] **Step 9: Commit**

```
git add apps/api/src/services/aiOperator/taskService.ts apps/api/src/services/aiOperator/taskService.recipeAdmission.test.ts
git commit -m "$(cat <<'EOF'
refactor(ai-operator): admission resolves its recipe through the registry (E1)

The workflow key/version and the deadline bound come from the resolved
RecipeDefinition instead of imported service-recovery constants. Unknown key
and unreleased version are typed refusals raised before any db work.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: The coordinator dispatches on the recipe

**Files:**
- Modify: `apps/api/src/services/aiOperator/taskCoordinator.ts` (`:1-40` docstring — append only, `:56-61` imports, `:302-385` `admitReasoningRun`, `:394-451` `advanceTask`, `:457-592` `advanceInvestigate`, `:595-675` `advanceExecute`, `:678-752` `advanceObserve`, `:755-843` `advanceVerify`, `:846-880` `writeLeasedStep`)
- Create: `apps/api/src/services/aiOperator/taskCoordinator.recipeResolution.test.ts`

**Interfaces:**
- Consumes: `getRecipe` (`./recipes`), `RecipeDefinition` (`./recipes/types`).
- Produces:
  - `export function resolveTaskRecipe(task: { workflowKey: string; workflowVersion: number }): { ok: true; recipe: RecipeDefinition<never> } | { ok: false; detail: string }` — pure, exported for unit test.
  - `type StepAdvancer` and the module-private `RECIPE_ADVANCERS` table.
  - `advanceTask` signature is **unchanged**: `(task: AiOperatorTaskRow, leaseEpoch: number) => Promise<string>`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiOperator/taskCoordinator.recipeResolution.test.ts
/**
 * The coordinator's recipe resolution (Recipe Library spec §6.1, wave E1).
 *
 * Pure and exported on purpose: `advanceTask` itself needs a leased row and a
 * live database, and the branch that matters most here — an admitted task
 * whose workflow key or version the registry does not know — must be a
 * classified HANDOFF, never a throw. A throw would leave the BullMQ wake job
 * retrying forever against a row that can never advance, with nothing in the
 * task's own outcome to tell a technician why it stopped.
 *
 * The handoff itself is proved against real Postgres in
 * `src/__tests__/integration/aiOperatorRecipeRegistry.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { resolveTaskRecipe } from './taskCoordinator';

describe('resolveTaskRecipe', () => {
  it('resolves the released service_recovery pair', () => {
    const resolved = resolveTaskRecipe({ workflowKey: 'service_recovery', workflowVersion: 1 });
    expect(resolved.ok).toBe(true);
    expect((resolved as { recipe: { key: string } }).recipe.key).toBe('service_recovery');
  });

  it('refuses an unknown key with a detail naming the key and the version', () => {
    const resolved = resolveTaskRecipe({ workflowKey: 'identity_offboarding', workflowVersion: 1 });
    expect(resolved.ok).toBe(false);
    expect((resolved as { detail: string }).detail).toContain('identity_offboarding');
    expect((resolved as { detail: string }).detail).toContain('1');
  });

  it('refuses a version the registry has not released — a task is never upgraded', () => {
    const resolved = resolveTaskRecipe({ workflowKey: 'service_recovery', workflowVersion: 2 });
    expect(resolved.ok).toBe(false);
    expect((resolved as { detail: string }).detail).toContain('service_recovery');
  });

  it('never throws, whatever it is handed', () => {
    expect(() => resolveTaskRecipe({ workflowKey: '', workflowVersion: 0 })).not.toThrow();
    expect(resolveTaskRecipe({ workflowKey: '', workflowVersion: 0 }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it red**

Run: `cd apps/api && npx vitest run src/services/aiOperator/taskCoordinator.recipeResolution.test.ts`
Expected: FAIL — `resolveTaskRecipe` is not exported from `./taskCoordinator`.

- [ ] **Step 3: Replace the recipe import block at `taskCoordinator.ts:56-61`**

Replace:

```ts
import {
  SERVICE_RECOVERY_BOUNDS,
  SERVICE_RECOVERY_PROMPT_VERSION,
  taskRunDedupeKey,
  validateNextStep,
} from './recipes/serviceRecovery';
```

with:

```ts
import { SERVICE_RECOVERY_WORKFLOW_KEY, taskRunDedupeKey } from './recipes/serviceRecovery';
import { getRecipe, validateRecipeNextStep } from './recipes';
import type { RecipeDefinition } from './recipes/types';
```

- [ ] **Step 4: Append a fourth paragraph to the module docstring, AFTER the `LEASE VS ATTEMPT` paragraph (`taskCoordinator.ts:34-39`) and before the closing `*/`**

Do not touch the three numbered invariants above it.

```
 * RECIPE RESOLUTION (Recipe Library spec §6.1). Every bound, prompt version,
 * step table and permitted-next-step table this file reads comes from the
 * RecipeDefinition resolved from the task's own frozen `(workflow_key,
 * workflow_version)`, never from an imported constant. What a step DOES is
 * still this file's job — spec §6.1's step-kind table assigns execution to the
 * coordinator and data to the recipe — so the per-recipe advancer table below
 * lives here and not in `recipes/`. A task whose pair the registry cannot
 * resolve HANDS OFF; it never throws, because a throw would leave its wake job
 * retrying against a row that can never advance.
```

- [ ] **Step 5: Add `resolveTaskRecipe` and the advancer table, immediately above `advanceTask` (before `taskCoordinator.ts:387`'s docstring)**

```ts
/**
 * Resolve the RecipeDefinition for a task's FROZEN pair.
 *
 * Pure, exported, and never throwing: the two failure modes (a key this build
 * does not ship, and a version this build has moved past) are both a task that
 * can never advance, and the only correct answer to that is a classified
 * handoff with a readable reason.
 */
export function resolveTaskRecipe(
  task: { workflowKey: string; workflowVersion: number },
): { ok: true; recipe: RecipeDefinition<never> } | { ok: false; detail: string } {
  const recipe = getRecipe(task.workflowKey, task.workflowVersion);
  if (!recipe) {
    return {
      ok: false,
      detail: `this build does not ship workflow '${task.workflowKey}' at version ${task.workflowVersion}`,
    };
  }
  return { ok: true, recipe };
}

/** How the coordinator advances ONE step of ONE recipe. */
type StepAdvancer = (args: {
  task: AiOperatorTaskRow;
  leaseEpoch: number;
  checkpoint: TaskCheckpoint;
  recipe: RecipeDefinition<never>;
  now: Date;
}) => Promise<string>;

/**
 * Step execution, per recipe. Spec §6.1: "Step execution by kind is
 * coordinator code, not recipe code" — so this table is here, next to the
 * functions it points at, rather than on the RecipeDefinition. A recipe that
 * carried its own executors could reach I/O, which is exactly what
 * `recipes/purity.test.ts` forbids.
 *
 * A recipe with no entry here, or a step with no entry in its table, settles
 * the task rather than guessing.
 */
const RECIPE_ADVANCERS: Readonly<Record<string, Readonly<Record<string, StepAdvancer>>>> = {
  [SERVICE_RECOVERY_WORKFLOW_KEY]: {
    investigate: (a) => advanceInvestigate(a.task, a.leaseEpoch, a.checkpoint, a.recipe),
    execute: (a) => advanceExecute(a.task, a.leaseEpoch, a.checkpoint, a.recipe),
    observe: (a) => advanceObserve(a.task, a.leaseEpoch, a.checkpoint, a.recipe, a.now),
    verify: (a) => advanceVerify(a.task, a.leaseEpoch, a.checkpoint, a.recipe),
  },
};
```

- [ ] **Step 6: Rewrite the dispatch tail of `advanceTask` (`taskCoordinator.ts:433-450`)**

Replace:

```ts
  const stepKey = task.currentStepKey ?? 'investigate';

  switch (stepKey) {
    case 'investigate':
      return advanceInvestigate(task, leaseEpoch, checkpoint);
    case 'execute':
      return advanceExecute(task, leaseEpoch, checkpoint);
    case 'observe':
      return advanceObserve(task, leaseEpoch, checkpoint, now);
    case 'verify':
      return advanceVerify(task, leaseEpoch, checkpoint);
    default:
      await settle({
        task, leaseEpoch, event: 'fail', outcome: 'unresolved',
        detail: `unknown step '${stepKey}'`, checkpoint,
      });
      return `failed: unknown step ${stepKey}`;
  }
}
```

with:

```ts
  // Resolve the recipe BEFORE dispatching a step. A task frozen against a
  // recipe this build no longer ships cannot be advanced by anything here, and
  // handing it off is the only answer that leaves a technician a reason to
  // read (Operator spec §7.3: a stopped task says what it did and did not do).
  const resolved = resolveTaskRecipe({
    workflowKey: task.workflowKey,
    workflowVersion: task.workflowVersion,
  });
  if (!resolved.ok) {
    await settle({
      task, leaseEpoch, event: 'hand_off', outcome: 'unresolved',
      detail: resolved.detail, checkpoint,
      handoffSummary:
        `Operator cannot continue this task: ${resolved.detail}. `
        + 'Nothing was changed. Start a new task with a currently supported workflow.',
    });
    return `handed off: ${resolved.detail}`;
  }
  const recipe = resolved.recipe;

  const stepKey = task.currentStepKey ?? 'investigate';
  const advance = RECIPE_ADVANCERS[recipe.key]?.[stepKey];
  if (!advance) {
    await settle({
      task, leaseEpoch, event: 'fail', outcome: 'unresolved',
      detail: `unknown step '${stepKey}'`, checkpoint,
    });
    return `failed: unknown step ${stepKey}`;
  }

  return advance({ task, leaseEpoch, checkpoint, recipe, now });
}
```

> The `detail` and the returned string for an unknown step are **unchanged** — `aiOperatorCoordinator.integration.test.ts` asserts against them.

- [ ] **Step 7: Thread `recipe` through the four advancers and read bounds from it**

Each edit below is mechanical. The behaviour must not change: `recipe.bounds` **is** `SERVICE_RECOVERY_BOUNDS` (Task 3 binds it by identity), and `recipe.promptVersion` **is** `SERVICE_RECOVERY_PROMPT_VERSION`.

1. `admitReasoningRun` (`:302-308`) — add `recipe: RecipeDefinition<never>;` to its args interface. Replace `SERVICE_RECOVERY_BOUNDS.maxReasoningRuns` at `:316` and `:319` with `args.recipe.bounds.maxReasoningRuns`, and `SERVICE_RECOVERY_PROMPT_VERSION` at `:360` with `args.recipe.promptVersion`. Pass `recipe` at both of its call sites (`:466-468`, `:811-813`).
2. `advanceInvestigate` (`:457-461`) — add a fourth parameter `recipe: RecipeDefinition<never>`. At `:562-566` replace:

```ts
  const validated = validateNextStep(
    'investigate',
    { key: proposal.nextStep.key, inputs: proposal.nextStep.inputs },
    checkpoint.recipeInput,
  );
```

with:

```ts
  // The RECIPE — not the model, and not a hardcoded step name — decides if the
  // proposal is reachable. The current step comes from the row rather than the
  // literal `'investigate'`: this function is registered as the advancer for
  // that step today, but a recipe whose reason step is called something else
  // would otherwise be validated against a step it does not have.
  const validated = validateRecipeNextStep(
    recipe,
    task.currentStepKey ?? 'investigate',
    { key: proposal.nextStep.key, inputs: proposal.nextStep.inputs },
    checkpoint.recipeInput as never,
  );
```

3. `advanceExecute` (`:595-599`) — add the `recipe` parameter; replace `SERVICE_RECOVERY_BOUNDS.observeWakeAfterMs` at `:650` with `recipe.bounds.observeWakeAfterMs`.
4. `advanceObserve` (`:678-683`) — add `recipe` as the fourth parameter (before `now`); replace `SERVICE_RECOVERY_BOUNDS.unknownEffectHorizonMs` at `:727` with `recipe.bounds.unknownEffectHorizonMs`. At `:722` replace:

```ts
    await writeLeasedStep(task, leaseEpoch, 'verify', 'verify', checkpoint);
```

with:

```ts
    await writeLeasedStep(task, leaseEpoch, 'verify', recipe, checkpoint);
```

5. `advanceVerify` (`:755-759`) — add the `recipe` parameter; replace `SERVICE_RECOVERY_BOUNDS.verificationWakeAfterMs` at `:799` with `recipe.bounds.verificationWakeAfterMs` and `SERVICE_RECOVERY_BOUNDS.maxMutationAttempts` at `:810` with `recipe.bounds.maxMutationAttempts`.
6. `writeLeasedStep` (`:846-852`) — replace the `phase` parameter with the recipe, so the (step, phase) pair comes from one place:

```ts
/** Move to the next step, keeping the task `running` under the same lease. */
async function writeLeasedStep(
  task: AiOperatorTaskRow,
  leaseEpoch: number,
  stepKey: string,
  recipe: RecipeDefinition<never>,
  checkpoint: TaskCheckpoint,
): Promise<void> {
  // The phase comes from the recipe's own step table. Passing it separately at
  // the call site is how a step and its phase drift apart, and `phase` is what
  // the task page renders.
  const phase = recipe.steps[stepKey]?.phase ?? 'investigate';
  await writeLeased({
```

and inside the `patch`, replace `phase,` with `phase,` unchanged (the local now supplies it).

- [ ] **Step 8: Run the coordinator unit test green**

Run: `cd apps/api && npx vitest run src/services/aiOperator/taskCoordinator.recipeResolution.test.ts`
Expected: PASS — 1 file, 4 tests.

- [ ] **Step 9: Typecheck the whole API package — this refactor's real blast radius is types**

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`
Expected: exit 0, no output.

- [ ] **Step 10: Run every aiOperator unit suite**

Run:
```
cd apps/api && npx vitest run \
  src/services/aiOperator \
  src/routes/aiOperatorTasks.test.ts \
  src/jobs/aiOperatorTaskOutboxPublisher.test.ts \
  src/services/aiAgents/runLoop.taskFence.test.ts
```
Expected: PASS, ≥ 12 files. `src/services/aiOperator` is a substring filter, not a glob — check the reported file count includes `recipes/serviceRecovery.test.ts`, `recipes/index.test.ts`, `recipes/purity.test.ts`, `recipes/types.test.ts`, `recipes/validateNextStep.test.ts`, `recipes/serviceRecovery.recipe.test.ts`, `taskCoordinator.recipeResolution.test.ts`, `taskService.recipeAdmission.test.ts`, `enumParity.test.ts`, `operationKey.test.ts`, `taskContext.test.ts`, `taskFence.test.ts`, `taskOutbox.test.ts`, `taskTransitions.test.ts`, `verification.test.ts`, `dispatchClaim.test.ts`, `operationService.test.ts`, `taskReadService.test.ts`.

- [ ] **Step 11: Commit**

```
git add apps/api/src/services/aiOperator/taskCoordinator.ts apps/api/src/services/aiOperator/taskCoordinator.recipeResolution.test.ts
git commit -m "$(cat <<'EOF'
refactor(ai-operator): coordinator dispatches on the resolved recipe (E1)

advanceTask resolves (workflow_key, workflow_version) through the registry and
dispatches through a per-recipe advancer table; bounds, prompt version and the
next-step validator all come from the RecipeDefinition. An unresolvable pair
hands off through the existing settle path and never throws. The three
coordinator invariants are untouched.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: The route refuses an unknown workflow key with 400 and the supported list

**Files:**
- Modify: `packages/shared/src/validators/aiOperator.ts:236`
- Modify: `apps/api/src/routes/aiOperatorTasks.ts:52-55` (imports), `:229-242` (readiness block)
- Modify: `apps/api/src/routes/aiOperatorTasks.test.ts` (append cases; do not edit existing ones)

**Interfaces:**
- Consumes: `resolveAdmissionRecipe`, `RECIPE_KEYS` (`../services/aiOperator/recipes`).
- Produces: `POST /api/v1/ai/operator/tasks` answers **400** `{ error, code: 'OPERATOR_UNKNOWN_RECIPE', supportedRecipeKeys: string[] }` for a key the registry does not have, and keeps its existing **422** `OPERATOR_RECIPE_VERSION_MISMATCH` for a known key at the wrong version.

- [ ] **Step 1: Write the failing tests (append to `apps/api/src/routes/aiOperatorTasks.test.ts`, inside the existing `POST /tasks` describe block)**

```ts
  it('rejects an unknown recipeKey with 400 and names the supported workflows', async () => {
    const res = await post(body({ recipeKey: 'identity_offboarding' }));
    expect(res.status).toBe(400);
    const json = await res.json() as { code: string; supportedRecipeKeys: string[]; error: string };
    expect(json.code).toBe('OPERATOR_UNKNOWN_RECIPE');
    expect(json.supportedRecipeKeys).toContain('service_recovery');
    expect(json.error).toContain('identity_offboarding');
    expect(admitMock).not.toHaveBeenCalled();
  });

  it('still rejects a known recipe at an unreleased version with 422, not 400', async () => {
    const res = await post(body({ recipeVersion: 99 }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'OPERATOR_RECIPE_VERSION_MISMATCH' });
    expect(admitMock).not.toHaveBeenCalled();
  });

  it('passes the resolved workflow key and version through to admission', async () => {
    await post(body());
    expect(admitMock).toHaveBeenCalledWith(expect.objectContaining({
      workflowKey: 'service_recovery',
      workflowVersion: 1,
    }));
  });
```

- [ ] **Step 2: Run them red**

Run: `cd apps/api && npx vitest run src/routes/aiOperatorTasks.test.ts`
Expected: FAIL — the unknown-key case gets 400 from the zod literal but with no `OPERATOR_UNKNOWN_RECIPE` code and no `supportedRecipeKeys`; the pass-through case fails because admission is called without `workflowKey`.

- [ ] **Step 3: Relax `recipeKey` in `packages/shared/src/validators/aiOperator.ts:236`**

Replace:

```ts
  recipeKey: z.literal('service_recovery'),
```

with:

```ts
  /**
   * The workflow the client is admitting. NOT a literal: the server validates
   * it against the recipe registry so an unknown key is refused with a 400
   * that names the supported workflows, which a zod literal mismatch cannot
   * do. `apps/api` owns the registry; `packages/shared` cannot import it.
   * The 128 cap mirrors `ai_operator_tasks_workflow_key_len_chk`.
   */
  recipeKey: z.string().min(1).max(128),
```

- [ ] **Step 4: Update the route imports at `routes/aiOperatorTasks.ts:52-55`**

Replace:

```ts
import {
  SERVICE_RECOVERY_WORKFLOW_KEY,
  SERVICE_RECOVERY_WORKFLOW_VERSION,
} from '../services/aiOperator/recipes/serviceRecovery';
```

with:

```ts
import { RECIPE_KEYS, resolveAdmissionRecipe } from '../services/aiOperator/recipes';
```

- [ ] **Step 5: Replace the version check at `routes/aiOperatorTasks.ts:235-241`**

Replace:

```ts
    if (body.recipeVersion !== SERVICE_RECOVERY_WORKFLOW_VERSION) {
      return c.json({
        error: `Workflow ${SERVICE_RECOVERY_WORKFLOW_KEY} is at version ${SERVICE_RECOVERY_WORKFLOW_VERSION}; `
          + `this request reviewed version ${body.recipeVersion}. Reload and review the current workflow.`,
        code: 'OPERATOR_RECIPE_VERSION_MISMATCH',
      }, 422);
    }
```

with:

```ts
    // Two different answers to the caller (Recipe Library spec §6.1):
    //  - an unknown key is a malformed request — no such workflow exists at
    //    any version, so the response names the ones that do (400);
    //  - a known key at an unreleased version is a stale client that reviewed
    //    a workflow this deployment has moved past (422 — spec §12's
    //    "422 for unsupported workflow/criteria/setup", and the shipped
    //    behaviour this route already had).
    const resolution = resolveAdmissionRecipe(body.recipeKey, body.recipeVersion);
    if (!resolution.ok && resolution.reason === 'unknown_recipe') {
      return c.json({
        error: resolution.detail,
        code: 'OPERATOR_UNKNOWN_RECIPE',
        supportedRecipeKeys: [...RECIPE_KEYS],
      }, 400);
    }
    if (!resolution.ok) {
      return c.json({
        error: resolution.detail,
        code: 'OPERATOR_RECIPE_VERSION_MISMATCH',
      }, 422);
    }
    const recipe = resolution.recipe;
```

- [ ] **Step 6: Pass the resolved pair to admission (`routes/aiOperatorTasks.ts`, inside the `admitServiceRecoveryTask({ … })` call, immediately after `agentId: agent.id,`)**

```ts
      // The RESOLVED pair. Admission re-resolves it — the two checks are not
      // redundant: this route is not the only admission caller, and admission
      // is the layer that writes the row.
      workflowKey: recipe.key,
      workflowVersion: recipe.version,
```

- [ ] **Step 7: Map the two new refusals in the route's refusal handler**

In the `if (!result.ok)` block (immediately after the `device_not_in_org` 404 branch), insert:

```ts
      if (result.refusal === 'unknown_recipe') {
        return c.json({
          error: result.detail,
          code: 'OPERATOR_UNKNOWN_RECIPE',
          supportedRecipeKeys: [...RECIPE_KEYS],
        }, 400);
      }
```

`recipe_version_mismatch` needs no branch: the existing fall-through answers 422 with `code: 'RECIPE_VERSION_MISMATCH'`, which is the same class of refusal. (The pre-check above returns first in practice; this is the defence for any other caller path.)

- [ ] **Step 8: Run green**

Run: `cd apps/api && npx vitest run src/routes/aiOperatorTasks.test.ts`
Expected: PASS — 1 file, all pre-existing tests plus the 3 new ones.

Run: `cd packages/shared && npx vitest run src/validators`
Expected: PASS, no regression.

Run: `cd apps/web && npx vitest run src/components/aiOperator`
Expected: PASS — `DelegateToOperatorButton.test.tsx` still sends `recipeKey: 'service_recovery'` and is unaffected.

- [ ] **Step 9: Commit**

```
git add packages/shared/src/validators/aiOperator.ts apps/api/src/routes/aiOperatorTasks.ts apps/api/src/routes/aiOperatorTasks.test.ts
git commit -m "$(cat <<'EOF'
feat(ai-operator): 400 with the supported workflow list for an unknown recipe key (E1)

recipeKey is validated against the registry instead of a zod literal, so an
unknown key is refused with the keys this build ships. A known key at an
unreleased version keeps its 422.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Integration proof — an unresolvable recipe hands the task off against real Postgres

**Files:**
- Create: `apps/api/src/__tests__/integration/aiOperatorRecipeRegistry.integration.test.ts`

**Interfaces:**
- Consumes: `claimTaskLease`, `advanceTask` (`../../services/aiOperator/taskCoordinator`), the existing integration fixtures used by `aiOperatorCoordinator.integration.test.ts` (read that file first and reuse its org/agent/device/task seeding helpers verbatim rather than inventing new ones).
- Produces: proof that a committed `ai_operator_tasks` row carrying a workflow key this build does not ship settles as `handed_off` / `unresolved` with a readable `outcome_detail`, and that `advanceTask` does not throw.

**Placement matters:** this file MUST live in `apps/api/src/__tests__/integration/`. A misplaced integration test runs **zero** tests and reports green.

- [ ] **Step 1: Read the existing coordinator integration suite and reuse its fixtures**

Run: `sed -n '1,120p' apps/api/src/__tests__/integration/aiOperatorCoordinator.integration.test.ts`
Copy its `beforeAll`/`afterAll` stack setup, its org/agent/device seeding and its task-insert helper into the new file, changing only the `workflowKey`/`workflowVersion` written and the assertions. Do not invent a second seeding convention.

- [ ] **Step 2: Write the failing test**

```ts
// apps/api/src/__tests__/integration/aiOperatorRecipeRegistry.integration.test.ts
/**
 * Recipe Library spec §6.1 / wave E1: a task frozen against a recipe this
 * build does not ship must HAND OFF, not throw and not spin.
 *
 * Against real Postgres because the property being proved is about a committed
 * row and a committed terminal transition: `advanceTask` takes a lease, writes
 * under the lease CAS, and the test reads the row back. A mocked db would
 * prove only that a branch was taken.
 *
 * Why this matters more than it looks: the wake path (`handleTaskWake`) turns
 * a throw into a retried BullMQ job. A task whose recipe vanished — a rolled
 * back deploy, a recipe renamed between releases, a version retired — would
 * then be re-attempted forever, holding a coordinator tick each time, with
 * nothing in its own outcome telling a technician why it never finished.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// … the same imports and fixture helpers as aiOperatorCoordinator.integration.test.ts …
import { advanceTask, claimTaskLease } from '../../services/aiOperator/taskCoordinator';

describe('coordinator: unresolvable recipe (E1)', () => {
  // … beforeAll/afterAll copied from aiOperatorCoordinator.integration.test.ts …

  it('hands off a task whose workflow key this build does not ship', async () => {
    const taskId = await seedTask({ workflowKey: 'identity_offboarding', workflowVersion: 1 });

    const claim = await claimTaskLease({ orgId, taskId, requireWakeDue: false });
    expect(claim.won).toBe(true);
    if (!claim.won) return;

    const outcome = await advanceTask(claim.task, claim.leaseEpoch);
    expect(outcome).toContain('handed off');

    const [row] = await readTaskRow(taskId);
    expect(row.state).toBe('handed_off');
    expect(row.outcome).toBe('unresolved');
    expect(row.outcomeDetail).toContain('identity_offboarding');
    expect(row.handoffSummary).toContain('Nothing was changed');
    // Released, not held: a task that can never advance must not pin a lease.
    expect(row.leaseOwner).toBeNull();
    expect(row.nextWakeAt).toBeNull();
  });

  it('hands off a task frozen at a workflow VERSION this build does not ship', async () => {
    const taskId = await seedTask({ workflowKey: 'service_recovery', workflowVersion: 99 });

    const claim = await claimTaskLease({ orgId, taskId, requireWakeDue: false });
    expect(claim.won).toBe(true);
    if (!claim.won) return;

    const outcome = await advanceTask(claim.task, claim.leaseEpoch);
    expect(outcome).toContain('handed off');

    const [row] = await readTaskRow(taskId);
    expect(row.state).toBe('handed_off');
    expect(row.outcomeDetail).toContain('version 99');
  });

  it('a released service_recovery task still advances normally — the registry did not break dispatch', async () => {
    const taskId = await seedTask({ workflowKey: 'service_recovery', workflowVersion: 1 });

    const claim = await claimTaskLease({ orgId, taskId, requireWakeDue: false });
    expect(claim.won).toBe(true);
    if (!claim.won) return;

    const outcome = await advanceTask(claim.task, claim.leaseEpoch);
    // The investigate step admits a reasoning run or hands off because one
    // could not be admitted — either way it is NOT the unresolvable-recipe
    // branch, which is the discriminator this case exists for.
    expect(outcome).not.toContain('does not ship');
  });
});
```

- [ ] **Step 3: Bring up the stack and run it red**

Run (repo root): `pnpm test-stack up`
Then: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiOperatorRecipeRegistry.integration.test.ts`

Expected on a build WITHOUT Task 7: the first two cases fail with `failed: unknown step investigate` / state `failed`. If Task 7 is already committed they pass on the first run — in that case confirm the test discriminates by temporarily making `resolveTaskRecipe` return `{ ok: true, recipe: RECIPES.service_recovery }` unconditionally, watching the two cases go red, then reverting.

- [ ] **Step 4: Run green and confirm the test count is non-zero**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiOperatorRecipeRegistry.integration.test.ts`
Expected: PASS — 1 file, 3 tests. **A "0 tests" report is a placement failure, not a pass.**

- [ ] **Step 5: Commit**

```
git add apps/api/src/__tests__/integration/aiOperatorRecipeRegistry.integration.test.ts
git commit -m "$(cat <<'EOF'
test(ai-operator): integration proof that an unresolvable recipe hands off (E1)

Against real Postgres: an admitted task whose (workflow_key, workflow_version)
the registry cannot resolve settles handed_off/unresolved with a readable
detail and releases its lease, instead of throwing into a retrying wake job.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Full aiOperator unit + integration suites on a test stack

This wave touches the agent execution path. Local unit green is not evidence; the coordinator's real behaviour only shows up against Postgres.

- [ ] **Step 1: Ensure the test stack is up**

Run (repo root): `pnpm test-stack up`
Expected: `.env.test` written, pg + redis healthy for this worktree.

- [ ] **Step 2: Typecheck all three packages**

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`
Run: `cd packages/shared && npx tsc --noEmit -p tsconfig.json`
Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0 each.

- [ ] **Step 3: Every aiOperator-touching unit suite**

Run:
```
cd apps/api && npx vitest run \
  src/services/aiOperator \
  src/routes/aiOperatorTasks.test.ts \
  src/jobs/aiOperatorTaskOutboxPublisher.test.ts \
  src/jobs/intentReleaseWorker.test.ts \
  src/services/aiAgents/runLoop.taskFence.test.ts \
  src/services/aiAgentSdk.test.ts \
  src/services/aiAgentSdk.approvalWait.test.ts \
  src/services/workerRegistry.test.ts \
  src/services/workerEntrypointClosure.contract.test.ts \
  src/routes/config.test.ts
```
Expected: PASS, ≥ 26 files, 0 failures.

- [ ] **Step 4: Every aiOperator integration suite**

Run:
```
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/aiOperatorAdmission.integration.test.ts \
  src/__tests__/integration/aiOperatorCoordinator.integration.test.ts \
  src/__tests__/integration/aiOperatorDispatchClaim.integration.test.ts \
  src/__tests__/integration/aiOperatorIndexes.integration.test.ts \
  src/__tests__/integration/aiOperatorIntentIdentity.integration.test.ts \
  src/__tests__/integration/aiOperatorRecipeRegistry.integration.test.ts \
  src/__tests__/integration/aiOperatorRecovery.integration.test.ts \
  src/__tests__/integration/aiOperatorSchema.integration.test.ts \
  src/__tests__/integration/aiOperatorServiceRecoveryE2E.integration.test.ts \
  src/__tests__/integration/aiOperatorTaskRead.integration.test.ts \
  src/__tests__/integration/aiOperatorTerminalWriters.integration.test.ts
```
Expected: PASS — 11 files, 0 failures. `aiOperatorServiceRecoveryE2E.integration.test.ts` passing **unmodified** is the end-to-end regression proof for the whole refactor.

- [ ] **Step 5: Shared and web packages**

Run: `cd packages/shared && npx vitest run`
Run: `cd apps/web && npx vitest run src/components/aiOperator`
Expected: PASS both.

- [ ] **Step 6: Assert the untouchable files really are untouched**

Run:
```
git diff --name-only origin/main...HEAD | sort
```
Expected: the list must NOT contain `apps/api/src/services/aiOperator/recipes/serviceRecovery.test.ts`, `apps/api/src/__tests__/integration/aiOperatorServiceRecoveryE2E.integration.test.ts`, any path under `apps/api/migrations/`, `apps/api/src/services/tenantCascade.ts`, `apps/api/src/services/tenantExportPolicyRegistry.ts`, `apps/api/src/services/orgMergeRegistry.ts`, `.env.example`, `deploy/.env.example`, `docker-compose.yml`, `deploy/docker-compose.prod.yml`.

- [ ] **Step 7: Lint**

Run (repo root): `pnpm lint`
Expected: exit 0.

- [ ] **Step 8: Tear the stack down**

Run (repo root): `pnpm test-stack down`
Expected: the worktree's private pg+redis project is gone. Nothing does this for you.

---

### Task 11: Open the PR and STOP

- [ ] **Step 1: Push the branch**

Run: `git push -u origin feature/<parent#>-operator-recipe-library/wave-<subissue#>`

- [ ] **Step 2: Open the PR**

```
gh pr create --base main --title "feat(ai-operator): recipe registry and coordinator dispatch refactor (E1)" --body "$(cat <<'EOF'
## What

Wave E1 of the Operator Recipe Library. `service_recovery` stops being hardcoded into the Operator's admission, coordinator and route.

- New pure module `services/aiOperator/recipes/types.ts` — `RecipeDefinition` and its supporting types, spec §6.1's field names verbatim plus one documented addition (`crossCheckStepInputs`).
- New `recipes/validateNextStep.ts` — the ONE generic next-step validator, driven by `permittedNextSteps` + `steps[k].inputSchema` + the recipe's pure cross-check against its frozen admission input.
- New `recipes/index.ts` — `RECIPES`, `RECIPE_KEYS`, `getRecipe(key, version)`, `getRecipeByKey(key)`, `resolveAdmissionRecipe(key, version)`. Version is frozen for life: an unreleased version resolves to `null`, never to the newest definition.
- `recipes/serviceRecovery.ts` ports to a `RecipeDefinition`, keeping every existing export and every existing behaviour. Its shipped unit suite and the service-recovery E2E integration suite pass **unmodified** — that is the regression proof.
- `taskService` admission, `taskCoordinator.advanceTask` and `POST /ai/operator/tasks` all resolve the recipe from the registry. An unknown key is a 400 naming the supported workflows; an unreleased version keeps its 422; an unresolvable pair on an admitted task hands the task off through the existing settle path and never throws.
- `recipes/purity.test.ts` enforces spec §6.1's "recipes stay pure: no I/O, no imports from services" mechanically, against a four-entry import allowlist.

## What this wave does NOT do

No schema change, no migration, no new table, no new env var, no UI. Nothing to register in `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_TENANT_EXPORT_POLICY` or `orgMergeRegistry.ts` — E2 is the wave that adds tables and carries that ceremony.

## Risk

High blast radius: this is the AI Operator's agent execution path. The three coordinator invariants in `taskCoordinator.ts`'s docstring are untouched. `recipe.bounds` and `recipe.promptVersion` are bound by identity to the shipped `SERVICE_RECOVERY_BOUNDS` / `SERVICE_RECOVERY_PROMPT_VERSION`, so every number the coordinator reads is the same object it read before.

## Verification

- All 18 aiOperator unit suites green, including the unmodified `recipes/serviceRecovery.test.ts`.
- All 11 aiOperator integration suites green against real Postgres, including the unmodified `aiOperatorServiceRecoveryE2E.integration.test.ts`.
- New `aiOperatorRecipeRegistry.integration.test.ts`: an unresolvable recipe hands off, releases its lease and clears `next_wake_at`.
- `tsc --noEmit` clean in `apps/api`, `packages/shared`, `apps/web`; `pnpm lint` clean.

Spec: `docs/superpowers/specs/ai-mcp/2026-09-17-operator-recipe-library-design.md` §6.1, §10 row E1, §2.
Plan: `docs/superpowers/plans/ai-mcp/2026-09-17-operator-recipe-library-w01-recipe-registry.md`

Closes #<wave sub-issue>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: STOP**

Do not merge. Do not `gh pr merge`. Do not `--admin`. Report the PR number and stop — the orchestrator runs the review round and decides when it enqueues.

---

## Self-review

**Spec coverage for E1**

| Spec § | Requirement | Task |
|---|---|---|
| §6.1 `RecipeDefinition` interface, verbatim field names | `key, version, promptVersion, gateClass, targetKinds, requires, inputSchema, steps, permittedNextSteps, bounds, buildPlan, operationKey` | 1 |
| §6.1 supporting types | `StepDefinition`, `StepKind`, `RecipeBounds`, `CapabilityRequirement`, `PlannedEffect`, `TargetKind`, `DiscoveryFacts` | 1 |
| §6.1 step-kind table is coordinator code | `RECIPE_ADVANCERS` lives in `taskCoordinator.ts`; `StepDefinition.kind`/`phase` in the recipe | 1, 7 |
| §6.1 `RECIPES` + lookup by `(workflow_key, workflow_version)` | `RECIPES`, `getRecipe`, `getRecipeByKey`, `resolveAdmissionRecipe` | 5 |
| §6.1 "Recipes stay pure: no I/O, no imports from services" | `purity.test.ts` import scan, proved discriminating by a mutation | 4 |
| §6.1 "`service_recovery` is ported first, behavior-identical, as the refactor's regression proof" | port + unmodified shipped suites | 3, 10 |
| §9 gate class | `gateClass: 'model_chooses_effect'` on the ported recipe; `RECIPE_GATE_CLASSES` union | 1, 3 |
| §5.1 target kinds | `TARGET_KINDS = ['device','ticket','contact']` | 1 |
| §6.4 `PlannedEffect` | `buildPlan` returns the single `manage_services` effect | 1, 3 |
| §2 "taskCoordinator imports service-recovery constants directly and switches on the step-key string" | dispatch refactor | 7 |
| §2 "taskService hardcodes the workflow key at admission" | admission refactor | 6 |
| Operator spec P3-4 "freeze recipe versions for admitted tasks" | `getRecipe` returns null on version mismatch; resolved pair is what is written | 5, 6, 9 |
| Brief: unknown key at admission → 400 with supported keys | `OPERATOR_UNKNOWN_RECIPE` + `supportedRecipeKeys` | 8 |
| Brief: unknown key/version → settle/handoff, never a throw | `resolveTaskRecipe` + `settle(hand_off)`; integration proof | 7, 9 |
| Brief: run the full aiOperator integration suites on a test stack | 11 suites enumerated with the exact command | 10 |

**Placeholder scan:** no `TBD`, no `TODO`, no "similar to", no "add validation". Every code block is complete; every run step names the command and the expected result. The two places that say "copy from the existing file" (Task 9 fixtures) name the exact file and the exact command to read it, because inventing a second Postgres seeding convention for the Operator family would be worse than reusing the shipped one.

**Identifier consistency:** `RecipeDefinition`/`AnyRecipeDefinition`, `STEP_KINDS`/`StepKind`, `TARGET_KINDS`/`TargetKind`, `RECIPE_GATE_CLASSES`/`RecipeGateClass`, `StepDefinition`, `RecipeBounds`, `CapabilityRequirement`, `PlannedEffect`, `EffectProvider`, `DiscoveryFacts`, `TaskPhase`, `NextStepValidation`, `NextStepFailureReason`, `CrossCheckResult` (Task 1) are used verbatim in Tasks 2, 3, 5, 7. `validateRecipeNextStep` (Task 2) is consumed in Tasks 3 and 7. `serviceRecoveryRecipe` (Task 3) is consumed in Task 5. `RECIPES`/`RECIPE_KEYS`/`getRecipe`/`getRecipeByKey`/`resolveAdmissionRecipe`/`RecipeResolution` (Task 5) are consumed in Tasks 6, 7, 8. `resolveTaskRecipe`/`StepAdvancer`/`RECIPE_ADVANCERS` (Task 7) are consumed in Tasks 7 and 9. `unknown_recipe`/`recipe_version_mismatch` (Task 6) are consumed in Task 8. `OPERATOR_UNKNOWN_RECIPE` and `supportedRecipeKeys` (Task 8) appear in the route, its test and the PR body identically.
