import { describe, expect, it } from 'vitest';
import type { OptionSupport } from '@breeze/shared';
import {
  BUDGET_THINKING_DEFAULT_TOKENS,
  FAST_MODE_BETA,
  THINKING_DISPLAY_UPDATES_BETA,
  UnsupportedWireOptionError,
  buildWireParams,
  toAgentSdkOptions,
  toMessagesApiParams,
} from './wireParams';

const FULL: OptionSupport = {
  effort: ['low', 'medium', 'high', 'xhigh', 'max'],
  thinkingDisplay: ['omitted', 'summarized', 'updates'],
  speed: ['standard', 'fast'],
  inferenceGeo: ['us', 'global'],
};
const NOTHING: OptionSupport = { effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] };
const base = { optionSupport: FULL, requested: {}, maxTokens: 4096 } as const;

describe('buildWireParams', () => {
  it('adaptive + supported effort → adaptive thinking with that effort, never disabled', () => {
    expect(buildWireParams({ ...base, thinkingMode: 'adaptive', requested: { effort: 'medium' } })).toEqual({
      thinking: { type: 'adaptive' },
      effort: 'medium',
      betas: [],
      applied: { effort: 'medium' },
    });
  });

  it('adaptive + an effort the model lacks → effort omitted and not applied', () => {
    const wire = buildWireParams({ ...base, thinkingMode: 'adaptive', optionSupport: { ...FULL, effort: ['low', 'high'] }, requested: { effort: 'medium' } });
    expect(wire.thinking).toEqual({ type: 'adaptive' });
    expect('effort' in wire).toBe(false);
    expect(wire.applied).toEqual({});
  });

  it('display summarized is sent without a beta; updates adds the updates beta', () => {
    expect(buildWireParams({ ...base, thinkingMode: 'adaptive', requested: { thinkingDisplay: 'summarized' } }))
      .toMatchObject({ thinking: { type: 'adaptive', display: 'summarized' }, betas: [], applied: { thinkingDisplay: 'summarized' } });
    expect(buildWireParams({ ...base, thinkingMode: 'adaptive', requested: { thinkingDisplay: 'updates' } }))
      .toMatchObject({ thinking: { type: 'adaptive', display: 'updates' }, betas: [THINKING_DISPLAY_UPDATES_BETA] });
  });

  it('a display the model does not support is omitted', () => {
    const wire = buildWireParams({ ...base, thinkingMode: 'adaptive', optionSupport: NOTHING, requested: { thinkingDisplay: 'updates', effort: 'low' } });
    expect(wire).toEqual({ thinking: { type: 'adaptive' }, betas: [], applied: {} });
  });

  it('budget → thinking disabled and no effort, even when effort is requested (spec §7: separate concepts)', () => {
    expect(buildWireParams({ ...base, thinkingMode: 'budget', requested: { effort: 'medium' } })).toEqual({
      thinking: { type: 'disabled' },
      betas: [],
      applied: {},
    });
  });

  it.each(['none', 'unknown'] as const)('%s → no thinking param and no effort', (thinkingMode) => {
    expect(buildWireParams({ ...base, thinkingMode, requested: { effort: 'medium' } })).toEqual({ betas: [], applied: {} });
  });

  it('speed fast only where supported; adds the fast-mode beta and records it as applied', () => {
    expect(buildWireParams({ ...base, thinkingMode: 'adaptive', requested: { speed: 'fast' } }))
      .toMatchObject({ speed: 'fast', betas: [FAST_MODE_BETA], applied: { speed: 'fast' } });
    const unsupported = buildWireParams({ ...base, thinkingMode: 'adaptive', optionSupport: NOTHING, requested: { speed: 'fast' } });
    expect('speed' in unsupported).toBe(false);
    expect(unsupported.applied).toEqual({});
    expect(buildWireParams({ ...base, thinkingMode: 'adaptive', requested: { speed: 'standard' } }).applied).toEqual({ speed: 'standard' });
  });

  it('inference geo only when the model supports that value', () => {
    expect(buildWireParams({ ...base, thinkingMode: 'adaptive', inferenceGeo: 'us' }).inferenceGeo).toBe('us');
    expect('inferenceGeo' in buildWireParams({ ...base, thinkingMode: 'adaptive', inferenceGeo: 'eu' })).toBe(false);
    expect('inferenceGeo' in buildWireParams({ ...base, thinkingMode: 'adaptive', inferenceGeo: null })).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects maxTokens %s', (maxTokens) => {
    expect(() => buildWireParams({ ...base, thinkingMode: 'adaptive', maxTokens })).toThrow(RangeError);
  });

  it('returns fresh objects (callers may spread and mutate)', () => {
    const a = buildWireParams({ ...base, thinkingMode: 'adaptive', requested: { effort: 'low' } });
    const b = buildWireParams({ ...base, thinkingMode: 'adaptive', requested: { effort: 'low' } });
    expect(a).not.toBe(b);
    expect(a.betas).not.toBe(b.betas);
  });
});

describe('toAgentSdkOptions', () => {
  it('adaptive + effort → exactly the W00 shape', () => {
    const wire = buildWireParams({ ...base, thinkingMode: 'adaptive', requested: { effort: 'medium' } });
    expect(toAgentSdkOptions(wire)).toEqual({ thinking: { type: 'adaptive' }, effort: 'medium' });
  });

  it('adaptive without effort → no effort key', () => {
    const out = toAgentSdkOptions(buildWireParams({ ...base, thinkingMode: 'adaptive' }));
    expect(out).toEqual({ thinking: { type: 'adaptive' } });
    expect('effort' in out).toBe(false);
  });

  it('carries display summarized through', () => {
    const wire = buildWireParams({ ...base, thinkingMode: 'adaptive', requested: { thinkingDisplay: 'summarized' } });
    expect(toAgentSdkOptions(wire)).toEqual({ thinking: { type: 'adaptive', display: 'summarized' } });
  });

  // #7587: with NO thinking option the SDK CLI turns extended thinking ON for
  // Haiku 4.5 (~11x output tokens). Every non-adaptive mode is an explicit off.
  it.each(['budget', 'none', 'unknown'] as const)('%s → explicit thinking disabled, never omitted', (thinkingMode) => {
    const out = toAgentSdkOptions(buildWireParams({ ...base, thinkingMode, requested: { effort: 'medium' } }));
    expect(out).toEqual({ thinking: { type: 'disabled' } });
    expect('effort' in out).toBe(false);
  });

  it.each([
    ['thinkingDisplay:updates', { thinkingDisplay: 'updates' as const }, undefined],
    ['speed', { speed: 'fast' as const }, undefined],
    ['inferenceGeo', {}, 'us'],
  ])('refuses %s until the spike findings say the SDK carries it', (option, requested, inferenceGeo) => {
    const wire = buildWireParams({ ...base, thinkingMode: 'adaptive', requested, inferenceGeo });
    expect(() => toAgentSdkOptions(wire)).toThrow(UnsupportedWireOptionError);
    try {
      toAgentSdkOptions(wire);
    } catch (error) {
      expect((error as UnsupportedWireOptionError).option).toBe(option);
    }
  });
});

describe('toMessagesApiParams', () => {
  const adaptiveMedium = () => buildWireParams({ ...base, thinkingMode: 'adaptive', requested: { effort: 'medium' } });

  it('a model that thinks when the param is omitted → adaptive + output_config.effort (caps it)', () => {
    expect(toMessagesApiParams(adaptiveMedium(), { thinksWhenOmitted: true })).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
    });
  });

  // #7587: one-shots never sent a thinking param before; a model that does not
  // think by default (Opus/Sonnet 4.6–4.8) is never switched on here.
  it('a model that does not think when omitted → nothing', () => {
    expect(toMessagesApiParams(adaptiveMedium(), { thinksWhenOmitted: false })).toEqual({});
  });

  it('adaptive with no effort and no display → nothing (nothing to cap)', () => {
    expect(toMessagesApiParams(buildWireParams({ ...base, thinkingMode: 'adaptive' }), { thinksWhenOmitted: true })).toEqual({});
  });

  it.each(['budget', 'none', 'unknown'] as const)('%s → nothing (a one-shot never sends disabled)', (thinkingMode) => {
    expect(toMessagesApiParams(buildWireParams({ ...base, thinkingMode }), { thinksWhenOmitted: true })).toEqual({});
  });

  it('refuses speed like the Agent SDK adapter', () => {
    const wire = buildWireParams({ ...base, thinkingMode: 'adaptive', requested: { speed: 'fast' } });
    expect(() => toMessagesApiParams(wire, { thinksWhenOmitted: true })).toThrow(UnsupportedWireOptionError);
  });
});

// Reference behaviour a differential fuzz run found unpinned (orchestrator review, W01 #7599).
describe('reference behaviour pins', () => {
  it.each(['budget', 'none'] as const)('records an explicit standard speed in applied on a %s model', (thinkingMode) => {
    const wire = buildWireParams({
      thinkingMode,
      optionSupport: { effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] },
      requested: { speed: 'standard' },
      maxTokens: 1024,
    });
    expect(wire.applied).toEqual({ speed: 'standard' });
    expect(wire.speed).toBeUndefined();
  });
});

describe('buildWireParams: budget thinking (W05)', () => {
  const budgetSupport: OptionSupport = { effort: [], thinkingDisplay: ['omitted', 'summarized'], speed: ['standard'], inferenceGeo: [] };
  const base = { thinkingMode: 'budget' as const, optionSupport: budgetSupport };

  it('on → enabled with the default budget, applied on', () => {
    const w = buildWireParams({ ...base, requested: { budgetThinking: 'on' }, maxTokens: 64000 });
    expect(w.thinking).toEqual({ type: 'enabled', budget_tokens: BUDGET_THINKING_DEFAULT_TOKENS });
    expect(w.applied).toEqual({ budgetThinking: 'on' });
  });
  it('on → the budget stays below max_tokens', () => {
    const w = buildWireParams({ ...base, requested: { budgetThinking: 'on' }, maxTokens: 2000 });
    expect(w.thinking).toEqual({ type: 'enabled', budget_tokens: 1999 });
  });
  it('on, but max_tokens leaves less than the 1024 floor → disabled, nothing applied', () => {
    const w = buildWireParams({ ...base, requested: { budgetThinking: 'on' }, maxTokens: 1024 });
    expect(w.thinking).toEqual({ type: 'disabled' });
    expect(w.applied).toEqual({});
  });
  it('off → disabled, applied off', () => {
    const w = buildWireParams({ ...base, requested: { budgetThinking: 'off' }, maxTokens: 64000 });
    expect(w.thinking).toEqual({ type: 'disabled' });
    expect(w.applied).toEqual({ budgetThinking: 'off' });
  });
  it('absent → disabled (W00 parity: budget models run with thinking off)', () => {
    expect(buildWireParams({ ...base, requested: {}, maxTokens: 64000 }).thinking).toEqual({ type: 'disabled' });
  });
  it('an adaptive model ignores budgetThinking', () => {
    const w = buildWireParams({
      thinkingMode: 'adaptive',
      optionSupport: { effort: ['medium'], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] },
      requested: { budgetThinking: 'on', effort: 'medium' },
      maxTokens: 64000,
    });
    expect(w.thinking).toEqual({ type: 'adaptive' });
    expect(w.applied).toEqual({ effort: 'medium' });
  });
  it('toAgentSdkOptions carries the enabled budget', () => {
    const w = buildWireParams({ ...base, requested: { budgetThinking: 'on' }, maxTokens: 64000 });
    expect(toAgentSdkOptions(w)).toEqual({ thinking: { type: 'enabled', budgetTokens: BUDGET_THINKING_DEFAULT_TOKENS } });
  });
});
