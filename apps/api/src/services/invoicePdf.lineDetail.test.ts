// #8604: invoice labor line itemization on the invoice PDF renderer (the HTML
// renderer was deleted in #9414 W3a). The default-settings case is pinned by
// invoicePdf.golden.test.ts; this file covers every non-default toggle, per-day
// grouping, the frozen issued-invoice columns, and pagination of tall rows.
import { describe, it, expect } from 'vitest';
import { DEFAULT_INVOICE_LINE_DETAIL, type InvoiceLineDetail } from '@breeze/shared';
import { renderInvoicePdfBuffer } from './invoicePdf';
import {
  extractPositionedPdfText, fixtureBranding, goldenLines, makeFixtureInvoice, makeFixtureLine, pdfPageCount,
} from '../testUtils/invoiceRenderFixtures';

const D = DEFAULT_INVOICE_LINE_DETAIL;
const withDate: InvoiceLineDetail = { ...D, showDate: true };
const byDay: InvoiceLineDetail = { ...D, showDate: true, grouping: 'day' };
const pdfText = async (detail: InvoiceLineDetail, lines = goldenLines(), invoice = makeFixtureInvoice()) =>
  extractPositionedPdfText(await renderInvoicePdfBuffer(invoice, lines, fixtureBranding, null, detail));

describe('invoice PDF — line detail (hidden lines, frozen columns, locale)', () => {
  const texts = async (detail?: InvoiceLineDetail, invoice = makeFixtureInvoice(), lines = goldenLines()) =>
    extractPositionedPdfText(await renderInvoicePdfBuffer(invoice, lines, fixtureBranding, null, detail)).map((f) => f.text);

  it('date ON (per entry): hidden lines never render; part, manual and overage lines carry no date', async () => {
    const t = await texts(withDate);
    expect(t.filter((x) => x === 'Sep 16, 2026')).toHaveLength(2);   // two visible entries that day (the hidden one never renders)
    expect(t.filter((x) => x === 'Sep 17, 2026')).toHaveLength(1);
    expect(t).not.toContain('Internal follow-up');
    expect(t).toEqual(expect.arrayContaining(['Fuser unit', 'Block hours overage']));
  });

  it('per day: hours and the day amount are exact; lines keep their own amounts and the overage stays one undated row', async () => {
    const t = await texts(byDay);
    expect(t).toEqual(expect.arrayContaining(['$150.00', '$50.00', '$200.00']));
    expect(t.filter((x) => x === 'Block hours overage')).toHaveLength(1);
    // Positions: one header per date (lines do not repeat it), ascending, hours at the
    // qty column and the day total at the amount column on the header's baseline.
    const f = await pdfText(byDay);
    const h16 = f.filter((x) => x.text === 'Sep 16, 2026');
    const h17 = f.filter((x) => x.text === 'Sep 17, 2026');
    expect(h16).toHaveLength(1);
    expect(h17).toHaveLength(1);
    expect(h16[0]!.y).toBeLessThan(h17[0]!.y);   // stored order had Sep 17 first
    const row16 = f.filter((x) => Math.abs(x.y - h16[0]!.y) < 0.5).map((x) => x.text);
    expect(row16).toEqual(expect.arrayContaining(['2', '$200.00']));   // 1.50 + 0.50 h (the hidden 0.25 h excluded)
    expect(f.find((x) => x.text === 'Fuser unit')!.y).toBeGreaterThan(h17[0]!.y);   // undated lines follow
  });

  it('note OFF: the generic labor label replaces each technician note; other lines unchanged', async () => {
    const t = await texts({ ...D, showNote: false });
    for (const note of ['Replaced fuser unit', 'Diagnosed paper jam', 'Tested print queue']) expect(t).not.toContain(note);
    expect(t.filter((x) => x === 'Labor')).toHaveLength(3);
    expect(t).toEqual(expect.arrayContaining(['Fuser unit', 'Travel and setup', 'Block hours overage']));  // a manual line's blurb is not a time-entry note
  });

  it('note OFF localises the labor label', async () => {
    const t = await texts({ ...D, showNote: false }, makeFixtureInvoice({ documentLocale: 'pt-BR' }));
    expect(t.filter((x) => x === 'M\u00e3o de obra')).toHaveLength(3);
  });

  it('worked time OFF hides the worked-vs-billed disclosure; ON (default) shows it', async () => {
    expect(await texts(D)).toContain('1.83 h worked \u00b7 1.50 h billed');
    expect((await texts({ ...D, showWorkedTime: false })).join('|')).not.toContain('h worked');
  });

  it('with no settings passed, an issued invoice renders from its frozen columns', async () => {
    const issued = makeFixtureInvoice({ status: 'sent', lineGrouping: 'entry', lineShowDate: true, lineShowNote: true, lineShowWorkedTime: false } as never);
    const t = await texts(undefined, issued);
    expect(t).toContain('Sep 16, 2026');
    expect(t.join('|')).not.toContain('h worked');
  });

  it('draws a hostile note verbatim as text and keeps the date beside it', async () => {
    const lines = [makeFixtureLine({ sourceType: 'time_entry', description: '<script>alert(1)</script>', workedMinutes: 60, workDate: '2026-09-16' })];
    const t = await texts(withDate, makeFixtureInvoice(), lines);
    expect(t).toContain('<script>alert(1)</script>');   // a PDF has no markup to inject into
    expect(t).toContain('Sep 16, 2026');
  });
});

describe('renderInvoicePdfBuffer — line detail', () => {
  it('explicit default settings draw the same text at the same positions as no settings', async () => {
    const inv = makeFixtureInvoice();
    const a = extractPositionedPdfText(await renderInvoicePdfBuffer(inv, goldenLines(), fixtureBranding, null, D));
    const b = extractPositionedPdfText(await renderInvoicePdfBuffer(inv, goldenLines(), fixtureBranding));
    expect(a).toEqual(b);
  });

  it('date ON draws the day under its line title, inside the description column, before the next row', async () => {
    const frags = await pdfText(withDate);
    const title = frags.find((f) => f.text === 'Diagnosed paper jam')!;
    const dates = frags.filter((f) => f.text === 'Sep 16, 2026');
    expect(dates).toHaveLength(2);
    const date = dates.find((f) => f.y > title.y && f.y - title.y < 30)!;
    expect(date).toBeDefined();
    expect(date.x).toBe(title.x);
    const next = frags.find((f) => f.text === 'Tested print queue')!;
    expect(next.y).toBeGreaterThan(date.y);
    expect(frags.filter((f) => f.text.includes('Sep 1')).length).toBe(3);    // no date on part/manual/overage
  });

  it('per day draws one header per date in ascending order with the day totals in the number columns', async () => {
    const frags = await pdfText(byDay);
    const h16 = frags.filter((f) => f.text === 'Sep 16, 2026');
    const h17 = frags.filter((f) => f.text === 'Sep 17, 2026');
    expect(h16).toHaveLength(1);
    expect(h17).toHaveLength(1);
    expect(h16[0]!.y).toBeLessThan(h17[0]!.y);
    const sameRow = (f: { y: number }) => frags.filter((g) => Math.abs(g.y - f.y) < 0.5).map((g) => g.text);
    expect(sameRow(h16[0]!)).toEqual(expect.arrayContaining(['2', '$200.00']));
    expect(sameRow(h17[0]!)).toEqual(expect.arrayContaining(['1', '$100.00']));
    // Undated rows come after the dated ones.
    expect(frags.find((f) => f.text === 'Fuser unit')!.y).toBeGreaterThan(h17[0]!.y);
  });

  it('note OFF and worked time OFF withhold the note and the disclosure from the PDF', async () => {
    const text = (await pdfText({ ...D, showNote: false, showWorkedTime: false })).map((f) => f.text).join('|');
    expect(text).not.toContain('Diagnosed paper jam');
    expect(text).not.toContain('h worked');
    expect(text.split('Labor').length - 1).toBe(3);
    expect(text).toContain('Fuser unit');
  });

  it('a tall row never splits its cells across pages: each title shares its page and baseline with its amount', async () => {
    const longNote = 'Ünïcödé àccéntéd wörk nötë — réplacéd thé fusér, cléanéd rollérs, tëstéd. '.repeat(10);
    const lines = Array.from({ length: 14 }, (_, i) => makeFixtureLine({
      sourceType: 'time_entry', description: `Entry ${i + 1}: ${longNote}`, quantity: '1.00', unitPrice: '100.00',
      lineTotal: `${101 + i}.00`, workedMinutes: 60, workDate: '2026-09-16',
    }));
    const pdf = await renderInvoicePdfBuffer(makeFixtureInvoice(), lines, fixtureBranding, null, withDate);
    expect(pdfPageCount(pdf)).toBeGreaterThan(2);
    const frags = extractPositionedPdfText(pdf);
    for (let i = 0; i < lines.length; i++) {
      const title = frags.find((f) => f.text.startsWith(`Entry ${i + 1}:`));
      const amount = frags.find((f) => f.text === `$${101 + i}.00`);
      expect(title, `title ${i + 1}`).toBeDefined();
      expect(amount, `amount ${i + 1}`).toBeDefined();
      expect(amount!.page, `row ${i + 1} page`).toBe(title!.page);
      expect(Math.abs(amount!.y - title!.y), `row ${i + 1} baseline`).toBeLessThan(1);
    }
  });
});
