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

  it('normalises case/whitespace and treats blank currency as USD', () => {
    expect(priceGuidanceFrom(12, null, ' eur ')).toBe('from €12.00');
    expect(priceGuidanceFrom(12, null, '')).toBe('from $12.00');
    expect(priceGuidanceFrom(12, null, '   ')).toBe('from $12.00');
  });

  it('does not throw on a non-ISO model-supplied code; keeps the label next to the number', () => {
    expect(priceGuidanceFrom(12, 15, 'dollars')).toBe('typically 12.00 DOLLARS–15.00 DOLLARS');
  });

  it('formats a zero bound (not a truthiness check)', () => {
    expect(priceGuidanceFrom(0, 5, 'USD')).toBe('typically $0.00–$5.00');
    expect(priceGuidanceFrom(0, null, 'USD')).toBe('from $0.00');
  });

  it('returns null with no bounds', () => {
    expect(priceGuidanceFrom(null, null, 'EUR')).toBeNull();
  });
});
