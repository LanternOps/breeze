// Quote/Proposal PDF rendering (Phase 1).
//
// Mirrors invoicePdf.ts: a pure, DB-free renderer drawn programmatically with
// pdfkit (no headless browser in the API path). The novel part here is that a
// quote is BLOCK-based — the customer document is an ordered list of content
// blocks (heading / rich_text / image / line_items) rather than a single fixed
// table. renderQuotePdf walks the blocks in sortOrder and draws each; pricing
// tables (line_items blocks + any orphan lines) reuse the invoice table styling,
// and the document closes with a recurring-summary footer (one-time / monthly /
// annual / first-invoice total) drawn from the quote header buckets.
//
// renderQuotePdf is intentionally pure (image bytes arrive via the injected
// `loadImage`, branding via `branding`) so it is unit-testable without a DB; the
// route in routes/quotes/quotes.ts supplies the real quote_images loader.

import PDFDocument from 'pdfkit';

// ---------------------------------------------------------------------------
// Formatting helpers (kept in lock-step with invoicePdf.ts conventions)
// ---------------------------------------------------------------------------

function formatMoney(amount: string | number | null | undefined, currency: string): string {
  const n = Number(amount ?? 0);
  const symbol = currency === 'USD' ? '$' : '';
  const formatted = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return symbol ? `${symbol}${formatted}` : `${formatted} ${currency}`;
}

function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '';
  const d = typeof value === 'string' ? new Date(value + (value.length === 10 ? 'T00:00:00Z' : '')) : value;
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit', timeZone: 'UTC' });
}

/** Suffix shown next to a recurring line's amount in the pricing table. */
function recurrenceSuffix(recurrence: string | null | undefined): string {
  if (recurrence === 'monthly') return '/mo';
  if (recurrence === 'annual') return '/yr';
  return '';
}

function hexToColor(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  const v = value.startsWith('#') ? value : `#${value}`;
  return /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : fallback;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

interface BillToAddress {
  line1?: string | null; line2?: string | null; city?: string | null;
  region?: string | null; postalCode?: string | null; country?: string | null;
}

function addressLines(addr: BillToAddress | null | undefined): string[] {
  if (!addr) return [];
  const cityLine = [addr.city, addr.region, addr.postalCode].filter(Boolean).join(', ');
  return [addr.line1, addr.line2, cityLine, addr.country].filter((s): s is string => !!s && s.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Public types (loosely typed to decouple from Drizzle row shapes — the
// renderer only reads a handful of fields off each).
// ---------------------------------------------------------------------------

export interface QuotePdfBranding {
  partnerName?: string | null;
  logoUrl?: string | null;
  primaryColor?: string | null;
  footer?: string | null;
  currencyCode?: string | null;
}

interface QuoteHeader {
  id: string;
  quoteNumber?: string | null;
  status?: string | null;
  currencyCode?: string | null;
  issueDate?: string | Date | null;
  expiryDate?: string | Date | null;
  billToName?: string | null;
  billToAddress?: unknown;
  billToTaxId?: string | null;
  introNotes?: string | null;
  terms?: string | null;
  subtotal?: string | number | null;
  taxRate?: string | number | null;
  taxTotal?: string | number | null;
  total?: string | number | null;
  oneTimeTotal?: string | number | null;
  monthlyRecurringTotal?: string | number | null;
  annualRecurringTotal?: string | number | null;
}

interface QuoteBlock {
  id: string;
  blockType: 'heading' | 'rich_text' | 'image' | 'line_items' | string;
  // jsonb column → typed `unknown` by Drizzle; the per-type casts below narrow it.
  content: unknown;
  sortOrder: number;
}

interface QuoteLine {
  id: string;
  blockId?: string | null;
  description: string;
  quantity: string | number;
  unitPrice: string | number;
  lineTotal?: string | number | null;
  recurrence?: string | null;
}

// ---------------------------------------------------------------------------
// Layout constants (shared between the line table + summary so columns align).
// Computed once we have the document margins.
// ---------------------------------------------------------------------------

interface Cols {
  left: number; right: number; contentWidth: number;
  colQtyX: number; colDescW: number; colUnitX: number; colNumW: number; colAmtX: number;
}

function columnsFor(doc: PDFKit.PDFDocument): Cols {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentWidth = right - left;
  return {
    left,
    right,
    contentWidth,
    // qty | description | unit | total
    colQtyX: left,
    colDescW: contentWidth * 0.46,
    colUnitX: left + contentWidth * 0.60,
    colAmtX: left + contentWidth * 0.80,
    colNumW: contentWidth * 0.18,
  };
}

/** Add a page if `y` is within the bottom margin band; returns the (possibly reset) y. */
function ensureSpace(doc: PDFKit.PDFDocument, y: number, needed = 40): number {
  if (y > doc.page.height - doc.page.margins.bottom - needed) {
    doc.addPage();
    return doc.page.margins.top;
  }
  return y;
}

// ---------------------------------------------------------------------------
// Line table: qty | description | unit | total. Right-aligned money columns,
// matching invoicePdf's table styling (uppercase grey headers, 1px rule).
// Returns the y position below the table.
// ---------------------------------------------------------------------------

function renderLineTable(doc: PDFKit.PDFDocument, lines: QuoteLine[], currency: string, startY: number): number {
  const c = columnsFor(doc);
  let y = ensureSpace(doc, startY, 60);

  // Header row.
  doc.fillColor('#9ca3af').fontSize(9).font('Helvetica-Bold');
  doc.text('QTY', c.colQtyX, y, { width: c.contentWidth * 0.10, align: 'left' });
  doc.text('DESCRIPTION', c.colQtyX + c.contentWidth * 0.12, y, { width: c.contentWidth * 0.46, align: 'left' });
  doc.text('UNIT', c.colUnitX, y, { width: c.colNumW, align: 'right' });
  doc.text('TOTAL', c.colAmtX, y, { width: c.colNumW, align: 'right' });
  y += 14;
  doc.moveTo(c.left, y).lineTo(c.right, y).lineWidth(1).strokeColor('#e5e7eb').stroke();
  y += 6;

  const descX = c.colQtyX + c.contentWidth * 0.12;
  for (const l of lines) {
    y = ensureSpace(doc, y, 30);
    doc.fillColor('#1f2937').fontSize(10).font('Helvetica');
    const descHeight = doc.heightOfString(l.description, { width: c.contentWidth * 0.46 });
    doc.text(String(Number(l.quantity)), c.colQtyX, y, { width: c.contentWidth * 0.10, align: 'left' });
    doc.text(l.description, descX, y, { width: c.contentWidth * 0.46 });
    doc.text(formatMoney(l.unitPrice, currency), c.colUnitX, y, { width: c.colNumW, align: 'right' });
    const suffix = recurrenceSuffix(l.recurrence);
    doc.text(`${formatMoney(l.lineTotal ?? Number(l.quantity) * Number(l.unitPrice), currency)}${suffix}`, c.colAmtX, y, { width: c.colNumW, align: 'right' });
    y += Math.max(descHeight, 12) + 6;
  }
  return y + 6;
}

// ---------------------------------------------------------------------------
// Recurring summary footer: One-time / Monthly / Annual / first-invoice total,
// drawn from the quote header buckets. The "first invoice total" is the quote's
// `total` (one-time charges + the first recurring period), matching how the
// header total is computed in quoteMath.
// ---------------------------------------------------------------------------

function renderRecurringSummary(doc: PDFKit.PDFDocument, quote: QuoteHeader, currency: string, startY: number): number {
  const c = columnsFor(doc);
  let y = ensureSpace(doc, startY + 6, 90);

  doc.moveTo(c.colUnitX, y).lineTo(c.right, y).lineWidth(1).strokeColor('#e5e7eb').stroke();
  y += 8;

  const labelX = c.colUnitX;
  const labelW = c.colAmtX - c.colUnitX - 4;
  const drawRow = (label: string, amount: string | number | null | undefined, suffix: string, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor(bold ? '#111827' : '#6b7280');
    doc.text(label, labelX, y, { width: labelW, align: 'left' });
    doc.fillColor(bold ? '#111827' : '#1f2937').text(`${formatMoney(amount, currency)}${suffix}`, c.colAmtX, y, { width: c.colNumW, align: 'right' });
    y += bold ? 18 : 14;
  };

  drawRow('One-time', quote.oneTimeTotal, '');
  drawRow('Monthly', quote.monthlyRecurringTotal, '/mo');
  drawRow('Annual', quote.annualRecurringTotal, '/yr');
  if (quote.taxTotal != null && Number(quote.taxTotal) > 0) {
    drawRow(`Tax${quote.taxRate ? ` (${(Number(quote.taxRate) * 100).toFixed(2)}%)` : ''}`, quote.taxTotal, '');
  }
  drawRow('First invoice total', quote.total, '', true);
  return y;
}

// ---------------------------------------------------------------------------
// PURE renderer: draws the quote PDF from structured data. Image bytes arrive
// via the injected loadImage; branding via the branding arg. No DB access.
// ---------------------------------------------------------------------------

export async function renderQuotePdf(
  quote: QuoteHeader,
  blocks: QuoteBlock[],
  lines: QuoteLine[],
  loadImage: (imageId: string) => Promise<{ data: Buffer } | null>,
  branding: QuotePdfBranding,
): Promise<Buffer> {
  const currency = quote.currencyCode ?? branding.currencyCode ?? 'USD';
  const primary = hexToColor(branding.primaryColor, '#2563eb');
  const partnerName = branding.partnerName ?? 'Proposal';

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (d: Buffer) => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const c = columnsFor(doc);

  // ---- Header: partner name + PROPOSAL title + quote number ----------------
  doc.fillColor(primary).fontSize(20).font('Helvetica-Bold').text(partnerName, c.left, 50, { width: c.contentWidth * 0.6 });
  doc.fillColor('#111827').fontSize(18).font('Helvetica-Bold').text('PROPOSAL', c.left, 52, { width: c.contentWidth, align: 'right' });
  doc.fillColor('#6b7280').fontSize(10).font('Helvetica').text(quote.quoteNumber ?? 'DRAFT', c.left, 74, { width: c.contentWidth, align: 'right' });
  doc.moveTo(c.left, 96).lineTo(c.right, 96).lineWidth(2).strokeColor(primary).stroke();

  // ---- Bill-to block + dates ----------------------------------------------
  let y = 112;
  if (quote.billToName) {
    doc.fillColor('#9ca3af').fontSize(9).font('Helvetica-Bold').text('PREPARED FOR', c.left, y);
    doc.fillColor('#111827').fontSize(12).font('Helvetica-Bold').text(quote.billToName, c.left, y + 12);
  }
  let billY = y + (quote.billToName ? 28 : 12);
  doc.fillColor('#4b5563').fontSize(10).font('Helvetica');
  for (const aline of addressLines(quote.billToAddress as BillToAddress | null)) {
    doc.text(aline, c.left, billY); billY += 13;
  }
  if (quote.billToTaxId) { doc.fillColor('#6b7280').fontSize(9).text(`Tax ID: ${quote.billToTaxId}`, c.left, billY); billY += 13; }

  const dateX = c.left + c.contentWidth * 0.6;
  let dateY = y;
  doc.fillColor('#4b5563').fontSize(10).font('Helvetica');
  if (quote.issueDate) { doc.text(`Issued: ${formatDate(quote.issueDate)}`, dateX, dateY, { width: c.contentWidth * 0.4, align: 'right' }); dateY += 14; }
  if (quote.expiryDate) { doc.text(`Valid until: ${formatDate(quote.expiryDate)}`, dateX, dateY, { width: c.contentWidth * 0.4, align: 'right' }); dateY += 14; }

  y = Math.max(billY, dateY) + 20;

  // Intro notes, if any (above the blocks).
  if (quote.introNotes) {
    doc.fillColor('#4b5563').fontSize(10).font('Helvetica').text(quote.introNotes, c.left, y, { width: c.contentWidth });
    y = doc.y + 14;
  }

  // ---- Walk blocks in sortOrder -------------------------------------------
  const sorted = [...blocks].sort((a, z) => a.sortOrder - z.sortOrder);
  for (const b of sorted) {
    y = ensureSpace(doc, y, 50);
    if (b.blockType === 'heading') {
      const level = Number((b.content as { level?: number }).level ?? 1);
      const text = String((b.content as { text?: string }).text ?? '');
      const size = level === 1 ? 18 : level === 2 ? 15 : 13;
      doc.fillColor('#111827').fontSize(size).font('Helvetica-Bold').text(text, c.left, y, { width: c.contentWidth });
      y = doc.y + 8;
    } else if (b.blockType === 'rich_text') {
      const html = String((b.content as { html?: string }).html ?? '');
      const text = stripHtml(html);
      if (text) {
        doc.fillColor('#1f2937').fontSize(11).font('Helvetica').text(text, c.left, y, { width: c.contentWidth });
        y = doc.y + 8;
      }
    } else if (b.blockType === 'image') {
      const imageId = (b.content as { imageId?: string }).imageId;
      // loadImage performs DB I/O and can reject; a failed fetch must degrade to
      // skip-the-image rather than escaping renderQuotePdf (which would skip
      // doc.end() and surface as a 500).
      let img: { data: Buffer } | null = null;
      try {
        img = imageId ? await loadImage(imageId) : null;
      } catch (e) {
        console.error('[quotePdf] loadImage failed', imageId, e instanceof Error ? e.message : e);
        img = null;
      }
      if (img?.data) {
        const fitWidth = Number((b.content as { width?: number }).width ?? 400);
        try {
          doc.image(img.data, c.left, y, { fit: [Math.min(fitWidth, c.contentWidth), 400] });
          y = doc.y + 6;
        } catch (e) {
          // A corrupt/unsupported image must not abort the whole document.
          console.error('[quotePdf] doc.image failed', imageId, e instanceof Error ? e.message : e);
          y += 6;
        }
        const caption = (b.content as { caption?: string }).caption;
        if (caption) {
          doc.fillColor('#6b7280').fontSize(9).font('Helvetica').text(caption, c.left, y, { width: c.contentWidth });
          y = doc.y;
        }
        doc.fillColor('#111827');
        y += 8;
      }
    } else if (b.blockType === 'line_items') {
      const blockLines = lines.filter((l) => l.blockId === b.id);
      if (blockLines.length) y = renderLineTable(doc, blockLines, currency, y);
    }
  }

  // ---- Trailing default table for lines with no block ----------------------
  const orphanLines = lines.filter((l) => !l.blockId);
  if (orphanLines.length) y = renderLineTable(doc, orphanLines, currency, y);

  // ---- Recurring summary footer -------------------------------------------
  y = renderRecurringSummary(doc, quote, currency, y);

  // ---- Terms + branding footer --------------------------------------------
  const footer = quote.terms ?? branding.footer ?? null;
  if (footer) {
    y = ensureSpace(doc, y + 14, 60);
    doc.fillColor('#9ca3af').fontSize(9).font('Helvetica').text(footer, c.left, y, { width: c.contentWidth });
  }
  if (branding.footer && branding.footer !== footer) {
    doc.fillColor('#888888').fontSize(8).font('Helvetica').text(branding.footer, c.left, doc.page.height - 60, { width: c.contentWidth });
  }

  doc.end();
  return done;
}
