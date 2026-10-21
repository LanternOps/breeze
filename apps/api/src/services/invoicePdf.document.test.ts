/**
 * W3a (#9414) — the invoice PDF drawn through the customer document model and
 * the shared line-table module: the document's language governs every printed
 * string, theme fonts reach the rows, and the long-invoice pagination.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import PDFKitDocument from 'pdfkit';
import { renderInvoicePdfBuffer } from './invoicePdf';
import { registerThemeFonts } from './documentThemes';
import {
  extractPositionedPdfText, fixtureBranding, goldenLines, makeFixtureInvoice, makeFixtureLine, pdfPageCount,
} from '../testUtils/invoiceRenderFixtures';

const state = vi.hoisted(() => ({ draws: [] as { font: string; text: string }[], currentFont: '' }));
const texts = (pdf: Buffer) => extractPositionedPdfText(pdf).map((f) => f.text);

describe('invoice PDF strings follow the document locale', () => {
  it('English: eyebrow, FROM / BILL TO, dates, column headers, totals', async () => {
    const t = texts(await renderInvoicePdfBuffer(makeFixtureInvoice(), goldenLines(), fixtureBranding));
    expect(t).toEqual(expect.arrayContaining([
      'INVOICE', 'FROM', 'BILL TO', 'Issued: Sep 30, 2026', 'Due: Oct 30, 2026',
      'DESCRIPTION', 'QTY', 'PRICE', 'TAX', 'AMOUNT', 'Subtotal', 'Tax (8.5%)', 'Total',
    ]));
  });

  it('pt-BR (stamped): every header string, date and total label is Portuguese', async () => {
    const t = texts(await renderInvoicePdfBuffer(makeFixtureInvoice({ documentLocale: 'pt-BR' }), goldenLines(), fixtureBranding));
    expect(t).toEqual(expect.arrayContaining([
      'FATURA', 'DE', 'COBRAR DE', 'Emitida: 30 de set. de 2026', 'Vencimento: 30 de out. de 2026',
      'DESCRIÇÃO', 'QTD', 'PREÇO', 'IMPOSTO', 'VALOR', 'Subtotal', 'Imposto (8.5%)',
    ]));
    for (const english of ['INVOICE', 'FROM', 'BILL TO', 'DESCRIPTION', 'Issued: Sep 30, 2026']) expect(t).not.toContain(english);
  });

  it('an unstamped document follows the branding (partner) locale', async () => {
    const pdf = await renderInvoicePdfBuffer(makeFixtureInvoice({ documentLocale: null }), goldenLines(), { ...fixtureBranding, locale: 'pt-BR' });
    expect(texts(pdf)).toContain('FATURA');
  });

  it('a locale without document labels prints English', async () => {
    const t = texts(await renderInvoicePdfBuffer(makeFixtureInvoice({ documentLocale: 'de-DE', currencyCode: 'EUR' }), goldenLines(), fixtureBranding));
    expect(t).toContain('INVOICE');
    expect(t.find((x) => x.startsWith('Issued: '))).toMatch(/^Issued: /); // English labels, whatever the money/date locale
  });

  it('a draft prints the localised labor label for a withheld note (spec §3.7)', async () => {
    const lines = [makeFixtureLine({ sourceType: 'time_entry', name: null, description: 'Diagnosed the spooler', quantity: '1.00', lineTotal: '100.00', workedMinutes: 60 })];
    const pdf = await renderInvoicePdfBuffer(
      makeFixtureInvoice({ status: 'draft', invoiceNumber: null, documentLocale: null }), lines, { ...fixtureBranding, locale: 'pt-BR' },
      null, { grouping: 'entry', showDate: false, showNote: false, showWorkedTime: true },
    );
    const t = texts(pdf);
    expect(t).toContain('Mão de obra');
    expect(t).not.toContain('Diagnosed the spooler');
    expect(t).toContain('Rascunho'); // the draft number slot
  });
});

describe('bill-to block', () => {
  it('prints the address lines and the tax id under the name, then the fallback email', async () => {
    const pdf = await renderInvoicePdfBuffer(
      makeFixtureInvoice({ billToTaxId: 'TAX-99' }), goldenLines(), { ...fixtureBranding, billToEmailFallback: 'ap@example.test' });
    const f = extractPositionedPdfText(pdf);
    const y = (text: string) => f.find((x) => x.text === text)!.y;
    expect(y('1 Example Way')).toBeGreaterThan(y('An hourly client'));
    expect(y('Springfield, IL, 62704')).toBeGreaterThan(y('1 Example Way'));
    expect(y('Tax ID: TAX-99')).toBeGreaterThan(y('US'));
    expect(y('ap@example.test')).toBeGreaterThan(y('Tax ID: TAX-99'));
  });
});

describe('totals', () => {
  it('an unpaid invoice shows Total and Balance due; a paid one adds Paid', async () => {
    const unpaid = texts(await renderInvoicePdfBuffer(makeFixtureInvoice(), goldenLines(), fixtureBranding));
    expect(unpaid).toEqual(expect.arrayContaining(['Total', 'Balance due']));
    expect(unpaid).not.toContain('Paid');
    const paid = texts(await renderInvoicePdfBuffer(makeFixtureInvoice({ amountPaid: '100.00', balance: '503.50' }), goldenLines(), fixtureBranding));
    expect(paid).toEqual(expect.arrayContaining(['Total', 'Paid', 'Balance due', '-$100.00']));
  });
});

describe('theme fonts', () => {
  let fontSpy: ReturnType<typeof vi.spyOn>;
  let textSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    state.draws = []; state.currentFont = '';
    const realFont = PDFKitDocument.prototype.font;
    const realText = PDFKitDocument.prototype.text;
    fontSpy = vi.spyOn(PDFKitDocument.prototype, 'font').mockImplementation(function (this: PDFKit.PDFDocument, ...args: unknown[]) {
      state.currentFont = String(args[0]);
      return (realFont as (...a: unknown[]) => unknown).apply(this, args) as PDFKit.PDFDocument;
    } as unknown as typeof PDFKitDocument.prototype.font);
    textSpy = vi.spyOn(PDFKitDocument.prototype, 'text').mockImplementation(function (this: PDFKit.PDFDocument, ...args: unknown[]) {
      state.draws.push({ font: state.currentFont, text: String(args[0]) });
      return (realText as (...a: unknown[]) => unknown).apply(this, args) as PDFKit.PDFDocument;
    } as unknown as typeof PDFKitDocument.prototype.text);
  });
  afterEach(() => { fontSpy.mockRestore(); textSpy.mockRestore(); });
  const fontFor = (text: string) => state.draws.find((d) => d.text === text)?.font;

  it('a condensed-theme invoice draws wordmark, headers, rows and totals in the condensed faces (D4)', async () => {
    const condensed = registerThemeFonts(new PDFKitDocument(), 'condensed');
    await renderInvoicePdfBuffer(makeFixtureInvoice({ documentTheme: 'condensed' }), goldenLines(), fixtureBranding);
    expect(fontFor('Example MSP')).toBe(condensed.heading.bold);
    expect(fontFor('DESCRIPTION')).toBe(condensed.body.bold);
    expect(fontFor('Subtotal')).toBe(condensed.body.regular);
    expect(state.draws.some((d) => d.font === 'Helvetica' || d.font === 'Helvetica-Bold')).toBe(false);
  });

  it('a classic invoice stays on Helvetica', async () => {
    await renderInvoicePdfBuffer(makeFixtureInvoice({ documentTheme: 'classic' }), goldenLines(), fixtureBranding);
    expect(fontFor('Example MSP')).toBe('Helvetica-Bold');
    expect(state.draws.every((d) => d.font.startsWith('Helvetica'))).toBe(true);
  });
});

describe('a long invoice (multi-page)', () => {
  const lines = Array.from({ length: 90 }, (_, i) => makeFixtureLine({
    description: `Managed service item ${i + 1}`, name: `Service ${i + 1}`, lineTotal: '10.00', unitPrice: '10.00', taxable: i % 2 === 0,
  }));

  it('paginates, repeats the column header on every page, keeps each row whole and ends with the totals', async () => {
    const pdf = await renderInvoicePdfBuffer(makeFixtureInvoice({ subtotal: '900.00', total: '903.50', balance: '903.50' }), lines, fixtureBranding);
    expect(pdfPageCount(pdf)).toBeGreaterThanOrEqual(3);
    const f = extractPositionedPdfText(pdf);
    const pages = [...new Set(f.map((x) => x.page))];
    const rowPages = [...new Set(f.filter((x) => /^Service \d+$/.test(x.text)).map((x) => x.page))];
    expect(rowPages.length).toBeGreaterThanOrEqual(2);
    for (const p of rowPages) expect(f.some((x) => x.page === p && x.text === 'DESCRIPTION'), `header on stream ${p}`).toBe(true);
    for (let i = 1; i <= 90; i++) {
      const title = f.find((x) => x.text === `Service ${i}`)!;
      expect(f.some((x) => x.page === title.page && x.x > 400 && Math.abs(x.y - title.y) < 1), `row ${i}`).toBe(true);
    }
    const last = Math.max(...pages);
    expect(f.find((x) => x.text === 'Subtotal')!.page).toBe(last);
    expect(f.find((x) => x.text === 'Balance due')!.page).toBe(last);
  });
});

describe('notes, terms, footer and pay-online line', () => {
  it('prints Notes and Terms & Conditions headings from the labels, then the pay-online link and the footer', async () => {
    const pdf = await renderInvoicePdfBuffer(
      makeFixtureInvoice({ termsAndConditions: 'Payment due within 30 days.', terms: null }), goldenLines(),
      { ...fixtureBranding, payOnlineUrl: 'https://pay.example.test/x' },
    );
    const t = texts(pdf);
    expect(t).toEqual(expect.arrayContaining(['NOTES', 'TERMS & CONDITIONS', 'Pay online: ', 'https://pay.example.test/x', 'Powered by Example']));
  });

  it("terms '' prints no footer; terms set wins over the branding footer", async () => {
    expect(texts(await renderInvoicePdfBuffer(makeFixtureInvoice({ terms: '' }), goldenLines(), fixtureBranding))).not.toContain('Powered by Example');
    const t = texts(await renderInvoicePdfBuffer(makeFixtureInvoice({ terms: 'Net 30.' }), goldenLines(), fixtureBranding));
    expect(t).toContain('Net 30.');
    expect(t).not.toContain('Powered by Example');
  });

  it('pt-BR headings and pay-online label', async () => {
    const t = texts(await renderInvoicePdfBuffer(
      makeFixtureInvoice({ documentLocale: 'pt-BR', termsAndConditions: 'x' }), goldenLines(), { ...fixtureBranding, payOnlineUrl: 'https://pay.example.test/x' }));
    expect(t).toEqual(expect.arrayContaining(['OBSERVAÇÕES', 'TERMOS E CONDIÇÕES', 'Pagar on-line: ']));
  });
});
