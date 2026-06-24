import { describe, it, expect, beforeEach, vi } from 'vitest';

// resolveQuoteBranding runs two sequential reads: select(...).from(partners)...
// then select(...).from(portal_branding)... Each `.limit(1)` chain resolves to
// the next queued row-array, so dbRows.next = [[partner], [brand]] per test.
const dbRows = vi.hoisted(() => ({ next: [] as unknown[][], i: 0 }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = () => Promise.resolve(dbRows.next[dbRows.i++] ?? []);
  return { db: { select: () => chain } };
});

import { resolveQuoteBranding, type QuoteBrandingSource } from './quoteBranding';

function queue(partner: unknown | null, brand: unknown | null): void {
  dbRows.next = [partner ? [partner] : [], brand ? [brand] : []];
  dbRows.i = 0;
}

const basePartner = {
  name: 'Lantern IT', invoiceFooter: 'partner footer', currencyCode: 'EUR',
  billingCompanyName: 'Lantern IT Services', billingEmail: 'b@x.io', billingPhone: null, billingWebsite: null,
  billingAddressLine1: '1 St', billingAddressLine2: null, billingAddressCity: 'PDX',
  billingAddressRegion: 'OR', billingAddressPostalCode: '97204', billingAddressCountry: 'US',
};
const baseBrand = { logoUrl: 'logo.png', primaryColor: '#1c8a9e', footerText: 'portal footer' };

function source(overrides: Partial<QuoteBrandingSource> = {}): QuoteBrandingSource {
  return { partnerId: 'p1', orgId: 'o1', currencyCode: 'USD', terms: null, sellerSnapshot: null, ...overrides };
}

beforeEach(() => { dbRows.next = []; dbRows.i = 0; });

describe('resolveQuoteBranding', () => {
  it('footer precedence: quote.terms wins over partner + portal footer', async () => {
    queue(basePartner, baseBrand);
    const b = await resolveQuoteBranding(source({ terms: 'quote terms' }));
    expect(b.footer).toBe('quote terms');
  });

  it('footer precedence: partner invoiceFooter beats portal footer when terms null', async () => {
    queue(basePartner, baseBrand);
    const b = await resolveQuoteBranding(source({ terms: null }));
    expect(b.footer).toBe('partner footer');
  });

  it('footer precedence: portal footerText used when terms + partner footer absent', async () => {
    queue({ ...basePartner, invoiceFooter: null }, baseBrand);
    const b = await resolveQuoteBranding(source());
    expect(b.footer).toBe('portal footer');
  });

  it('currency: quote → partner → USD fallback', async () => {
    queue(basePartner, baseBrand);
    expect((await resolveQuoteBranding(source({ currencyCode: 'GBP' }))).currencyCode).toBe('GBP');
    queue(basePartner, baseBrand);
    expect((await resolveQuoteBranding(source({ currencyCode: null }))).currencyCode).toBe('EUR'); // partner
    queue({ ...basePartner, currencyCode: null }, baseBrand);
    expect((await resolveQuoteBranding(source({ currencyCode: null }))).currencyCode).toBe('USD');
  });

  it('partner absent → partnerName falls back to "Proposal", logo/color/seller null', async () => {
    queue(null, baseBrand);
    const b = await resolveQuoteBranding(source());
    expect(b.partnerName).toBe('Proposal');
    expect(b.seller).toBeNull();
    // brand still resolves logo/color from the portal_branding read.
    expect(b.logoUrl).toBe('logo.png');
    expect(b.primaryColor).toBe('#1c8a9e');
  });

  it('frozen sellerSnapshot wins; buildSellerSnapshot is not synthesized', async () => {
    queue(basePartner, baseBrand);
    const frozen = { name: 'Frozen Co', address: null, phone: null, email: null, website: null };
    const b = await resolveQuoteBranding(source({ sellerSnapshot: frozen }));
    expect(b.seller).toEqual(frozen);
  });

  it('no frozen snapshot but partner present → seller synthesized from partner billing', async () => {
    queue(basePartner, baseBrand);
    const b = await resolveQuoteBranding(source({ sellerSnapshot: null }));
    expect(b.seller?.name).toBe('Lantern IT Services'); // billingCompanyName
    expect(b.seller?.email).toBe('b@x.io');
  });

  it('brand absent → logoUrl/primaryColor null', async () => {
    queue(basePartner, null);
    const b = await resolveQuoteBranding(source());
    expect(b.logoUrl).toBeNull();
    expect(b.primaryColor).toBeNull();
  });
});
