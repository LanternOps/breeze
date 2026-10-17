import { describe, it, expect } from 'vitest';
import { renderInvoicePdfBuffer, type InvoiceBranding } from './invoicePdf';
import { invoices } from '../db/schema';

type InvoiceRow = typeof invoices.$inferSelect;

function makeInvoice(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: 'inv-1', partnerId: 'p-1', orgId: 'o-1', siteId: null,
    invoiceNumber: 'INV-1', status: 'sent', currencyCode: 'USD',
    issueDate: '2026-06-14', dueDate: '2026-07-14',
    subtotal: '100.00', taxRate: '0', taxTotal: '0', total: '100.00',
    amountPaid: '0.00', balance: '100.00', billToName: 'Acme',
    billToAddress: null, billToTaxId: null, billToTaxExempt: false,
    notes: null, terms: null,
    ...overrides,
  } as unknown as InvoiceRow;
}

const branding: InvoiceBranding = { partnerName: 'Partner' };

/** First page's /MediaBox [0 0 w h] from the (uncompressed) page dictionary. */
function mediaBox(pdf: Buffer): [number, number] {
  const m = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(pdf.toString('latin1'));
  if (!m) throw new Error('no MediaBox');
  return [Number(m[1]), Number(m[2])];
}

const LETTER: [number, number] = [612, 792];
const A4: [number, number] = [595.28, 841.89];

describe('renderInvoicePdfBuffer page size (#8969)', () => {
  it('renders Letter when the invoice froze letter', async () => {
    const pdf = await renderInvoicePdfBuffer(makeInvoice({ documentPageSize: 'letter' }), [], branding);
    expect(mediaBox(pdf)).toEqual(LETTER);
  });

  it('renders A4 when the invoice froze a4, even if the partner default is letter', async () => {
    const pdf = await renderInvoicePdfBuffer(
      makeInvoice({ documentPageSize: 'a4' }), [], { ...branding, pageSize: 'letter' });
    expect(mediaBox(pdf)).toEqual(A4);
  });

  it('falls back to the branding (partner) default when unstamped', async () => {
    const pdf = await renderInvoicePdfBuffer(
      makeInvoice({ documentPageSize: null }), [], { ...branding, pageSize: 'letter' });
    expect(mediaBox(pdf)).toEqual(LETTER);
  });

  it('falls back to A4 when neither is set', async () => {
    const pdf = await renderInvoicePdfBuffer(makeInvoice({ documentPageSize: null }), [], branding);
    expect(mediaBox(pdf)).toEqual(A4);
  });
});
