// apps/api/src/services/aiModels/__fixtures__/seededPlatformModels.ts
/**
 * AI model registry W01 (#7599) test oracles.
 *
 * - SEEDED_PLATFORM_MODELS mirrors 2026-11-13-100100-ai-platform-models-seed.sql
 *   row for row. aiPlatformModels.integration.test.ts proves the DB matches.
 * - W00_* are FROZEN copies of #7593's MODEL_PRICING / OFFERABLE_AI_MODELS /
 *   calculateCostCents. Parity tests compare the registry against them, so
 *   they must never be "updated" to match new behaviour.
 */
import type { OptionSupport, PromptProfile } from '@breeze/shared';
import type { PlatformModel } from '../platformModels';

const SEEDED_AT = new Date('2026-11-13T10:01:00.000Z');

const yes = { supported: true } as const;
const no = { supported: false } as const;
export const SEED_CAPS_ADAPTIVE_FULL = {
  thinking: { supported: true, types: { adaptive: yes, enabled: no } },
  effort: { supported: true, low: yes, medium: yes, high: yes, xhigh: yes, max: yes },
  image_input: yes,
};
export const SEED_CAPS_ADAPTIVE_NO_XHIGH = {
  thinking: { supported: true, types: { adaptive: yes, enabled: yes } },
  effort: { supported: true, low: yes, medium: yes, high: yes, xhigh: no, max: yes },
  image_input: yes,
};
export const SEED_CAPS_BUDGET_ONLY = {
  thinking: { supported: true, types: { adaptive: no, enabled: yes } },
  effort: { supported: false, low: no, medium: no, high: no, xhigh: no, max: no },
  image_input: yes,
};

const EFFORT_ALL = ['low', 'medium', 'high', 'xhigh', 'max'] as OptionSupport['effort'];
const support = (over: Partial<OptionSupport>): OptionSupport => ({
  effort: [], thinkingDisplay: ['omitted', 'summarized'], speed: ['standard'], inferenceGeo: [], ...over,
});

function seeded(input: {
  modelId: string;
  displayName: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  capabilities: unknown;
  rates: [number, number, number, number];
  optionSupport: OptionSupport;
  promptProfile: PromptProfile;
  platformOffered: boolean;
  isPlatformDefault?: boolean;
}): PlatformModel {
  const [inputCentsPerM, outputCentsPerM, cacheReadCentsPerM, cacheWriteCentsPerM] = input.rates;
  return {
    id: `seed:${input.modelId}`,
    provider: 'anthropic',
    modelId: input.modelId,
    displayName: input.displayName,
    maxInputTokens: input.maxInputTokens,
    maxOutputTokens: input.maxOutputTokens,
    capabilities: input.capabilities,
    rates: { inputCentsPerM, outputCentsPerM, cacheReadCentsPerM, cacheWriteCentsPerM },
    optionRates: null,
    optionSupport: input.optionSupport,
    minPlan: null,
    promptProfile: input.promptProfile,
    platformOffered: input.platformOffered,
    isPlatformDefault: input.isPlatformDefault ?? false,
    lifecycle: 'available',
    missedSyncCount: 0,
    operatorNotifiedAt: SEEDED_AT,
    firstSeenAt: SEEDED_AT,
    lastSeenAt: null,
    updatedAt: SEEDED_AT,
  };
}

export const SEEDED_PLATFORM_MODELS: readonly PlatformModel[] = Object.freeze([
  seeded({ modelId: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', maxInputTokens: 1_000_000, maxOutputTokens: 128_000, capabilities: SEED_CAPS_ADAPTIVE_FULL, rates: [200, 1000, 20, 250], optionSupport: support({ effort: EFFORT_ALL, thinkingDisplay: ['omitted', 'summarized', 'updates'] }), promptProfile: 'claude-standard', platformOffered: true, isPlatformDefault: true }),
  seeded({ modelId: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', maxInputTokens: 1_000_000, maxOutputTokens: 128_000, capabilities: SEED_CAPS_ADAPTIVE_FULL, rates: [400, 2000, 20, 500], optionSupport: support({ effort: EFFORT_ALL, thinkingDisplay: ['omitted', 'summarized', 'updates'], speed: ['standard', 'fast'] }), promptProfile: 'claude-frontier', platformOffered: true }),
  seeded({ modelId: 'claude-fable-5-1', displayName: 'Claude Fable 5.1', maxInputTokens: 1_000_000, maxOutputTokens: 128_000, capabilities: SEED_CAPS_ADAPTIVE_FULL, rates: [1000, 5000, 25, 1250], optionSupport: support({ effort: EFFORT_ALL, thinkingDisplay: ['omitted', 'summarized', 'updates'] }), promptProfile: 'claude-frontier', platformOffered: true }),
  seeded({ modelId: 'claude-opus-4-8', displayName: 'Claude Opus 4.8', maxInputTokens: 1_000_000, maxOutputTokens: 128_000, capabilities: SEED_CAPS_ADAPTIVE_FULL, rates: [500, 2500, 50, 625], optionSupport: support({ effort: EFFORT_ALL, speed: ['standard', 'fast'] }), promptProfile: 'claude-standard', platformOffered: true }),
  seeded({ modelId: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', maxInputTokens: 1_000_000, maxOutputTokens: 128_000, capabilities: SEED_CAPS_ADAPTIVE_NO_XHIGH, rates: [300, 1500, 30, 375], optionSupport: support({ effort: ['low', 'medium', 'high', 'max'] }), promptProfile: 'claude-standard', platformOffered: true }),
  seeded({ modelId: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', maxInputTokens: 200_000, maxOutputTokens: 64_000, capabilities: SEED_CAPS_BUDGET_ONLY, rates: [100, 500, 10, 125], optionSupport: support({}), promptProfile: 'claude-small', platformOffered: true }),
  seeded({ modelId: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5 (2025-10-01)', maxInputTokens: 200_000, maxOutputTokens: 64_000, capabilities: SEED_CAPS_BUDGET_ONLY, rates: [100, 500, 10, 125], optionSupport: support({}), promptProfile: 'claude-small', platformOffered: false }),
  seeded({ modelId: 'claude-fable-5', displayName: 'Claude Fable 5', maxInputTokens: 1_000_000, maxOutputTokens: 128_000, capabilities: SEED_CAPS_ADAPTIVE_FULL, rates: [1000, 5000, 100, 1250], optionSupport: support({ effort: EFFORT_ALL }), promptProfile: 'claude-frontier', platformOffered: true }),
  seeded({ modelId: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5', maxInputTokens: 200_000, maxOutputTokens: 64_000, capabilities: SEED_CAPS_BUDGET_ONLY, rates: [300, 1500, 30, 375], optionSupport: support({}), promptProfile: 'claude-standard', platformOffered: false }),
  seeded({ modelId: 'claude-sonnet-4-5-20250929', displayName: 'Claude Sonnet 4.5 (2025-09-29)', maxInputTokens: 200_000, maxOutputTokens: 64_000, capabilities: SEED_CAPS_BUDGET_ONLY, rates: [300, 1500, 30, 375], optionSupport: support({}), promptProfile: 'claude-standard', platformOffered: false }),
]);

export function seededPlatformModel(modelId: string): PlatformModel {
  const model = SEEDED_PLATFORM_MODELS.find((m) => m.modelId === modelId);
  if (!model) throw new Error(`no seeded platform model "${modelId}"`);
  return model;
}

/** FROZEN: #7593 aiCostTracker.ts MODEL_PRICING (cents per MTok). */
export const W00_MODEL_PRICING: Readonly<Record<string, { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion?: number }>> = Object.freeze({
  'claude-sonnet-5-5': { inputPerMillion: 200, outputPerMillion: 1000 },
  'claude-opus-5-5': { inputPerMillion: 400, outputPerMillion: 2000, cacheReadPerMillion: 20 },
  'claude-fable-5-1': { inputPerMillion: 1000, outputPerMillion: 5000, cacheReadPerMillion: 25 },
  'claude-opus-4-8': { inputPerMillion: 500, outputPerMillion: 2500 },
  'claude-sonnet-4-6': { inputPerMillion: 300, outputPerMillion: 1500 },
  'claude-haiku-4-5': { inputPerMillion: 100, outputPerMillion: 500 },
  'claude-haiku-4-5-20251001': { inputPerMillion: 100, outputPerMillion: 500 },
  'claude-fable-5': { inputPerMillion: 1000, outputPerMillion: 5000 },
  'claude-sonnet-4-5': { inputPerMillion: 300, outputPerMillion: 1500 },
  'claude-sonnet-4-5-20250929': { inputPerMillion: 300, outputPerMillion: 1500 },
});

/** FROZEN: #7593 aiOfferableModels.ts OFFERABLE_AI_MODELS. */
export const W00_OFFERABLE_AI_MODELS: readonly string[] = Object.freeze([
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-fable-5-1',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-fable-5',
]);

/** FROZEN: #7593 calculateCostCents, including the DEFAULT_PRICING fallback. */
export function w00CalculateCostCents(model: string, input: number, output: number, cacheRead = 0, cacheWrite = 0): number {
  const pricing = W00_MODEL_PRICING[model] ?? { inputPerMillion: 500, outputPerMillion: 2500 };
  const inputCost = (input / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (output / 1_000_000) * pricing.outputPerMillion;
  const cacheReadCost = (cacheRead / 1_000_000) * (pricing.cacheReadPerMillion ?? pricing.inputPerMillion * 0.1);
  const cacheWriteCost = (cacheWrite / 1_000_000) * pricing.inputPerMillion * 1.25;
  return Math.round((inputCost + outputCost + cacheReadCost + cacheWriteCost) * 100) / 100;
}

/** [input, output, cacheRead, cacheWrite] vectors used by every price-parity test. */
export const PARITY_TOKEN_VECTORS: ReadonlyArray<readonly [number, number, number, number]> = Object.freeze([
  [0, 0, 0, 0],
  [1_000_000, 0, 0, 0],
  [0, 1_000_000, 0, 0],
  [0, 0, 1_000_000, 0],
  [0, 0, 0, 1_000_000],
  [1_234, 567, 89_000, 4_321],
  [250_000, 12_345, 3_000_000, 50_000],
  [7, 13, 0, 0],
]);
