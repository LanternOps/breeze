import { describe, expect, it } from 'vitest';
import {
  EFFORT_LEVELS,
  MODEL_LIFECYCLES,
  MODEL_SPEEDS,
  OPTION_RATE_KEYS,
  PROMPT_PROFILES,
  THINKING_DISPLAYS,
  emptyOptionSupport,
  modelRatesSchema,
  offeringOptionsSchema,
  optionRatesSchema,
  optionSupportSchema,
} from '../index';

const RATES = { inputCentsPerM: 200, outputCentsPerM: 1000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 250 };

describe('aiModelOptions literal sets', () => {
  it('pins the index contract literals', () => {
    expect(EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(THINKING_DISPLAYS).toEqual(['omitted', 'summarized', 'updates']);
    expect(MODEL_SPEEDS).toEqual(['standard', 'fast']);
    expect(PROMPT_PROFILES).toEqual(['claude-frontier', 'claude-standard', 'claude-small', 'generic']);
    expect(MODEL_LIFECYCLES).toEqual(['available', 'missing', 'retired']);
    expect(OPTION_RATE_KEYS).toEqual(['speed:fast']);
  });
});

describe('offeringOptionsSchema', () => {
  it('accepts the empty object and every single knob', () => {
    expect(offeringOptionsSchema.parse({})).toEqual({});
    expect(offeringOptionsSchema.parse({ effort: 'xhigh', thinkingDisplay: 'updates', speed: 'fast' }))
      .toEqual({ effort: 'xhigh', thinkingDisplay: 'updates', speed: 'fast' });
  });
  it('rejects unknown keys and unknown values', () => {
    expect(offeringOptionsSchema.safeParse({ effort: 'extreme' }).success).toBe(false);
    expect(offeringOptionsSchema.safeParse({ budgetTokens: 2048 }).success).toBe(false);
  });
});

describe('optionSupportSchema', () => {
  it('accepts the empty default', () => {
    expect(optionSupportSchema.parse(emptyOptionSupport())).toEqual({
      effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [],
    });
  });
  it('requires standard speed, unique values and lowercase geo tokens', () => {
    expect(optionSupportSchema.safeParse({ effort: [], thinkingDisplay: [], speed: ['fast'], inferenceGeo: [] }).success).toBe(false);
    expect(optionSupportSchema.safeParse({ effort: ['low', 'low'], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] }).success).toBe(false);
    expect(optionSupportSchema.safeParse({ effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: ['EU West'] }).success).toBe(false);
    expect(optionSupportSchema.safeParse({ effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: ['us', 'global'] }).success).toBe(true);
  });
  it('emptyOptionSupport returns a fresh object each call', () => {
    const a = emptyOptionSupport();
    a.effort.push('low');
    expect(emptyOptionSupport().effort).toEqual([]);
  });
});

describe('modelRatesSchema / optionRatesSchema', () => {
  it('accepts non-negative finite rates, including fractional cents and 0', () => {
    expect(modelRatesSchema.parse({ ...RATES, cacheReadCentsPerM: 2.5 })).toEqual({ ...RATES, cacheReadCentsPerM: 2.5 });
    expect(modelRatesSchema.parse({ inputCentsPerM: 0, outputCentsPerM: 0, cacheReadCentsPerM: 0, cacheWriteCentsPerM: 0 })).toBeTruthy();
  });
  it('rejects a missing component, a negative rate, and an unknown option key', () => {
    expect(modelRatesSchema.safeParse({ inputCentsPerM: 1, outputCentsPerM: 1, cacheReadCentsPerM: 1 }).success).toBe(false);
    expect(modelRatesSchema.safeParse({ ...RATES, inputCentsPerM: -1 }).success).toBe(false);
    expect(optionRatesSchema.safeParse({ 'speed:turbo': RATES }).success).toBe(false);
    expect(optionRatesSchema.parse({ 'speed:fast': RATES })).toEqual({ 'speed:fast': RATES });
  });
});
