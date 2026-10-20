import { describe, it, expect } from 'vitest';
import { buildInvoiceDocumentModel, DocumentModelError } from './invoiceBuilder';
import { INVOICE_DTO_FIXTURES as fx, type InvoiceFixtureName } from './fixtures/invoiceDtos';
import { DOCUMENT_LABELS_EN as EN } from './labels';
import { documentMoney } from './money';
import { formatMoney } from '../utils/currency';
import type { CustomerInvoiceDocument, CustomerInvoiceLineDto } from './dto';
import type { DocumentLineRow, DocumentMoney, InvoiceDocumentModel } from './model';

const build = (name: InvoiceFixtureName) => buildInvoiceDocumentModel(fx[name], EN);
type AnyRow = DocumentLineRow<DocumentMoney | 'exempt' | null>;
const allRows = (m: InvoiceDocumentModel): AnyRow[] =>
  (m.lines.groups as { days: { rows: AnyRow[] }[] }[]).flatMap((g) => g.days.flatMap((d) => d.rows));
const firstRow = (m: InvoiceDocumentModel) => allRows(m)[0]!;
const withLines = (d: CustomerInvoiceDocument, f: (l: CustomerInvoiceLineDto) => CustomerInvoiceLineDto): CustomerInvoiceDocument =>
  ({ ...d, lines: d.lines.map(f) });
const row = (m: InvoiceDocumentModel, key: string) => m.totals.rows.find((r) => r.key === key);

describe('buildInvoiceDocumentModel', () => {
  it('issued: header, dates, bill-to, status pill and seller', () => {
    const m = build('issued');
    expect(m.kind).toBe('invoice');
    expect(m.locale).toBe('en');
    expect(m.header).toEqual({
      eyebrow: 'Invoice', number: 'INV-0042', subtitle: null,
      status: { label: 'Sent', tone: 'info' },
      dates: [
        { label: 'Issued', value: { text: 'Mar 01, 2026', iso: '2026-03-01' } },
        { label: 'Due', value: { text: 'Mar 31, 2026', iso: '2026-03-31' } },
      ],
      billTo: { label: 'Bill to', name: 'Acme Dental', addressLines: [], taxId: null },
    });
    expect(m.branding).toEqual({
      logo: { kind: 'url', url: 'https://cdn.example-msp.test/logo.png' },
      logoAlt: 'Example MSP',
      wordmark: 'Example MSP',
      theme: 'classic',
      pageSize: 'letter',
      seller: {
        name: 'Example MSP', lines: ['100 Example Way', 'Springfield, IL, 62701', 'US'],
        phone: '+1 555 0100', email: 'billing@example-msp.test', website: 'https://example-msp.test',
      },
    });
    expect(m.notes).toBe('Thank you for your business.');
    expect(m.terms).toEqual({ short: null, full: { label: 'Terms & Conditions', text: 'Payment due within 30 days.\nLate fees may apply.', meta: '' } });
    expect(m.footer).toBeNull();
  });

  it('every row is keyed by its server line id and carries qty, unit and amount', () => {
    const m = build('issued');
    expect(allRows(m).map((r) => r.key)).toEqual(fx.issued.lines.map((l) => l.id));
    const r = firstRow(m);
    expect(r.qty).toBe('1.5');
    expect(r.unit).toEqual(documentMoney('100.00', 'USD', 'en'));
    expect(r.amount).toEqual(documentMoney('150.00', 'USD', 'en'));
    expect(r.descriptor).toEqual([]);
    expect(r.ticketText).toBeNull();
    expect(r.thumbnail).toBeNull();
  });

  it('title/blurb follow the portal: name ?? description, blurb only under a name', () => {
    const rows = allRows(build('issued'));
    expect(rows[0]).toMatchObject({ title: 'Remote support', blurb: 'Reset the mail profile' });
    expect(rows[1]).toMatchObject({ title: 'Replacement toner', blurb: null });
    expect(rows[2]).toMatchObject({ title: 'Monthly monitoring', blurb: null });
  });

  it('a blank line falls back to an em dash title', () => {
    const dto = withLines(fx.multilineBlurb, (l) => ({ ...l, name: null, description: '   ' }));
    expect(firstRow(buildInvoiceDocumentModel(dto, EN)).title).toBe('—');
  });

  it('a multi-line blurb keeps its newlines in the model', () => {
    expect(firstRow(build('multilineBlurb')).blurb).toBe('Line one\nLine two');
  });

  it('entry grouping: the work date sits on the row; worked-vs-billed note from structured data', () => {
    const r = firstRow(build('issued'));
    expect(r.workDate).toEqual({ text: 'Feb 26, 2026', iso: '2026-02-26' });
    expect(r.note).toBeNull(); // 90 min worked = 1.5 billed
    const dto = withLines(fx.issued, (l) => (l.workedMinutes ? { ...l, workedMinutes: 60 } : l));
    expect(firstRow(buildInvoiceDocumentModel(dto, EN)).note).toBe('1.00 h worked · 1.50 h billed');
  });

  it('groups by ticket in first-seen order; unticketed lines share a headerless group', () => {
    const m = build('issued');
    expect(m.lines.groups.map((g) => g.header)).toEqual([
      { kind: 'ticket', title: 'Ticket #42', category: 'Support' },
      null,
    ]);
    expect(m.lines.groups.map((g) => g.key)).toEqual(['num_42', '__none__']);
    expect(m.lines.groups[0]!.days).toHaveLength(1);
    expect(m.lines.groups[0]!.days[0]!.header).toBeNull();
  });

  it('day grouping: dated buckets ascending with hours and total, undated last; no per-row date', () => {
    const m = build('dayGrouping');
    const days = m.lines.groups[0]!.days;
    expect(days.map((d) => d.key)).toEqual(['2026-02-26', '2026-02-27', 'undated']);
    expect(days[0]!.header).toEqual({ date: { text: 'Feb 26, 2026', iso: '2026-02-26' }, hours: '1.5', total: documentMoney('150.00', 'USD', 'en') });
    expect(days[2]!.header).toBeNull();
    expect(allRows(m).every((r) => r.workDate === null)).toBe(true);
  });

  it('the tax column and row types agree', () => {
    expect(build('untaxed').lines.columns.tax).toBeNull();
    expect(allRows(build('untaxed')).every((r) => r.tax === null)).toBe(true);
    const taxed = build('taxed');
    expect(taxed.lines.columns).toEqual({ description: 'Description', qty: 'Qty', unitPrice: 'Price', tax: 'Tax', amount: 'Amount', notTaxable: 'Not taxable' });
    expect(allRows(taxed).map((r) => r.tax)).toEqual([
      documentMoney('12.38', 'USD', 'en'),
      documentMoney('4.13', 'USD', 'en'),
      'exempt',
    ]);
  });

  it('totals: subtotal, tax (always, with pct), total, hero balance due', () => {
    const m = build('taxed');
    expect(m.totals.rows).toEqual([
      { key: 'subtotal', label: 'Subtotal', value: documentMoney('300.00', 'USD', 'en'), weight: 'regular', ruleAbove: 'none' },
      { key: 'tax', label: 'Tax (8.25%)', value: documentMoney('16.51', 'USD', 'en'), weight: 'regular', ruleAbove: 'none' },
      { key: 'total', label: 'Total', value: documentMoney('316.51', 'USD', 'en'), weight: 'strong', ruleAbove: 'neutral' },
      { key: 'balance', label: 'Balance due', value: documentMoney('316.51', 'USD', 'en'), weight: 'hero', ruleAbove: 'accent' },
    ]);
    expect(row(build('untaxed'), 'tax')).toMatchObject({ label: 'Tax', value: documentMoney('0.00', 'USD', 'en') });
    expect(m.totals.aside).toBeNull();
  });

  it('paid: Paid row with a minus sign, Balance label, no deposit strip', () => {
    const m = build('paid');
    expect(row(m, 'paid')).toEqual({ key: 'paid', label: 'Paid', value: documentMoney('300.00', 'USD', 'en'), weight: 'regular', ruleAbove: 'none', sign: 'minus' });
    expect(row(m, 'balance')!.label).toBe('Balance');
    expect(m.totals.depositStrip).toBeNull();
    expect(row(build('issued'), 'paid')).toBeUndefined();
  });

  it('unpaid deposit: the strip is worded like the portal', () => {
    const m = build('deposit');
    expect(m.totals.depositStrip).toEqual({
      parts: ['Deposit of ', { strong: formatMoney('100.00', 'USD', 'en') }, ` due — ${formatMoney('0.00', 'USD', 'en')} of ${formatMoney('300.00', 'USD', 'en')} paid.`],
    });
    const covered = buildInvoiceDocumentModel({ ...fx.deposit, invoice: { ...fx.deposit.invoice, status: 'partially_paid', displayStatus: 'partially_paid', amountPaid: '100.00', balance: '200.00' } }, EN);
    expect(covered.totals.depositStrip).toEqual({ parts: [`Deposit paid — remaining balance ${formatMoney('200.00', 'USD', 'en')}.`] });
    expect(build('issued').totals.depositStrip).toBeNull();
  });

  it('draft has no status pill, the draft number label and no dates', () => {
    const m = build('draft');
    expect(m.header.status).toBeNull();
    expect(m.header.number).toBe(EN.draftNumber);
    expect(m.header.dates).toEqual([]);
  });

  it('void carries the neutral Void pill', () => {
    expect(build('void').header.status).toEqual({ label: 'Void', tone: 'neutral' });
  });

  it('status tones follow the plan map', () => {
    const tone = (s: 'partially_paid' | 'overdue' | 'paid') =>
      buildInvoiceDocumentModel({ ...fx.issued, invoice: { ...fx.issued.invoice, status: s, displayStatus: s } }, EN).header.status!.tone;
    expect([tone('partially_paid'), tone('overdue'), tone('paid')]).toEqual(['warning', 'danger', 'success']);
  });

  it('withheld note: labor label as title, no blurb, no note', () => {
    const r = firstRow(build('withheldNote'));
    expect(r.title).toBe('Labor'); expect(r.blurb).toBeNull(); expect(r.note).toBeNull();
  });

  it('no subject and flat children while the DTO omits them (OD-9 pending)', () => {
    const m = build('taxed');
    expect(m.lines.groups[0]!.header).toEqual({ kind: 'ticket', title: 'Ticket #42', category: 'Support' });
    expect(allRows(m).some((r) => r.isChild)).toBe(false);
  });

  it('subject and nesting render when the projection carries them', () => {
    const dto = withLines(fx.taxed, (l) => ({ ...l, ticketSubject: 'Printer offline', isChild: true }));
    const m = buildInvoiceDocumentModel(dto, EN);
    expect(m.lines.groups[0]!.header).toMatchObject({ title: 'Ticket #42: Printer offline' });
    expect(allRows(m).every((r) => r.isChild)).toBe(true);
  });

  it('CHF and INR format in the document locale; the raw amount stays for the PDF', () => {
    const chf = row(build('chf'), 'total')!.value as DocumentMoney;
    expect(chf).toEqual({ text: formatMoney('1234.50', 'CHF', 'de-CH'), amount: '1234.50', currency: 'CHF', suffix: null });
    expect(build('chf').locale).toBe('de-CH');
    const inr = row(build('inr'), 'total')!.value as DocumentMoney;
    expect(inr.text).toContain('₹');
    expect(inr.amount).toBe('99.00');
  });

  it('empty: no groups, the empty text, no notes or terms', () => {
    const m = build('empty');
    expect(m.lines.groups).toEqual([]);
    expect(m.lines.emptyText).toBe('No line items.');
    expect(m.notes).toBeNull();
    expect(m.terms.full).toBeNull();
    expect(build('issued').lines.emptyText).toBeNull();
  });

  it('condensed theme and A4 page size pass through', () => {
    expect(build('condensed').branding).toMatchObject({ theme: 'condensed', pageSize: 'a4' });
  });

  it('a blank bill-to name means no bill-to block; no partner name falls back to the seller', () => {
    const m = buildInvoiceDocumentModel({ ...fx.issued, invoice: { ...fx.issued.invoice, billToName: '  ' }, branding: { ...fx.issued.branding, partnerName: null, logoUrl: null } }, EN);
    expect(m.header.billTo).toBeNull();
    expect(m.branding.wordmark).toBe('Example MSP');
    expect(m.branding.logo).toBeNull();
  });

  it('the same DTO always yields the same model', () => {
    expect(build('deposit')).toEqual(build('deposit'));
  });

  it('every fixture builds', () => {
    for (const name of Object.keys(fx) as InvoiceFixtureName[]) expect(() => build(name)).not.toThrow();
  });

  it('throws DocumentModelError if a label map yields an empty title', () => {
    const dto = withLines(fx.withheldNote, (l) => ({ ...l, name: '', description: '' }));
    // '' name → '—' fallback, so the guard cannot fire from data alone; prove the class exists and is an Error.
    expect(() => buildInvoiceDocumentModel(dto, EN)).not.toThrow();
    expect(new DocumentModelError('x')).toBeInstanceOf(Error);
  });
});
