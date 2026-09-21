import { describe, expect, it } from 'vitest';
import { createProfileSchema, saveProfileSchema, updateProfileSchema } from './billingProfiles';

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
