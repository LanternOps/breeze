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
import * as registry from './index';
import type { AnyRecipeDefinition } from './types';
import { RECIPE_GATE_CLASSES, STEP_KINDS, TARGET_KINDS } from './types';
import { AI_OPERATOR_TASK_PHASES } from '../../../db/schema/aiOperatorTasks';

describe('RECIPES registry', () => {
  it('contains exactly the released recipes: identity_offboarding (R1a) and service_recovery', () => {
    expect(RECIPE_KEYS).toEqual(['identity_offboarding', 'service_recovery']);
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

      it('declares consistent R1a-0 recipe data (recipeDataProblems is empty)', () => {
        const recipeDataProblems = (registry as unknown as { recipeDataProblems: (r: AnyRecipeDefinition) => string[] })
          .recipeDataProblems;
        expect(recipeDataProblems(recipe)).toEqual([]);
      });
    });
  }
});

describe('getRecipe / getRecipeByKey', () => {
  it('returns the recipe for a released (key, version) pair', () => {
    expect(getRecipe('service_recovery', 1)?.key).toBe('service_recovery');
  });

  it('returns null for an unknown key', () => {
    expect(getRecipe('no_such_recipe', 1)).toBeNull();
    expect(getRecipeByKey('no_such_recipe')).toBeNull();
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
    const resolved = resolveAdmissionRecipe('no_such_recipe', 1);
    expect(resolved).toMatchObject({ ok: false, reason: 'unknown_recipe', releasedVersion: null });
    expect((resolved as { detail: string }).detail).toContain('no_such_recipe');
    expect((resolved as { detail: string }).detail).toContain('service_recovery');
    expect((resolved as { detail: string }).detail).toContain('identity_offboarding');
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

// ---- R1a-0 Task 1c: planningSnapshotStepKey / unobservableEffects / entryStepKey ----
describe('recipeDataProblems (R1a-0 Task 1c)', () => {
  const recipeDataProblems = (r: unknown) =>
    (registry as unknown as { recipeDataProblems: (r: unknown) => string[] }).recipeDataProblems(r);
  const fixture = (over: Record<string, unknown>) => ({
    ...(RECIPES.service_recovery as unknown as Record<string, unknown>),
    key: 'fixture_recipe',
    ...over,
  });

  it('reports exactly a dangling entryStepKey and a self-subsuming unobservable effect', () => {
    const problems = recipeDataProblems(fixture({
      entryStepKey: 'intake',
      unobservableEffects: { google_signout: 'google_signout' },
    }));
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toContain("entryStepKey 'intake'");
    expect(problems.join('\n')).toContain("'google_signout' cannot subsume itself");
  });

  it('reports a planningSnapshotStepKey that names no declared step', () => {
    const problems = recipeDataProblems(fixture({ planningSnapshotStepKey: 'discover' }));
    expect(problems).toEqual([expect.stringContaining("planningSnapshotStepKey 'discover'")]);
  });

  it('accepts keys that name declared steps and a distinct subsumer', () => {
    expect(recipeDataProblems(fixture({
      entryStepKey: 'investigate',
      planningSnapshotStepKey: 'observe',
      unobservableEffects: { google_signout: 'google_suspend_user' },
    }))).toEqual([]);
  });

  it('service_recovery declares none of the three fields', () => {
    const sr = RECIPES.service_recovery as unknown as Record<string, unknown>;
    expect(Object.hasOwn(sr, 'planningSnapshotStepKey')).toBe(false);
    expect(Object.hasOwn(sr, 'unobservableEffects')).toBe(false);
    expect(Object.hasOwn(sr, 'entryStepKey')).toBe(false);
  });
});
