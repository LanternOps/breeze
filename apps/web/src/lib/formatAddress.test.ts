import { describe, expect, it } from 'vitest';
import { formatAddress } from './formatAddress';

describe('formatAddress', () => {
  it('joins all six parts as line1, line2 · city, region postalCode · country', () => {
    expect(
      formatAddress({
        line1: '1 Main St',
        line2: 'Suite 200',
        city: 'Springfield',
        region: 'IL',
        postalCode: '62701',
        country: 'US',
      })
    ).toBe('1 Main St, Suite 200 · Springfield, IL 62701 · US');
  });

  it('returns an empty string for null, undefined and all-empty parts', () => {
    expect(formatAddress(null)).toBe('');
    expect(formatAddress(undefined)).toBe('');
    expect(formatAddress({})).toBe('');
    expect(formatAddress({ line1: '', city: null })).toBe('');
  });

  it('skips empty parts without dangling separators', () => {
    expect(formatAddress({ city: 'Springfield', country: 'US' })).toBe('Springfield · US');
    expect(formatAddress({ region: 'IL', postalCode: '62701' })).toBe('IL 62701');
    expect(formatAddress({ line2: 'Suite 2', city: 'Austin' })).toBe('Suite 2 · Austin');
  });

  it('treats whitespace-only parts as empty', () => {
    expect(formatAddress({ line1: '  ', city: 'Austin' })).toBe('Austin');
  });
});
