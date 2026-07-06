import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import { renderQuotePdf } from './quotePdf';

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
function extractPdfText(pdf: Buffer): string {
  const s = pdf.toString('latin1');
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let out = '';
  let sm: RegExpExecArray | null;
  while ((sm = streamRe.exec(s))) {
    let body: string;
    try { body = zlib.inflateSync(Buffer.from(sm[1]!, 'latin1')).toString('latin1'); } catch { continue; }
    const tokenRe = /<([0-9a-fA-F]+)>|\(((?:[^()\\]|\\.)*)\)/g;
    let tm: RegExpExecArray | null;
    while ((tm = tokenRe.exec(body))) {
      if (tm[1] !== undefined) {
        const hex = tm[1].length % 2 ? `${tm[1]}0` : tm[1];
        out += Buffer.from(hex, 'hex').toString('latin1');
      } else {
        out += tm[2]!.replace(/\\([()\\])/g, '$1');
      }
    }
    out += ' ';
  }
  return out;
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
        { id: 'b3', blockType: 'rich_text', sortOrder: 2, content: { html: '<p>Hello <b>world</b></p>' } },
      ],
      [],
      async (imageId) => { requestedId = imageId; return { data: ONE_BY_ONE_PNG }; },
      { partnerName: 'Acme MSP', primaryColor: '#0ea5e9' },
    );
    expect(requestedId).toBe('img-123');
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    expect(buf.length).toBeGreaterThan(800);
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
});
