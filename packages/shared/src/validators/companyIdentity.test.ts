import { describe, it, expect } from 'vitest';
import { parseCompanyContact, parseCompanyAddress, isCompanyAddressBlank } from './companyIdentity';

describe('parseCompanyContact', () => {
  it('returns all-null for undefined/null input', () => {
    expect(parseCompanyContact(undefined)).toEqual({ name: null, email: null, phone: null, website: null });
    expect(parseCompanyContact(null)).toEqual({ name: null, email: null, phone: null, website: null });
  });

  it('returns all-null for a non-object input (legacy corrupt jsonb)', () => {
    expect(parseCompanyContact('not an object')).toEqual({ name: null, email: null, phone: null, website: null });
    expect(parseCompanyContact(42)).toEqual({ name: null, email: null, phone: null, website: null });
    expect(parseCompanyContact([1, 2, 3])).toEqual({ name: null, email: null, phone: null, website: null });
  });

  it('parses well-formed contact fields', () => {
    expect(parseCompanyContact({ name: 'Jane Doe', email: 'jane@acme.test', phone: '+1 555 0100', website: 'https://acme.test' }))
      .toEqual({ name: 'Jane Doe', email: 'jane@acme.test', phone: '+1 555 0100', website: 'https://acme.test' });
  });

  it('trims whitespace and treats whitespace-only as absent', () => {
    expect(parseCompanyContact({ name: '  Jane  ', phone: '   ' })).toEqual({ name: 'Jane', email: null, phone: null, website: null });
  });

  it('field-level parsing: one malformed field does not discard sibling fields', () => {
    // website is an object instead of a string (legacy corrupt shape) — should
    // drop only `website`, not the whole contact block.
    expect(parseCompanyContact({ name: 'Acme MSP', phone: '555-0100', website: { bad: true } }))
      .toEqual({ name: 'Acme MSP', email: null, phone: '555-0100', website: null });
  });
});

describe('parseCompanyAddress', () => {
  it('returns all-null for undefined/malformed input', () => {
    const blank = { line1: null, line2: null, city: null, region: null, postalCode: null, country: null };
    expect(parseCompanyAddress(undefined)).toEqual(blank);
    expect(parseCompanyAddress('garbage')).toEqual(blank);
  });

  it('maps street1/street2 to line1/line2', () => {
    expect(parseCompanyAddress({ street1: '1 Main St', street2: 'Suite 100', city: 'Austin', region: 'TX', postalCode: '78701', country: 'US' }))
      .toEqual({ line1: '1 Main St', line2: 'Suite 100', city: 'Austin', region: 'TX', postalCode: '78701', country: 'US' });
  });

  it('field-level parsing: one malformed field does not discard the rest', () => {
    expect(parseCompanyAddress({ street1: '1 Main St', city: 12345, country: 'US' }))
      .toEqual({ line1: '1 Main St', line2: null, city: null, region: null, postalCode: null, country: 'US' });
  });
});

describe('isCompanyAddressBlank', () => {
  it('is true when every field is null', () => {
    expect(isCompanyAddressBlank({ line1: null, line2: null, city: null, region: null, postalCode: null, country: null })).toBe(true);
  });

  it('is false when any field is set', () => {
    expect(isCompanyAddressBlank({ line1: null, line2: null, city: 'Austin', region: null, postalCode: null, country: null })).toBe(false);
  });
});
