import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { renderInvoiceHtml, renderInvoicePdfBuffer, type InvoiceBranding } from './invoicePdf';
import { invoices, invoiceLines } from '../db/schema';

type InvoiceRow = typeof invoices.$inferSelect;
type InvoiceLineRow = typeof invoiceLines.$inferSelect;

// Minimal fixtures — only the fields the renderers read. Cast through unknown so
// we don't have to spell out every nullable column.
function makeInvoice(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: 'inv-1',
    partnerId: 'p-1',
    orgId: 'o-1',
    siteId: null,
    invoiceNumber: 'INV-2026-0001',
    status: 'sent',
    currencyCode: 'USD',
    issueDate: '2026-06-14',
    dueDate: '2026-07-14',
    subtotal: '150.00',
    taxRate: '0.085',
    taxTotal: '8.50',
    total: '158.50',
    amountPaid: '0.00',
    balance: '158.50',
    billToName: 'Acme Corp',
    billToAddress: { line1: '123 Main St', city: 'Springfield', region: 'IL', postalCode: '62704', country: 'US' },
    billToTaxId: 'TAX-99',
    billToTaxExempt: false,
    notes: 'Thanks for your business',
    terms: 'Net 30. Late fees apply.',
    ...overrides,
  } as unknown as InvoiceRow;
}

function makeLine(overrides: Partial<InvoiceLineRow> = {}): InvoiceLineRow {
  return {
    id: `line-${Math.random()}`,
    invoiceId: 'inv-1',
    orgId: 'o-1',
    sourceType: 'manual',
    sourceId: null,
    catalogItemId: null,
    parentLineId: null,
    ticketId: null,
    description: 'Consulting',
    quantity: '1',
    unitPrice: '100.00',
    costBasis: null,
    revenueAllocation: null,
    taxable: true,
    customerVisible: true,
    lineTotal: '100.00',
    isUnapprovedTime: false,
    sortOrder: 0,
    ...overrides,
  } as unknown as InvoiceLineRow;
}

const branding: InvoiceBranding = {
  partnerName: 'Lantern MSP',
  logoUrl: null,
  primaryColor: '#0ea5e9',
  footerText: 'Powered by Lantern',
  currencyCode: 'USD',
};

describe('renderInvoiceHtml', () => {
  it('excludes hidden (non-customer-visible) lines', () => {
    const lines = [
      makeLine({ description: 'Visible service', lineTotal: '100.00', customerVisible: true }),
      makeLine({ description: 'SECRET bundle component', lineTotal: '999.00', customerVisible: false }),
    ];
    const html = renderInvoiceHtml(makeInvoice(), lines, branding);
    expect(html).toContain('Visible service');
    expect(html).not.toContain('SECRET bundle component');
  });

  it('renders the bill-to block and the invoice number', () => {
    const html = renderInvoiceHtml(makeInvoice(), [makeLine()], branding);
    expect(html).toContain('Acme Corp');
    expect(html).toContain('123 Main St');
    expect(html).toContain('Springfield, IL, 62704');
    expect(html).toContain('INV-2026-0001');
    expect(html).toContain('Tax ID: TAX-99');
  });

  it('renders subtotal, tax and total', () => {
    const html = renderInvoiceHtml(makeInvoice(), [makeLine()], branding);
    expect(html).toContain('$150.00'); // subtotal
    expect(html).toContain('$8.50');   // tax
    expect(html).toContain('$158.50'); // total
    expect(html).toContain('8.50%');   // tax rate label
  });

  it('shows the paid/balance rows only when a payment has been made', () => {
    const unpaid = renderInvoiceHtml(makeInvoice(), [makeLine()], branding);
    expect(unpaid).not.toContain('Balance due');
    const partial = renderInvoiceHtml(
      makeInvoice({ amountPaid: '50.00', balance: '108.50' }),
      [makeLine()],
      branding,
    );
    expect(partial).toContain('Balance due');
    expect(partial).toContain('$108.50');
  });

  it('escapes HTML in customer-controlled fields', () => {
    const html = renderInvoiceHtml(
      makeInvoice({ billToName: '<script>alert(1)</script>' }),
      [makeLine({ description: '<b>bold</b>' })],
      branding,
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('renderInvoicePdfBuffer', () => {
  it('produces a valid %PDF- buffer', async () => {
    const pdf = await renderInvoicePdfBuffer(makeInvoice(), [makeLine()], branding);
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(100);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // sha256 is a stable 64-hex digest of the bytes (what renderInvoicePdf stores).
    const sha = createHash('sha256').update(pdf).digest('hex');
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it('renders multiple grouped lines without throwing', async () => {
    const lines = [
      makeLine({ description: 'Time entry A', ticketId: 't-1', lineTotal: '50.00' }),
      makeLine({ description: 'Part B', ticketId: 't-1', lineTotal: '30.00' }),
      makeLine({ description: 'Standalone', ticketId: null, lineTotal: '70.00' }),
      makeLine({ description: 'Hidden child', customerVisible: false, lineTotal: '5.00' }),
    ];
    const pdf = await renderInvoicePdfBuffer(makeInvoice(), lines, branding);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
