// #8604: invoice labor line itemization on the API renderers (customer HTML +
// PDF). The default-settings case is pinned byte-for-byte by
// invoicePdf.golden.test.ts; this file covers every non-default toggle, per-day
// grouping, the frozen issued-invoice columns, and pagination of tall rows.
import { describe, it, expect } from 'vitest';
import { DEFAULT_INVOICE_LINE_DETAIL, type InvoiceLineDetail } from '@breeze/shared';
import { renderInvoiceHtml, renderInvoicePdfBuffer } from './invoicePdf';
import {
  extractPositionedPdfText, fixtureBranding, goldenLines, makeFixtureInvoice, makeFixtureLine, pdfPageCount,
} from '../testUtils/invoiceRenderFixtures';

const D = DEFAULT_INVOICE_LINE_DETAIL;
const withDate: InvoiceLineDetail = { ...D, showDate: true };
const byDay: InvoiceLineDetail = { ...D, showDate: true, grouping: 'day' };
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
const pdfText = async (detail: InvoiceLineDetail, lines = goldenLines(), invoice = makeFixtureInvoice()) =>
  extractPositionedPdfText(await renderInvoicePdfBuffer(invoice, lines, fixtureBranding, null, detail));

describe('renderInvoiceHtml — line detail', () => {
  it('explicit default settings render the same bytes as no settings (the golden path)', () => {
    const inv = makeFixtureInvoice();
    expect(renderInvoiceHtml(inv, goldenLines(), fixtureBranding, D)).toBe(renderInvoiceHtml(inv, goldenLines(), fixtureBranding));
  });

  it('date ON (per entry): each dated time-entry line prints its day; undated lines print none', () => {
    const html = renderInvoiceHtml(makeFixtureInvoice(), goldenLines(), fixtureBranding, withDate);
    expect(count(html, 'Sep 16, 2026')).toBe(2);           // two visible entries that day (the hidden one never renders)
    expect(count(html, 'Sep 17, 2026')).toBe(1);
    // The date sits in the title cell of its own line, after the title.
    expect(html).toMatch(/Diagnosed paper jam<div[^>]*>Sep 16, 2026<\/div>/);
    // Part, manual and the aggregated block-hours overage line carry no date.
    expect(html).toMatch(/Fuser unit<\/td>/);
    expect(html).toMatch(/Block hours overage<\/td>/);
    expect(html).not.toContain('Internal follow-up');
  });

  it('per day: one sub-header per date, ascending, with exact per-day hours and amount; lines keep their own rows', () => {
    const html = renderInvoiceHtml(makeFixtureInvoice(), goldenLines(), fixtureBranding, byDay);
    expect(count(html, 'Sep 16, 2026')).toBe(1);           // on the header only — lines do not repeat it
    expect(count(html, 'Sep 17, 2026')).toBe(1);
    expect(html.indexOf('Sep 16, 2026')).toBeLessThan(html.indexOf('Sep 17, 2026'));   // stored order had Sep 17 first
    const day16 = html.slice(html.indexOf('data-day="2026-09-16"'));
    const header16 = day16.slice(0, day16.indexOf('</tr>'));
    expect(header16).toContain('>2<');                     // 1.50 + 0.50 h (hidden 0.25 h excluded)
    expect(header16).toContain('$200.00');
    // Both entries under that day keep their own amounts.
    expect(html).toContain('$150.00');
    expect(html).toContain('$50.00');
    // Undated lines follow the dated ones inside the ticket group, with no header of their own.
    expect(html.indexOf('Sep 17, 2026')).toBeLessThan(html.indexOf('Fuser unit'));
    // The overage line stays one aggregated, undated row.
    expect(count(html, 'Block hours overage')).toBe(1);
  });

  it('note OFF: a time-entry line prints the generic labor label, never the technician note; other lines unchanged', () => {
    const html = renderInvoiceHtml(makeFixtureInvoice(), goldenLines(), fixtureBranding, { ...D, showNote: false });
    for (const note of ['Replaced fuser unit', 'Diagnosed paper jam', 'Tested print queue']) expect(html).not.toContain(note);
    expect(count(html, '>Labor<')).toBe(3);
    expect(html).toContain('Fuser unit');
    expect(html).toContain('Travel and setup');            // a manual line's blurb is not a time-entry note
    expect(html).toContain('Block hours overage');
  });

  it('note OFF localises the labor label', () => {
    const html = renderInvoiceHtml(makeFixtureInvoice({ documentLocale: 'pt-BR' }), goldenLines(), fixtureBranding, { ...D, showNote: false });
    expect(html).toContain('Mão de obra');
  });

  it('worked time OFF hides the worked-vs-billed disclosure; ON (default) shows it', () => {
    expect(renderInvoiceHtml(makeFixtureInvoice(), goldenLines(), fixtureBranding, D)).toContain('1.83 h worked · 1.50 h billed');
    expect(renderInvoiceHtml(makeFixtureInvoice(), goldenLines(), fixtureBranding, { ...D, showWorkedTime: false })).not.toContain('h worked');
  });

  it('with no settings passed, an issued invoice renders from its frozen columns', () => {
    const issued = makeFixtureInvoice({ status: 'sent', lineGrouping: 'entry', lineShowDate: true, lineShowNote: true, lineShowWorkedTime: false } as never);
    const html = renderInvoiceHtml(issued, goldenLines(), fixtureBranding);
    expect(html).toContain('Sep 16, 2026');
    expect(html).not.toContain('h worked');
  });

  it('escapes a hostile note and keeps the date beside it', () => {
    const lines = [makeFixtureLine({ sourceType: 'time_entry', description: '<script>alert(1)</script>', workedMinutes: 60, workDate: '2026-09-16' })];
    const html = renderInvoiceHtml(makeFixtureInvoice(), lines, fixtureBranding, withDate);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Sep 16, 2026');
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
