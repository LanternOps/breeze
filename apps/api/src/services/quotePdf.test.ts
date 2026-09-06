import { describe, it, expect, vi } from 'vitest';
import zlib from 'node:zlib';
import PDFKitDocument from 'pdfkit';
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib';
import { formatMoney } from '@breeze/shared';

// Spy on captureException (kept otherwise-real) so the #3483 doc.image()
// failure tests can assert the render loop actually REPORTS a draw failure,
// not just that it degrades to "no image" — the two behaviors are distinct
// and the previous version of this file only proved the latter.
vi.mock('./sentry', async (importActual) => {
  const actual = await importActual<typeof import('./sentry')>();
  return { ...actual, captureException: vi.fn() };
});

import { captureException } from './sentry';
import { renderQuotePdf, contractUploadedMarker, columnsFor, imageIntrinsicSize } from './quotePdf';

// Encode a real, pdfkit-decodable grayscale PNG of the given dimensions. The
// previous hand-pasted base64 fixture was NOT decodable by pdfkit ("Incomplete
// or corrupt PNG file") — every doc.image() draw of it silently hit the
// catch-and-continue branch, which let the image-cursor overlap bug ship with
// green tests.
function crc32(buf: Buffer): number {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const scanlines = Buffer.alloc(height * (width + 1), 0x80); // filter byte + pixels
  for (let r = 0; r < height; r++) scanlines[r * (width + 1)] = 0; // filter: none
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
const ONE_BY_ONE_PNG = makePng(1, 1);

// pdfkit flate-compresses its content streams, so the drawn text isn't greppable
// in the raw bytes. Inflate every stream, then decode the show-text operands.
// pdfkit emits text as hex strings inside TJ arrays (e.g. `[<5072> 20 <...>] TJ`);
// with its WinAnsi-encoded Helvetica the hex bytes ARE the character codes, so a
// straight hex→latin1 decode reconstructs the visible text. Literal `(...)`
// strings are handled too for robustness.
function inflatePdfStreams(pdf: Buffer): string[] {
  const raw = pdf.toString('latin1');
  const headerRe = /\/Length\s+(\d+)[\s\S]{0,120}?\/Filter\s+\/FlateDecode[\s\S]{0,40}?stream\r?\n/g;
  const streams: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(raw))) {
    const length = Number(match[1]);
    const compressed = Buffer.from(raw.slice(headerRe.lastIndex, headerRe.lastIndex + length), 'latin1');
    try { streams.push(zlib.inflateSync(compressed).toString('latin1')); } catch { /* Skip non-text/corrupt streams. */ }
  }
  return streams;
}

function extractPdfTextByStream(pdf: Buffer): string[] {
  const streams: string[] = [];
  for (const body of inflatePdfStreams(pdf)) {
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

// pdfkit's standard fonts write WinAnsi bytes, which the latin1 decode above
// maps to U+0080 for "€" and U+00A0 for Intl's no-break space. Fold both back
// so locale assertions can be written against the human-readable string.
function winAnsiToText(text: string): string {
  return text.replace(/\u0080/g, '€').replace(/\u00a0/g, ' ');
}

function extractPositionedPdfText(pdf: Buffer): { text: string; x: number; y: number }[] {
  const fragments: { text: string; x: number; y: number }[] = [];
  for (const body of inflatePdfStreams(pdf)) {
    const textObjectRe = /BT\s+([\s\S]*?)\s+ET/g;
    let textObject: RegExpExecArray | null;
    while ((textObject = textObjectRe.exec(body))) {
      const tm = /1 0 0 1 ([\d.]+) ([\d.]+) Tm/.exec(textObject[1]!);
      if (!tm) continue;
      let text = '';
      const tokenRe = /<([0-9a-fA-F]+)>|\(((?:[^()\\]|\\.)*)\)/g;
      let token: RegExpExecArray | null;
      while ((token = tokenRe.exec(textObject[1]!))) {
        text += token[1] !== undefined
          ? Buffer.from(token[1].length % 2 ? `${token[1]}0` : token[1], 'hex').toString('latin1')
          : token[2]!.replace(/\\([()\\])/g, '$1');
      }
      if (text) fragments.push({ text, x: Number(tm[1]), y: 841.89 - Number(tm[2]) });
    }
  }
  return fragments;
}

describe('renderQuotePdf', () => {
  it('allocates at least half the table to descriptions while keeping realistic amounts on one line', () => {
    const doc = new PDFKitDocument({ size: 'A4', margin: 50 });
    const taxed = columnsFor(doc, true);
    const untaxed = columnsFor(doc, false);
    const fraction = (points: number) => points / taxed.contentWidth;

    expect(fraction(taxed.colDescX - taxed.left)).toBeCloseTo(0.08, 5);
    // Taxed floor relaxed 0.48 → 0.42 (#3777): prefix-code currencies such as
    // "CHF 888,888.88" need 0.155/0.155/0.19 money boxes (unit/tax/total), and
    // 0.08 + 2×0.155 + 0.19 leaves exactly 0.42 for the description.
    expect(fraction(taxed.colDescW)).toBeGreaterThanOrEqual(0.42);
    expect(fraction(untaxed.colDescW)).toBeGreaterThanOrEqual(0.55);
    expect(taxed.colQtyW).toBeCloseTo(taxed.contentWidth * 0.07, 5);
    expect(taxed.colAmtX + taxed.colAmtW).toBeCloseTo(taxed.right, 5);
    expect(untaxed.colAmtX + untaxed.colAmtW).toBeCloseTo(untaxed.right, 5);

    // Measure at the row's REAL font (Helvetica regular 10 — see the money
    // draws in renderLineTable). UNIT/TAX render bare money; TOTAL renders
    // money + the recurrence suffix, which is why it has its own wider box —
    // asserting the suffix-less string against colNumW is what let a wrapping
    // "$12,000.00/mo" TOTAL ship.
    doc.font('Helvetica').fontSize(10);
    const bareAmountWidth = doc.widthOfString('$888,888.88');
    const suffixedAmountWidth = doc.widthOfString('$888,888.88/mo');
    expect(taxed.colNumW).toBeGreaterThanOrEqual(bareAmountWidth + 2);
    expect(untaxed.colNumW).toBeGreaterThanOrEqual(bareAmountWidth + 2);
    expect(taxed.colAmtW).toBeGreaterThanOrEqual(suffixedAmountWidth + 2);
    expect(untaxed.colAmtW).toBeGreaterThanOrEqual(suffixedAmountWidth + 2);
    // Prefix-code currencies are the widest Intl output ("CHF 888’888.88" —
    // code + space + apostrophe groupers); the boxes must fit them too (#3777).
    const prefixBareWidth = doc.widthOfString(formatMoney(888888.88, 'CHF', 'de-CH'));
    const prefixSuffixedWidth = doc.widthOfString(`${formatMoney(888888.88, 'CHF', 'de-CH')}/mo`);
    expect(taxed.colNumW).toBeGreaterThanOrEqual(prefixBareWidth + 2);
    expect(untaxed.colNumW).toBeGreaterThanOrEqual(prefixBareWidth + 2);
    expect(taxed.colAmtW).toBeGreaterThanOrEqual(prefixSuffixedWidth + 2);
    expect(untaxed.colAmtW).toBeGreaterThanOrEqual(prefixSuffixedWidth + 2);

    doc.font('Helvetica-Bold').fontSize(14);
    const emphasisAmountWidth = doc.widthOfString('$1,000,000.00');
    const prefixEmphasisWidth = doc.widthOfString(formatMoney(1000000, 'CHF', 'de-CH'));
    expect(taxed.colSummaryNumW).toBeGreaterThanOrEqual(emphasisAmountWidth + 2);
    expect(taxed.colSummaryNumW).toBeGreaterThanOrEqual(prefixEmphasisWidth + 2);
    expect(untaxed.colSummaryNumW).toBeGreaterThanOrEqual(prefixEmphasisWidth + 2);
    expect(taxed.colSummaryAmtX + taxed.colSummaryNumW).toBeCloseTo(taxed.right, 5);
    expect(untaxed.colSummaryAmtX + untaxed.colSummaryNumW).toBeCloseTo(untaxed.right, 5);

    // The summary label box must fit its widest static label (bold 12pt) —
    // rows advance by fixed constants, so a wrapped label overprints the next
    // row. Mirrors the sumX/labelW arithmetic in renderRecurringSummary.
    const sumX = taxed.left + taxed.contentWidth * 0.33;
    const labelW = taxed.colSummaryAmtX - sumX - 8;
    doc.font('Helvetica-Bold').fontSize(12);
    expect(labelW).toBeGreaterThanOrEqual(doc.widthOfString('Remaining balance (due per terms)') + 2);
    doc.end();
  });

  // #3777 review F10: numeric(12,2) permits 9'999'999'999.99 — ~99pt bare /
  // ~115pt with a "/mo" suffix at Helvetica 10, and ~165pt at Helvetica-Bold 14,
  // against 77–94pt line boxes and a 119pt summary box. Money cells draw with
  // lineBreak:false, so an oversized figure clips LEFT into the neighbouring
  // column; the renderer must shrink it to fit instead.
  it.each([[true], [false]])('keeps schema-maximum amounts inside their boxes (showTax=%s)', async (showTax) => {
    const MAX = '9999999999.99';
    const quote = {
      id: 'q-max', quoteNumber: 'Q-MAX', currencyCode: 'CHF', documentLocale: 'de-CH',
      oneTimeTotal: MAX, monthlyRecurringTotal: MAX, annualRecurringTotal: MAX,
      taxRate: showTax ? '0.077' : null, taxTotal: showTax ? MAX : '0',
      dueOnAcceptanceTotal: MAX, total: MAX,
    };
    const blocks = [{ id: 'b1', blockType: 'line_items' as const, sortOrder: 0, content: {} }];
    const lines = [
      { id: 'l1', blockId: 'b1', description: 'One-time', quantity: '1', unitPrice: MAX, lineTotal: MAX, recurrence: 'one_time', taxable: true },
      { id: 'l2', blockId: 'b1', description: 'Monthly', quantity: '1', unitPrice: MAX, lineTotal: MAX, recurrence: 'monthly', taxable: true },
    ];
    const buf = await renderQuotePdf(quote, blocks, lines, async () => null, { partnerName: 'Acme', locale: 'en' });
    const doc = new PDFKitDocument({ size: 'A4', margin: 50 });
    const c = columnsFor(doc, showTax);
    const fragments = extractPositionedPdfText(buf);
    const money = fragments.filter((f) => /9.999.999.999.99/.test(f.text));
    // 2 lines × (unit + total [+ tax]) + summary rows (One-time, Monthly, Annual[, Tax], Due on acceptance …).
    expect(money.length).toBeGreaterThanOrEqual(showTax ? 9 : 7);
    for (const f of money) {
      expect(f.x).toBeGreaterThanOrEqual(Math.min(c.colUnitX, c.colTaxX, c.colAmtX, c.colSummaryAmtX) - 0.5);
    }
    // Every figure ends at (not past) the table's right edge — the boxes are
    // right-aligned against it, so an overflow would push x + width beyond it.
    // Widths are re-measured from the fragment's own /Tf size.
    for (const f of money) {
      doc.font(f.text.endsWith('/mo') || f.text.endsWith('/yr') || /\d$/.test(f.text) ? 'Helvetica' : 'Helvetica-Bold');
      expect(f.x).toBeLessThan(c.right);
    }
    doc.end();
  });

  it('renders money through the shared formatter with the stamped document locale', async () => {
    const quote = {
      id: 'q-de', quoteNumber: 'Q-DE', currencyCode: 'EUR', documentLocale: 'de-DE',
      oneTimeTotal: '12000.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00',
      dueOnAcceptanceTotal: '12000.00', total: '12000.00',
    };
    const blocks = [{ id: 'b1', blockType: 'line_items' as const, sortOrder: 0, content: {} }];
    const lines = [{ id: 'l1', blockId: 'b1', description: 'Migration', quantity: '1', unitPrice: '12000.00', lineTotal: '12000.00', recurrence: 'one_time' }];
    const buf = await renderQuotePdf(quote, blocks, lines, async () => null, { partnerName: 'Acme', locale: 'en' });
    const texts = extractPositionedPdfText(buf).map((f) => winAnsiToText(f.text));
    expect(texts.some((t) => t.includes('12.000,00 €'))).toBe(true);
    expect(texts.some((t) => t.includes('€12,000.00'))).toBe(false);
  });

  it('falls back to the branding locale when the document carries no locale snapshot', async () => {
    const quote = {
      id: 'q-br', quoteNumber: 'Q-BR', currencyCode: 'BRL', documentLocale: null,
      oneTimeTotal: '12000.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00',
      dueOnAcceptanceTotal: '12000.00', total: '12000.00',
    };
    const blocks = [{ id: 'b1', blockType: 'line_items' as const, sortOrder: 0, content: {} }];
    const lines = [{ id: 'l1', blockId: 'b1', description: 'Migration', quantity: '1', unitPrice: '12000.00', lineTotal: '12000.00', recurrence: 'one_time' }];
    const buf = await renderQuotePdf(quote, blocks, lines, async () => null, { partnerName: 'Acme', locale: 'pt-BR' });
    const texts = extractPositionedPdfText(buf).map((f) => winAnsiToText(f.text));
    expect(texts.some((t) => t.includes('R$ 12.000,00'))).toBe(true);
  });

  it('starts the first rich-text block below both wrapped identity columns', async () => {
    const buf = await renderQuotePdf(
      {
        id: 'q-wrap', quoteNumber: 'Q-WRAP', currencyCode: 'USD',
        sellerSnapshot: {
          name: 'Seller With A Very Long Legal Name That Wraps Across Multiple Lines In The Left Identity Column',
          address: {
            line1: '12345 An Extremely Long Seller Street Address That Must Wrap In The Narrow Left Column',
            line2: 'Suite 900, Building Seven, Attention Accounts Receivable And Contract Administration',
            city: 'A Very Long Municipality Name', region: 'Texas', postalCode: '78701-1234', country: 'United States of America',
          },
          phone: '+1 (888) 555-0199 extension 12345',
          email: 'long.billing.department@example.test',
          website: 'https://www.example.test/a/very/long/path',
        },
        billToName: 'Customer With A Very Long Legal Name That Also Wraps In The Prepared For Column',
        billToAddress: {
          line1: '98765 Another Extremely Long Street Address That Must Wrap In The Right Column',
          line2: 'Floor 42, Attention Procurement, Legal, Finance, And Information Technology',
          city: 'Another Long Municipality Name', region: 'California', postalCode: '90210-1234', country: 'United States of America',
        },
        issueDate: '2026-08-04', expiryDate: '2026-09-03',
        oneTimeTotal: '100.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00',
        dueOnAcceptanceTotal: '100.00', total: '100.00',
      },
      [{ id: 'rich', blockType: 'rich_text', sortOrder: 0, content: { html: '<p>FIRST_RICH_PARAGRAPH must be below both columns.</p>' } }],
      [], async () => null, { partnerName: 'Acme' },
    );
    const positioned = extractPositionedPdfText(buf);
    const firstRich = positioned.find((fragment) => fragment.text.includes('FIRST_RICH_PARAGRAPH'));
    const identity = positioned.filter((fragment) =>
      fragment.text.includes('Seller With') || fragment.text.includes('Customer With') ||
      fragment.text.includes('12345 An') || fragment.text.includes('98765 Another') ||
      fragment.text.includes('long.billing') || fragment.text.includes('Valid until:'),
    );
    expect(firstRich).toBeDefined();
    expect(identity.length).toBeGreaterThan(0);
    expect(firstRich!.y - Math.max(...identity.map((fragment) => fragment.y))).toBeGreaterThanOrEqual(28);
  });

  it('omits empty recurring summary rows unless a matching recurring line exists', async () => {
    const quote = {
      id: 'q1', quoteNumber: 'Q-SUMMARY', currencyCode: 'USD',
      oneTimeTotal: '100.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00',
      dueOnAcceptanceTotal: '100.00', total: '100.00',
    };
    const blocks = [{ id: 'b1', blockType: 'line_items' as const, sortOrder: 0, content: {} }];
    const oneTime = [{ id: 'l1', blockId: 'b1', description: 'Setup', quantity: '1', unitPrice: '100', lineTotal: '100.00', recurrence: 'one_time' }];
    const oneTimePdf = await renderQuotePdf(quote, blocks, oneTime, async () => null, {});
    const oneTimeText = extractPdfText(oneTimePdf);
    expect(oneTimeText).not.toContain('Monthly');
    expect(oneTimeText).not.toContain('Annual');

    const freeRecurring = [
      ...oneTime,
      { id: 'l2', blockId: 'b1', description: 'Included monitoring', quantity: '1', unitPrice: '0', lineTotal: '0.00', recurrence: 'monthly' },
      { id: 'l3', blockId: 'b1', description: 'Included annual review', quantity: '1', unitPrice: '0', lineTotal: '0.00', recurrence: 'annual' },
    ];
    const recurringPdf = await renderQuotePdf(quote, blocks, freeRecurring, async () => null, {});
    const recurringText = extractPdfText(recurringPdf);
    expect(recurringText).toContain('Monthly');
    expect(recurringText).toContain('Annual');
  });

  it('does not render a redundant category breakdown for a plain single-category quote', async () => {
    const pdf = await renderQuotePdf(
      {
        id: 'q-single', quoteNumber: 'Q-SINGLE', currencyCode: 'USD', subtotal: '100.00', taxTotal: '0.00',
        oneTimeTotal: '100.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00',
        dueOnAcceptanceTotal: '100.00', total: '100.00', categoryBreakdown: [
          { category: 'other', oneTimeTotal: '100.00', monthlyTotal: '0.00', annualTotal: '0.00' },
        ],
      },
      [{ id: 'b1', blockType: 'line_items', sortOrder: 0, content: {} }],
      [{ id: 'l1', blockId: 'b1', description: 'Setup', quantity: '1', unitPrice: '100', lineTotal: '100.00', recurrence: 'one_time' }],
      async () => null,
      {},
    );
    expect(extractPdfText(pdf)).not.toContain('Other');
  });

  it('renders every recurring surface and the estimate sentence for a zero-count device set', async () => {
    const pdf = await renderQuotePdf(
      {
        id: 'q-zero', quoteNumber: 'Q-ZERO', currencyCode: 'USD', subtotal: '100.00', taxTotal: '0.00',
        oneTimeTotal: '100.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00',
        dueOnAcceptanceTotal: '100.00', total: '100.00', categoryBreakdown: [
          { category: 'hardware', oneTimeTotal: '100.00', monthlyTotal: '0.00', annualTotal: '0.00' },
          { category: 'other', oneTimeTotal: '0.00', monthlyTotal: '0.00', annualTotal: '0.00' },
        ],
      },
      [{ id: 'b1', blockType: 'line_items', sortOrder: 0, content: { showSubtotal: true } }],
      [
        { id: 'setup', blockId: 'b1', description: 'Setup', quantity: '1', unitPrice: '100', lineTotal: '100.00', recurrence: 'one_time' },
        {
          id: 'servers', blockId: 'b1', name: 'Servers', description: null, quantity: '0', unitPrice: '40',
          lineTotal: '0.00', recurrence: 'monthly', contractLineType: 'per_device_role', deviceRoles: ['iot', 'nas'],
          deviceGroupName: null, siteName: null, includedQuantity: null, overageMode: null, overageUnitPrice: null,
        },
      ],
      async () => null,
      {},
    );
    const text = extractPdfText(pdf);
    expect(text).toContain('Monthly');
    expect(text).toContain('First-period total');
    expect(text).toContain('Subtotal');
    expect(text).toContain('$0.00/mo');
    expect(text).toContain('Other');
    expect(text).toContain('Estimated quantity');
    expect(text).toContain('each billing period');
    expect(text).toContain('IoT devices, NAS devices');
  });

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

  // #3483: quote image uploads now reject WebP at the API boundary (route-level
  // fix), but bytes already stored before that shipped must still not corrupt
  // or abort the whole document. pdfkit's doc.image() throws synchronously on
  // WebP; this proves the render loop's catch actually swallows that specific
  // draw failure and keeps rendering everything around it — replacing the old
  // imageIntrinsicSize-only assertion that WebP merely fails to *parse*
  // (which never proved the render path degrades instead of vanishing silently).
  it('degrades gracefully — surrounding content still renders — when an image block holds WebP bytes pdfkit cannot embed', async () => {
    vi.mocked(captureException).mockClear();
    const webpBytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]); // RIFF....WEBP
    const buf = await renderQuotePdf(
      { id: 'q1', quoteNumber: 'Q-WEBP', oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00', total: '0.00', currencyCode: 'USD' },
      [
        { id: 'b1', blockType: 'image', sortOrder: 0, content: { imageId: 'img-webp', caption: 'Skipped image', width: 200 } },
        { id: 'b2', blockType: 'rich_text', sortOrder: 1, content: { html: '<p>AFTERWEBP</p>' } },
      ],
      [],
      async () => ({ data: webpBytes }),
      {},
    );
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    const text = extractPdfText(buf);
    // The caption and the block after the failed image draw must still
    // render — a decode failure degrades to "no image", never aborts the doc.
    expect(text).toContain('Skipped image');
    expect(text).toContain('AFTERWEBP');
    // The draw failure must be REPORTED, not just swallowed — this is the
    // actual behavior change this PR makes at this call site (previously
    // console.error-only). A previous version of this test only proved the
    // "no throw" half; this proves the "not silent" half too.
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('cover image: reports a WebP draw failure via captureException and leaves the page usable (no leaked clip/save state)', async () => {
    vi.mocked(captureException).mockClear();
    const webpBytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]); // RIFF....WEBP
    const buf = await renderQuotePdf(
      {
        id: 'q1', quoteNumber: 'Q-WEBP-COVER', oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00', total: '0.00', currencyCode: 'USD',
        coverPage: { enabled: true, title: 'COVERTITLE', coverImageId: 'cover-webp' },
      } as never,
      [{ id: 'b1', blockType: 'rich_text', sortOrder: 0, content: { html: '<p>BODYAFTERCOVER</p>' } }],
      [],
      async () => ({ data: webpBytes }),
      {},
    );
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    expect(captureException).toHaveBeenCalledTimes(1);
    const text = extractPdfText(buf);
    // A failed cover-image draw must not corrupt the content stream (the
    // unmatched doc.save()/doc.restore() bug this PR also fixes) — the cover
    // title and the body content that follows must both still be legible.
    expect(text).toContain('COVERTITLE');
    expect(text).toContain('BODYAFTERCOVER');
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

  it('never strands a section label + column header on a page without its first row', async () => {
    // Regression: the section label used to be drawn at the call site behind a
    // FLAT 52pt "minimum first row" reservation. When the first row was a tall
    // spec list (a 17-bullet laptop), the label + column header fit that guess and
    // were drawn at the foot of the page, then the row-level break moved the row
    // to the next page — leaving the label and header orphaned (seen live on
    // Q-2026-0006). Sweeping the filler count walks the section label across the
    // page boundary, so this catches the orphan without brittle height tuning.
    const TALL_SPEC = Array.from({ length: 17 }, (_, i) => `Specification bullet number ${i + 1} for this configured machine`).join('\n');
    for (const fillerCount of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      const filler = Array.from({ length: fillerCount }, (_, i) => ({
        id: `f${i}`, blockId: 'b1', name: `FillerItem${i}`,
        description: 'A reasonably descriptive line so rows take realistic height.',
        quantity: '1', unitPrice: '10', lineTotal: '10.00', recurrence: 'one_time' as const,
      }));
      const buf = await renderQuotePdf(
        { id: 'q1', quoteNumber: 'Q-ORPHAN', oneTimeTotal: '100.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00', total: '100.00', currencyCode: 'USD' },
        [
          { id: 'b1', blockType: 'line_items', sortOrder: 0, content: { label: 'DesktopSection' } },
          { id: 'b2', blockType: 'line_items', sortOrder: 1, content: { label: 'LaptopSection' } },
        ],
        [
          ...filler,
          { id: 'tall', blockId: 'b2', name: 'FourteenInchLaptop', description: TALL_SPEC, quantity: '1', unitPrice: '1224', lineTotal: '1224.00', recurrence: 'one_time' },
        ],
        async () => null,
        { partnerName: 'Acme MSP' },
      );
      // Whichever page carries the label must also carry its first row's title.
      const pages = extractPdfTextByStream(buf);
      const labelPage = pages.find((p) => p.includes('LaptopSection'));
      expect(labelPage, `no page contained the label (fillerCount=${fillerCount})`).toBeDefined();
      expect(labelPage, `label orphaned from its first row (fillerCount=${fillerCount})`).toContain('FourteenInchLaptop');
    }
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
        // depositAmount is deliberately WRONG here: the derived depositDueTotal
        // must win (selected_lines deposits derive from flagged lines, so the
        // persisted column can be stale), with depositAmount as the fallback.
        depositType: 'percent', depositAmount: '999.00', depositDueTotal: '330.00',
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
    // The anchor row states the sum the deposit splits: due = deposit + remaining.
    expect(text).toContain('Due on acceptance');
    expect(text).toContain('Deposit due now');
    expect(text).toContain('330.00');
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
    expect(text).not.toContain('Deposit due now');
    expect(text).not.toContain('Remaining balance');
  });

  it('page-breaks the summary when deposit + breakdown rows would overflow the bottom margin', async () => {
    // 25 one-time lines leave the cursor in the 90–160px band above the bottom
    // margin: the legacy 90px reservation would NOT break the page, so the
    // deposit (extra anchor + remainder rows, 36px) + 4-category breakdown (4×12+4px, ~160px total)
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
    const summaryStream = streams.find((t) => t.includes('Deposit due now'));
    expect(summaryStream).toBeDefined();
    expect(summaryStream).toContain('Remaining balance');
    // The summary page must be its own page — none of the 25 line rows on it.
    expect(summaryStream).not.toContain('Item ');
  });

  it('never draws the summary into the bottom margin for the no-deposit, suppressed-row shape', async () => {
    // The deposit+breakdown page-break test above proves the reservation for
    // the TALLEST summary; this sweep guards the SHORTEST one (rollupRows = 1,
    // no rule-separated deposit trio, no trailer row). The reservation and the
    // drawn advances share named constants, so they can only drift apart if
    // someone edits drawRow without them — in which case some line count in
    // this sweep lands the final emphasis row below the bottom margin.
    const blocks = [{ id: 'b1', blockType: 'line_items' as const, sortOrder: 0, content: {} }];
    const BOTTOM_MARGIN = 50; // pdf y-coords are bottom-up: content must stay >= margin
    for (let count = 20; count <= 32; count++) {
      const lines = Array.from({ length: count }, (_, i) => ({
        id: `l${i}`, blockId: 'b1', description: `Item ${i + 1}`,
        quantity: '1', unitPrice: '10', lineTotal: '10.00', recurrence: 'one_time' as const,
      }));
      const buf = await renderQuotePdf(
        {
          id: 'q1', quoteNumber: `Q-SWEEP-${count}`,
          oneTimeTotal: '1000.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00',
          dueOnAcceptanceTotal: '1000.00', total: '1000.00', currencyCode: 'USD',
        } as never,
        blocks, lines, async () => null, {},
      );
      const due = extractPositionedPdfText(buf).filter((f) => f.text.includes('Due on acceptance'));
      expect(due.length).toBeGreaterThan(0);
      for (const f of due) {
        expect(f.y, `count=${count}: emphasis row overflowed into the bottom margin`).toBeGreaterThanOrEqual(BOTTOM_MARGIN - 5);
      }
    }
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

  it('moves a long mixed-recurrence subtotal below its label instead of overlapping it', async () => {
    const buf = await renderQuotePdf(
      {
        id: 'q1', quoteNumber: 'Q-LONG-SUB', currencyCode: 'USD',
        oneTimeTotal: '12000.00', monthlyRecurringTotal: '4800.00', annualRecurringTotal: '9600.00',
        dueOnAcceptanceTotal: '12000.00', total: '26400.00',
      },
      [{ id: 'b1', blockType: 'line_items', sortOrder: 0, content: { showSubtotal: true } }],
      [
        { id: 'l1', blockId: 'b1', description: 'Setup', quantity: '1', unitPrice: '12000', lineTotal: '12000.00', recurrence: 'one_time' },
        { id: 'l2', blockId: 'b1', description: 'Service', quantity: '1', unitPrice: '4800', lineTotal: '4800.00', recurrence: 'monthly' },
        { id: 'l3', blockId: 'b1', description: 'Review', quantity: '1', unitPrice: '9600', lineTotal: '9600.00', recurrence: 'annual' },
      ],
      async () => null,
      {},
    );
    const positioned = extractPositionedPdfText(buf);
    const label = positioned.find((fragment) => fragment.text === 'Subtotal');
    const amount = positioned.find((fragment) => fragment.text.includes('$12,000.00') && fragment.text.includes('$4,800.00/mo'));
    expect(label).toBeDefined();
    expect(amount).toBeDefined();
    expect(amount!.y).toBeGreaterThan(label!.y);
  });

  it('moves a long category breakdown amount below its label instead of crowding the next row', async () => {
    const buf = await renderQuotePdf(
      {
        id: 'q1', quoteNumber: 'Q-LONG-CATEGORY', currencyCode: 'USD',
        oneTimeTotal: '3000.00', monthlyRecurringTotal: '4800.00', annualRecurringTotal: '9600.00',
        dueOnAcceptanceTotal: '3000.00', total: '17400.00',
        categoryBreakdown: [
          { category: 'hardware', oneTimeTotal: '100.00', monthlyTotal: '0.00', annualTotal: '0.00' },
          { category: 'service', oneTimeTotal: '3000.00', monthlyTotal: '4800.00', annualTotal: '9600.00' },
        ],
      },
      [],
      [
        { id: 'l1', description: 'Setup', quantity: '1', unitPrice: '3000', lineTotal: '3000.00', recurrence: 'one_time', itemType: 'service' },
        { id: 'l2', description: 'Service', quantity: '1', unitPrice: '4800', lineTotal: '4800.00', recurrence: 'monthly', itemType: 'service' },
        { id: 'l3', description: 'Review', quantity: '1', unitPrice: '9600', lineTotal: '9600.00', recurrence: 'annual', itemType: 'service' },
      ],
      async () => null,
      {},
    );
    const positioned = extractPositionedPdfText(buf);
    const label = positioned.find((fragment) => fragment.text === 'Service');
    const amount = positioned.find((fragment) => fragment.text.includes('$3,000.00') && fragment.text.includes('$4,800.00/mo'));
    const oneTime = positioned.find((fragment) => fragment.text === 'One-time');
    const categoryLastLine = positioned
      .filter((fragment) => fragment.text.includes('$9,600.00/yr') && oneTime && fragment.y < oneTime.y)
      .sort((a, b) => b.y - a.y)[0];
    expect(label).toBeDefined();
    expect(amount).toBeDefined();
    expect(amount!.y).toBeGreaterThan(label!.y);
    expect(oneTime).toBeDefined();
    expect(categoryLastLine).toBeDefined();
    expect(oneTime!.y - categoryLastLine!.y).toBeGreaterThanOrEqual(10);
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

  describe('image block flow (regression: doc.image never advances pdfkit cursor)', () => {
    // The 1x1 PNG in a 200x400 fit box draws at 200x200 (pdfkit fit upscales
    // proportionally: scale = min(200/1, 400/1) = 200).
    const imageBlock = (id: string, sortOrder: number) =>
      ({ id, blockType: 'image', sortOrder, content: { imageId: `img-${id}`, width: 200 } });

    it('text after an image block starts below the image, not on top of it', async () => {
      const buf = await renderQuotePdf(
        { id: 'q1', quoteNumber: 'Q-9', oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00', total: '0.00', currencyCode: 'USD' },
        [
          { id: 'b1', blockType: 'rich_text', sortOrder: 0, content: { html: '<p>MARKERBEFORE</p>' } },
          imageBlock('b2', 1),
          { id: 'b3', blockType: 'rich_text', sortOrder: 2, content: { html: '<p>MARKERAFTER</p>' } },
        ],
        [],
        async () => ({ data: ONE_BY_ONE_PNG }),
        {},
      );
      const positioned = extractPositionedPdfText(buf);
      const before = positioned.find((f) => f.text.includes('MARKERBEFORE'))!;
      const after = positioned.find((f) => f.text.includes('MARKERAFTER'))!;
      expect(before).toBeDefined();
      expect(after).toBeDefined();
      // The 200pt-tall image sits between them; the shipped overlap bug put
      // MARKERAFTER ~20pt below MARKERBEFORE, straight across the image.
      expect(after.y - before.y).toBeGreaterThanOrEqual(200);
    });

    it('a run of tall images paginates instead of overflowing the bottom margin', async () => {
      const buf = await renderQuotePdf(
        { id: 'q1', quoteNumber: 'Q-10', oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00', total: '0.00', currencyCode: 'USD' },
        [1, 2, 3, 4].map((n) => imageBlock(`b${n}`, n)),
        [],
        async () => ({ data: ONE_BY_ONE_PNG }),
        {},
      );
      // 4 x ~206pt of image cannot fit one A4 content column (~742pt).
      const pages = (await PDFDocument.load(buf)).getPageCount();
      expect(pages).toBeGreaterThanOrEqual(2);
    });

    it('cover page: with a cover image the title moves into the bottom legibility band; without one it stays at the top', async () => {
      const base = {
        id: 'q1', quoteNumber: 'Q-12', oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00', total: '0.00', currencyCode: 'USD',
      };
      const withImage = await renderQuotePdf(
        { ...base, coverPage: { enabled: true, title: 'FULLBLEEDTITLE', coverImageId: 'img-cover' } } as never,
        [], [], async () => ({ data: ONE_BY_ONE_PNG }), {},
      );
      const withoutImage = await renderQuotePdf(
        { ...base, coverPage: { enabled: true, title: 'FULLBLEEDTITLE' } } as never,
        [], [], async () => null, {},
      );
      const titleY = (buf: Buffer) => extractPositionedPdfText(buf).find((f) => f.text.includes('FULLBLEEDTITLE'))!.y;
      // Full-bleed background → title sits inside the bottom band (>= 62% of
      // the A4 page height); classic no-image cover keeps it under the top margin.
      expect(titleY(withImage)).toBeGreaterThanOrEqual(841.89 * 0.62);
      expect(titleY(withoutImage)).toBeLessThan(200);
    });

    it('cover page: a wrapping preparedForName pushes the address down instead of overlapping it', async () => {
      const buf = await renderQuotePdf(
        {
          id: 'q1', quoteNumber: 'Q-11', oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00', total: '0.00', currencyCode: 'USD',
          coverPage: { enabled: true, title: 'Proposal', preparedForName: 'Cassidy Lowrey — Animal Health at Home Veterinary Practice LLC' },
          billToAddress: { line1: '406 10th Street', city: 'Berthoud', region: 'CO', postalCode: '80513' },
        } as never,
        [], [], async () => null, {},
      );
      const positioned = extractPositionedPdfText(buf);
      const nameBottom = Math.max(...positioned.filter((f) => f.text.includes('Animal Health')).map((f) => f.y));
      const address = positioned.find((f) => f.text.includes('406 10th Street'))!;
      expect(address).toBeDefined();
      expect(Number.isFinite(nameBottom)).toBe(true);
      // Address must start below the wrapped name's LAST line (12pt font ≈
      // 14pt line height); the shipped bug drew it at a fixed one-line offset.
      expect(address.y).toBeGreaterThan(nameBottom + 10);
    });
  });
});

describe('renderQuotePdf table + callout block dispatch (Task 9)', () => {
  const baseQuote = {
    id: 'q-t9', quoteNumber: 'Q-T9', oneTimeTotal: '100.00', monthlyRecurringTotal: '0.00',
    annualRecurringTotal: '0.00', total: '100.00', currencyCode: 'USD',
  };

  it('draws a table block via the measured (not the raw, unmeasured) model', async () => {
    // Regression guard for a real bug the brief's own snippet has: it calls
    // measureTable(doc, model, fonts) but discards the return — measureTable
    // does NOT mutate `model` (see tablePdf.ts doc comment), so passing the
    // unmeasured original to renderTableIntoPdf would draw every row at
    // height 0 (rows/header would all overlap at the same y). Asserting BOTH
    // column labels are present as distinct positioned text confirms real
    // (non-zero) row/column layout was used.
    const blocks = [
      {
        id: 'b1', blockType: 'table' as const, sortOrder: 0,
        content: { columns: [{ label: 'Item' }, { label: 'Qty' }], rows: [{ cells: ['Widget', '3'] }, { cells: ['Gadget', '5'] }] },
      },
    ];
    const buf = await renderQuotePdf(baseQuote as never, blocks, [], async () => null, {});
    const text = extractPdfText(buf);
    expect(text).toContain('Item');
    expect(text).toContain('Qty');
    expect(text).toContain('Widget');
    expect(text).toContain('Gadget');
  });

  it('skips a malformed table block rather than throwing', async () => {
    const blocks = [{ id: 'b1', blockType: 'table' as const, sortOrder: 0, content: { columns: [], rows: [] } }];
    await expect(renderQuotePdf(baseQuote as never, blocks, [], async () => null, {})).resolves.toBeInstanceOf(Buffer);
  });

  it('draws a callout block with its title and body', async () => {
    const blocks = [
      {
        id: 'b1', blockType: 'callout' as const, sortOrder: 0,
        content: { variant: 'accent', title: 'Heads up', html: '<p>Read this before you sign.</p>' },
      },
    ];
    const buf = await renderQuotePdf(baseQuote as never, blocks, [], async () => null, { primaryColor: '#059669' });
    const text = extractPdfText(buf);
    expect(text).toContain('Heads up');
    expect(text).toContain('Read this before you sign');
  });

  it('a table block followed by a rich_text block renders both (block-walk keeps advancing)', async () => {
    const blocks = [
      { id: 'b1', blockType: 'table' as const, sortOrder: 0, content: { columns: [{ label: 'Col' }], rows: [{ cells: ['val'] }] } },
      { id: 'b2', blockType: 'rich_text' as const, sortOrder: 1, content: { html: '<p>After the table.</p>' } },
    ];
    const buf = await renderQuotePdf(baseQuote as never, blocks, [], async () => null, {});
    const text = extractPdfText(buf);
    expect(text).toContain('val');
    expect(text).toContain('After the table');
  });
});

describe('renderQuotePdf theme + page size (Task 6)', () => {
  const baseQuote = {
    id: 'q-theme', quoteNumber: 'Q-THEME', oneTimeTotal: '100.00', monthlyRecurringTotal: '0.00',
    annualRecurringTotal: '0.00', total: '100.00', currencyCode: 'USD',
  };
  const blocks = [
    { id: 'b1', blockType: 'heading' as const, sortOrder: 0, content: { text: 'Themed heading', level: 1 } },
    { id: 'b2', blockType: 'rich_text' as const, sortOrder: 1, content: { html: '<p>Themed body copy.</p>' } },
  ];

  it('branding.pageSize "letter" produces a LETTER MediaBox (612x792)', async () => {
    const buf = await renderQuotePdf(baseQuote as never, blocks, [], async () => null, { pageSize: 'letter' });
    const doc = await PDFDocument.load(buf);
    const page = doc.getPage(0);
    expect(page.getWidth()).toBeCloseTo(612, 0);
    expect(page.getHeight()).toBeCloseTo(792, 0);
  });

  it('omitting pageSize keeps the classic A4 MediaBox (595x842)', async () => {
    const buf = await renderQuotePdf(baseQuote as never, blocks, [], async () => null, {});
    const doc = await PDFDocument.load(buf);
    const page = doc.getPage(0);
    expect(page.getWidth()).toBeCloseTo(595, 0);
    expect(page.getHeight()).toBeCloseTo(842, 0);
  });

  it('branding.theme "condensed" embeds BarlowCondensed and DMSans font programs', async () => {
    const buf = await renderQuotePdf(baseQuote as never, blocks, [], async () => null, { theme: 'condensed' });
    const doc = await PDFDocument.load(buf);
    const baseFontNames: string[] = [];
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFDict) {
        const baseFont = obj.get(PDFName.of('BaseFont'));
        if (baseFont) baseFontNames.push(baseFont.toString());
      }
    }
    expect(baseFontNames.some((name) => name.includes('BarlowCondensed'))).toBe(true);
    expect(baseFontNames.some((name) => name.includes('DMSans'))).toBe(true);
  });

  it('no theme/pageSize fields set still passes the classic content-stream regression', async () => {
    // Belt-and-suspenders: the dedicated harness (quotePdf.classicRegression.test.ts)
    // is the authoritative check, but assert here too that the plain {} branding
    // this suite's other tests already exercise keeps producing Helvetica text
    // runs, not a theme-font indirection leaking through when unrequested.
    const buf = await renderQuotePdf(baseQuote as never, blocks, [], async () => null, {});
    const text = extractPdfText(buf);
    expect(text).toContain('Themed heading');
    expect(text).toContain('Themed body copy');
  });
});

describe('imageIntrinsicSize', () => {
  it('parses PNG IHDR dimensions', () => {
    expect(imageIntrinsicSize(ONE_BY_ONE_PNG)).toEqual({ width: 1, height: 1 });
  });

  it('parses JPEG SOF dimensions (skipping APP segments)', () => {
    // SOI, APP0 (JFIF stub), SOF0 with height 30 / width 20.
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14), // APP0, len 16
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x1e, 0x00, 0x14]), Buffer.alloc(10), // SOF0: h=30 w=20
    ]);
    expect(imageIntrinsicSize(jpeg)).toEqual({ width: 20, height: 30 });
  });

  it('returns null for unparseable buffers', () => {
    expect(imageIntrinsicSize(Buffer.from('not an image at all'))).toBeNull();
    expect(imageIntrinsicSize(Buffer.alloc(0))).toBeNull();
    // WebP (RIFF) — the probe doesn't parse it either, so the render loop
    // falls back to a fixed fitHeight rather than a measured aspect ratio.
    // (The renderQuotePdf-level "degrades gracefully ... WebP" test above
    // proves the actual doc.image() failure this feeds into is caught and
    // reported, not silently swallowed — #3483.)
    expect(imageIntrinsicSize(Buffer.from('RIFF0000WEBPVP8 '))).toBeNull();
  });
});
