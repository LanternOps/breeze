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
  return { partnerId: 'p1', orgId: 'o1', currencyCode: 'USD', terms: null, sellerSnapshot: null, presentationSnapshot: null, ...overrides };
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

  it('partner absent AND no frozen seller → partnerName falls back to "Proposal", logo/color/seller null', async () => {
    queue(null, baseBrand);
    const b = await resolveQuoteBranding(source());
    expect(b.partnerName).toBe('Proposal');
    expect(b.seller).toBeNull();
    // brand still resolves logo/color from the portal_branding read.
    expect(b.logoUrl).toBe('logo.png');
    expect(b.primaryColor).toBe('#1c8a9e');
  });

  it('partner absent but seller frozen → wordmark uses the frozen company name, not "Proposal" (#2151)', async () => {
    // The realistic empty-partner case is the org-scoped RLS zero-row read the
    // module header warns about, not a nameless partner — and a sent document
    // still carries the seller name. Printing the document-type word in the
    // wordmark slot threw away a name we already had.
    queue(null, baseBrand);
    const frozen = { name: 'Lantern IT Services', address: null, phone: null, email: null, website: null };
    const b = await resolveQuoteBranding(source({ sellerSnapshot: frozen }));
    expect(b.partnerName).toBe('Lantern IT Services');
  });

  it('a live partner still outranks the frozen seller name', async () => {
    queue(basePartner, baseBrand);
    const frozen = { name: 'Stale Co', address: null, phone: null, email: null, website: null };
    const b = await resolveQuoteBranding(source({ sellerSnapshot: frozen }));
    expect(b.partnerName).toBe('Lantern IT');
  });

  it('a frozen seller with a null name still degrades to "Proposal"', async () => {
    queue(null, baseBrand);
    const frozen = { name: null, address: null, phone: null, email: null, website: null };
    const b = await resolveQuoteBranding(source({ sellerSnapshot: frozen }));
    expect(b.partnerName).toBe('Proposal');
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

  // Task 5: theme/pageSize resolution. Precedence: quote.presentationSnapshot
  // (non-null) → partner columns → defaults ('classic'/'a4').
  describe('theme/pageSize resolution', () => {
    it('resolves theme/pageSize from partner columns for drafts', async () => {
      queue({ ...basePartner, documentTheme: 'condensed', documentPageSize: 'letter' }, baseBrand);
      const b = await resolveQuoteBranding(source({ presentationSnapshot: null }));
      expect(b.theme).toBe('condensed');
      expect(b.pageSize).toBe('letter');
    });

    it('prefers the frozen snapshot for sent quotes, even when the partner disagrees', async () => {
      queue({ ...basePartner, documentTheme: 'condensed', documentPageSize: 'letter' }, baseBrand);
      const b = await resolveQuoteBranding(source({ presentationSnapshot: { theme: 'classic', pageSize: 'a4' } }));
      expect(b.theme).toBe('classic');
      expect(b.pageSize).toBe('a4');
    });

    it('falls back safely on unknown snapshot values', async () => {
      queue(basePartner, baseBrand);
      const b = await resolveQuoteBranding(source({ presentationSnapshot: { theme: 'x', pageSize: 'y' } }));
      expect(b.theme).toBe('classic');
      expect(b.pageSize).toBe('a4');
    });

    it('falls back to classic/a4 defaults when the partner is absent and there is no snapshot', async () => {
      queue(null, baseBrand);
      const b = await resolveQuoteBranding(source({ presentationSnapshot: null }));
      expect(b.theme).toBe('classic');
      expect(b.pageSize).toBe('a4');
    });
  });
});
