/**
 * W3a (#9414) — the shared PDF line table: geometry, row measuring/drawing,
 * pagination with a repeating column header, and the totals box. Drives the
 * module with the same view-model types the screen renders (built by the real
 * invoice builder), then reads the drawn text back out of the PDF.
 */
import { describe, it, expect } from 'vitest';
import PDFDocument from 'pdfkit';
import { buildInvoiceDocumentModel, documentLabelsFor, INVOICE_DTO_FIXTURES as fx } from '@breeze/shared/documents';
import type { CustomerInvoiceDocument, CustomerInvoiceLineDto, DocumentLineRow, DocumentMoney, DocumentLineTableModel } from '@breeze/shared/documents';
import { formatMoney } from '@breeze/shared';
import {
  documentColumnsFor, measureDocumentLineRow, drawDocumentLineRow, drawDocumentLineTable, drawDocumentTotals,
  type DocumentPdfStyle,
} from './documentPdfTable';
import { extractPositionedPdfText, pdfPageCount } from '../testUtils/invoiceRenderFixtures';

const FONTS = {
  heading: { regular: 'Helvetica', bold: 'Helvetica-Bold' },
  body: { regular: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique' },
};
const STYLE: DocumentPdfStyle = { fonts: FONTS, locale: 'en', accent: '#0ea5e9', categoryLabel: (c) => `Category: ${c}` };

type AnyRow = DocumentLineRow<DocumentMoney | 'exempt' | null>;
const lineDto = (n: number, patch: Partial<CustomerInvoiceLineDto> = {}): CustomerInvoiceLineDto => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  ticketNumber: null, ticketCategory: null, name: `Item ${n}`, description: '', quantity: '1',
  unitPrice: '10.00', taxable: false, lineTotal: '10.00', workedMinutes: null, workDate: null, ...patch,
});
function model(lines: CustomerInvoiceLineDto[], patch: Partial<CustomerInvoiceDocument['invoice']> = {}, locale = 'en') {
  const dto: CustomerInvoiceDocument = { ...fx.issued, invoice: { ...fx.issued.invoice, ...patch }, lines, documentLocale: locale };
  return buildInvoiceDocumentModel(dto, documentLabelsFor(locale));
}
const firstRow = (table: DocumentLineTableModel): AnyRow => (table.groups as { days: { rows: AnyRow[] }[] }[])[0]!.days[0]!.rows[0]!;

function render(draw: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (d: Buffer) => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try { draw(doc); doc.end(); } catch (e) { reject(e); }
  });
}

describe('documentColumnsFor', () => {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const taxed = documentColumnsFor(doc, { showTax: true });
  const untaxed = documentColumnsFor(doc, { showTax: false });

  it('starts with the description and uses the #9401 fractions', () => {
    for (const [c, desc, money, qty] of [[taxed, 0.42, 0.155, 0.08], [untaxed, 0.57, 0.16, 0.085]] as const) {
      expect(c.colDescW).toBeCloseTo(c.contentWidth * desc, 5);
      expect(c.colNumW).toBeCloseTo(c.contentWidth * money, 5);
      expect(c.colQtyW).toBeCloseTo(c.contentWidth * qty, 5);
      expect(c.colSummaryNumW).toBeCloseTo(c.contentWidth * 0.24, 5);
      expect(c.colQtyX).toBeGreaterThanOrEqual(c.left + c.colDescW);
      expect(c.colAmtX + c.colNumW).toBeCloseTo(c.right, 5);
      expect(c.colSummaryAmtX + c.colSummaryNumW).toBeCloseTo(c.right, 5);
    }
    expect(taxed.colTaxX).toBeGreaterThanOrEqual(taxed.colUnitX + taxed.colNumW);
    expect(untaxed.colTaxX).toBe(untaxed.colUnitX); // no branch needed by callers
  });

  it('sizes the money boxes for prefix-code currencies at the row font', () => {
    doc.font('Helvetica').fontSize(10);
    const w = doc.widthOfString(formatMoney(888888.88, 'CHF', 'de-CH'));
    expect(taxed.colNumW).toBeGreaterThanOrEqual(w + 2);
    expect(untaxed.colNumW).toBeGreaterThanOrEqual(w + 2);
    doc.font('Helvetica-Bold').fontSize(14);
    expect(taxed.colSummaryNumW).toBeGreaterThanOrEqual(doc.widthOfString(formatMoney(1000000, 'CHF', 'de-CH')) + 2);
  });
});

describe('measureDocumentLineRow / drawDocumentLineRow', () => {
  const cols = (showTax = false) => documentColumnsFor(new PDFDocument({ size: 'A4', margin: 50 }), { showTax });

  it('measures every fragment: a bulleted blurb, a date and a note make the row taller', () => {
    const plain = firstRow(model([lineDto(1)]).lines);
    const rich = firstRow(model([lineDto(2, { name: 'Remote support', description: '• one\n• two\n• three', workedMinutes: 90, quantity: '2', workDate: '2026-02-26' })]).lines);
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const a = measureDocumentLineRow(doc, plain, cols(), FONTS);
    const b = measureDocumentLineRow(doc, rich, cols(), FONTS);
    expect(b.descHeight).toBeGreaterThan(a.descHeight + 3 * 8);
    expect(b.rowHeight).toBeGreaterThan(a.rowHeight);
  });

  it('draws title, qty and amount on one baseline, each line of a bulleted blurb on its own row', async () => {
    const row = firstRow(model([lineDto(1, { name: 'Remote support', description: '• one\n• two', quantity: '2', unitPrice: '10.00', lineTotal: '20.00' })]).lines);
    const c = cols();
    const pdf = await render((doc) => { drawDocumentLineRow(doc, row, 100, { cols: c, style: STYLE, showTax: false }); });
    const t = extractPositionedPdfText(pdf);
    const title = t.find((f) => f.text === 'Remote support')!;
    // Distinct unit and total, so the amount cell cannot be mistaken for the unit-price cell.
    const amount = t.find((f) => f.text === '$20.00')!;
    const unit = t.find((f) => f.text === '$10.00')!;
    expect(amount.x).toBeGreaterThanOrEqual(c.colAmtX - 0.5);
    expect(unit.x).toBeLessThan(c.colAmtX);
    const one = t.find((f) => f.text.includes('one'))!;
    const two = t.find((f) => f.text.includes('two'))!;
    expect(amount.y).toBeCloseTo(title.y, 0);
    expect(unit.y).toBeCloseTo(title.y, 0);
    expect(two.y).toBeGreaterThan(one.y + 6);
    expect(one.y).toBeGreaterThan(title.y + 6);
  });

  it('returns the y after the row (height + 6 gap)', () => {
    const row = firstRow(model([lineDto(1)]).lines);
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const m = measureDocumentLineRow(doc, row, cols(), FONTS);
    expect(drawDocumentLineRow(doc, row, 100, { cols: cols(), style: STYLE, showTax: false })).toBeCloseTo(100 + m.rowHeight, 5);
  });

  it('shrinks a schema-maximum figure to fit its box instead of truncating it', async () => {
    const row = firstRow(model([lineDto(1, { unitPrice: '9999999999.99', lineTotal: '9999999999.99' })], { currencyCode: 'CHF' }, 'de-CH').lines);
    const pdf = await render((doc) => { drawDocumentLineRow(doc, row, 100, { cols: cols(), style: { ...STYLE, locale: 'de-CH' }, showTax: false }); });
    const figures = extractPositionedPdfText(pdf).filter((f) => /9.999.999.999.99/.test(f.text));
    expect(figures).toHaveLength(2);
  });

  it('prints an em dash for a non-taxable line in the tax column and the tax for a taxable one', async () => {
    const m = model([lineDto(1, { taxable: true, lineTotal: '100.00', unitPrice: '100.00' }), lineDto(2, { taxable: false })], { taxRate: '0.085', taxTotal: '8.50' });
    const pdf = await render((doc) => { drawDocumentLineTable(doc, m.lines, 100, { cols: documentColumnsFor(doc, { showTax: true }), style: STYLE }); });
    const t = extractPositionedPdfText(pdf).map((f) => f.text);
    expect(t).toContain('$8.50');
    expect(t).toContain('\u0097'); // WinAnsi em dash
  });
});

describe('drawDocumentLineTable — pagination', () => {
  const many = Array.from({ length: 70 }, (_, i) => lineDto(i + 1, { name: `Row number ${i + 1}`, description: i % 9 === 0 ? 'A note\nsecond line\nthird line' : '' }));

  it('breaks before drawing a row, repeats the column header, and never splits a row across pages', async () => {
    const m = model(many);
    const pdf = await render((doc) => { drawDocumentLineTable(doc, m.lines, 120, { cols: documentColumnsFor(doc, { showTax: false }), style: STYLE }); });
    expect(pdfPageCount(pdf)).toBeGreaterThan(1);
    const t = extractPositionedPdfText(pdf);
    const pages = new Set(t.map((f) => f.page));
    for (const p of pages) expect(t.some((f) => f.page === p && f.text === 'DESCRIPTION')).toBe(true);
    for (let i = 1; i <= 70; i++) {
      const title = t.find((f) => f.text === `Row number ${i}`)!;
      const amount = t.filter((f) => f.page === title.page && f.x > 400 && Math.abs(f.y - title.y) < 1);
      expect(amount.length, `row ${i} keeps its amount on its own page/baseline`).toBeGreaterThan(0);
    }
  });

  it('keeps a ticket group header with the row it introduces', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => lineDto(i + 1, { name: `Row ${i + 1}`, ticketNumber: String(100 + Math.floor(i / 4)), ticketCategory: 'Support' }));
    const m = model(lines);
    const pdf = await render((doc) => { drawDocumentLineTable(doc, m.lines, 120, { cols: documentColumnsFor(doc, { showTax: false }), style: STYLE }); });
    const t = extractPositionedPdfText(pdf);
    for (const f of t.filter((x) => /^Ticket #\d+$/.test(x.text))) {
      const n = Number(f.text.slice(8));
      const first = t.find((x) => x.text === `Row ${(n - 100) * 4 + 1}`)!;
      expect(first.page, `${f.text} header shares a page with its first row`).toBe(f.page);
    }
  });

  it('prints the ticket category under the header, day sub-headers with the hours and day total', async () => {
    const m = model([
      lineDto(1, { name: 'Fix', ticketNumber: '42', ticketCategory: 'Support', workDate: '2026-02-26', quantity: '1.5', lineTotal: '150.00', unitPrice: '100.00' }),
    ], { lineGrouping: 'day' });
    const pdf = await render((doc) => { drawDocumentLineTable(doc, m.lines, 120, { cols: documentColumnsFor(doc, { showTax: false }), style: STYLE }); });
    const text = extractPositionedPdfText(pdf).map((f) => f.text);
    expect(text).toContain('Ticket #42');
    expect(text).toContain('Category: Support');
    expect(text).toContain('Feb 26, 2026');
    expect(text.filter((x) => x === '$150.00').length).toBeGreaterThanOrEqual(2); // day total + line amount
  });

  it('draws the empty text when there are no lines', async () => {
    const m = model([]);
    const pdf = await render((doc) => { drawDocumentLineTable(doc, m.lines, 120, { cols: documentColumnsFor(doc, { showTax: false }), style: STYLE }); });
    expect(extractPositionedPdfText(pdf).map((f) => f.text)).toContain('No line items.');
  });

  it('draws with the fonts it is given', async () => {
    const m = model([lineDto(1)]);
    const courier = { heading: { regular: 'Courier', bold: 'Courier-Bold' }, body: { regular: 'Courier', bold: 'Courier-Bold', italic: 'Courier-Oblique', boldItalic: 'Courier-BoldOblique' } };
    const pdf = await render((doc) => { drawDocumentLineTable(doc, m.lines, 120, { cols: documentColumnsFor(doc, { showTax: false }), style: { ...STYLE, fonts: courier } }); });
    const raw = pdf.toString('latin1');
    expect(raw).toContain('/BaseFont /Courier');
    expect(raw).not.toContain('/BaseFont /Helvetica');
  });
});

describe('drawDocumentTotals', () => {
  it('draws every row in order; a paid invoice shows Total, Paid (minus) and Balance due', async () => {
    const m = model([lineDto(1)], { amountPaid: '100.00', balance: '200.00', total: '300.00' });
    const pdf = await render((doc) => { drawDocumentTotals(doc, m.totals, 400, { cols: documentColumnsFor(doc, { showTax: false }), style: STYLE }); });
    const t = extractPositionedPdfText(pdf);
    const labels = t.filter((f) => f.x < 400).map((f) => f.text);
    expect(labels).toEqual(['Subtotal', 'Tax', 'Total', 'Paid', 'Balance due']);
    expect(t.map((f) => f.text)).toContain('-$100.00');
    const ys = t.filter((f) => f.x < 400).map((f) => f.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  });

  it('returns the y below the block and moves the block whole to a new page when it will not fit', async () => {
    const m = model([lineDto(1)], { amountPaid: '100.00', balance: '200.00' });
    let endY = 0;
    const pdf = await render((doc) => {
      endY = drawDocumentTotals(doc, m.totals, doc.page.height - 100, { cols: documentColumnsFor(doc, { showTax: false }), style: STYLE });
    });
    expect(pdfPageCount(pdf)).toBe(2);
    const t = extractPositionedPdfText(pdf);
    expect(new Set(t.map((f) => f.page)).size).toBe(1); // all text on ONE page stream (page 1 of 2 has none)
    expect(endY).toBeGreaterThan(50);
  });

  it('joins a value list with " + " and fits the figure in the summary box', async () => {
    const totals = {
      rows: [{ key: 'x', label: 'First period', value: [
        { text: '$1.00', amount: '1.00', currency: 'USD', suffix: null }, { text: '$2.00', amount: '2.00', currency: 'USD', suffix: null },
      ], weight: 'strong' as const, ruleAbove: 'neutral' as const }],
      aside: null, depositStrip: null,
    };
    const pdf = await render((doc) => { drawDocumentTotals(doc, totals, 300, { cols: documentColumnsFor(doc, { showTax: false }), style: STYLE }); });
    expect(extractPositionedPdfText(pdf).map((f) => f.text)).toContain('$1.00 + $2.00');
  });
});
