import { describe, expect, it } from 'vitest';
import { deriveCapabilities, deriveOptionSupport, optionSupportErrors } from '../capabilities';
import { computeInvocationCents, platformRateSnapshot } from '../pricing';
import {
  PARITY_TOKEN_VECTORS,
  SEEDED_PLATFORM_MODELS,
  W00_MODEL_PRICING,
  W00_OFFERABLE_AI_MODELS,
  w00CalculateCostCents,
} from './seededPlatformModels';

describe('seeded platform models (fixture self-consistency)', () => {
  it('seeds exactly the W00 priced ids', () => {
    expect(SEEDED_PLATFORM_MODELS.map((m) => m.modelId).sort()).toEqual(Object.keys(W00_MODEL_PRICING).sort());
  });

  it('offers exactly the W00 offerable ids, with Sonnet 5.5 the only default', () => {
    expect(SEEDED_PLATFORM_MODELS.filter((m) => m.platformOffered).map((m) => m.modelId).sort())
      .toEqual([...W00_OFFERABLE_AI_MODELS].sort());
    expect(SEEDED_PLATFORM_MODELS.filter((m) => m.isPlatformDefault).map((m) => m.modelId)).toEqual(['claude-sonnet-5-5']);
  });

  it('every seeded rate prices every parity vector exactly as W00 did', () => {
    for (const model of SEEDED_PLATFORM_MODELS) {
      const rate = platformRateSnapshot(model);
      expect(rate, model.modelId).not.toBeNull();
      for (const [input, output, cacheRead, cacheWrite] of PARITY_TOKEN_VECTORS) {
        const cents = Math.round(computeInvocationCents(rate!, { input, output, cacheRead, cacheWrite }, {}) * 100) / 100;
        expect(cents, `${model.modelId} ${[input, output, cacheRead, cacheWrite].join('/')}`)
          .toBe(w00CalculateCostCents(model.modelId, input, output, cacheRead, cacheWrite));
      }
    }
  });

  it('seeded option support stays within what the seeded capabilities allow', () => {
    for (const model of SEEDED_PLATFORM_MODELS) {
      const derived = deriveCapabilities(model.capabilities);
      expect(optionSupportErrors(derived, model.optionSupport), model.modelId).toEqual([]);
      expect(model.optionSupport.effort, model.modelId).toEqual(deriveOptionSupport(derived).effort);
      expect(model.optionSupport.inferenceGeo, model.modelId).toEqual([]);
    }
  });

  it('seeded capabilities derive to the W00 thinking classes (adaptive for Fable and Opus/Sonnet 4.6+, budget otherwise)', () => {
    const modes = Object.fromEntries(SEEDED_PLATFORM_MODELS.map((m) => [m.modelId, deriveCapabilities(m.capabilities).thinkingMode]));
    expect(modes).toEqual({
      'claude-sonnet-5-5': 'adaptive',
      'claude-opus-5-5': 'adaptive',
      'claude-fable-5-1': 'adaptive',
      'claude-opus-4-8': 'adaptive',
      'claude-sonnet-4-6': 'adaptive',
      'claude-haiku-4-5': 'budget',
      'claude-haiku-4-5-20251001': 'budget',
      'claude-fable-5': 'adaptive',
      'claude-sonnet-4-5': 'budget',
      'claude-sonnet-4-5-20250929': 'budget',
    });
  });
});
