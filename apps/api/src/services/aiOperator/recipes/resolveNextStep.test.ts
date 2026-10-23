/**
 * The ONE resolver for `StepDefinition.next` (Recipe Library spec §6.3's
 * deterministic spine).
 *
 * `next` answers a different question from `permittedNextSteps`. The latter is
 * the set a MODEL may propose from a `reason` step; this is what the SERVER
 * does when a non-reason step settles. Conflating them is how a deterministic
 * recipe grows a model-chosen branch, so the two never read each other and
 * this file asserts that separation directly.
 *
 * Every failure is CLASSIFIED, never guessed: a recipe that forgets a `next`
 * is a recipe bug, and the coordinator settles the task with a readable reason
 * rather than falling through to some plausible-looking step.
 */
import { describe, expect, it } from 'vitest';
import { resolveDeterministicNextStep } from './resolveNextStep';
import type { NextStepContext, RecipeDefinition } from './types';

const EMPTY_CTX: NextStepContext = { input: {}, facts: {}, readiness: {} };

function fixture(steps: RecipeDefinition<never>['steps']): RecipeDefinition<never> {
  return {
    key: 'fixture', version: 1, promptVersion: 'fixture/v1',
    gateClass: 'deterministic', targetKinds: ['contact'], requires: [],
    inputSchema: { parse: (v: unknown) => v } as never,
    steps,
    permittedNextSteps: {},
    bounds: {
      maxReasoningRuns: 1, maxMutationAttempts: 1, freshnessSeconds: 1,
      observeWakeAfterMs: 1, verificationWakeAfterMs: 1,
      unknownEffectHorizonMs: 1, deadlineMs: 1,
    },
    buildPlan: () => [],
    operationKey: () => 'fixture',
  } as unknown as RecipeDefinition<never>;
}

describe('resolveDeterministicNextStep', () => {
  it('resolves a literal successor', () => {
    const r = fixture({ a: { kind: 'probe', phase: 'plan', next: 'b' }, b: { kind: 'document', phase: 'document', terminal: true } });
    expect(resolveDeterministicNextStep(r, 'a', EMPTY_CTX)).toEqual({ ok: true, key: 'b' });
  });

  it('resolves a functional successor from facts and readiness', () => {
    const r = fixture({
      a: {
        kind: 'wait', phase: 'execute',
        next: (ctx) => (ctx.readiness['m365.graph.auto_reply'] ? 'effects' : 'manual_work'),
      },
      effects: { kind: 'effect', phase: 'execute' },
      manual_work: { kind: 'human_work', phase: 'execute' },
    });
    expect(resolveDeterministicNextStep(r, 'a', { ...EMPTY_CTX, readiness: { 'm365.graph.auto_reply': true } }))
      .toEqual({ ok: true, key: 'effects' });
    expect(resolveDeterministicNextStep(r, 'a', EMPTY_CTX)).toEqual({ ok: true, key: 'manual_work' });
  });

  it('refuses when the step declares no `next`', () => {
    const r = fixture({ a: { kind: 'probe', phase: 'plan' } });
    const res = resolveDeterministicNextStep(r, 'a', EMPTY_CTX);
    expect(res).toEqual({ ok: false, reason: 'no_next_declared', detail: expect.stringContaining("'a'") });
  });

  it('refuses on a terminal step even if it somehow declares a next', () => {
    const r = fixture({ a: { kind: 'document', phase: 'document', terminal: true, next: 'b' }, b: { kind: 'probe', phase: 'plan' } });
    expect(resolveDeterministicNextStep(r, 'a', EMPTY_CTX).ok).toBe(false);
    expect((resolveDeterministicNextStep(r, 'a', EMPTY_CTX) as { reason: string }).reason).toBe('terminal_step');
  });

  it('refuses when the resolver names a step the recipe does not declare — never invents one', () => {
    const r = fixture({ a: { kind: 'probe', phase: 'plan', next: () => 'nope' } });
    const res = resolveDeterministicNextStep(r, 'a', EMPTY_CTX) as { ok: false; reason: string; detail: string };
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unknown_step');
    expect(res.detail).toContain('nope');
  });

  it('refuses when the current step key itself is unknown', () => {
    expect(resolveDeterministicNextStep(fixture({}), 'ghost', EMPTY_CTX))
      .toEqual({ ok: false, reason: 'unknown_step', detail: expect.stringContaining('ghost') });
  });

  it('refuses a prototype key such as `constructor` rather than reading Object.prototype', () => {
    const r = fixture({ a: { kind: 'probe', phase: 'plan', next: 'constructor' } });
    expect((resolveDeterministicNextStep(r, 'a', EMPTY_CTX) as { reason: string }).reason).toBe('unknown_step');
    expect((resolveDeterministicNextStep(r, 'toString', EMPTY_CTX) as { reason: string }).reason).toBe('unknown_step');
  });

  it('CONTAINS a throwing resolver instead of propagating it', () => {
    const r = fixture({ a: { kind: 'probe', phase: 'plan', next: () => { throw new Error('boom'); } } });
    const res = resolveDeterministicNextStep(r, 'a', EMPTY_CTX) as { ok: false; reason: string; detail: string };
    expect(res.reason).toBe('resolver_threw');
    expect(res.detail).toContain('boom');
    // A throw out of here would reach advanceTask and leave the BullMQ wake job
    // retrying forever against a row that can never advance.
  });

  it('never consults permittedNextSteps', () => {
    const r = fixture({ a: { kind: 'probe', phase: 'plan' } });
    (r as unknown as { permittedNextSteps: Record<string, string[]> }).permittedNextSteps = { a: ['b'] };
    expect(resolveDeterministicNextStep(r, 'a', EMPTY_CTX).ok).toBe(false);
  });
});
