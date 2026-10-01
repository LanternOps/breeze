import { beforeEach, describe, expect, it } from 'vitest';
import { seededPlatformModel, W00_MODEL_PRICING } from './__fixtures__/seededPlatformModels';
import { clearPlatformModelSnapshot, setPlatformModelSnapshot } from './platformModelSnapshot';
import {
  EXTENSION_AI_DEFAULT_MODEL,
  getLegacyModelRates,
  LEGACY_MODEL_RATES,
  legacyAgentModel,
  legacyExtensionModel,
  legacyOfficeChatModel,
  legacyReviewerModel,
} from './legacySurfaceModels';

describe('legacy surface model pickers (#7600 W02)', () => {
  it.each([
    [[], 'claude-sonnet-5-5', 'claude-sonnet-5-5'],
    [['claude-haiku-4-5'], 'claude-sonnet-5-5', 'claude-haiku-4-5'],
    [['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'], 'claude-sonnet-5-5', 'claude-sonnet-4-5-20250929'],
  ])('office chat: allowedModels %j over %s → %s', (allowed, resolved, expected) => {
    expect(legacyOfficeChatModel(allowed, resolved)).toBe(expected);
  });

  it('extension: caller model wins, then WORKSPACE_CONTENT_LLM_MODEL, then Haiku', () => {
    expect(legacyExtensionModel('claude-opus-5-5', { WORKSPACE_CONTENT_LLM_MODEL: 'x' })).toBe('claude-opus-5-5');
    expect(legacyExtensionModel(undefined, { WORKSPACE_CONTENT_LLM_MODEL: 'claude-sonnet-4-6' })).toBe('claude-sonnet-4-6');
    expect(legacyExtensionModel(undefined, {})).toBe(EXTENSION_AI_DEFAULT_MODEL);
    expect(EXTENSION_AI_DEFAULT_MODEL).toBe('claude-haiku-4-5');
  });

  it('extension: an empty env value is kept, exactly as the legacy `??` chain did', () => {
    expect(legacyExtensionModel(undefined, { WORKSPACE_CONTENT_LLM_MODEL: '' })).toBe('');
  });

  it('reviewer: the effective policy model wins over the env/platform reviewer default', () => {
    expect(legacyReviewerModel('claude-opus-5-5', 'claude-sonnet-5-5')).toBe('claude-opus-5-5');
    expect(legacyReviewerModel(null, 'claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
  });

  it('agents: the merged policy model wins over the resolved partner default', () => {
    expect(legacyAgentModel('claude-haiku-4-5', 'claude-sonnet-5-5')).toBe('claude-haiku-4-5');
    expect(legacyAgentModel(null, 'claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
  });
});

// Moved from aiCostTracker.ts in W03 Task 17 (plan R4): projection-only
// pricing for the per-partner cutover, never billing. W08 deletes it.
describe('getLegacyModelRates (#7600 W02, moved in #7601)', () => {
  beforeEach(() => clearPlatformModelSnapshot()); // cold snapshot → the frozen table, deterministic

  it('the frozen table is exactly W00 MODEL_PRICING', () => {
    expect(LEGACY_MODEL_RATES).toEqual(W00_MODEL_PRICING);
  });

  it('returns the frozen rates with the standard cache multipliers', () => {
    expect(getLegacyModelRates('claude-sonnet-5-5')).toEqual({
      source: 'priced',
      rates: { inputCentsPerM: 200, outputCentsPerM: 1000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 250 },
    });
  });

  it('honours a per-model cache-read override', () => {
    expect(getLegacyModelRates('claude-opus-5-5').rates.cacheReadCentsPerM).toBe(20);
    expect(getLegacyModelRates('claude-fable-5-1').rates.cacheReadCentsPerM).toBe(25);
  });

  it.each(['my-gateway-model', 'constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'falls back to the legacy default for an unknown or prototype-named id (%s)',
    (model) => {
      expect(getLegacyModelRates(model)).toEqual({
        source: 'default_pricing',
        rates: { inputCentsPerM: 500, outputCentsPerM: 2500, cacheReadCentsPerM: 50, cacheWriteCentsPerM: 625 },
      });
    },
  );

  it('a loaded platform row wins over the frozen table (the legacy resolution order)', () => {
    setPlatformModelSnapshot([{ ...seededPlatformModel('claude-opus-4-8'),
      rates: { inputCentsPerM: 450, outputCentsPerM: 2250, cacheReadCentsPerM: 45, cacheWriteCentsPerM: 560 } }]);
    expect(getLegacyModelRates('claude-opus-4-8')).toEqual({
      source: 'priced',
      rates: { inputCentsPerM: 450, outputCentsPerM: 2250, cacheReadCentsPerM: 45, cacheWriteCentsPerM: 560 },
    });
  });

  it('an unpriced platform row falls through to the frozen table', () => {
    setPlatformModelSnapshot([{ ...seededPlatformModel('claude-haiku-4-5'), rates: null }]);
    expect(getLegacyModelRates('claude-haiku-4-5').rates.inputCentsPerM).toBe(100);
  });
});
