import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import PDFDocument from 'pdfkit';
import { formatMoney } from '@breeze/shared';
import { renderInvoicePdfBuffer, buildInvoiceEmailAmounts, resolveDraftBillTo, type InvoiceBranding } from './invoicePdf';
import { documentColumnsFor } from './documentPdfTable';
import { formatMoneyForPdf } from './pdfMoney';
import { resolveDocumentFooter } from './documentFooter';
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

// pdfkit encodes WinAnsi bytes; the shared decoder reads them as latin1, so the
// euro sign arrives as \u0080 and the em dash as \u0097.
const win = (text: string) => text.replace(/\u20ac/g, '\u0080').replace(/\u2014/g, '\u0097');
async function pdfText(invoice: InvoiceRow, lines: InvoiceLineRow[], br: InvoiceBranding = branding): Promise<string> {
  return extractPositionedPdfText(await renderInvoicePdfBuffer(invoice, lines, br)).map((f) => f.text).join('\n');
}

// The customer-view HTML renderer is gone (#9414 W3a): the PDF draws the same
// customer document the screens render, so these assertions read the PDF text.
describe('invoice PDF content', () => {
  it('excludes hidden (non-customer-visible) lines', async () => {
    const lines = [
      makeLine({ description: 'Visible service', lineTotal: '100.00', customerVisible: true }),
      makeLine({ description: 'SECRET bundle component', lineTotal: '999.00', customerVisible: false }),
    ];
    const text = await pdfText(makeInvoice(), lines);
    expect(text).toContain('Visible service');
    expect(text).not.toContain('SECRET bundle component');
  });

  it('renders the bill-to block and the invoice number', async () => {
    const text = await pdfText(makeInvoice(), [makeLine()]);
    expect(text).toContain('Acme Corp');
    expect(text).toContain('123 Main St');
    expect(text).toContain('Springfield, IL, 62704');
    expect(text).toContain('INV-2026-0001');
    expect(text).toContain('Tax ID: TAX-99');
  });

  it('renders subtotal, tax and total', async () => {
    const text = await pdfText(makeInvoice(), [makeLine()]);
    expect(text).toContain('$150.00'); // subtotal
    expect(text).toContain('$8.50');   // tax
    expect(text).toContain('$158.50'); // total
    expect(text).toContain('Tax (8.5%)'); // tax rate label
  });

  it('shows the paid row only when a payment has been made; Balance due is always the closing row', async () => {
    const unpaid = await pdfText(makeInvoice(), [makeLine()]);
    expect(unpaid).toContain('Balance due');
    expect(unpaid).not.toMatch(/^Paid$/m);
    const partial = await pdfText(makeInvoice({ amountPaid: '50.00', balance: '108.50' }), [makeLine()]);
    expect(partial).toMatch(/^Paid$/m);
    expect(partial).toContain('-$50.00');
    expect(partial).toContain('$108.50');
  });

  it('formats money with the stamped document locale (de-DE EUR)', async () => {
    const text = await pdfText(
      makeInvoice({ currencyCode: 'EUR', documentLocale: 'de-DE', subtotal: '1000.00', taxTotal: '0.00', total: '1000.00', balance: '1000.00' }),
      [makeLine({ lineTotal: '1000.00' })],
    );
    expect(text).toContain(win('1.000,00\u00a0\u20ac'));
    expect(text).not.toContain('$');
  });

  it('falls back to the branding locale when the document is unstamped (fr-FR EUR)', async () => {
    const text = await pdfText(
      makeInvoice({ currencyCode: 'EUR', documentLocale: null, subtotal: '1000.00', taxTotal: '0.00', total: '1000.00', balance: '1000.00' }),
      [makeLine({ lineTotal: '1000.00' })],
      { ...branding, locale: 'fr-FR' },
    );
    // Intl fr-FR: narrow no-break space as the grouping separator (folded to NBSP for pdfkit), NBSP before the symbol.
    expect(text).toContain(win(formatMoneyForPdf(1000, 'EUR', 'fr-FR')));
    expect(text).toContain(win('1\u00a0000,00\u00a0\u20ac'));
  });

  // #6467: the worked-vs-billed disclosure is rendered from workedMinutes
  // (structured data), never baked into `description` — so it survives
  // regardless of what the description says, and localizes off the same
  // document_locale the rest of the invoice's money glyphs already honour.
  it('shows the worked-vs-billed note in English for a time_entry line, from workedMinutes not description', async () => {
    const text = await pdfText(makeInvoice(), [makeLine({ sourceType: 'time_entry', description: 'On-site', quantity: '1.00', workedMinutes: 30 })]);
    expect(text).toContain('0.50 h worked · 1.00 h billed'.replace('·', '\u00b7'));
  });

  it('shows no note when workedMinutes equals the billed quantity', async () => {
    const text = await pdfText(makeInvoice(), [makeLine({ sourceType: 'time_entry', description: 'Remote', quantity: '1.00', workedMinutes: 60 })]);
    expect(text).not.toContain('h worked');
  });

  it('shows no note for a non-time-entry line (workedMinutes null)', async () => {
    const text = await pdfText(makeInvoice(), [makeLine({ sourceType: 'manual', description: 'Widget', workedMinutes: null })]);
    expect(text).not.toContain('h worked');
  });

  it('localizes the note off the stamped document locale (pt-BR)', async () => {
    const text = await pdfText(
      makeInvoice({ documentLocale: 'pt-BR' }),
      [makeLine({ sourceType: 'time_entry', description: 'On-site', quantity: '1.00', workedMinutes: 30 })],
    );
    expect(text).toContain('0.50 h trabalhadas \u00b7 1.00 h faturadas');
  });
});

describe('unit price column (#7508)', () => {
  const lines = [makeLine({ quantity: '3', unitPrice: '1234.50', lineTotal: '3703.50' })];

  it.each([[true], [false]])('PDF draws a PRICE header and the unit price in its own column (showTax=%s)', async (showTax) => {
    const invoice = makeInvoice({
      currencyCode: 'EUR', documentLocale: 'de-DE',
      taxRate: showTax ? '0.085' : null, taxTotal: showTax ? '8.50' : '0',
    } as Partial<InvoiceRow>);
    const pdf = await renderInvoicePdfBuffer(invoice, lines, branding);
    const frags = extractPositionedPdfText(pdf);
    const c = documentColumnsFor(new PDFDocument({ size: 'A4', margin: 50 }), { showTax });
    expect(frags.some((f) => f.text === 'PRICE' && f.x >= c.colUnitX - 0.5 && f.x < c.colUnitX + c.colNumW)).toBe(true);
    const unit = frags.find((f) => /1.234,50/.test(f.text));
    expect(unit).toBeDefined();
    expect(unit!.x).toBeGreaterThanOrEqual(c.colUnitX - 0.5);
    expect(unit!.x).toBeLessThan(c.colUnitX + c.colNumW);
    // Unit price sits between Qty and Amount on the row.
    const amount = frags.find((f) => /3.703,50/.test(f.text) && Math.abs(f.y - unit!.y) < 1)!;
    expect(unit!.x).toBeLessThan(amount.x);
  });
});

describe('invoice PDF column geometry (#9401; shared with the quote PDF since W3b)', () => {
  it.each([
    ['A4', true], ['A4', false], ['LETTER', true], ['LETTER', false],
  ] as const)('%s showTax=%s: description column keeps its share and money still fits', (size, showTax) => {
    const doc = new PDFDocument({ size, margin: 50 });
    const inv = documentColumnsFor(doc, { showTax });
    // The quote PDF draws through the same module, so there is one geometry to pin.
    expect(inv.colDescW / inv.contentWidth).toBeCloseTo(showTax ? 0.42 : 0.57, 5);
    doc.font('Helvetica').fontSize(10);
    const w = doc.widthOfString(formatMoneyForPdf('888888.88', 'CHF', 'de-CH'));
    expect(inv.colNumW).toBeGreaterThanOrEqual(w + 2);
    // The narrow QTY box still holds a realistic quantity on one line.
    expect(inv.colQtyW).toBeGreaterThanOrEqual(doc.widthOfString('1000.25') + 2);
    // Every column stays clear of its left neighbour, and AMOUNT ends at the right edge.
    expect(inv.colQtyX).toBeGreaterThanOrEqual(inv.left + inv.colDescW);
    expect(inv.colUnitX).toBeGreaterThanOrEqual(inv.colQtyX + inv.colQtyW);
    if (showTax) expect(inv.colTaxX).toBeGreaterThanOrEqual(inv.colUnitX + inv.colNumW);
    expect(inv.colAmtX).toBeGreaterThanOrEqual((showTax ? inv.colTaxX : inv.colUnitX) + inv.colNumW);
    expect(inv.colAmtX + inv.colNumW).toBeCloseTo(inv.right, 5);
  });
});

describe('invoice PDF multi-line description (#9401)', () => {
  it('draws each line of a bulleted description on its own row, below the title', async () => {
    const lines = [makeLine({ name: 'Server build', description: 'Final build:\n• Dell R360\n• Windows Server 2025' })];
    const pdf = await renderInvoicePdfBuffer(makeInvoice(), lines, branding);
    const frags = extractPositionedPdfText(pdf);
    const row = (re: RegExp) => frags.find((f) => re.test(f.text))!;
    const [title, a, b, c] = [row(/Server build/), row(/Final build:/), row(/Dell R360/), row(/Windows Server 2025/)];
    for (const f of [title, a, b, c]) expect(f).toBeDefined();
    // pdf y grows upward in extraction order-agnostic terms: all four rows are distinct.
    expect(new Set([title.y, a.y, b.y, c.y]).size).toBe(4);
    // Amount cell sits on the title row, not on a description row.
    expect(frags.some((f) => /100\.00/.test(f.text) && Math.abs(f.y - title.y) < 1)).toBe(true);
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
    const taxed = documentColumnsFor(doc, { showTax: true });
    const untaxed = documentColumnsFor(doc, { showTax: false });
    // Line rows draw money at Helvetica regular 10 — measure at the REAL font.
    doc.font('Helvetica').fontSize(10);
    const rowAmountWidth = doc.widthOfString(formatMoney(888888.88, 'CHF', 'de-CH'));
    expect(taxed.colNumW).toBeGreaterThanOrEqual(rowAmountWidth + 2);
    expect(untaxed.colNumW).toBeGreaterThanOrEqual(rowAmountWidth + 2);
    expect(taxed.colAmtX + taxed.colNumW).toBeCloseTo(taxed.right, 5);
    expect(untaxed.colAmtX + untaxed.colNumW).toBeCloseTo(untaxed.right, 5);
    // Columns never overlap.
    expect(taxed.colQtyX).toBeGreaterThanOrEqual(taxed.left + taxed.colDescW);
    expect(taxed.colUnitX).toBeGreaterThanOrEqual(taxed.colQtyX + taxed.colQtyW);
    expect(taxed.colTaxX).toBeGreaterThanOrEqual(taxed.colUnitX + taxed.colNumW);
    expect(taxed.colAmtX).toBeGreaterThanOrEqual(taxed.colTaxX + taxed.colNumW);
    expect(untaxed.colUnitX).toBeGreaterThanOrEqual(untaxed.colQtyX + untaxed.colQtyW);
    expect(untaxed.colAmtX).toBeGreaterThanOrEqual(untaxed.colUnitX + untaxed.colNumW);
  });

  it('gives the emphasised total its own box wide enough for bold 14', () => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.font('Helvetica-Bold').fontSize(14);
    const emphasisWidth = doc.widthOfString(formatMoney(1000000, 'CHF', 'de-CH'));
    const labelWidth = doc.widthOfString('Balance due');
    for (const c of [documentColumnsFor(doc, { showTax: true }), documentColumnsFor(doc, { showTax: false })]) {
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
    const c = documentColumnsFor(doc, { showTax });
    const money = extractPositionedPdfText(pdf).filter((f) => MAX_AMOUNT_RE.test(f.text));
    // line UNIT PRICE + line AMOUNT + Subtotal + (Tax) + Total + Paid + Balance due.
    // The per-line TAX cell is lineTotal × rate, so it never equals the maximum itself.
    expect(money.length).toBe(showTax ? 7 : 6);
    for (const f of money) {
      // Right-aligned with lineBreak:false, pdfkit starts an over-wide string
      // LEFT of the box; a wrapped string shows up as a fragment without the
      // full figure. Both are caught by the x floor + the regex above.
      expect(f.x).toBeGreaterThanOrEqual(Math.min(c.colUnitX, c.colTaxX, c.colAmtX, c.colSummaryAmtX) - 0.5);
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

it('renders the From block and T&C', async () => {
  const text = extractPositionedPdfText(await renderInvoicePdfBuffer(
    { invoiceNumber: 'INV-1', currencyCode: 'USD', subtotal: '10', taxTotal: '0', total: '10', amountPaid: '0', balance: '10', billToName: 'Cust', sellerSnapshot, termsAndConditions: 'Net 30 terms' } as never,
    [],
    { partnerName: 'Acme MSP LLC' },
  )).map((f) => f.text).join('\n');
  expect(text).toContain('FROM');
  expect(text).toContain('billing@acme.test');
  expect(text).toContain('Net 30 terms');
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
});

describe('Invoice ticket grouping and line labeling (#3319)', () => {
  it('renders lines without ticketId directly without ticket headers', async () => {
    const lines = [makeLine({ name: 'Monthly Managed Services', description: 'Includes 24/7 monitoring', ticketId: null })];
    const text = await pdfText(makeInvoice(), lines);
    expect(text).toContain('Monthly Managed Services');
    expect(text).toContain('Includes 24/7 monitoring');
    expect(text).not.toContain('Ticket #');
    expect(text).not.toContain('Ticket work');
  });

  it('renders ticket header and follows #3319 title/blurb rules for ticket lines', async () => {
    const lines = [
      makeLine({
        ticketId: 't-1', ticketNumber: '1042', ticketSubject: 'Printer down', ticketCategory: 'Hardware',
        name: 'Diagnostic & Repair', description: 'Replaced feed rollers',
      } as never),
    ];
    const text = await pdfText(makeInvoice(), lines);
    expect(text).toContain('Ticket #1042: Printer down');
    expect(text).toContain('Category: Hardware');
    // #3319: name is the title, description is the blurb
    expect(text).toContain('Diagnostic & Repair');
    expect(text).toContain('Replaced feed rollers');
  });

  it('uses description as title with no blurb for ticket lines with name=null', async () => {
    const lines = [makeLine({ ticketId: 't-1', ticketNumber: '1042', name: null, description: 'Labor on workstation' } as never)];
    expect(await pdfText(makeInvoice(), lines)).toContain('Labor on workstation');
  });

  // The model groups by ticket NUMBER (the portal's rule; portal semantics win,
  // #9414): a ticket with no number gets no header, and two of them share the
  // unheaded group. The old PDF printed one "Ticket work" header per ticket id.
  it('prints no header for number-less tickets, and keeps their lines', async () => {
    const lines = [
      makeLine({ ticketId: 't-1', ticketNumber: null, ticketSubject: 'Network glitch', ticketCategory: 'Network', name: 'Router reboot' } as never),
      makeLine({ ticketId: 't-2', ticketNumber: null, ticketSubject: 'Email issue', ticketCategory: 'Software', name: 'Password reset' } as never),
    ];
    const text = await pdfText(makeInvoice(), lines);
    expect(text).toContain('Router reboot');
    expect(text).toContain('Password reset');
    expect(text).not.toContain('Ticket work');
    expect(text).not.toContain('Ticket #');
  });

  it('keeps first-seen group order when ticket lines interleave', async () => {
    const lines = [
      makeLine({ ticketId: 't-1', ticketNumber: 'A-1', name: 'first-a' } as never),
      makeLine({ ticketId: null, name: 'loose' }),
      makeLine({ ticketId: 't-1', ticketNumber: 'A-1', name: 'second-a' } as never),
      makeLine({ ticketId: 't-2', ticketNumber: 'B-2', name: 'only-b' } as never),
    ];
    const text = await pdfText(makeInvoice(), lines);
    // Ticket A-1's lines group together, the loose line is its own group, B-2 last.
    const order = ['Ticket #A-1', 'first-a', 'second-a', 'loose', 'Ticket #B-2', 'only-b'].map((x) => text.indexOf(x));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('renders English "Category:" label in PDFKit buffer', async () => {
    const lines = [makeLine({ ticketId: 't-1', ticketNumber: '1042', ticketCategory: 'Networking', name: 'Configure Switch' } as never)];
    const pdf = await renderInvoicePdfBuffer(makeInvoice(), lines, branding);
    const textFragments = extractPositionedPdfText(pdf).map((f) => f.text);
    expect(textFragments.some((t) => t.includes('Category: Networking'))).toBe(true);
    expect(textFragments.some((t) => t.includes('Categorie:'))).toBe(false);
  });

  it('localises the category label in pt-BR', async () => {
    const lines = [makeLine({ ticketId: 't-1', ticketNumber: '1042', ticketCategory: 'Rede', name: 'Configurar' } as never)];
    const text = await pdfText(makeInvoice({ documentLocale: 'pt-BR' }), lines);
    expect(text).toContain('Categoria: Rede');
    expect(text).toContain('Ticket n\u00ba 1042');
  });
});

// Sweep paper cut #16: a DRAFT invoice has no bill-to snapshot yet
// (billToName/billToAddress/billToTaxId are stamped only at issue —
// invoiceService.issueInvoice), so before issue the BILL TO block would
// otherwise render completely blank — not even the organization name, which
// the quote PDF prints for the same draft state. Fall back to the org's name
// (and its billing-contact email) for DISPLAY only; an issued invoice's own
// frozen billToName is never touched.
describe('resolveDraftBillTo', () => {
  it('falls back to the org name + billing contact email on a draft with no bill-to name', () => {
    expect(resolveDraftBillTo({
      status: 'draft', billToName: null, orgName: 'Sweep Org B',
      orgBillingContact: { email: 'ap@sweeporgb.example' },
    })).toEqual({ billToName: 'Sweep Org B', billToEmail: 'ap@sweeporgb.example' });
  });

  it('falls back to the org name with a null email when the org has a contact with no email', () => {
    expect(resolveDraftBillTo({
      status: 'draft', billToName: null, orgName: 'Sweep Org B', orgBillingContact: null,
    })).toEqual({ billToName: 'Sweep Org B', billToEmail: null });
  });

  it('treats a blank/whitespace billToName as absent, same as null', () => {
    expect(resolveDraftBillTo({
      status: 'draft', billToName: '   ', orgName: 'Sweep Org B', orgBillingContact: null,
    })).toEqual({ billToName: 'Sweep Org B', billToEmail: null });
  });

  it('a tech-entered billToName on a draft wins over the org name, and no email is surfaced', () => {
    expect(resolveDraftBillTo({
      status: 'draft', billToName: 'Custom Bill-To', orgName: 'Sweep Org B',
      orgBillingContact: { email: 'ap@sweeporgb.example' },
    })).toEqual({ billToName: 'Custom Bill-To', billToEmail: null });
  });

  it('never falls back once issued — the frozen billToName (even null) is returned verbatim', () => {
    expect(resolveDraftBillTo({
      status: 'sent', billToName: null, orgName: 'Sweep Org B', orgBillingContact: { email: 'ap@sweeporgb.example' },
    })).toEqual({ billToName: null, billToEmail: null });
  });
});

// Renderer-level check that the fallback email actually prints under BILL TO
// when a caller (loadInvoiceForRender) supplies it via branding — never
// printed when absent (every issued-invoice fixture in this file omits it).
describe('BILL TO email fallback rendering (sweep paper cut #16)', () => {
  it('renderInvoicePdfBuffer draws the fallback email under BILL TO when billToName is blank', async () => {
    const pdf = await renderInvoicePdfBuffer(
      makeInvoice({ billToName: null, billToAddress: null, billToTaxId: null }),
      [makeLine()],
      { ...branding, billToEmailFallback: 'ap@sweeporgb.example' },
    );
    const text = extractPositionedPdfText(pdf).map((f) => f.text).join('|');
    expect(text).toContain('ap@sweeporgb.example');
  });
});

// Sweep C4: an invoice's ticket label must be the human number the ticket UI
// shows (tickets.internal_number, e.g. T-2026-0001). The legacy
// tickets.ticket_number is NOT NULL, so COALESCE(ticket_number, internal_number)
// always printed the random legacy id ("Ticket #QIMK3YNBYR").
describe('invoiceTicketNumberSql', () => {
  it('prefers internal_number and falls back to the legacy ticket_number', async () => {
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { invoiceTicketNumberSql } = await import('./invoicePdf');
    const { sql: text } = new PgDialect().sqlToQuery(invoiceTicketNumberSql());
    expect(text).toBe('COALESCE("tickets"."internal_number", "tickets"."ticket_number")');
  });

  it('invoiceLineTicketNumberSql: a draft reads live, any issued status reads the frozen ticket_label', async () => {
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { invoiceLineTicketNumberSql } = await import('./invoicePdf');
    const dialect = new PgDialect();
    expect(dialect.sqlToQuery(invoiceLineTicketNumberSql('draft')).sql)
      .toBe('COALESCE("tickets"."internal_number", "tickets"."ticket_number")');
    for (const status of ['sent', 'partially_paid', 'overdue', 'paid', 'void']) {
      expect(dialect.sqlToQuery(invoiceLineTicketNumberSql(status)).sql).toBe('"invoice_lines"."ticket_label"');
    }
  });
});

// #7216: an invoice issued with no footer at any level is stamped terms = ''
// (freezeDocumentFooter). loadInvoiceForRender resolves branding.footerText
// through resolveDocumentFooter exactly as below, so a footer configured AFTER
// issue must not reach either renderer. The NULL (unfrozen draft/legacy) case
// is the control: the same later footer DOES print, proving the assertion bites.
describe('frozen "no footer" invoice render (#7216)', () => {
  const LATER = 'Footer added after issue';
  function renderInputs(terms: string | null) {
    const invoice = makeInvoice({ terms });
    // LATER is the org footer — the level that wins over the partner default (#7510).
    const footerText = resolveDocumentFooter({ documentTerms: invoice.terms, partnerFooter: 'Partner footer added later', brandingFooter: LATER });
    return { invoice, branding: { ...branding, footerText } };
  }
  const pdfText = (pdf: Buffer) => extractPositionedPdfText(pdf).map((f) => f.text).join(' ');

  it("PDF: terms '' prints no footer; terms NULL prints the live one", async () => {
    const frozen = renderInputs('');
    expect(pdfText(await renderInvoicePdfBuffer(frozen.invoice, [makeLine()], frozen.branding))).not.toContain(LATER);
    const live = renderInputs(null);
    expect(pdfText(await renderInvoicePdfBuffer(live.invoice, [makeLine()], live.branding))).toContain(LATER);
  });
});
