import { render } from '@testing-library/react';
import { INVOICE_DTO_FIXTURES, QUOTE_DTO_FIXTURES, type InvoiceFixtureName, type QuoteFixtureName } from '@breeze/shared/documents';
import { DocumentPaper } from '../DocumentPaper';
import { DocumentLineDescription } from '../DocumentLineDescription';
import { DocumentNotes } from '../DocumentNotes';
import { renderInvoice } from '../__fixtures__/renderInvoice';
import { renderQuote } from '../__fixtures__/renderQuote';

// Every exported component × every invoice fixture (the composition renders header,
// line table, totals, notes and terms), plus the leaf components on their own.
function renderAll() {
  const containers: HTMLElement[] = [];
  for (const theme of ['classic', 'condensed'] as const) {
    containers.push(render(<DocumentPaper theme={theme}>body</DocumentPaper>).container);
  }
  for (const name of Object.keys(INVOICE_DTO_FIXTURES) as InvoiceFixtureName[]) {
    containers.push(renderInvoice(name, { afterTotals: <span>slot</span> }).container);
  }
  for (const name of Object.keys(QUOTE_DTO_FIXTURES) as QuoteFixtureName[]) {
    containers.push(renderQuote(name, { signature: <span>slot</span> }).container);
  }
  containers.push(
    render(<DocumentLineDescription title="T" blurb="b" workDate={{ text: 'Jan 1, 2026', iso: '2026-01-01' }} note="n" descriptor={['d']} ticketText="t" qtyFold="1 × $1.00" />).container,
    render(<DocumentNotes label="Notes" text="x" />).container,
  );
  return containers;
}

it('renders no style attribute (CSP: the host nonces <style>, never style="")', () => {
  for (const container of renderAll()) {
    expect(container.querySelectorAll('[style]')).toHaveLength(0);
  }
});
