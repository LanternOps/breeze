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
