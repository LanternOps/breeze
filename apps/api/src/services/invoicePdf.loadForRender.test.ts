import { beforeEach, describe, expect, it, vi } from 'vitest';

// loadInvoiceForRender reads, in order: the invoice (.limit), its lines
// (.orderBy), the partner (.limit), then the org's portal_branding (.limit).
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
  rows.next = [[inv], [], [partner], orgFooter === null ? [] : [{ logoUrl: null, primaryColor: null, footerText: orgFooter }]];
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
