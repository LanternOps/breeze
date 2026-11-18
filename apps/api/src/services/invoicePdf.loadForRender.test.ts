import { beforeEach, describe, expect, it, vi } from 'vitest';

// loadInvoiceForRender reads, in order: the invoice (.limit), the partner
// (.limit), then the org's portal_branding (.limit). The lines come from the
// customer-document assembler (#9414 W3a), not from this loader.
// Each terminal call resolves to the next queued row-array.
const rows = vi.hoisted(() => ({ next: [] as unknown[][], i: 0 }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  const nextRows = () => Promise.resolve(rows.next[rows.i++] ?? []);
  chain.from = () => chain;
  chain.leftJoin = () => chain;
  chain.where = () => chain;
  chain.limit = nextRows;
  chain.orderBy = nextRows;
  return { db: { select: () => chain } };
});

import { loadInvoiceForRender } from './invoicePdf';

// A pre-#7216 issued invoice: status past draft, footer never frozen (terms
// NULL), so its footer resolves live through the shared chain.
const invoice = {
  id: 'inv-1', orgId: 'org-1', partnerId: 'p-1', status: 'sent', terms: null as string | null,
  deviceAppendix: false, sellerSnapshot: { name: 'Lantern IT' }, billToName: 'Customer Co',
  currencyCode: 'USD', documentLocale: 'en',
};
const partner = { id: 'p-1', name: 'Lantern IT', invoiceFooter: 'Partner footer', currencyCode: 'USD' };

function queue(inv: typeof invoice, orgFooter: string | null) {
  rows.next = [[inv], [partner], orgFooter === null ? [] : [{ logoUrl: null, primaryColor: null, footerText: orgFooter }]];
  rows.i = 0;
}

beforeEach(() => { rows.next = []; rows.i = 0; });

// #7510 (settings rule 3): the real render loader — not a copy of the chain —
// resolves document line → org footer → partner default.
describe('loadInvoiceForRender footer (#7510)', () => {
  it('prints the org footer over the partner default', async () => {
    queue(invoice, 'Org footer');
    expect((await loadInvoiceForRender('inv-1'))!.branding.footerText).toBe('Org footer');
  });

  it('prints the partner default when the org sets none', async () => {
    queue(invoice, null);
    expect((await loadInvoiceForRender('inv-1'))!.branding.footerText).toBe('Partner footer');
  });

  it("prints the invoice's frozen footer over both levels", async () => {
    queue({ ...invoice, terms: 'Frozen at issue' }, 'Org footer');
    expect((await loadInvoiceForRender('inv-1'))!.branding.footerText).toBe('Frozen at issue');
  });
});

// #9676: invoices fall back to the partner's Branding settings like quotes do;
// an org portal_branding value still wins field by field.
describe('loadInvoiceForRender partner branding fallback (#9676)', () => {
  const brandedPartner = { ...partner, settings: { branding: { logoUrl: 'https://cdn.example.test/p.png', primaryColor: '#112233' } } };

  it('carries the partner logo and colour when the org row has none', async () => {
    rows.next = [[invoice], [brandedPartner], [{ logoUrl: null, primaryColor: null, footerText: null }]];
    rows.i = 0;
    const loaded = (await loadInvoiceForRender('inv-1'))!;
    expect(loaded.branding).toMatchObject({ logoUrl: 'https://cdn.example.test/p.png', primaryColor: '#112233' });
  });

  it('lets an org portal_branding override win', async () => {
    rows.next = [[invoice], [brandedPartner], [{ logoUrl: 'https://cdn.example.test/org.png', primaryColor: '#abcdef', footerText: null }]];
    rows.i = 0;
    const loaded = (await loadInvoiceForRender('inv-1'))!;
    expect(loaded.branding).toMatchObject({ logoUrl: 'https://cdn.example.test/org.png', primaryColor: '#abcdef' });
  });
});

// #9414 W3a: the PDF render holds an open transaction, so the assembler must not open a second
// connection for the partner/branding reads: the loader hands over what it read on its own.
describe('loadInvoiceForRender preloaded branding (W3a)', () => {
  it('hands the assembler the partner and branding rows it read', async () => {
    queue(invoice, 'Org footer');
    const loaded = (await loadInvoiceForRender('inv-1'))!;
    expect(loaded.preloaded?.partner).toMatchObject({ name: 'Lantern IT' });
    expect(loaded.preloaded?.brand).toEqual({ logoUrl: null, primaryColor: null });
  });

  it('hands over nothing when the partner row was not visible (org-scoped caller), so the assembler falls back to its own read', async () => {
    rows.next = [[invoice], [], []];
    rows.i = 0;
    expect((await loadInvoiceForRender('inv-1'))!.preloaded).toBeUndefined();
  });
});

// #9454: same reason for the online-payment availability read (stripe_connect_accounts).
// Read order after the branding row: the stripe_connect row (.limit).
describe('loadInvoiceForRender online-payment availability (#9454)', () => {
  it('reads it on the caller connection for an issued invoice whose partner row is visible', async () => {
    rows.next = [[invoice], [partner], [], [{ status: 'connected', apiKey: 'enc:key' }]];
    rows.i = 0;
    expect((await loadInvoiceForRender('inv-1'))!.onlinePaymentAvailable).toBe(true);
    rows.next = [[invoice], [partner], [], []];
    rows.i = 0;
    expect((await loadInvoiceForRender('inv-1'))!.onlinePaymentAvailable).toBe(false);
  });

  it('leaves it unread for an org-scoped caller (partner row not visible): renderInvoicePdf falls back', async () => {
    rows.next = [[invoice], [], [], [{ status: 'connected', apiKey: 'enc:key' }]];
    rows.i = 0;
    expect((await loadInvoiceForRender('inv-1'))!.onlinePaymentAvailable).toBeUndefined();
    expect(rows.i).toBe(3);
  });

  it('leaves it unread for a draft (no pay line on a draft)', async () => {
    // A draft with a bill-to name skips the org read: invoice, partner, branding.
    rows.next = [[{ ...invoice, status: 'draft' }], [partner], [], [{ status: 'connected', apiKey: 'enc:key' }]];
    rows.i = 0;
    expect((await loadInvoiceForRender('inv-1'))!.onlinePaymentAvailable).toBeUndefined();
    expect(rows.i).toBe(3);
  });
});
