import { describe, it, expect } from 'vitest';
import { declineQuoteOnBehalfSchema, QUOTE_ACCEPT_ON_BEHALF_METHODS } from './quotes';

// Body for POST /quotes/:id/decline-on-behalf (#6634). Same evidence rule as
// accept-on-behalf: a recorded decline with no reference is a claim, not a
// record — so reference is required; the customer's reason is optional.
describe('declineQuoteOnBehalfSchema', () => {
  const valid = { method: 'email', reference: 'Email from J. Doe 2026-09-20' };

  it('accepts method + reference without a reason', () => {
    expect(declineQuoteOnBehalfSchema.parse(valid)).toEqual(valid);
  });

  it('accepts every accept-on-behalf method (one shared list)', () => {
    for (const method of QUOTE_ACCEPT_ON_BEHALF_METHODS) {
      expect(declineQuoteOnBehalfSchema.safeParse({ ...valid, method }).success).toBe(true);
    }
  });

  it('rejects a missing or blank reference', () => {
    expect(declineQuoteOnBehalfSchema.safeParse({ method: 'email' }).success).toBe(false);
    expect(declineQuoteOnBehalfSchema.safeParse({ ...valid, reference: '   ' }).success).toBe(false);
  });

  it('rejects a reference over 500 characters', () => {
    expect(declineQuoteOnBehalfSchema.safeParse({ ...valid, reference: 'x'.repeat(501) }).success).toBe(false);
  });

  it('rejects an unknown method', () => {
    expect(declineQuoteOnBehalfSchema.safeParse({ ...valid, method: 'telepathy' }).success).toBe(false);
  });

  it('caps the reason at the customer decline limit', () => {
    expect(declineQuoteOnBehalfSchema.safeParse({ ...valid, reason: 'x'.repeat(5000) }).success).toBe(true);
    expect(declineQuoteOnBehalfSchema.safeParse({ ...valid, reason: 'x'.repeat(5001) }).success).toBe(false);
  });
});
