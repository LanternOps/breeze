import { describe, expect, it } from 'vitest';
import type { OptionSupport } from '@breeze/shared';
import {
  deriveCapabilities,
  deriveOptionSupport,
  mergeDiscoveredOptionSupport,
  optionSupportErrors,
} from './capabilities';

const yes = { supported: true };
const no = { supported: false };
const effortTree = (levels: Record<string, boolean>) => ({
  supported: Object.values(levels).some(Boolean),
  low: { supported: !!levels.low },
  medium: { supported: !!levels.medium },
  high: { supported: !!levels.high },
  xhigh: { supported: !!levels.xhigh },
  max: { supported: !!levels.max },
});
const ADAPTIVE_FULL = {
  thinking: { supported: true, types: { adaptive: yes, enabled: no } },
  effort: effortTree({ low: true, medium: true, high: true, xhigh: true, max: true }),
  image_input: yes,
};
const ADAPTIVE_NO_XHIGH = {
  thinking: { supported: true, types: { adaptive: yes, enabled: yes } },
  effort: effortTree({ low: true, medium: true, high: true, xhigh: false, max: true }),
  image_input: yes,
};
const BUDGET_ONLY = {
  thinking: { supported: true, types: { adaptive: no, enabled: yes } },
  effort: effortTree({}),
  image_input: yes,
};
const NO_THINKING = {
  thinking: { supported: false, types: { adaptive: no, enabled: no } },
  effort: effortTree({}),
  image_input: no,
};

describe('deriveCapabilities', () => {
  it.each([
    ['adaptive, every effort level', ADAPTIVE_FULL, 'adaptive', ['low', 'medium', 'high', 'xhigh', 'max'], true],
    ['adaptive wins over enabled (Sonnet 4.6 shape), no xhigh', ADAPTIVE_NO_XHIGH, 'adaptive', ['low', 'medium', 'high', 'max'], true],
    ['enabled only (Haiku 4.5 shape)', BUDGET_ONLY, 'budget', [], true],
    ['neither', NO_THINKING, 'none', [], false],
  ] as const)('%s', (_label, raw, mode, effort, vision) => {
    expect(deriveCapabilities(raw)).toEqual({
      thinkingMode: mode,
      effortLevels: effort,
      supportsTools: true,
      supportsVision: vision,
    });
  });

  it.each([
    ['null', null],
    ['a string', 'adaptive'],
    ['an array', []],
    ['a tree without thinking', { effort: effortTree({ low: true }) }],
    ['thinking supported but no types', { thinking: { supported: true } }],
  ])('%s → unknown with no tools, no effort and no vision', (_label, raw) => {
    expect(deriveCapabilities(raw)).toEqual({
      thinkingMode: 'unknown',
      effortLevels: [],
      supportsTools: false,
      supportsVision: false,
    });
  });

  it('thinking.supported=false with no types → none', () => {
    expect(deriveCapabilities({ thinking: { supported: false } }).thinkingMode).toBe('none');
  });

  // Spike D4: an explicit tools leaf, should the Models API ever add one, wins.
  it('an explicit tool_use leaf overrides the default', () => {
    expect(deriveCapabilities({ ...ADAPTIVE_FULL, tool_use: no }).supportsTools).toBe(false);
  });

  it('only reports effort levels whose leaf is supported:true, and none when effort.supported is false', () => {
    expect(deriveCapabilities({ ...ADAPTIVE_FULL, effort: { ...effortTree({ low: true }), supported: false } }).effortLevels).toEqual([]);
    expect(deriveCapabilities({ ...ADAPTIVE_FULL, effort: { supported: true, low: yes, medium: 'yes' } }).effortLevels).toEqual(['low']);
  });

  it('returns a fresh object per call', () => {
    const a = deriveCapabilities(ADAPTIVE_FULL);
    a.effortLevels.push('low');
    expect(deriveCapabilities(ADAPTIVE_FULL).effortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
});

describe('deriveOptionSupport', () => {
  it('adaptive → effort levels + omitted/summarized; budget → display only; none/unknown → nothing', () => {
    expect(deriveOptionSupport(deriveCapabilities(ADAPTIVE_NO_XHIGH))).toEqual({
      effort: ['low', 'medium', 'high', 'max'], thinkingDisplay: ['omitted', 'summarized'], speed: ['standard'], inferenceGeo: [],
    });
    expect(deriveOptionSupport(deriveCapabilities(BUDGET_ONLY))).toEqual({
      effort: [], thinkingDisplay: ['omitted', 'summarized'], speed: ['standard'], inferenceGeo: [],
    });
    expect(deriveOptionSupport(deriveCapabilities(NO_THINKING))).toEqual({
      effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [],
    });
    expect(deriveOptionSupport(deriveCapabilities(null))).toEqual({
      effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [],
    });
  });
});

describe('mergeDiscoveredOptionSupport', () => {
  const operatorSet: OptionSupport = {
    effort: ['medium'],
    thinkingDisplay: ['omitted', 'summarized', 'updates'],
    speed: ['standard', 'fast'],
    inferenceGeo: ['us'],
  };

  it('takes effort from the API and keeps operator-set updates, fast and geo on an adaptive model', () => {
    expect(mergeDiscoveredOptionSupport(operatorSet, deriveCapabilities(ADAPTIVE_FULL))).toEqual({
      effort: ['low', 'medium', 'high', 'xhigh', 'max'],
      thinkingDisplay: ['omitted', 'summarized', 'updates'],
      speed: ['standard', 'fast'],
      inferenceGeo: ['us'],
    });
  });

  it('drops updates when the model is no longer adaptive', () => {
    expect(mergeDiscoveredOptionSupport(operatorSet, deriveCapabilities(BUDGET_ONLY)).thinkingDisplay)
      .toEqual(['omitted', 'summarized']);
  });
});

describe('optionSupportErrors', () => {
  const support = (over: Partial<OptionSupport>): OptionSupport => ({
    effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [], ...over,
  });

  it('accepts a subset of the derived support', () => {
    expect(optionSupportErrors(deriveCapabilities(ADAPTIVE_NO_XHIGH), support({ effort: ['low', 'max'], thinkingDisplay: ['updates'] }))).toEqual([]);
  });

  it.each([
    ['an effort level the model lacks', ADAPTIVE_NO_XHIGH, { effort: ['xhigh'] }, 'Effort "xhigh" is not supported by this model.'],
    ['effort on a budget model', BUDGET_ONLY, { effort: ['low'] }, 'Effort applies only to models with adaptive thinking.'],
    ['updates on a budget model', BUDGET_ONLY, { thinkingDisplay: ['updates'] }, 'Thinking display "updates" needs adaptive thinking.'],
    ['display on a model that does not think', NO_THINKING, { thinkingDisplay: ['omitted'] }, 'Thinking display applies only to models that think.'],
  ] as const)('rejects %s', (_label, raw, over, message) => {
    expect(optionSupportErrors(deriveCapabilities(raw), support(over as unknown as Partial<OptionSupport>))).toEqual([message]);
  });
});

// Reference behaviour a differential fuzz run found unpinned (orchestrator review, W01 #7599).
describe('reference behaviour pins', () => {
  const ADAPTIVE_TREE = { thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } } };
  const BUDGET_TREE = { thinking: { supported: true, types: { adaptive: { supported: false }, enabled: { supported: true } } } };

  it('an explicit tools leaf set to false gives supportsTools false', () => {
    expect(deriveCapabilities({ ...ADAPTIVE_TREE, tools: { supported: false } }).supportsTools).toBe(false);
  });

  it('mergeDiscoveredOptionSupport always keeps standard speed', () => {
    const merged = mergeDiscoveredOptionSupport(
      { effort: [], thinkingDisplay: [], speed: ['fast'] as unknown as OptionSupport['speed'], inferenceGeo: [] },
      deriveCapabilities(BUDGET_TREE),
    );
    expect(merged.speed).toEqual(['standard', 'fast']);
  });

  it('optionSupportErrors reports one message per category, not per offending level', () => {
    expect(optionSupportErrors(
      deriveCapabilities({ thinking: { supported: false } }),
      { effort: ['low', 'medium', 'xhigh'], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] },
    )).toEqual(['Effort applies only to models with adaptive thinking.']);
  });
});
