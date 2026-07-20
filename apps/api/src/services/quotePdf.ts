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
import { toCents, fromCents, type CoverPage } from '@breeze/shared';
import { sellerAddressLines, type SellerSnapshot, type BillToAddress } from './sellerSnapshot';
import { captureException } from './sentry';
import { renderRichTextIntoPdf } from './richTextPdf';

// ---------------------------------------------------------------------------
// Formatting helpers (kept in lock-step with invoicePdf.ts conventions)
// ---------------------------------------------------------------------------

// Exported so other renderers (contractTemplateRender.ts's auto-variable
// resolver) format money identically instead of hand-rolling a second
// Intl/toLocaleString call that could drift from this one.
export function formatMoney(amount: string | number | null | undefined, currency: string): string {
  const n = Number(amount ?? 0);
  const symbol = currency === 'USD' ? '$' : '';
  const formatted = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return symbol ? `${symbol}${formatted}` : `${formatted} ${currency}`;
}

// Exported for the same reason as formatMoney above — kept in lock-step so a
// contract's {{dates.effective}}/{{dates.expiry}} render in the same style as
// the PDF's own date fields.
export function formatDate(value: string | Date | null | undefined): string {
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

/** Per-line tax amount for the Tax column: taxable lines get lineTotal × rate
 *  rounded to cents; non-taxable lines / a non-positive rate return null (shown
 *  as '—'). The summary Tax stays quote.tax_total (authoritative), so the summed
 *  column can differ by a rounding cent on many-line quotes. */
function lineTax(lineTotal: string | number | null | undefined, taxable: boolean, rate: number): number | null {
  if (!taxable || !(rate > 0)) return null;
  const cents = Math.round(Number(lineTotal ?? 0) * 100);
  if (!Number.isFinite(cents)) return null;
  return Math.round(cents * rate) / 100;
}

function hexToColor(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  const v = value.startsWith('#') ? value : `#${value}`;
  return /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : fallback;
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
  title?: string | null;
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
  // Amount invoiced on accept (one-time + one-time tax); derived in getQuote.
  dueOnAcceptanceTotal?: string | number | null;
  // Deposit config (persisted columns): when set to a non-'none' type with an
  // amount, the summary shows a bold deposit figure + remaining-balance row in
  // place of the plain "Due on acceptance" row.
  depositType?: string | null;
  depositAmount?: string | null;
  // Derived at-read deposit figure (getQuote / the portal totals recompute) —
  // authoritative over the persisted depositAmount column (selected_lines
  // deposits derive from flagged lines). Optional: callers passing a raw row
  // fall back to depositAmount, preserving the legacy rendering.
  depositDueTotal?: string | number | null;
  // Per-category subtotals (one-time / monthly / annual), derived in getQuote.
  // Rendered as muted rows only when >1 category is present.
  categoryBreakdown?: { category: string; oneTimeTotal: string; monthlyTotal: string; annualTotal: string }[];
  sellerSnapshot?: unknown;
  termsAndConditions?: string | null;
  // Enhanced-proposals cover page (quotes.cover_page jsonb). Typed `unknown` like
  // billToAddress/sellerSnapshot above — a raw Drizzle jsonb select — and cast to
  // CoverPage inside renderCoverPage, which also treats a malformed/absent value
  // as "no cover page" rather than throwing.
  coverPage?: unknown;
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
  catalogItemId?: string | null;
  /** Per-line uploaded image (quote_images id); wins over the catalog image. */
  imageId?: string | null;
  name?: string | null;
  description?: string | null;
  quantity: string | number;
  unitPrice: string | number;
  lineTotal?: string | number | null;
  recurrence?: string | null;
  taxable?: boolean | null;
}

/** Loads a catalog item's product image bytes (or null). Injected so renderQuotePdf
 *  stays pure / DB-free; the route supplies the real readCatalogItemImage loader. */
type LoadCatalogImage = (catalogItemId: string) => Promise<{ data: Buffer } | null>;

// A `contract` quote block's PDF-ready render data, keyed by block id and
// injected into renderQuotePdf (Task 14) so it stays pure / DB-free — the
// route pre-fetches this via contractTemplateRender.ts's loadContractPdfInputs
// (same pinned-template-version read Task 13's client render path uses).
// `html` is the ALREADY-SUBSTITUTED authored body for an 'authored' block, or
// null for an 'uploaded' block (pdfkit can't draw an existing PDF's pages — see
// pdfMerge.ts; the renderer draws a one-line marker instead and the route
// appends the uploaded PDF's own pages after rendering).
export interface ContractPdfBlockData {
  html: string | null;
  templateName: string;
}

/** Exact one-line marker text drawn for an UPLOADED contract block. Exported so
 *  contractTemplateRender.ts's loadContractPdfInputs builds the SAME string for
 *  pdfMerge.ts's `afterMarker` — the two must never drift, or a future
 *  interleaving pass (see pdfMerge.ts's v1-limitation comment) would look for a
 *  marker that doesn't match what's actually drawn on the page. */
export function contractUploadedMarker(templateName: string): string {
  return `${templateName} — attached below`;
}

// ---------------------------------------------------------------------------
// Layout constants (shared between the line table + summary so columns align).
// Computed once we have the document margins.
// ---------------------------------------------------------------------------

interface Cols {
  left: number; right: number; contentWidth: number;
  colQtyX: number; colDescX: number; colDescW: number; colUnitX: number; colTaxX: number; colNumW: number; colAmtX: number;
  showTax: boolean;
}

// When showTax is set the table carries a fifth column (qty | description | unit
// | tax | total) and the money columns narrow to fit; otherwise the original
// four-column layout (qty | description | unit | total) is preserved so existing
// tax-free quotes render byte-identically. The summary uses the same colAmtX so
// its amounts stay aligned under TOTAL.
function columnsFor(doc: PDFKit.PDFDocument, showTax = false): Cols {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentWidth = right - left;
  const colDescX = left + contentWidth * 0.12;
  if (showTax) {
    return {
      left, right, contentWidth, showTax,
      colQtyX: left,
      colDescX,
      colDescW: contentWidth * 0.36,
      colUnitX: left + contentWidth * 0.50,
      colTaxX: left + contentWidth * 0.67,
      colAmtX: left + contentWidth * 0.84,
      colNumW: contentWidth * 0.15,
    };
  }
  return {
    left, right, contentWidth, showTax,
    colQtyX: left,
    colDescX,
    colDescW: contentWidth * 0.46,
    colUnitX: left + contentWidth * 0.60,
    colTaxX: left + contentWidth * 0.70, // unused when !showTax
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

async function renderLineTable(
  doc: PDFKit.PDFDocument,
  lines: QuoteLine[],
  currency: string,
  startY: number,
  loadCatalogImage: LoadCatalogImage,
  loadQuoteImage: (imageId: string) => Promise<{ data: Buffer } | null>,
  taxRate = 0,
  showTax = false,
  showSubtotal = false,
  label = '',
): Promise<number> {
  const c = columnsFor(doc, showTax);
  let y = startY;

  // Pre-load product images (DB I/O): a per-line uploaded image wins, else the
  // catalog item's image. A failed load degrades to "no thumbnail" — never
  // aborts the document. 44pt: large enough to recognize the product, small
  // enough that rows stay table-like.
  const THUMB = 44;
  const imageByLine = new Map<string, Buffer>();
  for (const l of lines) {
    try {
      if (l.imageId) {
        const img = await loadQuoteImage(l.imageId);
        if (img?.data) { imageByLine.set(l.id, img.data); continue; }
      }
      if (l.catalogItemId) {
        const img = await loadCatalogImage(l.catalogItemId);
        if (img?.data) imageByLine.set(l.id, img.data);
      }
    } catch (e) {
      // Degrade to "no thumbnail" (never abort the customer document), but report
      // to Sentry — a systemic image-serving break would otherwise be invisible
      // behind console.error.
      console.error('[quotePdf] line image load failed', l.imageId ?? l.catalogItemId, e instanceof Error ? e.message : e);
      captureException(e instanceof Error ? e : new Error(String(e)));
    }
  }
  // Reserve a thumbnail gutter only when at least one line has an image, so the
  // description column stays aligned across rows.
  const gutter = imageByLine.size > 0 ? THUMB + 8 : 0;
  const descW = c.colDescW - gutter;

  // Header row with a light fill bar. Extracted so it re-draws at the top of
  // every page the table spills onto — a continuation page without column
  // headers forces the reader to flip back to relearn the columns.
  const drawTableHeader = (headerY: number): number => {
    doc.save();
    doc.rect(c.left - 6, headerY - 5, c.contentWidth + 12, 22).fill('#f8fafc');
    doc.restore();
    doc.fillColor('#6b7280').fontSize(8.5).font('Helvetica-Bold');
    doc.text('QTY', c.colQtyX, headerY, { width: c.contentWidth * 0.10, align: 'left' });
    doc.text('DESCRIPTION', c.colDescX, headerY, { width: c.colDescW, align: 'left' });
    doc.text('UNIT', c.colUnitX, headerY, { width: c.colNumW, align: 'right' });
    if (showTax) doc.text('TAX', c.colTaxX, headerY, { width: c.colNumW, align: 'right' });
    doc.text('TOTAL', c.colAmtX, headerY, { width: c.colNumW, align: 'right' });
    return headerY + 24;
  };
  // Page-break helper that re-draws the column header on the fresh page (unlike
  // the generic ensureSpace, which just resets y).
  const ensureRowSpace = (rowY: number, needed: number): number => {
    if (rowY > doc.page.height - doc.page.margins.bottom - needed) {
      doc.addPage();
      return drawTableHeader(doc.page.margins.top);
    }
    return rowY;
  };

  // Measure each fragment at the SAME font/size it is drawn with. The blurb is
  // rendered at 8.5pt but used to be measured while the font was still 10pt,
  // over-reserving ~1.5pt per wrapped line — a visible gap below tall spec-list
  // rows (e.g. a 15-bullet PC). Measure title as bold-10, blurb as regular-8.5.
  const measureRow = (l: QuoteLine) => {
    // Title falls back to description for legacy lines that predate the name/description split.
    const title = (l.name ?? l.description ?? '').trim() || '—';
    const blurb = l.name ? (l.description ?? '').trim() : '';
    doc.font('Helvetica-Bold').fontSize(10);
    const titleHeight = doc.heightOfString(title, { width: descW });
    doc.font('Helvetica').fontSize(8.5);
    const blurbHeight = blurb ? doc.heightOfString(blurb, { width: descW, lineGap: 1 }) + 2 : 0;
    const img = imageByLine.get(l.id);
    return { title, blurb, titleHeight, img, rowHeight: Math.max(titleHeight + blurbHeight, img ? THUMB : 12) };
  };

  // Keep the section label, the column header and the FIRST row together as one
  // unit. Reserving a flat minimum row (the old 52pt at the call site) breaks
  // whenever the first row is a tall spec list: the label + header fit the guess,
  // got drawn at the foot of the page, then the row-level break moved the row to
  // the next page and stranded them. Reserve the first row's real measured height
  // instead, capped to a page so a taller-than-a-page row can't force a blank one.
  const labelHeight = label ? (doc.font('Helvetica-Bold').fontSize(11).heightOfString(label, { width: c.contentWidth }) + 6) : 0;
  const usable = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
  const firstLine = lines[0];
  const firstRowHeight = firstLine ? measureRow(firstLine).rowHeight + 6 : 0;
  y = ensureSpace(doc, y, Math.min(labelHeight + 24 + firstRowHeight, usable));
  if (label) {
    doc.fillColor('#111827').fontSize(11).font('Helvetica-Bold').text(label, c.left, y, { width: c.contentWidth });
    y = doc.y + 6;
  }

  y = drawTableHeader(y);

  const descX = c.colDescX;
  for (const l of lines) {
    const { title, blurb, titleHeight, img, rowHeight } = measureRow(l);
    // Keep the whole row together: if it won't fit in the remaining page, break to
    // a fresh page (re-drawing the column header) rather than letting a long
    // description overflow into the footer band. (Old reserve was a flat 30/52pt,
    // so tall rows spilled past the bottom margin.)
    y = ensureRowSpace(y, rowHeight + 6);
    doc.fillColor('#1f2937').font('Helvetica').fontSize(10);
    doc.text(String(Number(l.quantity)), c.colQtyX, y, { width: c.contentWidth * 0.10, align: 'left' });
    if (img) {
      // A buffer that loaded but pdfkit can't decode: skip the thumbnail (never
      // abort the document) but REPORT it — the pre-load loop above logs byte-level
      // failures, so a decode-at-draw failure must not be the one silent gap.
      try {
        doc.image(img, descX, y, { fit: [THUMB, THUMB] });
      } catch (e) {
        console.error('[quotePdf] doc.image (line thumbnail) failed', l.id, e instanceof Error ? e.message : e);
        captureException(e instanceof Error ? e : new Error(String(e)));
      }
    }
    doc.fillColor('#1f2937').font('Helvetica-Bold').fontSize(10).text(title, descX + gutter, y, { width: descW });
    if (blurb) {
      doc.fillColor('#6b7280').fontSize(8.5).font('Helvetica').text(blurb, descX + gutter, y + titleHeight + 2, { width: descW, lineGap: 1 });
      doc.fillColor('#1f2937').fontSize(10);
    }
    doc.font('Helvetica').fontSize(10).text(formatMoney(l.unitPrice, currency), c.colUnitX, y, { width: c.colNumW, align: 'right' });
    if (showTax) {
      const t = lineTax(l.lineTotal ?? Number(l.quantity) * Number(l.unitPrice), !!l.taxable, taxRate);
      doc.fillColor('#6b7280').text(t === null ? '—' : formatMoney(t, currency), c.colTaxX, y, { width: c.colNumW, align: 'right' });
      doc.fillColor('#1f2937');
    }
    const suffix = recurrenceSuffix(l.recurrence);
    doc.font('Helvetica').fontSize(10).text(`${formatMoney(l.lineTotal ?? Number(l.quantity) * Number(l.unitPrice), currency)}${suffix}`, c.colAmtX, y, { width: c.colNumW, align: 'right' });
    y += rowHeight + 6;
  }

  // Opt-in per-table subtotal: sum THIS table's lines split by recurrence, shown
  // as non-zero parts joined with " + " (matches the document footer style).
  if (showSubtotal) {
    const sums = { one_time: 0, monthly: 0, annual: 0 };
    for (const l of lines) {
      // Fold any unrecognized recurrence (e.g. a future re-enabled 'quarterly')
      // into one_time so the printed Subtotal always covers every rendered row —
      // never silently omit a bucket the parts list below doesn't know about.
      const key = l.recurrence === 'monthly' || l.recurrence === 'annual' ? l.recurrence : 'one_time';
      sums[key] += Number(l.lineTotal ?? Number(l.quantity) * Number(l.unitPrice));
    }
    const parts: string[] = [];
    if (sums.one_time > 0) parts.push(formatMoney(sums.one_time, currency));
    if (sums.monthly > 0) parts.push(`${formatMoney(sums.monthly, currency)}/mo`);
    if (sums.annual > 0) parts.push(`${formatMoney(sums.annual, currency)}/yr`);
    if (parts.length) {
      y = ensureRowSpace(y, 24);
      doc.moveTo(c.colUnitX, y).lineTo(c.right, y).lineWidth(0.5).strokeColor('#e5e7eb').stroke();
      y += 6;
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#374151').text('Subtotal', c.colUnitX, y, { width: c.contentWidth * 0.2, align: 'left' });
      doc.fillColor('#111827').text(parts.join('  +  '), c.colUnitX, y, { width: c.right - c.colUnitX, align: 'right' });
      y += 18;
    }
  }
  return y + 6;
}

// ---------------------------------------------------------------------------
// Recurring summary footer: One-time / Monthly / Annual / due-on-acceptance,
// drawn from the quote header buckets. The bold "Due on acceptance" figure is
// what accept actually invoices (one-time charges + tax on the one-time lines —
// quote.dueOnAcceptanceTotal); recurring lines bill later via the contract, so
// they are NOT in that figure. When there is recurring revenue we also show the
// `total` as a secondary "first-period total (incl. recurring)" line so the
// recurring-inclusive number is still visible but not presented as the invoiced
// amount.
// ---------------------------------------------------------------------------

function renderRecurringSummary(doc: PDFKit.PDFDocument, quote: QuoteHeader, currency: string, primary: string, startY: number, showTax = false): number {
  const c = columnsFor(doc, showTax);
  // Hoisted above ensureSpace so the page-break reservation can size itself to
  // the actual content drawn below.
  const breakdown = quote.categoryBreakdown ?? [];
  const depositDue = quote.depositDueTotal ?? quote.depositAmount;
  const hasDeposit = quote.depositType && quote.depositType !== 'none' && depositDue != null;
  // 90px covered the legacy footer. Category rows add 12px each (+4px gap) and a
  // deposit adds the due-on-acceptance anchor row (18px) plus the bold remainder
  // row (18px) — reserve for them, or ensureSpace won't break the page and the
  // new rows draw past the bottom margin (pdfkit doesn't auto-paginate
  // explicit-coordinate text). Stays 90 for a no-deposit, ≤1-category quote so
  // those render exactly as before.
  const needed = 90 + (breakdown.length > 1 ? breakdown.length * 12 + 4 : 0) + (hasDeposit ? 36 : 0);
  let y = ensureSpace(doc, startY + 6, needed);

  // Wider label column than the line table's so the emphasised "Due on
  // acceptance" figure (14pt) and the recurring labels never wrap/overlap.
  const sumX = c.left + c.contentWidth * 0.40;
  doc.moveTo(sumX, y).lineTo(c.right, y).lineWidth(1).strokeColor('#e5e7eb').stroke();
  y += 8;

  const labelX = sumX;
  const labelW = c.colAmtX - sumX - 8;

  // Per-category subtotals (muted) — only worth showing when the quote spans more
  // than one category. Drawn above the One-time/Monthly/Annual roll-up.
  if (breakdown.length > 1) {
    for (const b of breakdown) {
      const label = b.category === 'other' ? 'Other' : b.category[0]!.toUpperCase() + b.category.slice(1);
      const parts: string[] = [];
      if (Number(b.oneTimeTotal) > 0) parts.push(formatMoney(b.oneTimeTotal, currency));
      if (Number(b.monthlyTotal) > 0) parts.push(`${formatMoney(b.monthlyTotal, currency)}/mo`);
      if (Number(b.annualTotal) > 0) parts.push(`${formatMoney(b.annualTotal, currency)}/yr`);
      doc.font('Helvetica').fontSize(9).fillColor('#9ca3af');
      doc.text(label, labelX, y, { width: labelW, align: 'left' });
      doc.text(parts.join(' + '), c.colAmtX - 60, y, { width: c.colNumW + 60, align: 'right' });
      y += 12;
    }
    y += 4;
  }
  const drawRow = (
    label: string,
    amount: string | number | null | undefined,
    suffix: string,
    opts: { bold?: boolean; emphasis?: boolean } = {},
  ) => {
    const { bold = false, emphasis = false } = opts;
    const strong = bold || emphasis;
    doc.font(strong ? 'Helvetica-Bold' : 'Helvetica').fontSize(emphasis ? 14 : strong ? 12 : 10).fillColor(strong ? '#111827' : '#6b7280');
    doc.text(label, labelX, y, { width: labelW, align: 'left' });
    doc.fillColor(emphasis ? primary : strong ? '#111827' : '#1f2937').text(`${formatMoney(amount, currency)}${suffix}`, c.colAmtX, y, { width: c.colNumW, align: 'right' });
    y += emphasis ? 20 : strong ? 18 : 14;
  };

  drawRow('One-time', quote.oneTimeTotal, '');
  drawRow('Monthly', quote.monthlyRecurringTotal, '/mo');
  drawRow('Annual', quote.annualRecurringTotal, '/yr');
  if (quote.taxTotal != null && Number(quote.taxTotal) > 0) {
    drawRow(`Tax${quote.taxRate ? ` (${(Number(quote.taxRate) * 100).toFixed(2)}%)` : ''}`, quote.taxTotal, '');
  }
  const hasRecurring =
    Number(quote.monthlyRecurringTotal ?? 0) > 0 || Number(quote.annualRecurringTotal ?? 0) > 0;
  // Accent primary figure = what the customer pays NOW. With a deposit, the
  // emphasised figure is the deposit due — anchored by an explicit "Due on
  // acceptance" row above it so the three figures visibly sum (due = deposit +
  // remaining) instead of asking the reader to infer the relationship. Same
  // presentation contract as the web preview and both portal views. Falls back
  // to the one-time total if the derived field is somehow absent.
  if (hasDeposit) {
    drawRow('Due on acceptance', quote.dueOnAcceptanceTotal ?? quote.oneTimeTotal, '', { bold: true });
    drawRow('Deposit due now', depositDue, '', { emphasis: true });
    const remainderCents = toCents(quote.dueOnAcceptanceTotal ?? quote.oneTimeTotal) - toCents(depositDue);
    drawRow('Remaining balance (due per terms)', fromCents(remainderCents), '', { bold: true });
  } else {
    drawRow('Due on acceptance', quote.dueOnAcceptanceTotal ?? quote.oneTimeTotal, '', { emphasis: true });
  }
  if (hasRecurring) {
    drawRow('First-period total', quote.total, '');
  }
  return y;
}

// ---------------------------------------------------------------------------
// Cover page (Task 14): a page-1 frame drawn ahead of every block when
// `quote.coverPage.enabled` — branding wordmark, a hero cover image (top ~55%
// of the page), the proposal title (24pt bold), then Prepared-for/Prepared-by
// side by side at the bottom. Always ends with doc.addPage() when it draws
// anything, so the existing header/blocks code below is unaffected — it always
// starts drawing on a fresh page at the usual y=50 origin, cover or no cover.
// ---------------------------------------------------------------------------

async function renderCoverPage(
  doc: PDFKit.PDFDocument,
  quote: QuoteHeader,
  branding: QuotePdfBranding,
  loadImage: (imageId: string) => Promise<{ data: Buffer } | null>,
  c: Cols,
): Promise<void> {
  const cp = (quote.coverPage ?? null) as CoverPage | null;
  if (!cp?.enabled) return;

  const partnerName = branding.partnerName ?? 'Proposal';
  const top = doc.page.margins.top;
  const pageBottom = doc.page.height - doc.page.margins.bottom;

  // Branding wordmark (mirrors the main document header's plain-text wordmark —
  // this renderer has no logo-image loader; logoUrl is a remote URL and the
  // renderer must stay network-free/pure).
  doc.fillColor('#111827').fontSize(16).font('Helvetica-Bold').text(partnerName, c.left, top);

  // Cover image: top ~55% of the page, full content width. A failed/absent
  // load degrades to "no image" — never aborts the document (same discipline
  // as every other image draw in this file).
  const imageTop = top + 30;
  const imageAreaHeight = doc.page.height * 0.55 - imageTop;
  let imageBottom = imageTop;
  if (cp.coverImageId) {
    let img: { data: Buffer } | null = null;
    try {
      img = await loadImage(cp.coverImageId);
    } catch (e) {
      console.error('[quotePdf] cover image load failed', cp.coverImageId, e instanceof Error ? e.message : e);
      captureException(e instanceof Error ? e : new Error(String(e)));
    }
    if (img?.data) {
      try {
        doc.image(img.data, c.left, imageTop, { fit: [c.contentWidth, imageAreaHeight] });
        imageBottom = imageTop + imageAreaHeight;
      } catch (e) {
        console.error('[quotePdf] cover doc.image failed', cp.coverImageId, e instanceof Error ? e.message : e);
      }
    }
  }

  // Title (24pt bold).
  if (cp.title?.trim()) {
    doc.fillColor('#111827').fontSize(24).font('Helvetica-Bold').text(cp.title.trim(), c.left, imageBottom + 24, { width: c.contentWidth });
  }

  // Prepared for / Prepared by, side by side at the bottom of the page.
  const rowY = pageBottom - 90;
  const colW = c.contentWidth / 2 - 12;
  const rightX = c.left + colW + 24;

  const preparedForName = cp.preparedForName ?? quote.billToName ?? null;
  if (preparedForName) {
    doc.fillColor('#9ca3af').fontSize(9).font('Helvetica-Bold').text('PREPARED FOR', c.left, rowY);
    doc.fillColor('#111827').fontSize(12).font('Helvetica-Bold').text(preparedForName, c.left, rowY + 14, { width: colW });
    let addrY = rowY + 30;
    doc.fillColor('#4b5563').fontSize(9).font('Helvetica');
    for (const line of addressLines(quote.billToAddress as BillToAddress | null)) {
      doc.text(line, c.left, addrY, { width: colW });
      addrY += 12;
    }
  }

  // showPreparedBy defaults true at the validator layer; treat anything but an
  // explicit `false` as "show" so a legacy/loosely-typed value degrades safely.
  if (cp.showPreparedBy !== false) {
    const seller = (quote.sellerSnapshot as SellerSnapshot | null) ?? null;
    doc.fillColor('#9ca3af').fontSize(9).font('Helvetica-Bold').text('PREPARED BY', rightX, rowY);
    doc.fillColor('#111827').fontSize(12).font('Helvetica-Bold').text(seller?.name ?? partnerName, rightX, rowY + 14, { width: colW });
    let addrY = rowY + 30;
    doc.fillColor('#4b5563').fontSize(9).font('Helvetica');
    for (const line of sellerAddressLines(seller)) {
      doc.text(line, rightX, addrY, { width: colW });
      addrY += 12;
    }
  }

  doc.fillColor('#111827');
  doc.addPage();
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
  // Optional so existing callers/tests compile; the route injects the real loader.
  loadCatalogImage: LoadCatalogImage = async () => null,
  // Optional so existing callers/tests compile; the route pre-fetches this via
  // contractTemplateRender.ts's loadContractPdfInputs (Task 14) and injects it
  // here so the renderer stays pure / DB-free — same discipline as loadImage
  // and loadCatalogImage above.
  contractRenderData: Map<string, ContractPdfBlockData> = new Map(),
): Promise<Buffer> {
  const currency = quote.currencyCode ?? branding.currencyCode ?? 'USD';
  const primary = hexToColor(branding.primaryColor, '#2563eb');
  const partnerName = branding.partnerName ?? 'Proposal';
  // Per-line Tax column only when this quote carries tax (mirrors the summary).
  const taxRate = quote.taxRate ? Number(quote.taxRate) : 0;
  const showTax = Number(quote.taxTotal ?? 0) > 0;

  // bufferPages keeps every page addressable until the end so the footer pass
  // can stamp "Page X of Y" — the total isn't known while content is drawn.
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (d: Buffer) => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const c = columnsFor(doc);

  // ---- Cover page (page 1, when enabled) — always ends with doc.addPage() ---
  await renderCoverPage(doc, quote, branding, loadImage, c);

  // ---- Header: partner wordmark (left) + accent PROPOSAL eyebrow + number ---
  doc.fillColor('#111827').fontSize(20).font('Helvetica-Bold').text(partnerName, c.left, 50, { width: c.contentWidth * 0.55 });
  doc.fillColor(primary).fontSize(10).font('Helvetica-Bold').text('PROPOSAL', c.left, 52, { width: c.contentWidth, align: 'right', characterSpacing: 1.5 });
  doc.fillColor('#111827').fontSize(20).font('Helvetica-Bold').text(quote.quoteNumber ?? 'Draft', c.left, 66, { width: c.contentWidth, align: 'right' });
  doc.moveTo(c.left, 100).lineTo(c.right, 100).lineWidth(2).strokeColor(primary).stroke();

  // ---- Quote title (tech-authored, e.g. "Office Network Refresh") -----------
  let y = 120;
  if (quote.title?.trim()) {
    doc.fillColor('#111827').fontSize(15).font('Helvetica-Bold').text(quote.title.trim(), c.left, y - 6, { width: c.contentWidth });
    y = doc.y + 16;
  }

  // ---- From (seller) left column; Prepared For + dates right column ---------
  const seller = (quote.sellerSnapshot as SellerSnapshot | null) ?? null;
  const rightX = c.left + c.contentWidth * 0.55;
  const rightW = c.contentWidth * 0.45;

  doc.fillColor('#9ca3af').fontSize(9).font('Helvetica-Bold').text('FROM', c.left, y);
  doc.fillColor('#111827').fontSize(12).font('Helvetica-Bold').text(seller?.name ?? partnerName, c.left, y + 12, { width: c.contentWidth * 0.5 });
  let fromY = y + 28;
  doc.fillColor('#4b5563').fontSize(10).font('Helvetica');
  for (const aline of sellerAddressLines(seller)) { doc.text(aline, c.left, fromY, { width: c.contentWidth * 0.5 }); fromY += 13; }
  doc.fillColor('#6b7280').fontSize(9);
  if (seller?.phone) { doc.text(seller.phone, c.left, fromY, { width: c.contentWidth * 0.5 }); fromY += 12; }
  if (seller?.email) { doc.text(seller.email, c.left, fromY, { width: c.contentWidth * 0.5 }); fromY += 12; }
  if (seller?.website) { doc.text(seller.website, c.left, fromY, { width: c.contentWidth * 0.5 }); fromY += 12; }

  let billY = y;
  if (quote.billToName) {
    doc.fillColor('#9ca3af').fontSize(9).font('Helvetica-Bold').text('PREPARED FOR', rightX, billY, { width: rightW });
    doc.fillColor('#111827').fontSize(12).font('Helvetica-Bold').text(quote.billToName, rightX, billY + 12, { width: rightW });
    billY += 28;
  }
  doc.fillColor('#4b5563').fontSize(10).font('Helvetica');
  for (const aline of addressLines(quote.billToAddress as BillToAddress | null)) { doc.text(aline, rightX, billY, { width: rightW }); billY += 13; }
  if (quote.billToTaxId) { doc.fillColor('#6b7280').fontSize(9).text(`Tax ID: ${quote.billToTaxId}`, rightX, billY, { width: rightW }); billY += 13; }
  doc.fillColor('#4b5563').fontSize(10).font('Helvetica');
  if (quote.issueDate) { doc.text(`Issued: ${formatDate(quote.issueDate)}`, rightX, billY, { width: rightW }); billY += 14; }
  if (quote.expiryDate) { doc.text(`Valid until: ${formatDate(quote.expiryDate)}`, rightX, billY, { width: rightW }); billY += 14; }

  y = Math.max(fromY, billY) + 20;

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
      if (html.trim()) {
        // ensureRoom reads doc.y (pdfkit's own cursor, kept accurate by every
        // draw call the renderer makes) rather than the outer `y` snapshot, so
        // it stays correct across the multiple blocks a single rich_text block
        // can expand into (paragraphs/headings/lists), not just the one
        // page-break check the outer `y` would otherwise be stale for.
        const ensureRoom = (needed: number): number => {
          y = ensureSpace(doc, doc.y, needed);
          return y;
        };
        y = renderRichTextIntoPdf(doc, html, { x: c.left, width: c.contentWidth, startY: y, ensureRoom });
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
        captureException(e instanceof Error ? e : new Error(String(e)));
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
      if (blockLines.length) {
        // Section label above the table (parity with the web document), e.g.
        // "Recurring services" / "One-time".
        const label = String((b.content as { label?: string }).label ?? '').trim();
        // The label is drawn by renderLineTable so it shares one keep-together
        // reservation with the column header and the first row, sized to that
        // row's real height. Reserving a flat minimum here instead stranded the
        // label + header at the foot of a page whenever the first row was tall.
        const showSubtotal = (b.content as { showSubtotal?: boolean }).showSubtotal === true;
        y = await renderLineTable(doc, blockLines, currency, y, loadCatalogImage, loadImage, taxRate, showTax, showSubtotal, label);
      }
    } else if (b.blockType === 'contract') {
      // contractRenderData[b.id] is pre-fetched by the route (Task 14's
      // loadContractPdfInputs) — never a DB read here, keeping the renderer pure.
      // A missing entry (render data load failed upstream, or an injected-empty
      // Map in a caller that doesn't pass one) degrades to the uploaded-marker
      // branch below rather than throwing.
      const raw = b.content && typeof b.content === 'object' && !Array.isArray(b.content) ? (b.content as Record<string, unknown>) : {};
      const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : undefined;
      const data = contractRenderData.get(b.id);
      const templateName = data?.templateName || 'Contract';
      if (data?.html) {
        // Authored: heading (template name, unless a block-level label overrides
        // it) + the substituted rich text, via the SAME renderer/pagination
        // discipline the rich_text block branch above uses.
        y = ensureSpace(doc, y, 40);
        doc.fillColor('#111827').fontSize(13).font('Helvetica-Bold').text(label ?? templateName, c.left, y, { width: c.contentWidth });
        y = doc.y + 8;
        const ensureRoom = (needed: number): number => {
          y = ensureSpace(doc, doc.y, needed);
          return y;
        };
        y = renderRichTextIntoPdf(doc, data.html, { x: c.left, width: c.contentWidth, startY: y, ensureRoom });
      } else {
        // Uploaded: pdfkit can't draw an existing PDF's pages (see pdfMerge.ts) —
        // draw a one-line marker; the route appends the uploaded PDF's own pages
        // after this document via mergeUploadedContractPdfs.
        y = ensureSpace(doc, y, 30);
        doc.fillColor('#111827').fontSize(11).font('Helvetica-Bold').text(contractUploadedMarker(templateName), c.left, y, { width: c.contentWidth });
        y = doc.y + 8;
      }
    }
  }

  // ---- Trailing default table for lines with no block ----------------------
  const orphanLines = lines.filter((l) => !l.blockId);
  if (orphanLines.length) y = await renderLineTable(doc, orphanLines, currency, y, loadCatalogImage, loadImage, taxRate, showTax);

  // ---- Recurring summary footer -------------------------------------------
  y = renderRecurringSummary(doc, quote, currency, primary, y, showTax);

  // ---- Terms & Conditions --------------------------------------------------
  if (quote.termsAndConditions) {
    y = ensureSpace(doc, y + 14, 60);
    doc.fillColor('#9ca3af').fontSize(9).font('Helvetica-Bold').text('TERMS & CONDITIONS', c.left, y); y = doc.y + 4;
    doc.fillColor('#6b7280').fontSize(9).font('Helvetica').text(quote.termsAndConditions, c.left, y, { width: c.contentWidth });
    y = doc.y;
  }

  // ---- Inline terms (content, not chrome) -----------------------------------
  // The branding footer is no longer drawn inline — it now lives in the per-page
  // footer band below, on EVERY page.
  if (quote.terms) {
    y = ensureSpace(doc, y + 14, 60);
    doc.fillColor('#9ca3af').fontSize(9).font('Helvetica').text(quote.terms, c.left, y, { width: c.contentWidth });
  }

  // ---- Per-page footer band: branding footer + quote number + page X of Y ---
  // Runs after all content so the page count is final. Bottom margin is zeroed
  // while stamping: pdfkit auto-adds a page when text lands inside the margin
  // band, which would otherwise spawn a blank trailing page per footer.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const fLeft = doc.page.margins.left;
    const fRight = doc.page.width - doc.page.margins.right;
    const fWidth = fRight - fLeft;
    const ruleY = doc.page.height - 38;
    doc.moveTo(fLeft, ruleY).lineTo(fRight, ruleY).lineWidth(0.5).strokeColor('#e5e7eb').stroke();
    doc.fillColor('#9ca3af').fontSize(7.5).font('Helvetica');
    // Left: branding footer (single line, ellipsized) or the partner wordmark.
    doc.text(branding.footer?.trim() || partnerName, fLeft, ruleY + 7, {
      width: fWidth * 0.68, height: 10, lineBreak: false, ellipsis: true,
    });
    // Right: quote number + page counter.
    doc.text(`${quote.quoteNumber ?? 'Draft'} · Page ${i + 1} of ${range.count}`, fLeft, ruleY + 7, {
      width: fWidth, align: 'right', lineBreak: false,
    });
    doc.page.margins.bottom = savedBottom;
  }

  doc.end();
  return done;
}
