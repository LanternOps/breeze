// #8604 golden: the customer HTML and the PDF's drawn text for a fixed invoice
// under DEFAULT line-detail settings. The snapshot was recorded on the
// renderer as it stood before #8604, so any diff here means a partner who
// never touches the new setting would see a different document.
import { describe, it, expect } from 'vitest';
import { renderInvoiceHtml, renderInvoicePdfBuffer } from './invoicePdf';
import {
  extractPositionedPdfText, fixtureBranding, goldenLines, makeFixtureInvoice, pdfPageCount,
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
