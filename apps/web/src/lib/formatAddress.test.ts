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

  // #9024: "· US" on every customer of a US partner is noise.
  it('omits the country when it is the home country passed in (case-insensitive), and only then', () => {
    const parts = { line1: '1 Main St', city: 'Springfield', region: 'IL', country: 'US' };
    expect(formatAddress(parts, { homeCountry: 'us' })).toBe('1 Main St · Springfield, IL');
    expect(formatAddress(parts, { homeCountry: 'CA' })).toBe('1 Main St · Springfield, IL · US');
    expect(formatAddress(parts, { homeCountry: null })).toBe('1 Main St · Springfield, IL · US');
    expect(formatAddress(parts)).toBe('1 Main St · Springfield, IL · US');
    // A country-only address is still an address: it never collapses to ''.
    expect(formatAddress({ country: 'US' }, { homeCountry: 'US' })).toBe('US');
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
