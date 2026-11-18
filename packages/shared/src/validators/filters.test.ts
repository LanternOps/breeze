import { describe, expect, it } from 'vitest';
import { filterConditionSchema, filterOperatorSchema, filterValueSchema, softwareVersionValueSchema } from './filters';

describe('software version filter values', () => {
  it('keeps the compound value intact and trims both strings', () => {
    expect(filterValueSchema.parse({ name: ' Chrome ', version: ' v10.0 ' })).toEqual({ name: 'Chrome', version: 'v10.0' });
  });

  it.each([
    {}, { name: 'Chrome' }, { version: '1.2' },
    { name: '', version: '1.2' }, { name: '  ', version: '1.2' },
    { name: 'Chrome', version: '' }, { name: 'Chrome', version: '  ' },
    { name: 123, version: '1.2' }, { name: 'Chrome', version: 123 },
    { name: 'x'.repeat(501), version: '1.2' },
    { name: 'Chrome', version: '1'.repeat(101) },
  ])('rejects invalid compound values: %j', (value) => {
    expect(softwareVersionValueSchema.safeParse(value).success).toBe(false);
    expect(filterValueSchema.safeParse(value).success).toBe(false);
  });

  it('accepts the maximum lengths', () => {
    const value = { name: 'x'.repeat(500), version: '1'.repeat(100) };
    expect(filterValueSchema.parse(value)).toEqual(value);
  });

  it.each(['below', 'atLeast', 'equals'])('accepts the %s operator', (operator) => {
    expect(filterOperatorSchema.parse(operator)).toBe(operator);
    expect(filterConditionSchema.parse({ field: 'software.version', operator, value: { name: 'Chrome', version: '10.0' } })).toEqual({ field: 'software.version', operator, value: { name: 'Chrome', version: '10.0' } });
  });
});

describe('filter value union ordering', () => {
  it('keeps numeric ranges numeric', () => {
    expect(filterValueSchema.parse({ from: 10, to: 90 })).toEqual({ from: 10, to: 90 });
  });

  it('keeps relative-time values intact', () => {
    expect(filterValueSchema.parse({ amount: 7, unit: 'days' })).toEqual({ amount: 7, unit: 'days' });
  });

  it('keeps date ranges and single-element string arrays in their branches', () => {
    const from = new Date('2026-01-01');
    const to = new Date('2026-02-01');
    expect(filterValueSchema.parse({ from, to })).toEqual({ from, to });
    expect(filterValueSchema.parse(['Floor 2'])).toEqual(['Floor 2']);
  });
});
