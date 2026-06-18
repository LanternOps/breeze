import { describe, it, expect } from 'vitest';
import { formatQuoteNumber } from './quoteNumbers';

describe('formatQuoteNumber', () => {
  it('zero-pads the counter to 4 digits', () => {
    expect(formatQuoteNumber('Q', 2026, 7)).toBe('Q-2026-0007');
    expect(formatQuoteNumber('QUO', 2026, 1234)).toBe('QUO-2026-1234');
  });
});
