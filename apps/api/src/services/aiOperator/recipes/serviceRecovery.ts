/**
 * The ONE recipe of the thin vertical slice (#5205 W06): recover a supported
 * service incident on one device, supervised mode only. Baseline §2 is the
 * recipe card; this file is its executable form.
 *
 * A recipe is DATA plus pure validators. It owns:
 *  - the ordered step keys and which next step the model may propose from each;
 *  - the Zod schema for each step's inputs;
 *  - the verification criterion it will be graded on;
 *  - its own bounds (restart attempts, freshness, wait horizons).
 *
 * It owns NO I/O. `taskCoordinator.ts` executes steps; putting the effect here
 * would give the recipe two jobs and make "which key may the model propose"
 * unauditable without reading an execution path.
 *
 * SUPERVISED ONLY. There is no direct-act branch: the execute step reserves an
 * operation and creates an action intent, and the task waits for a human
 * approval. Baseline §2.3 pins the policy mapping — action key
 * `manage_services:restart`, Tier 3, supervised (not four-eyes), and a device
 * whose service is listed in `protectedResources.services` is denied BEFORE an
 * intent exists, which the recipe must surface as an admission refusal rather
 * than a failed operation.
 */

import { z } from 'zod';
import { buildTaskOperationKey } from '../operationKey';
import {
  serviceRecoveryInputSchema,
  taskCriterionSchema,
  type ServiceRecoveryInput,
  type TaskCriterion,
} from '@breeze/shared';

export const SERVICE_RECOVERY_WORKFLOW_KEY = 'service_recovery' as const;
export const SERVICE_RECOVERY_WORKFLOW_VERSION = 1 as const;

/**
 * The prompt template version recorded on every task-linked run
 * (`ai_agent_runs.prompt_version`, spec §6.2).
 *
 * There is no prompt registry yet, so runs 1 and 4 of ONE task may use
 * different released prompts. Spec §6.2 accepts that drift explicitly but
 * requires it to be RECORDED — this constant is what makes the drift visible
 * in task evidence. Bump it whenever `taskContext.ts`'s rendering changes in a
 * way that could change model behaviour.
 */
export const SERVICE_RECOVERY_PROMPT_VERSION = 'service_recovery/v1' as const;

/** Ordered step keys. `document` is terminal for the recipe. */
export const SERVICE_RECOVERY_STEP_KEYS = [
  'investigate', 'execute', 'observe', 'verify', 'document',
] as const;
export type ServiceRecoveryStepKey = (typeof SERVICE_RECOVERY_STEP_KEYS)[number];

export function isServiceRecoveryStepKey(key: string): key is ServiceRecoveryStepKey {
  return (SERVICE_RECOVERY_STEP_KEYS as readonly string[]).includes(key);
}

/**
 * Which step keys the MODEL is permitted to propose from each step, via
 * `submit_task_step`.
 *
 * Deliberately sparse. From `investigate` the model may propose exactly one
 * thing — `execute` — or hand off / ask a question. It may NOT propose
 * `verify` (that would let it skip the fix and claim success) and it may not
 * propose `observe` (that would let it assert an effect it never dispatched).
 * Every other step is driven by the coordinator from authoritative rows, not
 * by the model, which is why their permitted sets are empty: after
 * `execute`, the model is not consulted again until verification actually
 * fails.
 */
export const SERVICE_RECOVERY_PERMITTED_NEXT_STEPS: Readonly<
  Record<ServiceRecoveryStepKey, readonly ServiceRecoveryStepKey[]>
> = {
  investigate: ['execute'],
  execute: [],
  observe: [],
  verify: [],
  document: [],
};

/** Inputs the model must supply with each proposable next step. */
export const SERVICE_RECOVERY_STEP_INPUT_SCHEMAS = {
  execute: z.object({
    /**
     * Must equal the `serviceName` frozen at admission. It is part of the
     * argument digest, so a DIFFERENT name is a different operation needing a
     * different approval (spec §7.1) — the coordinator rejects a mismatch
     * rather than silently minting a second operation.
     */
    serviceName: z.string().min(1).max(255),
  }).strict(),
} as const;

/**
 * Recipe bounds. Narrower than the spec §7.2 policy defaults on purpose — the
 * recipe is allowed to be stricter than the policy, never looser.
 */
export const SERVICE_RECOVERY_BOUNDS = {
  /** Spec §7.2 default "Reasoning runs per task". */
  maxReasoningRuns: 4,
  /** Spec §7.2 allows 3 mutation attempts per target; this recipe caps at 2. */
  maxMutationAttempts: 2,
  /** Criterion freshness (baseline C9 — no existing constant means this one). */
  freshnessSeconds: 120,
  /**
   * How long to wait before re-observing a dispatched command. Baseline §2.6:
   * the tool returns at 30 s but the device command reaps at 5 min, so the
   * 30 s-to-5 min window is the recipe's NORMAL unknown-effect case. Waking
   * at the reap plus a 30 s cushion is the first moment the command's state is
   * actually settled.
   */
  observeWakeAfterMs: 5 * 60 * 1000 + 30 * 1000,
  /** How long to wait between polls of a still-holding fix watch. */
  verificationWakeAfterMs: 5 * 60 * 1000,
  /**
   * Past this, an operation whose effect cannot be proven absent hands off
   * with `unknown_effect` rather than being retried (spec §6.5, §6.3).
   * Sized past the 20-minute stale-executing intent reap so the intent layer
   * has had its chance to settle first.
   */
  unknownEffectHorizonMs: 30 * 60 * 1000,
  /** Default task deadline. Spec §7.2's 72 h; recipes may be shorter. */
  deadlineMs: 24 * 60 * 60 * 1000,
} as const;

/**
 * Whether this recipe accepts `verified_resolved` when the task has NO
 * triggering alert.
 *
 * FALSE, and this is the C11 decision, not an oversight. Without an alert
 * there is no recurrence signal: half (b) of the criterion cannot be
 * evaluated at all, and "the service is running right now" is not evidence
 * that the incident is fixed — it is not even evidence there WAS an incident.
 * Spec §8.1 forbids crediting `verified` in that case, so the best honest
 * outcome is `investigation_complete`, which spec §6.1 explicitly defines as
 * "not counted as a fix". A recipe variant that wants otherwise must justify
 * it with its own endpoint signal.
 */
export const SERVICE_RECOVERY_RESOLVABLE_WITHOUT_ALERT = false;

export function parseServiceRecoveryInput(value: unknown): ServiceRecoveryInput {
  return serviceRecoveryInputSchema.parse(value);
}

/** Build the frozen criterion for a set of validated recipe inputs. */
export function buildServiceRecoveryCriterion(input: ServiceRecoveryInput): TaskCriterion {
  return taskCriterionSchema.parse({
    adapter: 'service_running',
    adapterVersion: 1,
    deviceId: input.deviceId,
    serviceName: input.serviceName,
    freshnessSeconds: SERVICE_RECOVERY_BOUNDS.freshnessSeconds,
    alertId: input.triggeringAlertId,
    resolvableWithoutAlert: SERVICE_RECOVERY_RESOLVABLE_WITHOUT_ALERT,
  });
}

export type NextStepValidation =
  | { ok: true; key: ServiceRecoveryStepKey; inputs: Record<string, unknown> }
  | { ok: false; reason: 'unsupported_step' | 'step_not_permitted' | 'invalid_inputs'; detail: string };

/**
 * Validate a `submit_task_step` `nextStep` of kind `'step'` against this
 * recipe. An unsupported key, a key not reachable from the current step, or
 * inputs that do not parse are ALL classified failures that end the run and
 * hand the task off (spec §6.2) — never a silent coercion onto some other
 * step, and never a widening of what the model may do.
 */
export function validateNextStep(
  currentStepKey: string,
  proposed: { key: string; inputs: Record<string, unknown> },
  frozen: ServiceRecoveryInput,
): NextStepValidation {
  if (!isServiceRecoveryStepKey(proposed.key)) {
    return {
      ok: false,
      reason: 'unsupported_step',
      detail: `'${proposed.key}' is not a step of ${SERVICE_RECOVERY_WORKFLOW_KEY}`,
    };
  }
  if (!isServiceRecoveryStepKey(currentStepKey)) {
    return {
      ok: false,
      reason: 'unsupported_step',
      detail: `current step '${currentStepKey}' is not a step of ${SERVICE_RECOVERY_WORKFLOW_KEY}`,
    };
  }

  const permitted = SERVICE_RECOVERY_PERMITTED_NEXT_STEPS[currentStepKey];
  if (!permitted.includes(proposed.key)) {
    return {
      ok: false,
      reason: 'step_not_permitted',
      detail: `'${proposed.key}' is not reachable from '${currentStepKey}'`,
    };
  }

  const schema = (SERVICE_RECOVERY_STEP_INPUT_SCHEMAS as Record<string, z.ZodTypeAny | undefined>)[proposed.key];
  if (!schema) {
    return { ok: true, key: proposed.key, inputs: {} };
  }

  const parsed = schema.safeParse(proposed.inputs);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'invalid_inputs',
      detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 400),
    };
  }

  // Cross-check against the FROZEN admission input. The model proposing a
  // different service name is not a typo to fix, it is an attempt (however
  // accidental) to act outside the approved scope — spec §7.1: "Existing
  // approvals only authorize their pinned arguments."
  if (proposed.key === 'execute') {
    const inputs = parsed.data as { serviceName: string };
    if (inputs.serviceName !== frozen.serviceName) {
      return {
        ok: false,
        reason: 'invalid_inputs',
        detail: `serviceName '${inputs.serviceName}' does not match the service frozen at admission`,
      };
    }
  }

  return { ok: true, key: proposed.key, inputs: parsed.data as Record<string, unknown> };
}

/**
 * The stable operation key for this recipe's one mutating operation.
 *
 * Spec §6.5: identity is step + target + workflow version + plan revision +
 * semantic ordinal. `attemptOrdinal` is deliberately ABSENT — a continuation
 * run re-proposing the same restart must converge on the EXISTING operation
 * row, which is precisely what makes attempt 2 attach instead of duplicating.
 * `planRevision` IS present, because a genuine plan change (a new reasoning
 * attempt admitted after failed verification) is a NEW operation that needs
 * its own approval.
 */
export function serviceRecoveryOperationKey(args: {
  stepKey: ServiceRecoveryStepKey;
  deviceId: string;
  planRevision: number;
  ordinal: number;
}): string {
  // Delegates to the shared builder rather than formatting its own string.
  // `runLoop.ts`'s pre-hook also has to build this key (it is where a Tier-3
  // proposal turns into an intent) and it must NOT import a recipe. Two
  // formatters would eventually disagree, and the failure mode of disagreeing
  // is a DUPLICATE operation row for one real-world effect.
  return buildTaskOperationKey({
    taskStepKey: args.stepKey,
    planRevision: args.planRevision,
    toolName: 'manage_services',
    targetId: args.deviceId,
    ordinal: args.ordinal,
  });
}

/**
 * The dedupe key for a task-linked reasoning run's admission.
 *
 * `createAndEnqueueAgentRun` dedupes on `(org_id, dedupe_key)`; spec §6.2's
 * admission identity is `(org_id, task_id, task_step_key, attempt_ordinal)`.
 * Deriving one from the other means the run table's own unique index and the
 * new `ai_agent_runs_task_admission_uq` partial index agree by construction,
 * so a retried or lease-recovered admission converges on the same row instead
 * of minting a second attempt.
 */
export function taskRunDedupeKey(taskId: string, stepKey: string, attemptOrdinal: number): string {
  return `operator-task:${taskId}:${stepKey}:${attemptOrdinal}`;
}
