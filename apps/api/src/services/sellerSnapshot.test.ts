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
