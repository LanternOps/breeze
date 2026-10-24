import { describe, it, expect } from 'vitest';
import { buildQuoteDocumentModel } from './quoteBuilder';
import { DocumentModelError } from './invoiceBuilder';
import { QUOTE_DTO_FIXTURES as fx, QUOTE_FIXTURE_IDS, type QuoteFixtureName } from './fixtures/quoteDtos';
import { DOCUMENT_LABELS_EN as EN } from './labels';
import { documentMoney } from './money';
import type { CustomerQuoteBlockDto, CustomerQuoteDocument, CustomerQuoteLineDto } from './quoteDto';
import type { DocumentLineRow, DocumentLineTableModel, DocumentMoney, SanitizedHtml } from './model';
import type { QuoteBlockModel, QuoteDocumentModel } from './quoteModel';

const build = (name: QuoteFixtureName) => buildQuoteDocumentModel(fx[name], EN);
type AnyRow = DocumentLineRow<DocumentMoney | 'exempt' | null>;
const tables = (m: QuoteDocumentModel): DocumentLineTableModel[] =>
  m.blocks.flatMap((b) => (b.kind === 'line_items' ? [b.table] : []));
const rowsOf = (t: DocumentLineTableModel): AnyRow[] =>
  (t.groups as { days: { rows: AnyRow[] }[] }[]).flatMap((g) => g.days.flatMap((d) => d.rows));
const allRows = (m: QuoteDocumentModel) => tables(m).flatMap(rowsOf);
const idOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const usd = (a: string, suffix: DocumentMoney['suffix'] = null) => documentMoney(a, 'USD', 'en', suffix);
const withLines = (d: CustomerQuoteDocument, f: (l: CustomerQuoteLineDto) => CustomerQuoteLineDto): CustomerQuoteDocument =>
  ({ ...d, lines: d.lines.map(f) });

describe('buildQuoteDocumentModel', () => {
  it('issued: header, branding, notes, short terms; no cover, no agreements', () => {
    const m = build('issued');
    expect(m.kind).toBe('quote');
    expect(m.locale).toBe('en');
    expect(m.header).toEqual({
      eyebrow: 'Proposal', number: 'Q-0042', subtitle: 'Network refresh',
      status: { label: 'Viewed', tone: 'info' },
      dates: [
        { label: 'Issued', value: { text: 'Mar 01, 2026', iso: '2026-03-01' } },
        { label: 'Valid until', value: { text: 'Mar 31, 2026', iso: '2026-03-31' } },
      ],
      billTo: { label: 'Prepared for', name: 'Acme Dental', addressLines: [], taxId: null },
    });
    expect(m.branding).toEqual({
      logo: { kind: 'url', url: 'https://cdn.example-msp.test/logo.png' },
      logoAlt: 'Example MSP', wordmark: 'Example MSP', theme: 'classic', pageSize: 'letter',
      seller: {
        name: 'Example MSP', lines: ['100 Example Way', 'Springfield, IL, 62701', 'US'],
        phone: '+1 555 0100', email: 'sales@example-msp.test', website: 'https://example-msp.test',
      },
    });
    expect(m.cover).toBeNull();
    expect(m.introNotes).toBe('Thanks for the opportunity.');
    expect(m.terms).toEqual({ short: { label: 'Terms', text: 'Valid for 30 days.' } });
    expect(m.agreements).toEqual([]);
    expect(m.footer).toBeNull();
  });

  it('issued: one pricing table, rows keyed by line id, thumbnail as a line ref', () => {
    const m = build('issued');
    expect(m.blocks.map((b) => [b.kind, b.key])).toEqual([['line_items', QUOTE_FIXTURE_IDS.pricingBlock]]);
    const [t] = tables(m);
    expect(t!.label).toBe('Hardware');
    expect(t!.columns).toEqual({ description: 'Description', qty: 'Qty', unitPrice: 'Unit price', tax: null, amount: 'Amount' });
    expect(t!.subtotal).toBeNull();
    expect(t!.emptyText).toBeNull();
    expect(t!.groups.map((g) => g.header)).toEqual([null]);
    const [r1, r2] = rowsOf(t!);
    expect(r1).toEqual({
      key: idOf(101), title: 'Firewall', blurb: 'Rack-mounted pair', workDate: null, qty: '2',
      unit: usd('100.00'), tax: null, amount: usd('200.00'), note: null, descriptor: [], ticketText: null,
      thumbnail: { kind: 'line_thumb', id: idOf(101) }, isChild: false,
    });
    expect(r2).toMatchObject({ title: 'Installation', blurb: null, thumbnail: null });
  });

  it('issued totals: a single Total hero row, no aside', () => {
    expect(build('issued').totals).toEqual({
      rows: [{ key: 'total', label: 'Total', value: usd('300.00'), weight: 'hero', ruleAbove: 'accent' }],
      aside: null,
      depositStrip: null,
    });
  });

  it('taxed: tax column, per-line tax from the portal rule, Subtotal + Tax rows', () => {
    const m = build('taxed');
    const [t] = tables(m);
    expect(t!.columns.tax).toBe('Tax');
    expect(t!.columns).toMatchObject({ notTaxable: 'Not taxable' });
    expect(rowsOf(t!).map((r) => r.tax)).toEqual([usd('17.00'), 'exempt']);
    expect(m.totals.rows.map((r) => [r.key, r.label])).toEqual([
      ['subtotal', 'Subtotal'], ['tax', 'Tax (8.5%)'], ['total', 'Total'],
    ]);
    expect(m.totals.rows[1]!.value).toEqual(usd('17.00'));
    expect(m.totals.rows[2]!.value).toEqual(usd('317.00'));
  });

  it('the tax column and the row cells agree', () => {
    expect(allRows(build('untaxed')).every((r) => r.tax === null)).toBe(true);
    expect(allRows(build('taxed')).every((r) => r.tax !== null)).toBe(true);
  });

  it('untaxed: lines with no block land in the trailing default pricing table', () => {
    const m = build('untaxed');
    expect(m.blocks.map((b) => b.key)).toEqual(['default-pricing']);
    expect(tables(m)[0]!.label).toBe('Pricing');
    expect(tables(m)[0]!.subtotal).toBeNull();
  });

  it('recurring: cadence groups in canonical order, OD-11 suffix on unit and amount, table subtotal', () => {
    const m = build('recurring');
    const [t] = tables(m);
    expect(t!.groups.map((g) => [g.key, g.header])).toEqual([
      ['one_time', { kind: 'cadence', label: 'One-time' }],
      ['monthly', { kind: 'cadence', label: 'Monthly' }],
      ['annual', { kind: 'cadence', label: 'Annual' }],
    ]);
    const [setup, monthly, annual] = rowsOf(t!);
    expect(setup!.unit.suffix).toBeNull();
    expect(monthly!.unit).toEqual(usd('50.00', EN.perMonth));
    expect(monthly!.amount).toEqual(usd('50.00', EN.perMonth));
    expect(annual!.unit.suffix).toEqual(EN.perYear);
    expect(annual!.amount.suffix).toEqual(EN.perYear);
    expect(t!.subtotal).toEqual({ label: 'Subtotal', parts: [usd('100.00'), usd('50.00', EN.perMonth), usd('600.00', EN.perYear)] });
  });

  it('recurring totals: recurring rows, category breakdown, Due on acceptance, first-period aside', () => {
    const m = build('recurring');
    expect(m.totals.rows).toEqual([
      { key: 'monthly', label: 'Monthly recurring', value: usd('50.00', EN.perMonth), weight: 'regular', ruleAbove: 'none' },
      { key: 'annual', label: 'Annual recurring', value: usd('600.00', EN.perYear), weight: 'regular', ruleAbove: 'none' },
      { key: 'category:hardware', label: 'Hardware', value: [usd('100.00')], weight: 'muted', ruleAbove: 'none' },
      { key: 'category:services', label: 'Services', value: [usd('50.00', EN.perMonth), usd('600.00', EN.perYear)], weight: 'muted', ruleAbove: 'none' },
      { key: 'dueOnAcceptance', label: 'Due on acceptance', value: usd('100.00'), weight: 'hero', ruleAbove: 'accent' },
    ]);
    expect(m.totals.aside).toEqual({
      rows: [{ key: 'firstPeriodTotal', label: 'First-period total', value: usd('750.00'), weight: 'regular', ruleAbove: 'none' }],
      note: EN.quote.totals.recurringNote,
    });
  });

  it('a non-zero recurring header total alone makes the quote recurring (the logged-in rule)', () => {
    const d = { ...fx.issued, quote: { ...fx.issued.quote, monthlyRecurringTotal: '10.00' } };
    const m = buildQuoteDocumentModel(d, EN);
    expect(m.totals.rows.at(-1)!.label).toBe('Due on acceptance');
    expect(m.totals.aside).not.toBeNull();
    // No monthly LINE is visible, so no Monthly recurring row.
    expect(m.totals.rows.some((r) => r.key === 'monthly')).toBe(false);
  });

  it('deposit: Due on acceptance, Deposit due now (hero) and the integer-cent remainder', () => {
    expect(build('deposit').totals.rows).toEqual([
      { key: 'dueOnAcceptance', label: 'Due on acceptance', value: usd('300.00'), weight: 'strong', ruleAbove: 'accent' },
      { key: 'depositDueNow', label: 'Deposit due now', value: usd('150.00'), weight: 'hero', ruleAbove: 'none' },
      { key: 'remainingBalance', label: 'Remaining balance (due per terms)', value: usd('150.00'), weight: 'regular', ruleAbove: 'none' },
    ]);
  });

  it('cover: the cover carries Prepared for, so the header has no bill-to', () => {
    const m = build('cover');
    expect(m.cover).toEqual({
      title: 'Network refresh proposal',
      image: { kind: 'cover', id: QUOTE_FIXTURE_IDS.coverImage },
      preparedFor: 'Acme Dental',
      preparedBy: 'Example MSP',
      eyebrow: 'Proposal',
      preparedForLabel: 'Prepared for',
      preparedByLabel: 'Prepared by',
    });
    expect(m.header.billTo).toBeNull();
  });

  it('cover fallbacks: title → quote title → number → eyebrow; preparedBy hidden when not shown', () => {
    const cover = { enabled: true, title: null, coverImageId: null, preparedForName: 'Front desk', showPreparedBy: false };
    const m = buildQuoteDocumentModel({ ...fx.issued, quote: { ...fx.issued.quote, coverPage: cover } }, EN);
    expect(m.cover).toMatchObject({ title: 'Network refresh', image: null, preparedFor: 'Front desk', preparedBy: null });
    const bare = buildQuoteDocumentModel({ ...fx.issued, quote: { ...fx.issued.quote, title: null, quoteNumber: null, coverPage: cover } }, EN);
    expect(bare.cover!.title).toBe('Proposal');
    const off = buildQuoteDocumentModel({ ...fx.issued, quote: { ...fx.issued.quote, coverPage: { ...cover, enabled: false } } }, EN);
    expect(off.cover).toBeNull();
    expect(off.header.billTo).not.toBeNull();
  });

  it('blocks: walk in sortOrder, blank content omitted, contracts out of the body', () => {
    const m = build('blocks');
    expect(m.blocks.map((b) => [b.kind, b.key])).toEqual([
      ['heading', idOf(20)],
      ['rich_text', idOf(21)],
      ['table', idOf(23)],
      ['callout', idOf(25)],
      ['image', idOf(27)],
      ['image', idOf(28)],
      ['line_items', idOf(30)],
      ['heading', idOf(32)],
      ['line_items', 'default-pricing'],
    ]);
  });

  it('blocks: decisive fields of each kind', () => {
    const byKey = new Map(build('blocks').blocks.map((b) => [b.key, b] as [string, QuoteBlockModel]));
    expect(byKey.get(idOf(20))).toEqual({ kind: 'heading', key: idOf(20), level: 2, text: 'Overview' });
    expect(byKey.get(idOf(32))).toMatchObject({ level: 3 });
    expect(byKey.get(idOf(21))).toEqual({ kind: 'rich_text', key: idOf(21), html: '<p>We will replace the core switch.</p>' });
    expect(byKey.get(idOf(23))).toEqual({
      kind: 'table', key: idOf(23),
      table: {
        columns: [{ label: 'Item', align: 'left' }, { label: '<strong>Cost</strong>', align: 'right' }],
        rows: [{ key: `${idOf(23)}:0`, cells: ['Switch', '$900'] }, { key: `${idOf(23)}:1`, cells: ['Cabling', '$100'] }],
        headerStyle: 'plain', zebra: true, caption: 'Estimate only',
      },
    });
    expect(byKey.get(idOf(25))).toEqual({ kind: 'callout', key: idOf(25), tone: 'warn', title: 'Downtime', html: '<p>One hour outage.</p>' });
    expect(byKey.get(idOf(27))).toEqual({
      kind: 'image', key: idOf(27), image: { kind: 'block_image', id: idOf(60) }, alt: 'Rack layout', caption: 'Rack layout', width: 320,
      unavailableText: 'Image unavailable',
    });
    expect(byKey.get(idOf(28))).toEqual({
      kind: 'image', key: idOf(28), image: null, alt: 'Proposal image', caption: null, width: null, unavailableText: 'Image unavailable',
    });
    const li = byKey.get(idOf(30));
    expect(li?.kind === 'line_items' && li.table.label).toBe('Pricing');
  });

  it('a line bound to a block that is not a line_items block is dropped (today)', () => {
    const titles = allRows(build('blocks')).map((r) => r.title);
    expect(titles).toEqual(['Switch', 'Orphan']);
  });

  it('a table row whose cell count differs from the columns is a builder error', () => {
    const bad = {
      ...fx.blocks,
      blocks: [{
        ...fx.blocks.blocks[3]!,
        content: { columns: [{ label: 'A' as SanitizedHtml }], rows: [{ cells: ['1' as SanitizedHtml, '2' as SanitizedHtml] }] },
      } as CustomerQuoteBlockDto],
    };
    expect(() => buildQuoteDocumentModel(bad, EN)).toThrow(DocumentModelError);
  });

  it('agreements: contract blocks in sortOrder, then Terms & Conditions', () => {
    const m = build('agreements');
    expect(m.agreements).toEqual([
      {
        id: idOf(41), anchor: `agreement-${idOf(41)}`, title: 'Service agreement', meta: '~1 min read',
        body: { kind: 'authored', html: '<p>The provider will support the listed devices.</p>', footer: 'Service agreement — v2', unavailableText: 'Agreement content unavailable' },
      },
      {
        id: idOf(40), anchor: `agreement-${idOf(40)}`, title: 'Uploaded MSA', meta: 'PDF document',
        body: {
          kind: 'uploaded', file: { kind: 'agreement_file', id: idOf(40) }, fileTitle: 'MSA (PDF)', footer: 'MSA (PDF) — v3',
          downloadLabel: 'Download agreement', unavailableText: 'Agreement file unavailable',
        },
      },
      {
        id: idOf(42), anchor: `agreement-${idOf(42)}`, title: 'DPA', meta: 'Unavailable',
        body: { kind: 'authored', html: null, footer: 'DPA — v1', unavailableText: 'Agreement content unavailable' },
      },
      {
        id: idOf(43), anchor: `agreement-${idOf(43)}`, title: 'SLA', meta: 'PDF document',
        body: {
          kind: 'uploaded', file: null, fileTitle: 'SLA', footer: 'SLA — v1',
          downloadLabel: 'Download agreement', unavailableText: 'Agreement file unavailable',
        },
      },
      {
        id: 'terms', anchor: 'terms', title: 'Terms & Conditions', meta: '2 sections · ~1 min read',
        body: { kind: 'terms', text: '1. Scope\nWe do the work.\n2. Payment\nNet 30.' },
      },
    ]);
    expect(m.blocks.every((b) => !b.key.startsWith(idOf(4)))).toBe(true);
  });

  it('device-set lines carry the customer descriptor sentences', () => {
    expect(allRows(build('deviceSet')).map((r) => r.descriptor)).toEqual([
      [
        'Estimated quantity — billed at the actual number of servers, workstations at HQ each billing period.',
        'Includes 5; additional units billed at $10.00 each.',
      ],
      [
        'Estimated quantity — billed at the actual number of seats each billing period.',
        'Includes 10; additional units are reported for review, not billed automatically.',
      ],
      ['Estimated quantity — billed at the actual number of devices in “Servers” each billing period.'],
      ['Estimated quantity — billed at the actual number of devices each billing period.'],
    ]);
  });

  it('CHF monthly line: the de-CH money form with the suffix on unit and amount (Review Focus 5)', () => {
    const r = allRows(build('chfMonthly'))[0]!;
    const chf = documentMoney('1234.50', 'CHF', 'de-CH', EN.perMonth);
    expect(r.unit).toEqual(chf);
    expect(r.amount).toEqual(chf);
    expect(r.unit.suffix).toEqual({ text: '/mo', srText: 'per month' });
  });

  it('INR keeps its symbol on screen and the raw amount for the PDF', () => {
    const r = allRows(build('inr'))[0]!;
    expect(r.amount.text).toContain('₹');
    expect(r.amount.amount).toBe('99.00');
  });

  it('superseded: a neutral Replaced pill', () => {
    expect(build('superseded').header.status).toEqual({ label: 'Replaced', tone: 'neutral' });
  });

  it('status tones follow the portal', () => {
    const tone = (s: CustomerQuoteDocument['quote']['displayStatus']) =>
      buildQuoteDocumentModel({ ...fx.issued, quote: { ...fx.issued.quote, displayStatus: s } }, EN).header.status;
    expect(tone('accepted')).toEqual({ label: 'Accepted', tone: 'success' });
    expect(tone('converted')).toEqual({ label: 'Accepted', tone: 'success' });
    expect(tone('declined')).toEqual({ label: 'Declined', tone: 'danger' });
    expect(tone('expired')).toEqual({ label: 'Expired', tone: 'danger' });
  });

  it('draft: the fallback number, no pill, no dates', () => {
    const m = build('draft');
    expect(m.header).toMatchObject({ number: 'Proposal', status: null, dates: [] });
  });

  it('empty: no tables, a zero Total', () => {
    const m = build('empty');
    expect(m.blocks).toEqual([]);
    expect(m.totals.rows).toEqual([{ key: 'total', label: 'Total', value: usd('0.00'), weight: 'hero', ruleAbove: 'accent' }]);
  });

  it('a multi-line blurb keeps its newlines', () => {
    expect(allRows(build('multilineBlurb'))[0]!.blurb).toBe('Line one\nLine two');
  });

  it('bundle children are flat while the projection omits isChild (OD-9), nested when it carries it', () => {
    expect(allRows(build('issued')).some((r) => r.isChild)).toBe(false);
    const nested = buildQuoteDocumentModel(withLines(fx.issued, (l) => ({ ...l, isChild: true })), EN);
    expect(allRows(nested).every((r) => r.isChild)).toBe(true);
  });

  it('a line with neither name nor description gets the em-dash title; titles are never empty', () => {
    const m = buildQuoteDocumentModel(withLines(fx.issued, (l) => ({ ...l, name: null, description: '  ' })), EN);
    expect(allRows(m).map((r) => r.title)).toEqual(['—', '—']);
    for (const name of Object.keys(fx) as QuoteFixtureName[]) {
      for (const r of allRows(build(name))) expect(r.title.trim()).not.toBe('');
    }
  });

  it('the same DTO always yields the same model', () => {
    expect(build('agreements')).toEqual(build('agreements'));
    expect(build('recurring')).toEqual(build('recurring'));
  });
});

// Assertions carried over from the portal's quoteBlocks.test.tsx (deleted in W2b #9419).
describe('buildQuoteDocumentModel — carried-over portal assertions', () => {
  const block = (n: number, sortOrder: number, b: Pick<CustomerQuoteBlockDto, 'blockType' | 'content'>): CustomerQuoteBlockDto =>
    ({ id: idOf(n), quoteId: idOf(1), orgId: idOf(2), sortOrder, createdAt: '2026-03-01T12:00:00.000Z', ...b }) as CustomerQuoteBlockDto;
  const withBlocks = (blocks: CustomerQuoteBlockDto[]): CustomerQuoteDocument => ({ ...fx.empty, blocks });
  const contract = (n: number, content: Record<string, unknown>) =>
    block(n, 0, { blockType: 'contract', content } as never);

  it('an unknown block type renders nothing (customers never see debris)', () => {
    const m = buildQuoteDocumentModel(withBlocks([block(9, 0, { blockType: 'mystery_block', content: { foo: 'bar' } } as never)]), EN);
    expect(m.blocks).toEqual([]);
    expect(m.agreements).toEqual([]);
  });

  it('a contract block is an agreement, never a body block', () => {
    const m = buildQuoteDocumentModel(withBlocks([
      block(1, 0, { blockType: 'heading', content: { level: 2, text: 'Scope' } }),
      contract(2, { templateName: 'MSA', versionNumber: 1, sourceType: 'authored', renderedHtml: '<p>Terms body</p>', fileUrl: null }),
    ]), EN);
    expect(m.blocks.map((b) => b.kind)).toEqual(['heading']);
    expect(m.agreements).toHaveLength(1);
  });

  it('the agreement title and footer fall back label → template name → "Agreement"', () => {
    const only = (content: Record<string, unknown>) => buildQuoteDocumentModel(withBlocks([contract(3, content)]), EN).agreements[0]!;
    const label = only({ label: 'Master Services Agreement', versionNumber: 4, sourceType: 'authored', renderedHtml: '<p>x</p>', fileUrl: null });
    expect(label.title).toBe('Master Services Agreement');
    expect(label.body).toMatchObject({ kind: 'authored', footer: 'Master Services Agreement — v4' });
    const bare = only({ versionNumber: 5, sourceType: 'authored', renderedHtml: '<p>x</p>', fileUrl: null });
    expect(bare.title).toBe('Agreement');
    expect(bare.body).toMatchObject({ footer: 'Agreement — v5' });
  });

  it('agreement vocabulary: "Agreement content/file unavailable", "Download agreement"', () => {
    const authored = buildQuoteDocumentModel(withBlocks([contract(4, { templateName: 'MSA', versionNumber: 1, sourceType: 'authored', renderedHtml: null, fileUrl: null })]), EN).agreements[0]!;
    expect(authored.body).toMatchObject({ kind: 'authored', html: null, unavailableText: 'Agreement content unavailable' });
    const uploaded = buildQuoteDocumentModel(withBlocks([contract(5, { templateName: 'MSA', versionNumber: 2, sourceType: 'uploaded', renderedHtml: null, fileUrl: '/f/msa.pdf' })]), EN).agreements[0]!;
    expect(uploaded.body).toMatchObject({ kind: 'uploaded', downloadLabel: 'Download agreement', unavailableText: 'Agreement file unavailable' });
    expect((uploaded.body as { file: unknown }).file).toEqual({ kind: 'agreement_file', id: idOf(5) });
    const noFile = buildQuoteDocumentModel(withBlocks([contract(6, { templateName: 'MSA', versionNumber: 1, sourceType: 'uploaded', renderedHtml: null, fileUrl: null })]), EN).agreements[0]!;
    expect((noFile.body as { file: unknown }).file).toBeNull();
  });

  it('a name with a distinct description is a title plus blurb; a legacy line uses the description as the title', () => {
    const rows = allRows(buildQuoteDocumentModel(fx.issued, EN));
    expect(rows[0]).toMatchObject({ title: 'Firewall', blurb: 'Rack-mounted pair' });
    expect(rows[1]).toMatchObject({ title: 'Installation', blurb: null });
  });

  it('agreements expose the labels the component prints (heading, Read, Hide)', () => {
    expect(build('agreements').agreementLabels).toEqual({ heading: 'Agreements', read: 'Read', hide: 'Hide' });
  });

  // #3205 W05 decision 21 (the web Preview's zero-recurring test, carried over): a device-set line
  // counting ZERO devices is a first-class state; visibility keys on recurrence, amounts stay 0.00.
  it('a zero-quantity recurring device-set line still shows the recurring rows, the aside and the estimate sentence', () => {
    const zero = withLines(
      {
        ...fx.deviceSet,
        quote: { ...fx.deviceSet.quote, subtotal: '0.00', total: '0.00', monthlyRecurringTotal: '0.00', dueOnAcceptanceTotal: '0.00' },
      },
      (l) => ({ ...l, quantity: '0.00', lineTotal: '0.00' }),
    );
    const m = buildQuoteDocumentModel(zero, EN);
    expect(m.totals.rows.map((r) => r.key)).toContain('monthly');
    expect(m.totals.aside?.rows[0]?.value).toMatchObject({ text: '$0.00' });
    expect(allRows(m)[0]!.descriptor[0]).toMatch(/each billing period/);
  });

  it('uses the canonical case-sensitive nouns for IoT and NAS roles', () => {
    const m = buildQuoteDocumentModel(
      withLines(fx.deviceSet, (l) => (l.contractLineType === 'per_device_role' ? { ...l, deviceRoles: ['iot', 'nas'], siteName: null } : l)),
      EN,
    );
    expect(allRows(m)[0]!.descriptor[0]).toContain('IoT devices, NAS devices');
  });

  it('a single-category quote has no category breakdown rows', () => {
    const m = buildQuoteDocumentModel({ ...fx.recurring, quote: { ...fx.recurring.quote, categoryBreakdown: [fx.recurring.quote.categoryBreakdown[1]!] } }, EN);
    expect(m.totals.rows.some((r) => r.key.startsWith('category:'))).toBe(false);
  });
});
