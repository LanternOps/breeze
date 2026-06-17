import { describe, it, expect } from 'vitest';
import { computeQuoteSha256 } from './quoteContentHash';

const quote = { id: 'q1', quoteNumber: 'Q-2026-0001', status: 'sent', currencyCode: 'USD', total: '100.00', oneTimeTotal: '100.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00', taxTotal: '0.00', subtotal: '100.00' } as any;
const blocks = [{ id: 'b1', blockType: 'heading', content: { text: 'Proposal' }, sortOrder: 0 }] as any;
const lines = [{ id: 'l1', description: 'Setup', quantity: '1', unitPrice: '100.00', lineTotal: '100.00', recurrence: 'one_time', taxable: false, customerVisible: true, sortOrder: 0 }] as any;

describe('computeQuoteSha256', () => {
  it('returns a stable 64-char hex hash for the same content', () => {
    const a = computeQuoteSha256(quote, blocks, lines);
    const b = computeQuoteSha256(quote, blocks, lines);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });
  it('is order-independent on input arrays but content-sensitive', () => {
    const reordered = computeQuoteSha256(quote, blocks, [...lines].reverse());
    expect(reordered).toBe(computeQuoteSha256(quote, blocks, lines));
  });
  it('changes when a line amount is tampered', () => {
    const tampered = [{ ...lines[0], unitPrice: '1.00', lineTotal: '1.00' }];
    expect(computeQuoteSha256(quote, blocks, tampered)).not.toBe(computeQuoteSha256(quote, blocks, lines));
  });
  it('ignores volatile workflow fields — status + quote number (C4)', () => {
    // The quote legitimately transitions sent→converted (and gets a number) during
    // accept; the content hash must NOT change, or a later re-verify false-positives.
    const evolved = { ...quote, status: 'converted', quoteNumber: 'Q-9999-9999' };
    expect(computeQuoteSha256(evolved, blocks, lines)).toBe(computeQuoteSha256(quote, blocks, lines));
  });
});
