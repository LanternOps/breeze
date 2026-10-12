import { describe, expect, it } from 'vitest';
import { priceGuidanceFrom } from './catalogEnrichmentService';

describe('priceGuidanceFrom (#3200)', () => {
  it('USD and null currency use the $ symbol', () => {
    expect(priceGuidanceFrom(12, 15, 'USD')).toBe('typically $12.00–$15.00');
    expect(priceGuidanceFrom(12, 15, null)).toBe('typically $12.00–$15.00');
    expect(priceGuidanceFrom(12, null, 'USD')).toBe('from $12.00');
    expect(priceGuidanceFrom(null, 15, null)).toBe('up to $15.00');
  });

  it('EUR, GBP and CAD render locale-correct symbols, not "EUR 12"', () => {
    expect(priceGuidanceFrom(12, 15, 'EUR')).toBe('typically €12.00–€15.00');
    expect(priceGuidanceFrom(12, 15, 'GBP')).toBe('typically £12.00–£15.00');
    expect(priceGuidanceFrom(12, 15, 'CAD')).toBe('typically CA$12.00–CA$15.00');
    expect(priceGuidanceFrom(9.5, null, 'EUR')).toBe('from €9.50');
  });

  it('returns null with no bounds', () => {
    expect(priceGuidanceFrom(null, null, 'EUR')).toBeNull();
  });
});
