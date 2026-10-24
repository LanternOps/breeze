// #8604 golden: the PDF's drawn text for a fixed invoice under DEFAULT
// line-detail settings. The snapshot was first recorded on the renderer as it
// stood before #8604, so a diff means a partner who never touches the setting
// would see a different document. #9414 W3a regenerated it deliberately (the
// PDF now draws through the shared document model and line-table module);
// the HTML snapshot went with `renderInvoiceHtml`.
import { describe, it, expect } from 'vitest';
import { renderInvoicePdfBuffer } from './invoicePdf';
import {
  extractPositionedPdfText, fixtureBranding, goldenLines, makeFixtureInvoice, makeFixtureLine, pdfPageCount,
  WRAPPING_GOLDEN_FILLERS, wrappingGoldenLines,
} from '../testUtils/invoiceRenderFixtures';

const cases = [
  { name: 'taxed', invoice: () => makeFixtureInvoice() },
  { name: 'untaxed', invoice: () => makeFixtureInvoice({ taxRate: null, taxTotal: '0.00', total: '595.00', balance: '595.00' }) },
];

describe('invoice PDF — golden (default line-detail settings)', () => {
  for (const c of cases) {
    it(`PDF text, positions and page count are unchanged (${c.name})`, async () => {
      const pdf = await renderInvoicePdfBuffer(c.invoice(), goldenLines(), fixtureBranding);
      expect({ pages: pdfPageCount(pdf), text: extractPositionedPdfText(pdf) }).toMatchSnapshot();
    });
  }
});

// #8604 review: the ONE intentional default-settings layout change. Wrapping
// titles are now measured in bold (the blurb used to print over the title's
// second line) and a tall row moves whole to the next page instead of being
// split. Issued invoices keep their stored PDF (pdf_sha256); only drafts and
// not-yet-rendered invoices with these shapes lay out differently.
describe('invoice PDF — golden (wrapping title + tall row near the page bottom)', () => {
  it('PDF text, positions and page count', async () => {
    const pdf = await renderInvoicePdfBuffer(makeFixtureInvoice(), wrappingGoldenLines(), fixtureBranding);
    const text = extractPositionedPdfText(pdf);
    expect({ pages: pdfPageCount(pdf), text }).toMatchSnapshot();

    // Structural guards, so a regenerated snapshot cannot hide a regression.
    const titleLines = text.filter((f) => /Quarterly managed|rule audit|verification/.test(f.text));
    const blurb = text.find((f) => f.text.startsWith('Reviewed with'))!;
    expect(titleLines.length).toBeGreaterThanOrEqual(2); // the bold title wraps
    expect(blurb.y).toBeGreaterThan(Math.max(...titleLines.map((f) => f.y)) + 8); // blurb under it, not over it

    const lastFiller = text.find((f) => f.text === `Filler item ${WRAPPING_GOLDEN_FILLERS}`)!;
    const tallRow = text.filter((f) => /Replaced the core switch|h worked/.test(f.text));
    expect(lastFiller.page).toBe(0);
    expect(tallRow.length).toBeGreaterThan(2);
    expect(new Set(tallRow.map((f) => f.page))).toEqual(new Set([1])); // never split across pages
  });
});

// #9414 W3a: the multi-page fixture. A 90-row invoice pins the pagination the
// shared line-table module owns: where each page breaks, that the column header
// repeats on every page that carries rows, and that the totals land on the last page.
describe('invoice PDF — golden (multi-page)', () => {
  it('page breaks, repeated column header and totals placement', async () => {
    const lines = Array.from({ length: 90 }, (_, i) => makeFixtureLine({
      name: `Service ${i + 1}`, description: i % 10 === 0 ? 'A note on this row\nwith a second line' : '', lineTotal: '10.00', unitPrice: '10.00', taxable: i % 2 === 0,
    }));
    const pdf = await renderInvoicePdfBuffer(makeFixtureInvoice({ subtotal: '900.00', total: '903.50', balance: '903.50' }), lines, fixtureBranding);
    const text = extractPositionedPdfText(pdf);
    const pages = [...new Set(text.map((f) => f.page))].sort((a, b) => a - b);
    const shape = pages.map((p) => ({
      textPage: p,
      rows: text.filter((f) => f.page === p && /^Service \d+$/.test(f.text)).length,
      firstRow: text.find((f) => f.page === p && /^Service \d+$/.test(f.text))?.text ?? null,
      columnHeader: text.some((f) => f.page === p && f.text === 'DESCRIPTION'),
      totals: text.some((f) => f.page === p && f.text === 'Balance due'),
    }));
    expect({ pages: pdfPageCount(pdf), shape }).toMatchSnapshot();
    // Totals sit on (or after) the last page that carries rows; the notes/footer may spill onto a final page.
    const lastRows = Math.max(...shape.filter((s) => s.rows > 0).map((s) => s.textPage));
    expect(shape.find((s) => s.totals)!.textPage).toBeGreaterThanOrEqual(lastRows);
    expect(shape.filter((s) => s.rows > 0).every((s) => s.columnHeader)).toBe(true);
    expect(shape.reduce((n, s) => n + s.rows, 0)).toBe(90);
  });
});
