import { describe, expect, it } from 'vitest';
import { aiUsageRequestFields, normalizeAiUsage, showUsdOnlyWarning, validateAiUsage, type AiUsageValue } from './aiUsagePricing';

const row = (over: Partial<AiUsageValue['aiRates'][number]> = {}) => ({
  modelId: 'claude-sonnet-4-5', inputPricePerM: '3.00', outputPricePerM: '15.00', cacheReadPricePerM: '0.30', cacheWritePricePerM: '3.75', ...over,
});
const billable = (over: Partial<AiUsageValue> = {}): AiUsageValue => ({ aiCoverage: 'billable', aiMarkupPercent: null, aiRates: [], ...over });

describe('normalizeAiUsage', () => {
  it('defaults a legacy profile with no AI fields to non_billable', () => {
    expect(normalizeAiUsage(undefined)).toEqual({ aiCoverage: 'non_billable', aiMarkupPercent: null, aiRates: [] });
    expect(normalizeAiUsage({})).toEqual({ aiCoverage: 'non_billable', aiMarkupPercent: null, aiRates: [] });
  });
  it('copies rows so edits never mutate the loaded profile', () => {
    const source = { aiCoverage: 'billable' as const, aiMarkupPercent: '25.00', aiRates: [row()] };
    const copy = normalizeAiUsage(source);
    copy.aiRates[0].modelId = 'changed';
    expect(source.aiRates[0].modelId).toBe('claude-sonnet-4-5');
  });
});

describe('validateAiUsage', () => {
  it('accepts blank markup and a complete row', () => {
    expect(validateAiUsage(billable({ aiRates: [row()] })).valid).toBe(true);
    expect(validateAiUsage(billable()).valid).toBe(true);
  });
  it.each(['abc', '-1', '1000.01', '12345', '1.234', '25%'])('rejects markup %s', (aiMarkupPercent) => {
    const result = validateAiUsage(billable({ aiMarkupPercent }));
    expect(result.markupInvalid).toBe(true);
    expect(result.valid).toBe(false);
  });
  it.each(['0', '25', '25.5', '1000', '1000.00', '0.01'])('accepts markup %s', (aiMarkupPercent) => {
    expect(validateAiUsage(billable({ aiMarkupPercent })).markupInvalid).toBe(false);
  });
  it('ignores markup and rows when coverage is not billable', () => {
    expect(validateAiUsage({ aiCoverage: 'included', aiMarkupPercent: 'abc', aiRates: [row({ modelId: '' })] }).valid).toBe(true);
  });
  it('flags empty model ids, bad prices, and missing prices', () => {
    expect(validateAiUsage(billable({ aiRates: [row({ modelId: '  ' })] })).rows[0].invalid).toBe(true);
    expect(validateAiUsage(billable({ aiRates: [row({ inputPricePerM: '' })] })).rows[0].invalid).toBe(true);
    expect(validateAiUsage(billable({ aiRates: [row({ outputPricePerM: '1.1234567' })] })).rows[0].invalid).toBe(true);
    expect(validateAiUsage(billable({ aiRates: [row({ cacheReadPricePerM: '123456789' })] })).rows[0].invalid).toBe(true);
    expect(validateAiUsage(billable({ aiRates: [row({ cacheWritePricePerM: '0' })] })).rows[0].invalid).toBe(false);
  });
  it('flags duplicate model ids on the second occurrence only', () => {
    const result = validateAiUsage(billable({ aiRates: [row(), row()] }));
    expect(result.rows.map((r) => r.duplicate)).toEqual([false, true]);
    expect(result.valid).toBe(false);
  });
});

describe('aiUsageRequestFields', () => {
  it('trims model ids, keeps notes only when set, and never sends markup/rows for non-billable cards', () => {
    expect(aiUsageRequestFields(billable({ aiMarkupPercent: '25', aiRates: [row({ modelId: ' claude-sonnet-4-5 ', notes: 'x' }), row({ modelId: 'b', notes: null })] }))).toEqual({
      aiCoverage: 'billable', aiMarkupPercent: '25',
      aiRates: [
        { modelId: 'claude-sonnet-4-5', inputPricePerM: '3.00', outputPricePerM: '15.00', cacheReadPricePerM: '0.30', cacheWritePricePerM: '3.75', notes: 'x' },
        { modelId: 'b', inputPricePerM: '3.00', outputPricePerM: '15.00', cacheReadPricePerM: '0.30', cacheWritePricePerM: '3.75' },
      ],
    });
    expect(aiUsageRequestFields({ aiCoverage: 'included', aiMarkupPercent: '25', aiRates: [row()] })).toEqual({ aiCoverage: 'included', aiMarkupPercent: null, aiRates: [] });
  });
  it('sends blank markup as null', () => {
    expect(aiUsageRequestFields(billable({ aiMarkupPercent: '' })).aiMarkupPercent).toBeNull();
  });
});

describe('showUsdOnlyWarning', () => {
  it('warns only for a billable non-USD card without a price list', () => {
    expect(showUsdOnlyWarning(billable(), 'EUR')).toBe(true);
    expect(showUsdOnlyWarning(billable({ aiMarkupPercent: '20' }), 'EUR')).toBe(true);
    expect(showUsdOnlyWarning(billable({ aiRates: [row()] }), 'EUR')).toBe(false);
    expect(showUsdOnlyWarning(billable(), 'USD')).toBe(false);
    expect(showUsdOnlyWarning({ aiCoverage: 'included', aiMarkupPercent: null, aiRates: [] }, 'EUR')).toBe(false);
  });
});
