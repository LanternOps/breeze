import { describe, expect, it } from 'vitest';
import type { PlatformModel } from './platformModels';
import { PlatformModelError, validatePlatformModelAdminPatch, type PlatformModelAdminPatch } from './platformModelAdmin';

const RATES = { inputCentsPerM: 400, outputCentsPerM: 2000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 500 };
const ADAPTIVE = {
  thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } },
  effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: false }, max: { supported: true } },
};

function model(over: Partial<PlatformModel> = {}): PlatformModel {
  const at = new Date('2026-11-13T00:00:00.000Z');
  return {
    id: 'id-a', provider: 'anthropic', modelId: 'model-a', displayName: 'A', maxInputTokens: null, maxOutputTokens: null,
    capabilities: ADAPTIVE, rates: RATES, optionRates: null,
    optionSupport: { effort: ['low', 'medium', 'high', 'max'], thinkingDisplay: ['omitted', 'summarized'], speed: ['standard'], inferenceGeo: [] },
    minPlan: null, promptProfile: 'claude-standard', platformOffered: true, isPlatformDefault: false, lifecycle: 'available',
    missedSyncCount: 0, operatorNotifiedAt: null, firstSeenAt: at, lastSeenAt: at, updatedAt: at, ...over,
  };
}

function rejection(current: PlatformModel, patch: PlatformModelAdminPatch): { status: number; message: string } {
  try {
    validatePlatformModelAdminPatch(current, patch);
  } catch (error) {
    if (error instanceof PlatformModelError) return { status: error.status, message: error.message };
    throw error;
  }
  throw new Error('expected a PlatformModelError');
}

describe('validatePlatformModelAdminPatch', () => {
  it('applies a partial patch over the current state', () => {
    expect(validatePlatformModelAdminPatch(model(), { minPlan: 'pro', promptProfile: 'claude-frontier' })).toEqual({
      rates: RATES,
      optionRates: null,
      optionSupport: model().optionSupport,
      minPlan: 'pro',
      promptProfile: 'claude-frontier',
      platformOffered: true,
      isPlatformDefault: false,
    });
  });

  it('allows promoting an offered, available model to default', () => {
    expect(validatePlatformModelAdminPatch(model(), { isPlatformDefault: true }).isPlatformDefault).toBe(true);
  });

  it.each([
    ['offering an unpriced model', model({ rates: null, platformOffered: false }), { platformOffered: true }, 400, 'Set all four prices before offering this model.'],
    ['clearing the prices of an offered model', model(), { rates: null }, 400, 'Set all four prices before offering this model.'],
    ['offering a retired model', model({ platformOffered: false, lifecycle: 'retired' }), { platformOffered: true }, 400, 'A retired model cannot be offered.'],
    ['un-defaulting the current default', model({ isPlatformDefault: true }), { isPlatformDefault: false }, 409, 'This model is the platform default. Make another model the default first.'],
    ['un-offering the current default', model({ isPlatformDefault: true }), { platformOffered: false }, 409, 'The platform default must stay offered. Make another model the default first.'],
    ['defaulting an unoffered model', model({ platformOffered: false }), { isPlatformDefault: true }, 400, 'Only an offered, available model can be the platform default.'],
    ['defaulting a missing model', model({ lifecycle: 'missing' }), { isPlatformDefault: true }, 400, 'Only an offered, available model can be the platform default.'],
    ['an effort level the model lacks', model(), { optionSupport: { effort: ['xhigh'], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] } }, 400, 'Effort "xhigh" is not supported by this model.'],
  ] as const)('rejects %s', (_label, current, patch, status, message) => {
    expect(rejection(current, patch as PlatformModelAdminPatch)).toEqual({ status, message });
  });

  it('allows a fast rate without fast support and fast support without a rate (an unpriced variant is simply unselectable, spec §8)', () => {
    expect(() => validatePlatformModelAdminPatch(model(), { optionRates: { 'speed:fast': RATES } })).not.toThrow();
    expect(() => validatePlatformModelAdminPatch(model(), {
      optionSupport: { ...model().optionSupport, speed: ['standard', 'fast'] },
    })).not.toThrow();
  });
});
