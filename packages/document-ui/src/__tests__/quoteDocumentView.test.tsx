import { act, fireEvent } from '@testing-library/react';
import { buildQuoteDocumentModel, documentLabelsFor, QUOTE_DTO_FIXTURES, QUOTE_FIXTURE_IDS } from '@breeze/shared/documents';
import { quoteAgreementLinks } from '../QuoteDocumentView';
import { renderQuote } from '../__fixtures__/renderQuote';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('QuoteDocumentView — blocks', () => {
  it('headings render at their level; level 1 is not an h1 (the cover/number own h1)', () => {
    const { getByTestId } = renderQuote('blocks');
    const h2 = getByTestId(`document-block-${id(20)}`);
    expect(h2.tagName).toBe('H2');
    expect(h2.className).toContain('text-xl');
    expect(getByTestId(`document-block-${id(32)}`).className).toContain('text-lg');
  });

  it('rich_text and callout render their sanitized html; blank ones render nothing', () => {
    const { getByTestId, queryByTestId } = renderQuote('blocks');
    expect(getByTestId(`document-block-${id(21)}`).innerHTML).toContain('<p>We will replace the core switch.</p>');
    expect(queryByTestId(`document-block-${id(22)}`)).toBeNull();
    const callout = getByTestId(`document-block-${id(25)}`);
    expect(callout.className).toContain('border-warning/40');
    expect(callout.textContent).toContain('Downtime');
    expect(queryByTestId(`document-block-${id(26)}`)).toBeNull();
  });

  it('table block: plain header, right alignment as a class, zebra, caption; empty table renders nothing', () => {
    const { getByTestId, queryByTestId } = renderQuote('blocks');
    const wrap = getByTestId(`document-block-${id(23)}`);
    const headRow = wrap.querySelector('thead tr')!;
    expect(headRow.className).toBe('border-b-2');
    expect(headRow.children[1].className).toContain('text-right');
    expect(headRow.children[1].innerHTML).toBe('<strong>Cost</strong>');
    expect(wrap.querySelectorAll('tbody tr')[1].className).toContain('bg-muted/30');
    expect(wrap.querySelectorAll('tbody tr')[0].className).not.toContain('bg-muted/30');
    expect(wrap.textContent).toContain('Estimate only');
    expect(queryByTestId(`document-block-${id(24)}`)).toBeNull();
  });

  it('image block: width attribute, caption, and the unavailable fallback', () => {
    const { getByTestId } = renderQuote('blocks');
    const fig = getByTestId(`document-block-${id(27)}`);
    const img = fig.querySelector('img')!;
    expect(img.getAttribute('width')).toBe('320');
    expect(img.getAttribute('data-asset')).toBe(`block_image:${id(60)}`);
    expect(img.className).toContain('max-w-full');
    expect(img.getAttribute('style')).toBeNull();
    expect(fig.querySelector('figcaption')!.textContent).toBe('Rack layout');
    expect(getByTestId(`document-block-${id(28)}`).textContent).toContain('Image unavailable');
  });

  it('contract blocks are not body blocks', () => {
    const { queryByTestId } = renderQuote('blocks');
    expect(queryByTestId(`document-block-${id(29)}`)).toBeNull();
  });

  it('line_items: own label, cadence headers, subtotal row, and the suffix on unit AND amount', () => {
    const { getByTestId } = renderQuote('recurring');
    const table = getByTestId(`document-block-${QUOTE_FIXTURE_IDS.pricingBlock}`);
    expect(table.textContent).toContain('Plan');
    expect(table.textContent).toContain('One-time');
    expect(table.textContent).toContain('Monthly');
    const monthly = getByTestId(`document-line-${id(102)}`);
    const cells = monthly.querySelectorAll('td');
    expect(cells[2].textContent).toContain('/mo');   // unit price
    expect(cells[3].textContent).toContain('/mo');   // amount
    const sub = getByTestId(`document-block-${QUOTE_FIXTURE_IDS.pricingBlock}`).querySelector('tfoot')!;
    expect(sub.textContent).toContain('Subtotal');
    // The suffix also carries screen-reader text (" per month"); strip it to compare the visual string.
    expect(sub.textContent!.replace(/ per (month|year)/g, '')).toContain('$100.00 + $50.00/mo + $600.00/yr');
  });

  it('CHF monthly: the suffix span sits in the unit and amount cells', () => {
    const { container } = renderQuote('chfMonthly');
    const row = container.querySelector('[data-testid^="document-line-"]')!;
    const cells = row.querySelectorAll('td');
    expect(cells[2].querySelector('span[aria-hidden]')?.textContent).toBe('/mo');
    expect(cells[3].querySelector('span[aria-hidden]')?.textContent).toBe('/mo');
  });

  it('un-blocked lines form a trailing default table; a line bound to a non-pricing block renders nowhere', () => {
    const { getByTestId, queryByText } = renderQuote('blocks');
    expect(getByTestId('document-block-default-pricing').textContent).toContain('Orphan');
    expect(queryByText('Bound to a heading')).toBeNull();
  });

  it('device-set lines render their descriptor sentences', () => {
    const { container } = renderQuote('deviceSet');
    expect(container.textContent).toContain('Estimated quantity — billed at the actual number of servers, workstations at HQ each billing period.');
    expect(container.textContent).toContain('Includes 5; additional units billed at $10.00 each.');
  });

  it('a line with a thumbnail renders it through components.Image', () => {
    const { container } = renderQuote('issued');
    expect(container.querySelector(`img[data-asset="line_thumb:${id(101)}"]`)).toBeTruthy();
  });
});

describe('QuoteDocumentView — frame', () => {
  it('no cover: the number is the h1 and bill-to is shown', () => {
    const { container } = renderQuote('issued');
    expect(container.querySelector('[data-testid="document-cover"]')).toBeNull();
    expect(container.querySelector('h1')!.textContent).toBe('Q-0042');
    expect(container.textContent).toContain('Prepared for');
  });

  it('cover: carries the h1 title, the image and prepared-for/by; the number steps down to h2', () => {
    const { getByTestId, container } = renderQuote('cover');
    const cover = getByTestId('document-cover');
    expect(cover.querySelector('h1')!.textContent).toBe('Network refresh proposal');
    expect(cover.querySelector(`img[data-asset="cover:${QUOTE_FIXTURE_IDS.coverImage}"]`)).toBeTruthy();
    expect(cover.textContent).toContain('Prepared for');
    expect(cover.textContent).toContain('Acme Dental');
    expect(cover.textContent).toContain('Prepared by');
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(container.querySelector('h2')!.textContent).toBe('Q-0042');
  });

  it('the displayStatus pill shows on every status including viewed', () => {
    expect(renderQuote('issued').container.textContent).toContain('Viewed');
    expect(renderQuote('superseded').container.textContent).toContain('Replaced');
  });

  it('a draft prints the draft number and no pill', () => {
    const { container } = renderQuote('draft');
    expect(container.querySelector('h1')!.textContent).toBe('Proposal');
  });

  it('totals: recurring shows the aside box with the note; deposit shows the three figures', () => {
    const rec = renderQuote('recurring').container;
    expect(rec.querySelector('[data-testid="document-totals-aside"]')!.textContent).toContain('First-period total');
    expect(rec.querySelector('[data-testid="document-totals-aside"]')!.textContent).toContain('Accepting this proposal bills only the one-time charges now.');
    const dep = renderQuote('deposit').container;
    expect(dep.textContent).toContain('Due on acceptance');
    expect(dep.querySelector('[data-testid="document-totals-hero"]')!.textContent).toContain('Deposit due now');
    expect(dep.textContent).toContain('Remaining balance (due per terms)');
    expect(dep.querySelector('[data-testid="document-totals-aside"]')).toBeNull();
  });

  it('short terms render under the totals, before the agreements', () => {
    const { container } = renderQuote('agreements');
    const html = container.innerHTML;
    expect(html.indexOf('Valid for 30 days.')).toBeGreaterThan(html.indexOf('document-totals-hero'));
    expect(html.indexOf('document-agreements')).toBeGreaterThan(html.indexOf('Valid for 30 days.'));
  });

  it('empty quote: no table, but the totals and header still render', () => {
    const { container } = renderQuote('empty');
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('[data-testid="document-totals-hero"]')).toBeTruthy();
  });

  it('a host signature slot renders inside its data-slot container; empty by default', () => {
    expect(renderQuote('agreements').container.querySelector('[data-slot="signature"]')?.childElementCount).toBe(0);
    const { container } = renderQuote('agreements', { signature: <button data-testid="sign">Sign</button> });
    expect(container.querySelector('[data-slot="signature"] [data-testid="sign"]')).toBeTruthy();
  });

  it('quoteAgreementLinks builds the signature panel links from the model, in order', () => {
    const model = buildQuoteDocumentModel(QUOTE_DTO_FIXTURES.agreements, documentLabelsFor('en'));
    expect(quoteAgreementLinks(model)).toEqual([
      { label: 'Service agreement', href: `#agreement-${id(41)}` },
      { label: 'Uploaded MSA', href: `#agreement-${id(40)}` },
      { label: 'DPA', href: `#agreement-${id(42)}` },
      { label: 'SLA', href: `#agreement-${id(43)}` },
      { label: 'Terms & Conditions', href: '#terms' },
    ]);
  });
});

describe('QuoteDocumentView — agreements', () => {
  it('lists contract rows in block order (sortOrder) then Terms & Conditions, collapsed', () => {
    const { container } = renderQuote('agreements');
    const rows = Array.from(container.querySelectorAll('details'));
    expect(rows.map((r) => r.id)).toEqual([`agreement-${id(41)}`, `agreement-${id(40)}`, `agreement-${id(42)}`, `agreement-${id(43)}`, 'terms']);
    expect(rows.every((r) => !r.open)).toBe(true);
    expect(container.querySelector('[data-testid="document-agreements"] h3')!.textContent).toBe('Agreements');
  });

  it('a lone row has no list heading', () => {
    const { container } = renderQuote('blocks');
    expect(container.querySelectorAll('[data-testid="document-agreements"] h3')).toHaveLength(0);
  });

  it('uploaded body mounts components.AgreementFile only while open', () => {
    const { container } = renderQuote('agreements');
    const row = container.querySelector(`details#agreement-${id(40)}`) as HTMLDetailsElement;
    expect(row.querySelector('a[data-asset]')).toBeNull();
    act(() => { row.open = true; fireEvent(row, new Event('toggle')); });
    expect(row.querySelector(`a[data-asset="agreement_file:${id(40)}"]`)).toBeTruthy();
    expect(row.textContent).toContain('MSA (PDF) — v3');
  });

  it('missing content / file render the unavailable text', () => {
    const { container } = renderQuote('agreements');
    const dpa = container.querySelector(`details#agreement-${id(42)}`) as HTMLDetailsElement;
    expect(dpa.textContent).toContain('Agreement content unavailable');
    const sla = container.querySelector(`details#agreement-${id(43)}`) as HTMLDetailsElement;
    act(() => { sla.open = true; fireEvent(sla, new Event('toggle')); });
    expect(sla.textContent).toContain('Agreement file unavailable');
  });

  it('beforeprint opens every row and afterprint restores', () => {
    const { container } = renderQuote('agreements');
    const rows = () => Array.from(container.querySelectorAll('details')) as HTMLDetailsElement[];
    act(() => { window.dispatchEvent(new Event('beforeprint')); });
    expect(rows().every((r) => r.open)).toBe(true);
    act(() => { window.dispatchEvent(new Event('afterprint')); });
    expect(rows().every((r) => !r.open)).toBe(true);
  });

  it('a #hash deep link opens its row', () => {
    window.location.hash = `#agreement-${id(41)}`;
    const { container } = renderQuote('agreements');
    expect((container.querySelector(`details#agreement-${id(41)}`) as HTMLDetailsElement).open).toBe(true);
    window.location.hash = '';
  });

  it('the terms row sections the text', () => {
    const { container } = renderQuote('agreements');
    expect(container.querySelector('details#terms')!.textContent).toContain('2 sections');
  });
});

it('never prints internal cost / markup / net, even if the payload carries them', () => {
  const dto = QUOTE_DTO_FIXTURES.issued;
  const leaky = {
    ...dto,
    lines: dto.lines.map((l) => ({ ...l, unitCost: '77.77', markup: '13.13', netTotal: '66.66' })),
    quote: { ...dto.quote, totalCost: '88.88', margin: '99.99' },
  } as unknown as typeof dto;
  const model = buildQuoteDocumentModel(leaky, documentLabelsFor('en'));
  const json = JSON.stringify(model);
  for (const secret of ['77.77', '13.13', '66.66', '88.88', '99.99']) expect(json).not.toContain(secret);
});
