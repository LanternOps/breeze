import { describe, it, expect } from 'vitest';
import { sellerLines } from './sellerLines';

describe('sellerLines', () => {
  it('returns [] for null address', () => {
    expect(sellerLines(null)).toEqual([]);
  });

  it('joins city/region/postalCode and drops empty fields', () => {
    const result = sellerLines({
      line1: '123 Main St',
      line2: null,
      city: 'Austin',
      region: 'TX',
      postalCode: '78701',
      country: 'US',
    });
    expect(result).toEqual(['123 Main St', 'Austin, TX, 78701', 'US']);
  });

  it('drops line2 when empty string', () => {
    const result = sellerLines({
      line1: '456 Oak Ave',
      line2: '',
      city: 'Boston',
      region: 'MA',
      postalCode: '02101',
      country: null,
    });
    expect(result).toEqual(['456 Oak Ave', 'Boston, MA, 02101']);
  });

  it('handles partial city line', () => {
    const result = sellerLines({
      line1: null,
      line2: null,
      city: 'London',
      region: null,
      postalCode: 'EC1A',
      country: 'UK',
    });
    expect(result).toEqual(['London, EC1A', 'UK']);
  });
});
