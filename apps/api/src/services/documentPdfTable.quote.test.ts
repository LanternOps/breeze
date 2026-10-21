/**
 * W3b (#9421) — what the quote PDF needs from the shared module: the OD-11
 * recurrence suffix on the unit AND the amount cell, line thumbnails, a table
 * label kept with its header + first row, the per-table subtotal, and the
 * totals aside box.
 */
import { describe, it, expect } from 'vitest';
import PDFDocument from 'pdfkit';
import type { DocumentLineRow, DocumentLineTableModel, DocumentMoney } from '@breeze/shared/documents';
import { formatMoney } from '@breeze/shared';
import {
  documentColumnsFor, drawDocumentLineRow, drawDocumentLineTable, drawDocumentTotals, type DocumentPdfStyle,
} from './documentPdfTable';
import { extractPositionedPdfText } from '../testUtils/invoiceRenderFixtures';

const FONTS = {
  heading: { regular: 'Helvetica', bold: 'Helvetica-Bold' },
  body: { regular: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique' },
};
const STYLE: DocumentPdfStyle = { fonts: FONTS, locale: 'en', accent: '#0ea5e9', categoryLabel: (c) => `Category: ${c}` };

type AnyRow = DocumentLineRow<DocumentMoney | 'exempt' | null>;
const MO = { text: '/mo', srText: 'per month' };
const mny = (amount: string, currency = 'USD', suffix: DocumentMoney['suffix'] = null): DocumentMoney =>
  ({ text: amount, amount, currency, suffix });
const qrow = (n: number, patch: Partial<AnyRow> = {}): AnyRow => ({
  key: `r${n}`, title: `Item ${n}`, blurb: null, workDate: null, qty: '1', unit: mny('10.00'), tax: null, amount: mny('10.00'),
  note: null, descriptor: [], ticketText: null, thumbnail: null, isChild: false, ...patch,
});
const table = (rows: AnyRow[], patch: Partial<DocumentLineTableModel> = {}): DocumentLineTableModel => ({
  label: null, subtotal: null, emptyText: null,
  columns: { description: 'Description', qty: 'Qty', unitPrice: 'Unit', tax: null, amount: 'Total' },
  groups: [{ key: 'g', header: null, days: [{ key: 'd', header: null, rows }] }],
  ...patch,
} as DocumentLineTableModel);
// 1x1 grayscale PNG pdfkit can decode.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64');

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
const cols = () => documentColumnsFor(new PDFDocument({ size: 'A4', margin: 50 }), { showTax: false });

describe('documentPdfTable — quote needs (W3b)', () => {
  it('prints the recurrence suffix on the unit AND the amount cell, and never wraps or truncates a CHF figure', async () => {
    const chf = (a: string) => mny(a, 'CHF', MO);
    const c = cols();
    const style = { ...STYLE, locale: 'de-CH' };
    const pdf = await render((doc) => {
      drawDocumentLineRow(doc, qrow(1, { unit: chf('1234.50'), amount: chf('1234.50') }), 100, { cols: c, style, showTax: false });
      drawDocumentLineRow(doc, qrow(2, { unit: chf('888888.88'), amount: chf('888888.88') }), 200, { cols: c, style, showTax: false });
    });
    const figures = extractPositionedPdfText(pdf).filter((f) => f.text.endsWith('/mo'));
    expect(figures).toHaveLength(4); // unit + amount on both rows
    expect(figures.filter((f) => /1.234.50\/mo$/.test(f.text))).toHaveLength(2);
    expect(figures.filter((f) => /888.888.88\/mo$/.test(f.text))).toHaveLength(2);
    // The realistic figure fits its box at the row font with no shrink.
    const d = new PDFDocument({ size: 'A4', margin: 50 });
    d.font('Helvetica').fontSize(10);
    expect(d.widthOfString(`${formatMoney(1234.5, 'CHF', 'de-CH')}/mo`)).toBeLessThanOrEqual(c.colNumW);
  });

  it('draws a thumbnail and indents every description by the gutter', async () => {
    const t = table([qrow(1, { thumbnail: { kind: 'line_thumb', id: 'r1' } }), qrow(2)]);
    const pdf = await render((doc) => {
      drawDocumentLineTable(doc, t, 100, { cols: documentColumnsFor(doc, { showTax: false }), style: STYLE, thumbnails: new Map([['r1', PNG]]) });
    });
    expect(pdf.toString('latin1')).toContain('/Subtype /Image');
    const items = extractPositionedPdfText(pdf).filter((f) => /^Item /.test(f.text));
    expect(items).toHaveLength(2);
    expect(items[0]!.x).toBeGreaterThan(50 + 40);
    expect(items[1]!.x).toBeCloseTo(items[0]!.x, 1);
  });

  it('a row with no bytes in the thumbnail map draws no image and no gutter', async () => {
    const t = table([qrow(1, { thumbnail: { kind: 'line_thumb', id: 'r1' } })]);
    const pdf = await render((doc) => { drawDocumentLineTable(doc, t, 100, { cols: documentColumnsFor(doc, { showTax: false }), style: STYLE }); });
    expect(pdf.toString('latin1')).not.toContain('/Subtype /Image');
    expect(extractPositionedPdfText(pdf).find((f) => f.text === 'Item 1')!.x).toBeCloseTo(50, 0);
  });

  it('draws the table label above the header and keeps label + header + first row together', async () => {
    const t = table([qrow(1), qrow(2)], { label: 'Recurring services' });
    const pdf = await render((doc) => {
      // Label (~19pt) + header (24pt) fit in 52pt; the first row (~18pt more) does not.
      drawDocumentLineTable(doc, t, doc.page.height - 50 - 52, { cols: documentColumnsFor(doc, { showTax: false }), style: STYLE });
    });
    const f = extractPositionedPdfText(pdf);
    const label = f.find((x) => x.text === 'Recurring services')!;
    const header = f.find((x) => x.text === 'DESCRIPTION')!;
    const first = f.find((x) => x.text === 'Item 1')!;
    expect(label.page).toBe(first.page);
    expect(header.page).toBe(first.page);
    expect(label.y).toBeLessThan(header.y);
  });

  it('skips a totals row with no figure instead of printing a bare label', async () => {
    const totals = {
      rows: [
        { key: 'category:free', label: 'Free tier', value: [] as DocumentMoney[], weight: 'muted' as const, ruleAbove: 'none' as const },
        { key: 'total', label: 'Total', value: mny('5.00'), weight: 'hero' as const, ruleAbove: 'accent' as const },
      ],
      aside: null, depositStrip: null,
    };
    const pdf = await render((doc) => { drawDocumentTotals(doc, totals, 300, { cols: documentColumnsFor(doc, { showTax: false }), style: STYLE }); });
    const txt = extractPositionedPdfText(pdf).map((f) => f.text);
    expect(txt).not.toContain('Free tier');
    expect(txt).toContain('Total');
  });

  it('prints the per-table subtotal parts joined, with the suffix', async () => {
    const t = table([qrow(1)], { subtotal: { label: 'Subtotal', parts: [mny('200.00'), mny('50.00', 'USD', MO)] } });
    const pdf = await render((doc) => { drawDocumentLineTable(doc, t, 100, { cols: documentColumnsFor(doc, { showTax: false }), style: STYLE }); });
    const txt = extractPositionedPdfText(pdf).map((f) => f.text);
    expect(txt).toContain('Subtotal');
    expect(txt.some((x) => x.includes('$200.00') && x.includes('$50.00/mo'))).toBe(true);
  });

  it('draws the totals aside: its rows and note inside a tinted box', async () => {
    const totals = {
      rows: [{ key: 'due', label: 'Due on acceptance', value: mny('100.00'), weight: 'hero' as const, ruleAbove: 'accent' as const }],
      aside: {
        rows: [{ key: 'fp', label: 'First-period total', value: mny('150.00'), weight: 'regular' as const, ruleAbove: 'none' as const }],
        note: 'Accepting bills the one-time charges only.',
      },
      depositStrip: null,
    };
    let endY = 0;
    const pdf = await render((doc) => { endY = drawDocumentTotals(doc, totals, 300, { cols: documentColumnsFor(doc, { showTax: false }), style: STYLE }); });
    const txt = extractPositionedPdfText(pdf).map((f) => f.text);
    expect(txt).toContain('First-period total');
    expect(txt).toContain('$150.00');
    expect(txt.some((x) => x.startsWith('Accepting bills'))).toBe(true);
    const due = extractPositionedPdfText(pdf).find((f) => f.text === 'Due on acceptance')!;
    const fp = extractPositionedPdfText(pdf).find((f) => f.text === 'First-period total')!;
    expect(fp.y).toBeGreaterThan(due.y);
    expect(endY).toBeGreaterThan(fp.y);
  });
});
