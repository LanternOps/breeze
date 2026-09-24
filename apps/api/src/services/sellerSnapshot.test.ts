import { describe, it, expect } from 'vitest';
import { buildSellerSnapshot, sellerAddressLines } from './sellerSnapshot';

const base = {
  name: 'Acme MSP', billingCompanyName: null, billingEmail: null, billingPhone: null,
  billingWebsite: null, billingAddressLine1: null, billingAddressLine2: null,
  billingAddressCity: null, billingAddressRegion: null, billingAddressPostalCode: null,
  billingAddressCountry: null,
};

describe('buildSellerSnapshot', () => {
  it('falls back to partner.name when billingCompanyName is null', () => {
    expect(buildSellerSnapshot(base).name).toBe('Acme MSP');
  });

  it('prefers billingCompanyName over name', () => {
    expect(buildSellerSnapshot({ ...base, billingCompanyName: 'Acme MSP LLC' }).name).toBe('Acme MSP LLC');
  });

  it('maps contact + address fields', () => {
    const snap = buildSellerSnapshot({
      ...base, billingEmail: 'billing@acme.test', billingPhone: '+1 555 0100',
      billingWebsite: 'acme.test', billingAddressLine1: '1 Main St', billingAddressCity: 'Austin',
      billingAddressRegion: 'TX', billingAddressPostalCode: '78701', billingAddressCountry: 'US',
    });
    expect(snap.email).toBe('billing@acme.test');
    expect(snap.phone).toBe('+1 555 0100');
    expect(snap.website).toBe('acme.test');
    expect(snap.address).toMatchObject({ line1: '1 Main St', city: 'Austin', region: 'TX', postalCode: '78701', country: 'US' });
  });

  describe('company-details fallback (#6228)', () => {
    const withCompany = (settings: unknown) => ({ ...base, settings });

    it('falls back to settings.contact.phone/website when billing override is unset', () => {
      const snap = buildSellerSnapshot(withCompany({ contact: { phone: '555-0100', website: 'https://acme.test' } }));
      expect(snap.phone).toBe('555-0100');
      expect(snap.website).toBe('https://acme.test');
    });

    it('billing override wins over company details when both are set', () => {
      const snap = buildSellerSnapshot({
        ...base, billingPhone: '555-9999', billingWebsite: 'https://billing.acme.test',
        settings: { contact: { phone: '555-0100', website: 'https://acme.test' } },
      });
      expect(snap.phone).toBe('555-9999');
      expect(snap.website).toBe('https://billing.acme.test');
    });

    it('whitespace-only billing override is treated as absent and falls back', () => {
      const snap = buildSellerSnapshot({
        ...base, billingPhone: '   ',
        settings: { contact: { phone: '555-0100' } },
      });
      expect(snap.phone).toBe('555-0100');
    });

    it('never falls back for email — stays billingEmail only', () => {
      const snap = buildSellerSnapshot(withCompany({ contact: { email: 'contact@acme.test' } }));
      expect(snap.email).toBeNull();
    });

    it('address BLOCK semantics: any one billing address field present freezes the full billing address, not a mix', () => {
      const snap = buildSellerSnapshot({
        ...base, billingAddressCity: 'Austin', // only city set on the override
        settings: { address: { street1: '1 Company Rd', city: 'Company City', country: 'CA' } },
      });
      // Billing block wins wholesale: city from billing, everything else null —
      // NOT filled in from the company address.
      expect(snap.address).toEqual({ line1: null, line2: null, city: 'Austin', region: null, postalCode: null, country: null });
    });

    it('address BLOCK semantics: billing address fully blank inherits the whole company address', () => {
      const snap = buildSellerSnapshot(withCompany({
        address: { street1: '1 Company Rd', street2: 'Suite 9', city: 'Company City', region: 'CC', postalCode: '00001', country: 'CA' },
      }));
      expect(snap.address).toEqual({ line1: '1 Company Rd', line2: 'Suite 9', city: 'Company City', region: 'CC', postalCode: '00001', country: 'CA' });
    });

    it('both billing and company address blank → all-null address', () => {
      const snap = buildSellerSnapshot(withCompany({}));
      expect(snap.address).toEqual({ line1: null, line2: null, city: null, region: null, postalCode: null, country: null });
    });

    it('malformed settings (string instead of object) never throws and degrades to no fallback', () => {
      expect(() => buildSellerSnapshot({ ...base, settings: 'not-an-object' })).not.toThrow();
      const snap = buildSellerSnapshot({ ...base, settings: 'not-an-object' });
      expect(snap.phone).toBeNull();
      expect(snap.address).toEqual({ line1: null, line2: null, city: null, region: null, postalCode: null, country: null });
    });

    it('one malformed company-detail field does not discard a valid sibling field', () => {
      // website is the wrong type; phone is still valid and must still resolve.
      const snap = buildSellerSnapshot(withCompany({ contact: { phone: '555-0100', website: { bad: true } } }));
      expect(snap.phone).toBe('555-0100');
      expect(snap.website).toBeNull();
    });
  });
});

describe('sellerAddressLines', () => {
  it('joins city/region/postal and drops empties', () => {
    const snap = buildSellerSnapshot({
      ...base, billingAddressLine1: '1 Main St', billingAddressCity: 'Austin',
      billingAddressRegion: 'TX', billingAddressPostalCode: '78701', billingAddressCountry: 'US',
    });
    expect(sellerAddressLines(snap)).toEqual(['1 Main St', 'Austin, TX, 78701', 'US']);
  });

  it('includes line2 when present', () => {
    const snap = buildSellerSnapshot({
      ...base, billingAddressLine1: '1 Main St', billingAddressLine2: 'Suite 100',
      billingAddressCity: 'Austin', billingAddressRegion: 'TX',
      billingAddressPostalCode: '78701', billingAddressCountry: 'US',
    });
    expect(sellerAddressLines(snap)).toEqual(['1 Main St', 'Suite 100', 'Austin, TX, 78701', 'US']);
  });

  it('returns [] for a null snapshot', () => {
    expect(sellerAddressLines(null)).toEqual([]);
  });
});
