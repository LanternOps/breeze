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
