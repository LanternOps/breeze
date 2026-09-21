import { describe, it, expect } from 'vitest';
import { acceptQuoteOnBehalfSchema, QUOTE_ACCEPT_ON_BEHALF_METHODS } from './quotes';

const valid = {
  method: 'purchase_order' as const,
  reference: 'PO 4471',
  signerName: 'Dana Buyer',
  signerEmail: 'dana@customer.example',
};

describe('acceptQuoteOnBehalfSchema', () => {
  it('accepts a complete body', () => {
    expect(acceptQuoteOnBehalfSchema.parse(valid)).toEqual(valid);
  });

  it('accepts a body with no signer email', () => {
    const { signerEmail: _drop, ...rest } = valid;
    expect(acceptQuoteOnBehalfSchema.parse(rest).signerEmail).toBeUndefined();
  });

  it('accepts an explicitly null signer email', () => {
    expect(acceptQuoteOnBehalfSchema.parse({ ...valid, signerEmail: null }).signerEmail).toBeNull();
  });

  // The reference is the whole point of the evidence trail: a blank one is a
  // record a dispute reviewer cannot act on.
  it.each(['', '   '])('rejects a blank reference (%j)', (reference) => {
    expect(acceptQuoteOnBehalfSchema.safeParse({ ...valid, reference }).success).toBe(false);
  });

  it('trims the free-text fields', () => {
    const parsed = acceptQuoteOnBehalfSchema.parse({
      ...valid, reference: '  PO 4471  ', signerName: '  Dana Buyer  ',
    });
    expect(parsed.reference).toBe('PO 4471');
    expect(parsed.signerName).toBe('Dana Buyer');
  });

  it('rejects an unknown method', () => {
    expect(acceptQuoteOnBehalfSchema.safeParse({ ...valid, method: 'telepathy' }).success).toBe(false);
  });

  it('rejects a missing signer name', () => {
    const { signerName: _drop, ...rest } = valid;
    expect(acceptQuoteOnBehalfSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects an oversize reference (DB column is text, but 500 is the API cap)', () => {
    expect(acceptQuoteOnBehalfSchema.safeParse({ ...valid, reference: 'x'.repeat(501) }).success).toBe(false);
  });

  // varchar(32) on quote_acceptances.method — the longest member must fit.
  it('keeps every method inside the 32-char column', () => {
    for (const m of QUOTE_ACCEPT_ON_BEHALF_METHODS) expect(m.length).toBeLessThanOrEqual(32);
  });
});
