import { describe, it, expect } from 'vitest';
import {
  createQuoteSchema, quoteLineInputSchema, quoteBlockInputSchema, listQuotesQuerySchema,
} from './quotes';

describe('quote validators', () => {
  it('accepts a minimal create payload', () => {
    const q = createQuoteSchema.parse({ orgId: '11111111-1111-1111-1111-111111111111' });
    expect(q.currencyCode).toBe('USD');
  });

  it('parses a recurring catalog line with term', () => {
    const line = quoteLineInputSchema.parse({
      sourceType: 'catalog', catalogItemId: '22222222-2222-2222-2222-222222222222',
      description: 'M365', quantity: 10, unitPrice: 22, taxable: true,
      recurrence: 'monthly', termMonths: 12,
    });
    expect(line.recurrence).toBe('monthly');
  });

  it('rejects a heading block with no text', () => {
    expect(() => quoteBlockInputSchema.parse({ blockType: 'heading', content: {} })).toThrow();
  });

  it('defaults list limit to 50', () => {
    expect(listQuotesQuerySchema.parse({}).limit).toBe(50);
  });
});
