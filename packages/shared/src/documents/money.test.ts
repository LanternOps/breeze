import { describe, it, expect } from 'vitest';
import { formatMoney } from '../utils/currency';
import { documentMoney } from './money';

describe('documentMoney', () => {
  it('formats in the document locale and keeps the raw amount for the PDF', () => {
    const m = documentMoney('1234.5', 'CHF', 'de-CH');
    expect(m).toEqual({ text: formatMoney('1234.5', 'CHF', 'de-CH'), amount: '1234.5', currency: 'CHF', suffix: null });
  });

  it('INR keeps its symbol on screen; amount stays raw for the glyph-safe PDF path', () => {
    expect(documentMoney('99', 'INR', 'en-IN').text).toContain('₹');
    expect(documentMoney('99', 'INR', 'en-IN').amount).toBe('99');
  });

  it('carries a recurrence suffix through unchanged', () => {
    const suffix = { text: '/mo', srText: 'per month' };
    expect(documentMoney('10', 'USD', 'en', suffix).suffix).toEqual(suffix);
  });
});
