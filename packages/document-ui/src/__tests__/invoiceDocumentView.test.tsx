import { render } from '@testing-library/react';
import { INVOICE_DTO_FIXTURES } from '@breeze/shared/documents';
import { DocumentLineDescription } from '../DocumentLineDescription';
import { renderInvoice } from '../__fixtures__/renderInvoice';

const MULTILINE_ROW_ID = INVOICE_DTO_FIXTURES.multilineBlurb.lines[0].id;

describe('InvoiceDocumentView', () => {
  it('blurb keeps literal newlines and pre-line wrapping', () => {
    const { getByTestId } = renderInvoice('multilineBlurb');
    const p = getByTestId(`document-line-blurb-${MULTILINE_ROW_ID}`);
    expect(p.className).toContain('whitespace-pre-line');
    expect(p.textContent).toBe('Line one\nLine two');
  });

  it('no tax column header and no tax cells when columns.tax is null', () => {
    const { container } = renderInvoice('untaxed');
    expect(container.querySelector('thead')!.textContent).not.toContain('Tax');
    expect(container.querySelector('thead tr')!.children).toHaveLength(4);
    expect(container.textContent).not.toContain('Not taxable'); // no tax cells at all
    // The totals Tax row is always present (the customer sees the same rows on every surface).
    expect(container.querySelector('section')!.textContent).toContain('Tax');
  });

  it('taxed table shows the tax column and an exempt cell reads as not taxable', () => {
    const { container, getAllByText } = renderInvoice('taxed');
    expect(container.querySelector('thead tr')!.children).toHaveLength(5);
    expect(getAllByText('Not taxable').length).toBeGreaterThan(0);
  });

  it('hero row shows Balance due and the accent rule', () => {
    const { getByTestId } = renderInvoice('issued');
    const hero = getByTestId('document-totals-hero');
    expect(hero.textContent).toContain('Balance due');
    expect(hero.className).toContain('doc-accent-border');
  });

  it('paid invoice shows Paid with a minus and the plain Balance label', () => {
    const { getByTestId, container } = renderInvoice('paid');
    expect(getByTestId('document-totals-hero').textContent).not.toContain('Balance due');
    expect(getByTestId('document-totals-hero').textContent).toContain('Balance');
    expect(container.textContent).toContain('−$300.00');
  });

  it('deposit strip renders with the strong amount', () => {
    const { getByTestId } = renderInvoice('deposit');
    expect(getByTestId('document-deposit').querySelector('strong')?.textContent).toBe('$100.00');
  });

  it('day grouping renders a day header per date', () => {
    const { getByTestId } = renderInvoice('dayGrouping');
    expect(getByTestId('document-day-2026-02-26')).toBeTruthy();
    expect(getByTestId('document-day-2026-02-27')).toBeTruthy();
  });

  it('a slot is rendered inside its data-slot container', () => {
    const { container } = renderInvoice('issued', { afterTotals: <button data-testid="pay">Pay</button> });
    expect(container.querySelector('[data-slot="after-totals"] [data-testid="pay"]')).toBeTruthy();
    expect(container.querySelector('[data-slot="signature"]')?.childElementCount).toBe(0);
  });

  it('the document root carries the theme', () => {
    const { getByTestId } = renderInvoice('condensed');
    expect(getByTestId('document-root').getAttribute('data-doc-theme')).toBe('condensed');
  });

  it('notes render after the totals and terms is a collapsed disclosure', () => {
    const { container } = renderInvoice('issued');
    const html = container.innerHTML;
    expect(html.indexOf('Thank you for your business.')).toBeGreaterThan(html.indexOf('document-totals-hero'));
    expect((container.querySelector('details#terms') as HTMLDetailsElement).open).toBe(false);
  });

  it('empty invoice shows the empty text', () => {
    const { container } = renderInvoice('empty');
    expect(container.textContent).toContain('No line items.');
  });
});

describe('DocumentLineDescription', () => {
  it('carries whitespace-pre-line on the blurb by construction', () => {
    const { container } = render(
      <DocumentLineDescription rowKey="r1" title="T" blurb={'a\nb'} workDate={null} note={null} descriptor={[]} ticketText={null} qtyFold={null} />,
    );
    const p = container.querySelector('[data-testid="document-line-blurb-r1"]')!;
    expect(p.className).toContain('whitespace-pre-line');
    expect(p.textContent).toBe('a\nb');
  });
});
