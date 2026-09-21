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
