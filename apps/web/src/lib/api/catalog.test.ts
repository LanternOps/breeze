import { describe, it, expect } from 'vitest';
import { computeMargin, formatMargin, marginTone } from './catalog';

describe('computeMargin', () => {
  it('returns gross margin percent from price and cost', () => {
    expect(computeMargin(100, 60)).toBeCloseTo(40);
    expect(computeMargin('200.00', '50.00')).toBeCloseTo(75);
  });

  it('is negative when cost exceeds price (loss leader)', () => {
    expect(computeMargin(80, 100)).toBeCloseTo(-25);
  });

  it('returns null when cost basis is absent or blank', () => {
    expect(computeMargin(100, null)).toBeNull();
    expect(computeMargin(100, undefined)).toBeNull();
    expect(computeMargin(100, '')).toBeNull();
  });

  it('returns null when price is zero, negative, or non-numeric (no divide-by-zero)', () => {
    expect(computeMargin(0, 10)).toBeNull();
    expect(computeMargin(-5, 10)).toBeNull();
    expect(computeMargin('abc', 10)).toBeNull();
    expect(computeMargin(100, 'abc')).toBeNull();
  });
});

describe('formatMargin', () => {
  it('renders one-decimal percent, em-dash for null', () => {
    expect(formatMargin(42.5)).toBe('42.5%');
    expect(formatMargin(-8)).toBe('-8.0%');
    expect(formatMargin(null)).toBe('—');
  });
});

describe('marginTone', () => {
  it('flags negative margins as destructive, others neutral', () => {
    expect(marginTone(-1)).toBe('text-destructive');
    expect(marginTone(30)).toBe('text-foreground');
    expect(marginTone(null)).toBe('text-muted-foreground');
  });
});
