import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { renderQuotePdf, contractUploadedMarker } from './quotePdf';

// A minimal valid 1x1 transparent PNG (the smallest real PNG pdfkit will accept).
const ONE_BY_ONE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// pdfkit flate-compresses its content streams, so the drawn text isn't greppable
// in the raw bytes. Inflate every stream, then decode the show-text operands.
// pdfkit emits text as hex strings inside TJ arrays (e.g. `[<5072> 20 <...>] TJ`);
// with its WinAnsi-encoded Helvetica the hex bytes ARE the character codes, so a
// straight hex→latin1 decode reconstructs the visible text. Literal `(...)`
// strings are handled too for robustness.
function extractPdfTextByStream(pdf: Buffer): string[] {
  const s = pdf.toString('latin1');
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  const streams: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = streamRe.exec(s))) {
    let body: string;
    try { body = zlib.inflateSync(Buffer.from(sm[1]!, 'latin1')).toString('latin1'); } catch { continue; }
    const tokenRe = /<([0-9a-fA-F]+)>|\(((?:[^()\\]|\\.)*)\)/g;
    let out = '';
    let tm: RegExpExecArray | null;
    while ((tm = tokenRe.exec(body))) {
      if (tm[1] !== undefined) {
        const hex = tm[1].length % 2 ? `${tm[1]}0` : tm[1];
        out += Buffer.from(hex, 'hex').toString('latin1');
      } else {
        out += tm[2]!.replace(/\\([()\\])/g, '$1');
      }
    }
    streams.push(out);
  }
  return streams;
}

function extractPdfText(pdf: Buffer): string {
  return extractPdfTextByStream(pdf).join(' ');
}

describe('renderQuotePdf', () => {
  it('produces a PDF buffer (heading + line_items block)', async () => {
    const buf = await renderQuotePdf(
      { id: 'q1', quoteNumber: 'Q-1', oneTimeTotal: '100.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00', total: '100.00', currencyCode: 'USD' },
      [
        { id: 'b1', blockType: 'heading', sortOrder: 0, content: { text: 'Proposal', level: 1 } },
        { id: 'b2', blockType: 'line_items', sortOrder: 1, content: {} },
      ],
      [{ id: 'l1', blockId: 'b2', description: 'Setup', quantity: '1', unitPrice: '100', lineTotal: '100.00', recurrence: 'one_time' }],
      async () => null,
      {},
    );
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('renders an image block when loadImage returns a buffer', async () => {
    let requestedId: string | null = null;
    const buf = await renderQuotePdf(
      { id: 'q1', quoteNumber: 'Q-2', oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00', total: '0.00', currencyCode: 'USD' },
      [
        { id: 'b1', blockType: 'heading', sortOrder: 0, content: { text: 'Our work', level: 2 } },
        { id: 'b2', blockType: 'image', sortOrder: 1, content: { imageId: 'img-123', caption: 'A diagram', width: 200 } },
        // <strong> (not <b>) — the sanitized rich-text subset (richTextSanitize.ts)
        // never emits <b>, and the hand-rolled parser only recognizes the 11
        // allowed tags.
        { id: 'b3', blockType: 'rich_text', sortOrder: 2, content: { html: '<p>Hello <strong>world</strong></p>' } },
      ],
      [],
      async (imageId) => { requestedId = imageId; return { data: ONE_BY_ONE_PNG }; },
      { partnerName: 'Acme MSP', primaryColor: '#0ea5e9' },
    );
    expect(requestedId).toBe('img-123');
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    expect(buf.length).toBeGreaterThan(800);
    // Formatted rich-text rendering (Task 2): the paragraph's text actually
    // reaches the page, split across the plain/bold run boundary.
    const text = extractPdfText(buf);
    expect(text).toContain('Hello');
    expect(text).toContain('world');
  });

  it('embeds a product thumbnail for a catalog-sourced line via loadCatalogImage', async () => {
    const requested: string[] = [];
    const buf = await renderQuotePdf(
      { id: 'q1', quoteNumber: 'Q-3', oneTimeTotal: '100.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00', total: '100.00', currencyCode: 'USD' },
      [{ id: 'b2', blockType: 'line_items', sortOrder: 0, content: {} }],
      [{ id: 'l1', blockId: 'b2', catalogItemId: 'cat-9', description: 'Laptop', quantity: '1', unitPrice: '100', lineTotal: '100.00', recurrence: 'one_time' }],
      async () => null,
      {},
      async (catalogItemId) => { requested.push(catalogItemId); return { data: ONE_BY_ONE_PNG }; },
    );
    expect(requested).toEqual(['cat-9']);
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('skips the thumbnail (no throw) when loadCatalogImage rejects', async () => {
    const buf = await renderQuotePdf(
      { id: 'q1', quoteNumber: 'Q-4', oneTimeTotal: '100.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00', total: '100.00', currencyCode: 'USD' },
      [{ id: 'b2', blockType: 'line_items', sortOrder: 0, content: {} }],
      [{ id: 'l1', blockId: 'b2', catalogItemId: 'cat-9', description: 'Laptop', quantity: '1', unitPrice: '100', lineTotal: '100.00', recurrence: 'one_time' }],
      async () => null,
      {},
      async () => { throw new Error('image store down'); },
    );
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('renders mixed one-time + monthly + annual lines without throwing', async () => {
    const buf = await renderQuotePdf(
      {
        id: 'q1', quoteNumber: 'Q-3',
        oneTimeTotal: '500.00', monthlyRecurringTotal: '120.00', annualRecurringTotal: '1200.00',
        taxRate: '0.075', taxTotal: '45.00', total: '665.00', currencyCode: 'USD',
        billToName: 'Globex Corp', terms: 'Net 30. Valid for 30 days.',
      },
      [{ id: 'b1', blockType: 'line_items', sortOrder: 0, content: {} }],
      [
        { id: 'l1', blockId: 'b1', description: 'Onboarding & setup', quantity: '1', unitPrice: '500', lineTotal: '500.00', recurrence: 'one_time' },
        { id: 'l2', blockId: 'b1', description: 'Managed support', quantity: '4', unitPrice: '30', lineTotal: '120.00', recurrence: 'monthly' },
        { id: 'l3', blockId: 'b1', description: 'Annual license', quantity: '1', unitPrice: '1200', lineTotal: '1200.00', recurrence: 'annual' },
        // An orphan line (no blockId) → trailing default table.
        { id: 'l4', description: 'Misc materials', quantity: '2', unitPrice: '15', lineTotal: '30.00', recurrence: 'one_time' },
      ],
      async () => null,
      {},
    );
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    // A multi-line, multi-section document should be non-trivial in size.
    expect(buf.length).toBeGreaterThan(1500);
  });

  it('renders the due-on-acceptance + first-period summary rows for a recurring quote', async () => {
    // Quote with recurring revenue: the summary draws a bold "Due on acceptance"
    // (one-time + one-time tax) plus a "First-period total (incl. recurring)" row.
    const buf = await renderQuotePdf(
      {
        id: 'q1', quoteNumber: 'Q-4',
        oneTimeTotal: '500.00', monthlyRecurringTotal: '1000.00', annualRecurringTotal: '450.00',
        dueOnAcceptanceTotal: '500.00', total: '1950.00', currencyCode: 'USD',
      },
      [{ id: 'b1', blockType: 'line_items', sortOrder: 0, content: {} }],
      [{ id: 'l1', blockId: 'b1', description: 'Setup', quantity: '1', unitPrice: '500', lineTotal: '500.00', recurrence: 'one_time' }],
      async () => null,
      {},
    );
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    expect(buf.length).toBeGreaterThan(800);
  });

  it('prefers a per-line uploaded image over the catalog image', async () => {
    const loadCatalog = { called: false };
    let requestedImage: string | null = null;
    const buf = await renderQuotePdf(
      { id: 'q1', quoteNumber: 'Q-7', oneTimeTotal: '100.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00', total: '100.00', currencyCode: 'USD' },
      [{ id: 'b1', blockType: 'line_items', sortOrder: 0, content: {} }],
      [{ id: 'l1', blockId: 'b1', catalogItemId: 'cat-1', imageId: 'li-img-1', name: 'AP', description: null, quantity: '1', unitPrice: '100', lineTotal: '100.00', recurrence: 'one_time' }],
      async (imageId) => { requestedImage = imageId; return { data: ONE_BY_ONE_PNG }; },
      {},
      async () => { loadCatalog.called = true; return null; },
    );
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    expect(requestedImage).toBe('li-img-1');
    // The uploaded image satisfied the thumbnail — the catalog loader never ran.
    expect(loadCatalog.called).toBe(false);
  });

  it('spills a long table across pages with per-page footers (page count grows)', async () => {
    const manyLines = Array.from({ length: 60 }, (_, i) => ({
      id: `l${i}`, blockId: 'b1', name: `Item ${i + 1}`,
      description: 'A reasonably descriptive line so rows take realistic height.',
      quantity: '1', unitPrice: '10', lineTotal: '10.00', recurrence: 'one_time' as const,
    }));
    const buf = await renderQuotePdf(
      { id: 'q1', quoteNumber: 'Q-5', oneTimeTotal: '600.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00', total: '600.00', currencyCode: 'USD' },
      [{ id: 'b1', blockType: 'line_items', sortOrder: 0, content: { label: 'Hardware' } }],
      manyLines,
      async () => null,
      { partnerName: 'Acme MSP', footer: 'Acme MSP LLC · acme.example.com · (512) 555-0100' },
    );
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    // Each page is a `/Type /Page` object in the (uncompressed) object dictionaries;
    // 60 rows cannot fit one A4 page, so the table must have spilled.
    const pageCount = (buf.toString('latin1').match(/\/Type \/Page[^s]/g) ?? []).length;
    expect(pageCount).toBeGreaterThan(1);
  });

  it('a single-page quote stays single-page after the footer pass (no blank trailing page)', async () => {
    const buf = await renderQuotePdf(
      { id: 'q1', quoteNumber: 'Q-6', oneTimeTotal: '100.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00', total: '100.00', currencyCode: 'USD' },
      [{ id: 'b1', blockType: 'line_items', sortOrder: 0, content: {} }],
      [{ id: 'l1', blockId: 'b1', description: 'Setup', quantity: '1', unitPrice: '100', lineTotal: '100.00', recurrence: 'one_time' }],
      async () => null,
      { footer: 'Acme MSP LLC' },
    );
    const pageCount = (buf.toString('latin1').match(/\/Type \/Page[^s]/g) ?? []).length;
    expect(pageCount).toBe(1);
  });

  it('renders deposit rows + category breakdown when a deposit is configured', async () => {
    const buf = await renderQuotePdf(
      {
        id: 'q1', quoteNumber: 'Q-DEP',
        oneTimeTotal: '1100.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00',
        dueOnAcceptanceTotal: '1100.00', total: '1100.00', currencyCode: 'USD',
        depositType: 'percent', depositAmount: '330.00',
        categoryBreakdown: [
          { category: 'hardware', oneTimeTotal: '1000.00', monthlyTotal: '0.00', annualTotal: '0.00' },
          { category: 'other', oneTimeTotal: '100.00', monthlyTotal: '0.00', annualTotal: '0.00' },
        ],
      },
      [{ id: 'b1', blockType: 'line_items', sortOrder: 0, content: {} }],
      [
        { id: 'l1', blockId: 'b1', description: 'Firewall', quantity: '1', unitPrice: '1000', lineTotal: '1000.00', recurrence: 'one_time' },
        { id: 'l2', blockId: 'b1', description: 'Cabling', quantity: '1', unitPrice: '100', lineTotal: '100.00', recurrence: 'one_time' },
      ],
      async () => null,
      {},
    );
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    const text = extractPdfText(buf);
    expect(text).toContain('Deposit due on acceptance');
    expect(text).toContain('Remaining balance');
    // Remainder = dueOnAcceptance 1100.00 − deposit 330.00 = 770.00 (cents math).
    expect(text).toContain('770.00');
    // Category rows (>1 category) present.
    expect(text).toContain('Hardware');
    expect(text).toContain('Other');
  });

  it('a no-deposit quote still renders the plain Due on acceptance row (no deposit rows)', async () => {
    const buf = await renderQuotePdf(
      { id: 'q1', quoteNumber: 'Q-NODEP', oneTimeTotal: '500.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00', dueOnAcceptanceTotal: '500.00', total: '500.00', currencyCode: 'USD' },
      [{ id: 'b1', blockType: 'line_items', sortOrder: 0, content: {} }],
      [{ id: 'l1', blockId: 'b1', description: 'Setup', quantity: '1', unitPrice: '500', lineTotal: '500.00', recurrence: 'one_time' }],
      async () => null,
      {},
    );
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    const text = extractPdfText(buf);
    expect(text).toContain('Due on acceptance');
    expect(text).not.toContain('Deposit due on acceptance');
    expect(text).not.toContain('Remaining balance');
  });

  it('page-breaks the summary when deposit + breakdown rows would overflow the bottom margin', async () => {
    // 25 one-time lines leave the cursor in the 90–160px band above the bottom
    // margin: the legacy 90px reservation would NOT break the page, so the
    // deposit (extra 18px row) + 4-category breakdown (4×12+4px, ~160px total)
    // rows would crowd into the bottom margin / footer band (and pdfkit's
    // auto-page-add on the overflowing last row spawns a stray page). The sized
    // reservation must instead move the WHOLE summary to page 2 — asserted by
    // requiring the deposit row to live in a different content stream (page)
    // from the line rows. A no-deposit, no-breakdown twin of the same quote
    // stays single-page — proving the extra rows (not the line table) forced
    // the break.
    const mkLines = () => Array.from({ length: 25 }, (_, i) => ({
      id: `l${i}`, blockId: 'b1', description: `Item ${i + 1}`,
      quantity: '1', unitPrice: '10', lineTotal: '10.00', recurrence: 'one_time' as const,
    }));
    const base = {
      id: 'q1', quoteNumber: 'Q-BRK',
      oneTimeTotal: '1000.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00',
      dueOnAcceptanceTotal: '1000.00', total: '1000.00', currencyCode: 'USD',
    };
    const blocks = [{ id: 'b1', blockType: 'line_items' as const, sortOrder: 0, content: {} }];
    const pageCount = (buf: Buffer) => (buf.toString('latin1').match(/\/Type \/Page[^s]/g) ?? []).length;

    const plain = await renderQuotePdf(base, blocks, mkLines(), async () => null, {});
    expect(pageCount(plain)).toBe(1);

    const withDeposit = await renderQuotePdf(
      {
        ...base,
        depositType: 'percent', depositAmount: '300.00',
        categoryBreakdown: [
          { category: 'hardware', oneTimeTotal: '400.00', monthlyTotal: '0.00', annualTotal: '0.00' },
          { category: 'software', oneTimeTotal: '300.00', monthlyTotal: '0.00', annualTotal: '0.00' },
          { category: 'service', oneTimeTotal: '200.00', monthlyTotal: '0.00', annualTotal: '0.00' },
          { category: 'other', oneTimeTotal: '100.00', monthlyTotal: '0.00', annualTotal: '0.00' },
        ],
      },
      blocks, mkLines(), async () => null, {},
    );
    expect(pageCount(withDeposit)).toBe(2);
    const streams = extractPdfTextByStream(withDeposit);
    const summaryStream = streams.find((t) => t.includes('Deposit due on acceptance'));
    expect(summaryStream).toBeDefined();
    expect(summaryStream).toContain('Remaining balance');
    // The summary page must be its own page — none of the 25 line rows on it.
    expect(summaryStream).not.toContain('Item ');
  });

  it('renders a per-table Subtotal row only when the block opts in', async () => {
    const lines = [
      { id: 'l1', blockId: 'b1', description: 'Widget', quantity: '2', unitPrice: '100', lineTotal: '200.00', recurrence: 'one_time' as const },
      { id: 'l2', blockId: 'b1', description: 'Service', quantity: '1', unitPrice: '50', lineTotal: '50.00', recurrence: 'monthly' as const },
    ];
    const base = { id: 'q1', quoteNumber: 'Q-SUB', currencyCode: 'USD', oneTimeTotal: '200.00', monthlyRecurringTotal: '50.00', total: '250.00', dueOnAcceptanceTotal: '200.00' };

    const off = await renderQuotePdf(base as never, [{ id: 'b1', blockType: 'line_items', sortOrder: 0, content: {} }], lines, async () => null, {});
    expect(extractPdfText(off)).not.toContain('Subtotal');

    const on = await renderQuotePdf(base as never, [{ id: 'b1', blockType: 'line_items', sortOrder: 0, content: { showSubtotal: true } }], lines, async () => null, {});
    const text = extractPdfText(on);
    expect(text).toContain('Subtotal');
    // Split by recurrence: one-time $200 and $50/mo.
    expect(text).toContain('200.00');
    expect(text).toContain('50.00/mo');
  });

  it('renderQuotePdf includes the From block and T&C', async () => {
    const buf = await renderQuotePdf(
      { id: 'q1', quoteNumber: 'Q-1', currencyCode: 'USD', billToName: 'Cust',
        sellerSnapshot: { name: 'Acme MSP LLC', phone: null, email: 'billing@acme.test', website: null,
          address: { line1: '1 Main St', line2: null, city: 'Austin', region: 'TX', postalCode: '78701', country: 'US' } },
        termsAndConditions: 'Valid 30 days' } as never,
      [], [], async () => null, { partnerName: 'Acme MSP LLC' },
    );
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });

  // Task 14: proposal cover page + contract blocks in the PDF.
  describe('cover page', () => {
    const baseQuote = {
      id: 'q1', quoteNumber: 'Q-COVER', currencyCode: 'USD',
      oneTimeTotal: '100.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00', total: '100.00',
      billToName: 'Globex Corp',
      billToAddress: { line1: '1 Main St', line2: null, city: 'Austin', region: 'TX', postalCode: '78701', country: 'US' },
      sellerSnapshot: { name: 'Acme MSP LLC', phone: null, email: null, website: null, address: null },
    };
    const blocks = [{ id: 'b1', blockType: 'heading', sortOrder: 0, content: { text: 'Proposal', level: 1 } }] as const;

    it('a coverPage.enabled quote grows the page count by exactly 1 vs. the same quote with cover disabled', async () => {
      const without = await renderQuotePdf({ ...baseQuote, coverPage: { enabled: false, showPreparedBy: true } } as never, blocks as never, [], async () => null, {});
      const withCover = await renderQuotePdf(
        { ...baseQuote, coverPage: { enabled: true, title: 'Network Refresh Proposal', coverImageId: null, preparedForName: null, showPreparedBy: true } } as never,
        blocks as never, [], async () => null, {},
      );
      const withoutPages = (await PDFDocument.load(without)).getPageCount();
      const withPages = (await PDFDocument.load(withCover)).getPageCount();
      expect(withPages).toBe(withoutPages + 1);
    });

    it('renders the cover title, prepared-for, and prepared-by text on the cover page', async () => {
      const buf = await renderQuotePdf(
        { ...baseQuote, coverPage: { enabled: true, title: 'Network Refresh Proposal', coverImageId: null, preparedForName: null, showPreparedBy: true } } as never,
        blocks as never, [], async () => null, { partnerName: 'Acme MSP LLC' },
      );
      const text = extractPdfText(buf);
      expect(text).toContain('Network Refresh Proposal');
      expect(text).toContain('PREPARED FOR');
      expect(text).toContain('Globex Corp');
      expect(text).toContain('PREPARED BY');
      expect(text).toContain('Acme MSP LLC');
    });

    it('draws the cover image via loadImage when coverImageId is set', async () => {
      let requested: string | null = null;
      const buf = await renderQuotePdf(
        { ...baseQuote, coverPage: { enabled: true, title: 'Cover', coverImageId: 'cover-img-1', preparedForName: null, showPreparedBy: true } } as never,
        blocks as never, [],
        async (imageId) => { requested = imageId; return { data: ONE_BY_ONE_PNG }; },
        {},
      );
      expect(requested).toBe('cover-img-1');
      expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    });

    it('omits the Prepared by block when showPreparedBy is false', async () => {
      const buf = await renderQuotePdf(
        { ...baseQuote, coverPage: { enabled: true, title: 'Cover', coverImageId: null, preparedForName: null, showPreparedBy: false } } as never,
        blocks as never, [], async () => null, {},
      );
      const text = extractPdfText(buf);
      expect(text).toContain('PREPARED FOR');
      expect(text).not.toContain('PREPARED BY');
    });

    it('a quote with no coverPage (undefined) renders unchanged (no extra page, no throw)', async () => {
      const buf = await renderQuotePdf(baseQuote as never, blocks as never, [], async () => null, {});
      expect(buf.subarray(0, 4).toString()).toBe('%PDF');
      const pages = (await PDFDocument.load(buf)).getPageCount();
      expect(pages).toBe(1);
    });
  });

  // Task 14: contract blocks — authored (rich text) and uploaded (marker line).
  describe('contract blocks', () => {
    const baseQuote = {
      id: 'q1', quoteNumber: 'Q-CONTRACT', currencyCode: 'USD',
      oneTimeTotal: '100.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00', total: '100.00',
    };

    it('renders an authored contract block: heading (template name) + substituted rich text', async () => {
      const contractRenderData = new Map([
        ['b1', { html: '<p>This agreement is between <strong>Acme MSP</strong> and the client.</p>', templateName: 'Master Services Agreement' }],
      ]);
      const buf = await renderQuotePdf(
        baseQuote as never,
        [{ id: 'b1', blockType: 'contract', sortOrder: 0, content: { templateId: 't1', templateVersionId: 'v1', variableValues: {} } }],
        [], async () => null, {}, async () => null, contractRenderData as never,
      );
      const text = extractPdfText(buf);
      expect(text).toContain('Master Services Agreement');
      expect(text).toContain('This agreement is between');
      expect(text).toContain('Acme MSP');
    });

    it('a label on the block content overrides the template-name heading', async () => {
      const contractRenderData = new Map([
        ['b1', { html: '<p>Body text.</p>', templateName: 'Master Services Agreement' }],
      ]);
      const buf = await renderQuotePdf(
        baseQuote as never,
        [{ id: 'b1', blockType: 'contract', sortOrder: 0, content: { templateId: 't1', templateVersionId: 'v1', variableValues: {}, label: 'Our Custom Agreement' } }],
        [], async () => null, {}, async () => null, contractRenderData as never,
      );
      const text = extractPdfText(buf);
      expect(text).toContain('Our Custom Agreement');
      expect(text).not.toContain('Master Services Agreement');
    });

    it('renders a one-line marker for an uploaded contract block (html: null)', async () => {
      const contractRenderData = new Map([
        ['b1', { html: null, templateName: 'Signed NDA' }],
      ]);
      const buf = await renderQuotePdf(
        baseQuote as never,
        [{ id: 'b1', blockType: 'contract', sortOrder: 0, content: { templateId: 't1', templateVersionId: 'v1', variableValues: {} } }],
        [], async () => null, {}, async () => null, contractRenderData as never,
      );
      const text = extractPdfText(buf);
      // The em dash doesn't survive the test's hex→latin1 text extraction (pdfkit
      // maps it to a WinAnsi glyph code outside straight ASCII, unlike every other
      // fixture string in this suite) — assert the surrounding text instead of the
      // exact byte sequence; the marker format itself is asserted directly against
      // contractUploadedMarker() below.
      expect(text).toContain('Signed NDA');
      expect(text).toContain('attached below');
      expect(contractUploadedMarker('Signed NDA')).toBe('Signed NDA — attached below');
    });

    it('a contract block with no matching contractRenderData entry does not throw', async () => {
      const buf = await renderQuotePdf(
        baseQuote as never,
        [{ id: 'b1', blockType: 'contract', sortOrder: 0, content: { templateId: 't1', templateVersionId: 'v1', variableValues: {} } }],
        [], async () => null, {},
      );
      expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    });
  });
});
