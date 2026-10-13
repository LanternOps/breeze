// #8604 golden: the customer HTML and the PDF's drawn text for a fixed invoice
// under DEFAULT line-detail settings. The snapshot was recorded on the
// renderer as it stood before #8604, so any diff here means a partner who
// never touches the new setting would see a different document.
import { describe, it, expect } from 'vitest';
import { renderInvoiceHtml, renderInvoicePdfBuffer } from './invoicePdf';
import {
  extractPositionedPdfText, fixtureBranding, goldenLines, makeFixtureInvoice, pdfPageCount,
  WRAPPING_GOLDEN_FILLERS, wrappingGoldenLines,
} from '../testUtils/invoiceRenderFixtures';

const cases = [
  { name: 'taxed', invoice: () => makeFixtureInvoice() },
  { name: 'untaxed', invoice: () => makeFixtureInvoice({ taxRate: null, taxTotal: '0.00', total: '595.00', balance: '595.00' }) },
];

describe('invoice renderers — golden (default line-detail settings)', () => {
  for (const c of cases) {
    it(`HTML is unchanged (${c.name})`, () => {
      expect(renderInvoiceHtml(c.invoice(), goldenLines(), fixtureBranding)).toMatchSnapshot();
    });

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
describe('invoice renderers — golden (wrapping title + tall row near the page bottom)', () => {
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
