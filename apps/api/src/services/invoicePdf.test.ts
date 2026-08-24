import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import PDFDocument from 'pdfkit';
import { formatMoney } from '@breeze/shared';
import { renderInvoiceHtml, renderInvoicePdfBuffer, buildInvoiceEmailAmounts, invoiceColumnsFor, type InvoiceBranding } from './invoicePdf';
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

// Inflate pdfkit's flate content streams and decode each BT…ET text object to
// {text, x, y} (WinAnsi bytes → latin1). Mirrors quotePdf.test.ts.
function extractPositionedPdfText(pdf: Buffer): { text: string; x: number; y: number }[] {
  const raw = pdf.toString('latin1');
  const headerRe = /\/Length\s+(\d+)[\s\S]{0,120}?\/Filter\s+\/FlateDecode[\s\S]{0,40}?stream\r?\n/g;
  const fragments: { text: string; x: number; y: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(raw))) {
    const compressed = Buffer.from(raw.slice(headerRe.lastIndex, headerRe.lastIndex + Number(match[1])), 'latin1');
    let body: string;
    try { body = zlib.inflateSync(compressed).toString('latin1'); } catch { continue; }
    const textObjectRe = /BT\s+([\s\S]*?)\s+ET/g;
    let textObject: RegExpExecArray | null;
    while ((textObject = textObjectRe.exec(body))) {
      const tm = /1 0 0 1 ([\d.]+) ([\d.]+) Tm/.exec(textObject[1]!);
      if (!tm) continue;
      let text = '';
      const tokenRe = /<([0-9a-fA-F]+)>|\(((?:[^()\\]|\\.)*)\)/g;
      let token: RegExpExecArray | null;
      while ((token = tokenRe.exec(textObject[1]!))) {
        text += token[1] !== undefined
          ? Buffer.from(token[1].length % 2 ? `${token[1]}0` : token[1], 'hex').toString('latin1')
          : token[2]!.replace(/\\([()\\])/g, '$1');
      }
      if (text) fragments.push({ text, x: Number(tm[1]), y: 841.89 - Number(tm[2]) });
    }
  }
  return fragments;
}

// numeric(12,2) schema maximum — the widest string the formatter can emit.
const MAX_AMOUNT = '9999999999.99';
const MAX_AMOUNT_RE = /9.999.999.999.99/;

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

  it('formats money with the stamped document locale (de-DE EUR)', () => {
    const html = renderInvoiceHtml(
      makeInvoice({ currencyCode: 'EUR', documentLocale: 'de-DE', subtotal: '1000.00', taxTotal: '0.00', total: '1000.00', balance: '1000.00' }),
      [makeLine({ lineTotal: '1000.00' })],
      branding,
    );
    expect(html).toContain('1.000,00\u00a0€');
    expect(html).not.toContain('$');
  });

  it('falls back to the branding locale when the document is unstamped (fr-FR EUR)', () => {
    const html = renderInvoiceHtml(
      makeInvoice({ currencyCode: 'EUR', documentLocale: null, subtotal: '1000.00', taxTotal: '0.00', total: '1000.00', balance: '1000.00' }),
      [makeLine({ lineTotal: '1000.00' })],
      { ...branding, locale: 'fr-FR' },
    );
    // Intl fr-FR: narrow no-break space as the grouping separator, NBSP before the symbol.
    expect(html).toContain('1\u202f000,00\u00a0€');
    expect(html).toContain(formatMoney(1000, 'EUR', 'fr-FR'));
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

  it('sizes the money columns for prefix-code currencies at the row font', () => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const taxed = invoiceColumnsFor(doc, true);
    const untaxed = invoiceColumnsFor(doc, false);
    // Line rows draw money at Helvetica regular 10 — measure at the REAL font.
    doc.font('Helvetica').fontSize(10);
    const rowAmountWidth = doc.widthOfString(formatMoney(888888.88, 'CHF', 'de-CH'));
    expect(taxed.colNumW).toBeGreaterThanOrEqual(rowAmountWidth + 2);
    expect(untaxed.colNumW).toBeGreaterThanOrEqual(rowAmountWidth + 2);
    expect(taxed.colAmtX + taxed.colNumW).toBeCloseTo(taxed.right, 5);
    expect(untaxed.colAmtX + untaxed.colNumW).toBeCloseTo(untaxed.right, 5);
    // Columns never overlap.
    expect(taxed.colQtyX).toBeGreaterThanOrEqual(taxed.left + taxed.colDescW);
    expect(taxed.colTaxX).toBeGreaterThanOrEqual(taxed.colQtyX + taxed.colNumW);
    expect(taxed.colAmtX).toBeGreaterThanOrEqual(taxed.colTaxX + taxed.colNumW);
    expect(untaxed.colAmtX).toBeGreaterThanOrEqual(untaxed.colQtyX + untaxed.colNumW);
  });

  it('gives the emphasised total its own box wide enough for bold 14', () => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.font('Helvetica-Bold').fontSize(14);
    const emphasisWidth = doc.widthOfString(formatMoney(1000000, 'CHF', 'de-CH'));
    const labelWidth = doc.widthOfString('Balance due');
    for (const c of [invoiceColumnsFor(doc, true), invoiceColumnsFor(doc, false)]) {
      expect(c.colSummaryNumW).toBeGreaterThanOrEqual(emphasisWidth + 2);
      expect(c.colSummaryAmtX + c.colSummaryNumW).toBeCloseTo(c.right, 5);
      // The widest static label at the same bold 14 must fit its own box —
      // rows advance by fixed constants, so a wrapped label overprints.
      expect(c.colSummaryLabelW).toBeGreaterThanOrEqual(labelWidth + 2);
      expect(c.colSummaryLabelX + c.colSummaryLabelW + 4).toBeCloseTo(c.colSummaryAmtX, 5);
    }
  });

  // #3777 review F10: the boxes are sized for ~1M; numeric(12,2) allows
  // 9'999'999'999.99, which at CHF/de-CH is ~99pt (Helvetica 10) against an
  // 84pt line box and ~140pt (Helvetica-Bold 14) against the 119pt summary box.
  // The renderer must shrink the figure to fit rather than wrap/overprint.
  it.each([[true], [false]])('keeps schema-maximum amounts inside their boxes on one line (showTax=%s)', async (showTax) => {
    const invoice = makeInvoice({
      currencyCode: 'CHF', documentLocale: 'de-CH',
      subtotal: MAX_AMOUNT, taxRate: showTax ? '0.077' : null, taxTotal: showTax ? MAX_AMOUNT : '0',
      total: MAX_AMOUNT, amountPaid: MAX_AMOUNT, balance: MAX_AMOUNT,
    } as Partial<InvoiceRow>);
    const lines = [makeLine({ quantity: '1', unitPrice: MAX_AMOUNT, lineTotal: MAX_AMOUNT, taxable: true })];
    const pdf = await renderInvoicePdfBuffer(invoice, lines, branding);
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const c = invoiceColumnsFor(doc, showTax);
    const money = extractPositionedPdfText(pdf).filter((f) => MAX_AMOUNT_RE.test(f.text));
    // line AMOUNT + Subtotal + (Tax) + Total + Paid + Balance due. The per-line
    // TAX cell is lineTotal × rate, so it never equals the maximum itself.
    expect(money.length).toBe(showTax ? 6 : 5);
    for (const f of money) {
      // Right-aligned with lineBreak:false, pdfkit starts an over-wide string
      // LEFT of the box; a wrapped string shows up as a fragment without the
      // full figure. Both are caught by the x floor + the regex above.
      expect(f.x).toBeGreaterThanOrEqual(Math.min(c.colTaxX, c.colAmtX, c.colSummaryAmtX) - 0.5);
    }
    // The whole figure stays on its row: no fragment holds only a tail like "999.99".
    const tails = extractPositionedPdfText(pdf).filter((f) => /^[\u2019'\u0092]?999/.test(f.text.trim()));
    expect(tails).toHaveLength(0);
    // The Balance due amount sits on its label's row (a shrunk font shifts the
    // baseline by a few points; a wrapped second line would land ≥14pt lower).
    const balance = extractPositionedPdfText(pdf).find((f) => f.text.startsWith('Balance due'))!;
    expect(money.some((f) => Math.abs(f.y - balance.y) < 6)).toBe(true);
    doc.end();
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

// ---------------------------------------------------------------------------
// Seller From block + T&C tests
// ---------------------------------------------------------------------------

const sellerSnapshot = {
  name: 'Acme MSP LLC', phone: '+1 555 0100', email: 'billing@acme.test', website: 'acme.test',
  address: { line1: '1 Main St', line2: null, city: 'Austin', region: 'TX', postalCode: '78701', country: 'US' },
};

it('renderInvoiceHtml shows the From block and T&C', () => {
  const html = renderInvoiceHtml(
    { invoiceNumber: 'INV-1', currencyCode: 'USD', subtotal: '10', taxTotal: '0', total: '10', amountPaid: '0', balance: '10', billToName: 'Cust', sellerSnapshot, termsAndConditions: 'Net 30 terms' } as never,
    [],
    { partnerName: 'Acme MSP LLC' },
  );
  expect(html).toContain('From');
  expect(html).toContain('billing@acme.test');
  expect(html).toContain('Net 30 terms');
});

it('renderInvoicePdfBuffer emits a %PDF with a seller snapshot present', async () => {
  const buf = await renderInvoicePdfBuffer(
    { invoiceNumber: 'INV-1', currencyCode: 'USD', subtotal: '10', taxTotal: '0', total: '10', amountPaid: '0', balance: '10', billToName: 'Cust', sellerSnapshot, termsAndConditions: 'Net 30' } as never,
    [],
    { partnerName: 'Acme MSP LLC' },
  );
  expect(buf.subarray(0, 4).toString()).toBe('%PDF');
});

describe('buildInvoiceEmailAmounts (deposit-vs-balance split for the email)', () => {
  const base = { total: '1000.00', currencyCode: 'USD' as string | null };

  it('a deposit invoice with nothing paid asks for the DEPOSIT, not the total', () => {
    const a = buildInvoiceEmailAmounts({ ...base, depositDue: '300.00', amountPaid: '0.00', balance: '1000.00' });
    expect(a.amountDueNow).toBe('$300.00');
    // The regression this test exists for: amountDueNow must NOT be the total, or a
    // customer would be emailed to pay the full amount before any deposit is applied.
    expect(a.amountDueNow).not.toBe(a.total);
    expect(a.total).toBe('$1,000.00');
    expect(a.amountPaid).toBeUndefined();
  });

  it('once the deposit is paid, it asks for the remaining balance and shows amountPaid', () => {
    const a = buildInvoiceEmailAmounts({ ...base, depositDue: '300.00', amountPaid: '300.00', balance: '700.00' });
    expect(a.amountDueNow).toBe('$700.00');
    expect(a.amountPaid).toBe('$300.00');
  });

  it('a non-deposit invoice asks for the full balance', () => {
    const a = buildInvoiceEmailAmounts({ ...base, depositDue: null, amountPaid: '0.00', balance: '1000.00' });
    expect(a.amountDueNow).toBe('$1,000.00');
    expect(a.amountPaid).toBeUndefined();
  });

  it('formats with the stamped document locale and a zero-decimal currency', () => {
    const a = buildInvoiceEmailAmounts({ total: '1000', currencyCode: 'JPY', depositDue: null, amountPaid: '0', balance: '1000', documentLocale: 'en' });
    expect(a.total).toBe('¥1,000');
    expect(a.amountDueNow).toBe('¥1,000');
  });

  it('document locale wins over the caller locale; the caller locale is the fallback', () => {
    const stamped = buildInvoiceEmailAmounts({ ...base, currencyCode: 'EUR', depositDue: null, amountPaid: '0.00', balance: '1000.00', documentLocale: 'de-DE' }, 'fr-FR');
    expect(stamped.total).toBe(formatMoney(1000, 'EUR', 'de-DE'));
    const fallback = buildInvoiceEmailAmounts({ ...base, currencyCode: 'EUR', depositDue: null, amountPaid: '0.00', balance: '1000.00', documentLocale: null }, 'fr-FR');
    expect(fallback.total).toBe(formatMoney(1000, 'EUR', 'fr-FR'));
  });

  it('clamps the charge to the balance when a manual payment shrank it below the deposit', () => {
    const a = buildInvoiceEmailAmounts({ ...base, depositDue: '300.00', amountPaid: '900.00', balance: '100.00' });
    expect(a.amountDueNow).toBe('$100.00'); // never advertises more than is owed
  });
})
