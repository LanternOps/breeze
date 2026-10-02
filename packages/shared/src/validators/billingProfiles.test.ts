import { describe, expect, it } from 'vitest';
import {
  aiCoverageSchema, aiMarkupPercentSchema, aiRateRowSchema, aiRateRowsSchema,
  createProfileSchema, saveProfileSchema, updateProfileSchema,
} from './billingProfiles';

const workTypeId = '33333333-3333-4333-8333-333333333333';
const input = { name: 'Standard', notes: null, currencyCode: 'USD', baseCoverage: 'billable',
  baseHourlyRate: '175.00', baseMinimumMinutes: 45, roundingIncrementMinutes: 30,
  rows: [{ workTypeId, coverage: 'included', hourlyRate: null, minimumMinutes: null }] };

describe('atomic billing profile contracts', () => {
  it('accepts metadata, base pricing and every work-type rule together', () => {
    expect(saveProfileSchema.parse(input)).toEqual(input);
    expect(createProfileSchema.parse(input)).toEqual(input);
  });
  it('accepts an empty replacement but requires the rows field on save', () => {
    expect(saveProfileSchema.safeParse({ ...input, rows: [] }).success).toBe(true);
    const { rows: _, ...missingRows } = input;
    expect(saveProfileSchema.safeParse(missingRows).success).toBe(false);
    expect(createProfileSchema.safeParse(missingRows).success).toBe(true);
  });
  it.each(['billable', 'included', 'non_billable'])('accepts a %s row without a rate', coverage => {
    expect(saveProfileSchema.safeParse({ ...input, rows: [{ workTypeId, coverage, hourlyRate: null, minimumMinutes: null }] }).success).toBe(true);
  });
  it.each([
    { name: '' }, { currencyCode: 'usd' }, { baseCoverage: 'invalid' },
    { baseHourlyRate: '-1' }, { baseHourlyRate: '100000000' }, { baseHourlyRate: '0.001' },
    { baseMinimumMinutes: -1 }, { baseMinimumMinutes: 1.5 }, { baseMinimumMinutes: 2147483648 },
    { roundingIncrementMinutes: 0 }, { roundingIncrementMinutes: 481 },
    { rows: [{ workTypeId: 'bad', coverage: 'billable', hourlyRate: null, minimumMinutes: null }] },
    { rows: [{ workTypeId, coverage: 'included', hourlyRate: '5', minimumMinutes: null }] },
    { rows: [{ workTypeId, coverage: 'non_billable', hourlyRate: null, minimumMinutes: 30 }] },
  ])('rejects invalid input %j', patch => {
    expect(saveProfileSchema.safeParse({ ...input, ...patch }).success).toBe(false);
    expect(createProfileSchema.safeParse({ ...input, ...patch }).success).toBe(false);
  });
  it('enforces the row limit on create and save', () => {
    expect(saveProfileSchema.safeParse({ ...input, rows: Array(1000).fill(input.rows[0]) }).success).toBe(true);
    expect(saveProfileSchema.safeParse({ ...input, rows: Array(1001).fill(input.rows[0]) }).success).toBe(false);
    expect(createProfileSchema.safeParse({ ...input, rows: Array(1001).fill(input.rows[0]) }).success).toBe(false);
  });
  it('keeps default and archive actions separate from the drawer save', () => {
    expect(saveProfileSchema.safeParse({ ...input, isDefault: true }).success).toBe(false);
    expect(saveProfileSchema.safeParse({ ...input, isActive: false }).success).toBe(false);
    expect(updateProfileSchema.safeParse({ isDefault: true }).success).toBe(true);
    expect(updateProfileSchema.safeParse({ isActive: false }).success).toBe(true);
  });
});

const rate = { modelId: 'w10-test-sonnet', inputPricePerM: '3.60', outputPricePerM: '18.000000',
  cacheReadPricePerM: '0.36', cacheWritePricePerM: '4.5' };

describe('AI chargeback terms on the card (#7608)', () => {
  it('accepts AI coverage, markup and a price list on save and create', () => {
    const withAi = { ...input, aiCoverage: 'billable', aiMarkupPercent: '25.00', aiRates: [rate] };
    expect(saveProfileSchema.parse(withAi)).toEqual(withAi);
    expect(createProfileSchema.parse(withAi)).toEqual(withAi);
  });
  it('keeps aiRates optional on save (absent = unchanged)', () => {
    expect(saveProfileSchema.safeParse(input).success).toBe(true);
  });
  it.each(['billable', 'included', 'non_billable'])('accepts coverage %s', (c) => {
    expect(aiCoverageSchema.safeParse(c).success).toBe(true);
  });
  it('rejects an unknown coverage', () => {
    expect(aiCoverageSchema.safeParse('free').success).toBe(false);
  });
  it.each(['0', '25', '25.5', '1000', '1000.00', null])('accepts markup %s', (m) => {
    expect(aiMarkupPercentSchema.safeParse(m).success).toBe(true);
  });
  it.each(['-1', '1000.01', '10000', '2.345', 'abc', ''])('rejects markup %s', (m) => {
    expect(aiMarkupPercentSchema.safeParse(m).success).toBe(false);
  });
  it.each([
    { modelId: '' }, { modelId: 'x'.repeat(201) }, { inputPricePerM: '-1' }, { outputPricePerM: '0.0000001' },
    { cacheReadPricePerM: '123456789' }, { cacheWritePricePerM: '1e3' },
  ])('rejects rate row %o', (bad) => {
    expect(aiRateRowSchema.safeParse({ ...rate, ...bad }).success).toBe(false);
  });
  it('rejects a duplicate model in one price list', () => {
    expect(aiRateRowsSchema.safeParse([rate, { ...rate }]).success).toBe(false);
  });
  it('rejects more than 200 price-list rows', () => {
    const rows = Array.from({ length: 201 }, (_, i) => ({ ...rate, modelId: `m-${i}` }));
    expect(aiRateRowsSchema.safeParse(rows).success).toBe(false);
  });
  it('rejects an unknown key on save (the schema stays strict)', () => {
    expect(saveProfileSchema.safeParse({ ...input, aiPrice: '1' }).success).toBe(false);
  });
});
