/**
 * W3b (#9421) — the quote PDF draws its pricing tables, totals and header
 * through the shared document module, from `buildQuoteDocumentModel`.
 * Description first (D3), the OD-11 recurrence suffix on unit AND amount, the
 * totals box that matches the screen, header strings/dates from the shared
 * labels in the document locale.
 */
import { describe, it, expect } from 'vitest';
import { renderQuotePdf, quotePdfDocument } from './quotePdf';
import { extractPositionedPdfText, pdfPageCount } from '../testUtils/invoiceRenderFixtures';

const noImage = async () => null;
const branding = { partnerName: 'Acme MSP', primaryColor: '#2563eb', currencyCode: 'USD', locale: 'en' } as const;

const quote = (patch: Record<string, unknown> = {}) => ({
  id: 'q1', quoteNumber: 'Q-0001', title: 'Network refresh', status: 'sent', currencyCode: 'USD',
  issueDate: '2026-10-20', expiryDate: '2026-11-19', billToName: 'Globex',
  subtotal: '300.00', taxRate: null, taxTotal: '0.00', total: '300.00', oneTimeTotal: '300.00',
  monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00', dueOnAcceptanceTotal: '300.00',
  depositType: 'none', ...patch,
});
const line = (n: number, patch: Record<string, unknown> = {}) => ({
  id: `l${n}`, blockId: null, name: `Item ${n}`, description: null, quantity: '1', unitPrice: '100.00', lineTotal: '100.00',
  recurrence: 'one_time', taxable: false, customerVisible: true, ...patch,
});
const render = (q: ReturnType<typeof quote>, lines: ReturnType<typeof line>[], blocks: unknown[] = [], b: Record<string, unknown> = branding) =>
  renderQuotePdf(q as never, blocks as never, lines as never, noImage, b as never);
const texts = (pdf: Buffer) => extractPositionedPdfText(pdf);

describe('quotePdfDocument — rows → customer DTO', () => {
  it('drops hidden lines, folds an unknown recurrence into one_time and derives a missing lineTotal', () => {
    const dto = quotePdfDocument(
      quote() as never, [] as never,
      [line(1), line(2, { customerVisible: false }), line(3, { recurrence: 'quarterly', lineTotal: null, quantity: '2', unitPrice: '12.50' })] as never,
      { ...branding } as never,
    );
    expect(dto.lines.map((l) => l.id)).toEqual(['l1', 'l3']);
    expect(dto.lines[1]!.recurrence).toBe('one_time');
    expect(dto.lines[1]!.lineTotal).toBe('25.00');
    expect(dto.documentLocale).toBe('en');
    expect(dto.quote.dueOnAcceptanceTotal).toBe('300.00');
  });

  it('derives the subtotal from the visible lines when the header has none (never a false $0.00)', () => {
    const dto = quotePdfDocument(
      quote({ subtotal: undefined }) as never, [] as never,
      [line(1), line(2, { customerVisible: false }), line(3, { quantity: '2', unitPrice: '12.50', lineTotal: null })] as never,
      { ...branding } as never,
    );
    expect(dto.quote.subtotal).toBe('125.00');
    expect(quotePdfDocument(quote({ subtotal: '999.00' }) as never, [] as never, [line(1)] as never, { ...branding } as never).quote.subtotal).toBe('999.00');
  });

  it('falls back to oneTimeTotal for due-on-acceptance and carries a deposit only when configured', () => {
    const plain = quotePdfDocument(quote({ dueOnAcceptanceTotal: null, oneTimeTotal: '300.00' }) as never, [] as never, [] as never, { ...branding } as never);
    expect(plain.quote.dueOnAcceptanceTotal).toBe('300.00');
    expect(plain.quote.depositDueTotal).toBeNull();
    const dep = quotePdfDocument(quote({ depositType: 'percent', depositAmount: '90.00', depositDueTotal: null }) as never, [] as never, [] as never, { ...branding } as never);
    expect(dep.quote.depositDueTotal).toBe('90.00');
  });
});

describe('renderQuotePdf — pricing table through the module', () => {
  it('puts the description first: DESCRIPTION < QTY < UNIT PRICE < TAX < AMOUNT', async () => {
    const pdf = await render(quote({ taxRate: '0.1', taxTotal: '10.00' }), [line(1, { taxable: true })]);
    const t = texts(pdf);
    const x = (s: string) => t.find((f) => f.text === s)!.x;
    expect(x('DESCRIPTION')).toBeLessThan(x('QTY'));
    expect(x('QTY')).toBeLessThan(x('UNIT PRICE'));
    expect(x('UNIT PRICE')).toBeLessThan(x('TAX'));
    expect(x('TAX')).toBeLessThan(x('AMOUNT'));
    const item = t.find((f) => f.text === 'Item 1')!;
    expect(item.x).toBeLessThan(x('QTY'));
  });

  it('prints the recurrence suffix on the unit AND the amount cell of a monthly line (OD-11)', async () => {
    const pdf = await render(quote(), [line(1, { recurrence: 'monthly', unitPrice: '1234.50', lineTotal: '1234.50' })]);
    const figs = texts(pdf).filter((f) => f.text === '$1,234.50/mo');
    // unit + amount in the table (the totals row for monthly recurring prints one more).
    expect(figs.length).toBeGreaterThanOrEqual(2);
    const row = texts(pdf).find((f) => f.text === 'Item 1')!;
    expect(figs.filter((f) => Math.abs(f.y - row.y) < 1)).toHaveLength(2);
  });

  it('draws the block label once, a cadence header when cadences mix, and the per-table subtotal', async () => {
    const blocks = [{ id: 'b1', blockType: 'line_items', sortOrder: 1, content: { label: 'Services', showSubtotal: true } }];
    const pdf = await render(
      quote({ monthlyRecurringTotal: '50.00' }),
      [line(1, { blockId: 'b1' }), line(2, { blockId: 'b1', recurrence: 'monthly', unitPrice: '50.00', lineTotal: '50.00' })],
      blocks,
    );
    const t = texts(pdf).map((f) => f.text);
    expect(t.filter((x) => x === 'Services')).toHaveLength(1);
    expect(t).toContain('One-time');
    expect(t).toContain('Monthly');
    expect(t.some((x) => x.includes('$100.00') && x.includes('$50.00/mo'))).toBe(true);
  });

  it('shows the tax column only when the quote is taxed', async () => {
    const untaxed = texts(await render(quote(), [line(1)])).map((f) => f.text);
    expect(untaxed).not.toContain('TAX');
    const taxed = texts(await render(quote({ taxRate: '0.1', taxTotal: '10.00' }), [line(1, { taxable: true })])).map((f) => f.text);
    expect(taxed).toContain('TAX');
  });

  it('paginates a long quote: the column header repeats and no row is split from its amount', async () => {
    const many = Array.from({ length: 60 }, (_, i) => line(i + 1, { name: `Row number ${i + 1}`, description: i % 7 === 0 ? 'note\nsecond\nthird' : null }));
    const pdf = await render(quote({ total: '6000.00', subtotal: '6000.00', dueOnAcceptanceTotal: '6000.00' }), many);
    expect(pdfPageCount(pdf)).toBeGreaterThan(1);
    const t = texts(pdf);
    const tablePages = new Set(t.filter((f) => /^Row number /.test(f.text)).map((f) => f.page));
    expect(tablePages.size).toBeGreaterThan(1);
    for (const p of tablePages) expect(t.some((f) => f.page === p && f.text === 'DESCRIPTION')).toBe(true);
    for (let i = 1; i <= 60; i++) {
      const title = t.find((f) => f.text === `Row number ${i}`)!;
      expect(t.some((f) => f.page === title.page && f.x > 400 && Math.abs(f.y - title.y) < 1), `row ${i} keeps its amount`).toBe(true);
    }
  });
});

describe('renderQuotePdf — totals box matches the screen', () => {
  it('an untaxed one-time quote prints a single Total row (no Subtotal/Tax/One-time rows)', async () => {
    const t = texts(await render(quote(), [line(1)])).map((f) => f.text);
    expect(t).toContain('Total');
    expect(t).not.toContain('Subtotal');
    expect(t).not.toContain('One-time');
  });

  it('a recurring quote prints Due on acceptance, the monthly row and the first-period aside with its note', async () => {
    const t = texts(await render(
      quote({ monthlyRecurringTotal: '50.00', total: '350.00' }),
      [line(1), line(2, { recurrence: 'monthly', unitPrice: '50.00', lineTotal: '50.00' })],
    )).map((f) => f.text);
    expect(t).toContain('Due on acceptance');
    expect(t).toContain('Monthly recurring');
    expect(t).toContain('First-period total');
    expect(t.some((x) => x.startsWith('Accepting this proposal bills only the one-time charges'))).toBe(true);
  });

  it('a deposit quote prints the due / deposit / remaining trio', async () => {
    const t = texts(await render(
      quote({ depositType: 'percent', depositAmount: '90.00', depositDueTotal: '90.00' }), [line(1)],
    )).map((f) => f.text);
    expect(t).toContain('Due on acceptance');
    expect(t).toContain('Deposit due now');
    // The long label may wrap inside its box (the row grows to fit); it starts on one fragment.
    expect(t.some((x) => x.startsWith('Remaining balance'))).toBe(true);
    expect(t).toContain('$210.00');
  });
});

describe('renderQuotePdf — header strings and dates from the shared labels', () => {
  it('prints the From label and the dates in the document locale (pt-BR), English unchanged', async () => {
    const pt = texts(await render(quote({ documentLocale: 'pt-BR' }), [line(1)], [], { ...branding, locale: 'pt-BR' })).map((f) => f.text);
    expect(pt).toContain('DE');                       // labels.pdf.from, upper-cased
    expect(pt.some((x) => /^Emitida: /.test(x))).toBe(true); // pt-BR quote labels landed in W2b (labels/pt-BR.ts quote.issued)
    expect(pt.some((x) => /out/i.test(x) && /2026/.test(x))).toBe(true); // 20 de out. de 2026
    const en = texts(await render(quote(), [line(1)])).map((f) => f.text);
    expect(en).toContain('FROM');
    expect(en).toContain('Issued: Oct 20, 2026');
    expect(en).toContain('Valid until: Nov 19, 2026');
    expect(en).toContain('PROPOSAL');
  });
});
