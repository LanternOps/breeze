/**
 * The single resolver for `StepDefinition.next` (spec §6.3).
 *
 * PURE — this file lives inside `recipes/` and is scanned by `purity.test.ts`.
 * It imports types only.
 *
 * Every outcome is classified. There is deliberately no fallback branch that
 * picks a "reasonable" step: a recipe that forgot a `next` is a recipe bug,
 * and the coordinator's answer to a recipe bug is `settle(fail, unresolved)`
 * with the reason in the detail — never a guess that dispatches an effect
 * nobody wrote down.
 */
import type { NextStepContext, RecipeDefinition } from './types';

export type NextStepResolution =
  | { ok: true; key: string }
  | {
    ok: false;
    reason: 'no_next_declared' | 'terminal_step' | 'unknown_step' | 'resolver_threw';
    detail: string;
  };

export function resolveDeterministicNextStep(
  recipe: RecipeDefinition<never>,
  stepKey: string,
  ctx: NextStepContext,
): NextStepResolution {
  const step = Object.hasOwn(recipe.steps, stepKey) ? recipe.steps[stepKey] : undefined;
  if (!step) {
    return { ok: false, reason: 'unknown_step', detail: `${recipe.key} does not declare a step '${stepKey}'` };
  }
  if (step.terminal) {
    return { ok: false, reason: 'terminal_step', detail: `step '${stepKey}' of ${recipe.key} is terminal` };
  }
  if (step.next === undefined) {
    return { ok: false, reason: 'no_next_declared', detail: `step '${stepKey}' of ${recipe.key} declares no deterministic next step` };
  }

  let candidate: unknown;
  if (typeof step.next === 'string') {
    candidate = step.next;
  } else {
    try {
      candidate = step.next(ctx);
    } catch (err) {
      return {
        ok: false,
        reason: 'resolver_threw',
        detail: `next resolver for '${stepKey}' of ${recipe.key} threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (typeof candidate !== 'string' || !Object.hasOwn(recipe.steps, candidate)) {
    return {
      ok: false,
      reason: 'unknown_step',
      detail: `next resolver for '${stepKey}' of ${recipe.key} named '${String(candidate)}', which the recipe does not declare`,
    };
  }
  return { ok: true, key: candidate };
}
