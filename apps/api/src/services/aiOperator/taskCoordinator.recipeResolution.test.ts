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
import { resolveTaskRecipe, stepNeedsRequesterAccessRecheck } from './taskCoordinator';
import { RECIPES } from './recipes';

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

/**
 * `stepNeedsRequesterAccessRecheck` is what makes the requester-access gate
 * (spec §5.1: recheck live access "before each new effect") a dispatch-level
 * property instead of a fact about one step named `execute`. `advanceTask`
 * consults it for whatever step key the task is CURRENTLY on, however it got
 * there — the normal per-tick advance, or a `human_work`/`wait` resume that
 * jumps straight to a step by name (`settleStepAndMove`). A future recipe
 * that names its mutating step something other than `execute`, or that
 * resumes a checklist item directly into one, is covered without this file
 * changing, because the classification is by STEP KIND, not by step key.
 */
describe('stepNeedsRequesterAccessRecheck', () => {
  it('is true for an effect-kind step and false for every other kind', () => {
    expect(stepNeedsRequesterAccessRecheck({ kind: 'effect', phase: 'execute' })).toBe(true);
    for (const kind of ['reason', 'probe', 'wait', 'human_work', 'document'] as const) {
      expect(stepNeedsRequesterAccessRecheck({ kind, phase: 'execute' })).toBe(false);
    }
  });

  it('is undefined-safe — a step key the recipe does not declare needs no recheck of its own', () => {
    expect(stepNeedsRequesterAccessRecheck(undefined)).toBe(false);
  });

  it('agrees with every registered recipe\'s own step table: exactly its effect-kind steps are flagged', () => {
    for (const recipe of Object.values(RECIPES)) {
      for (const [stepKey, step] of Object.entries(recipe.steps)) {
        expect(stepNeedsRequesterAccessRecheck(step)).toBe(step.kind === 'effect');
        void stepKey;
      }
    }
  });
});
