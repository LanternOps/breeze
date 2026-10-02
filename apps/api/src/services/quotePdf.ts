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

import zlib from 'node:zlib';
import PDFDocument from 'pdfkit';
import { DEVICE_ROLE_NOUNS, toCents, fromCents, formatMoney as sharedFormatMoney, type BillableDeviceRole, type CoverPage } from '@breeze/shared';
import { formatMoneyForPdf } from './pdfMoney';
import { fitFontSize } from './pdfFitText';
import { sellerAddressLines, type SellerSnapshot, type BillToAddress } from './sellerSnapshot';
import { captureException } from './sentry';
import { renderRichTextIntoPdf, measureRichTextLead, parseRichText, WEB_TYPOGRAPHY } from './richTextPdf';
import { registerThemeFonts, pdfPageSize, type DocumentThemeId, type DocumentPageSize, type PdfThemeFonts } from './documentThemes';
import { parseTable, measureTable, renderTableIntoPdf, tableLeadHeight, type EnsureRoomRich } from './tablePdf';
import { renderCalloutIntoPdf, measureCalloutLead } from './calloutPdf';

// ---------------------------------------------------------------------------
// Formatting helpers (kept in lock-step with invoicePdf.ts conventions)
// ---------------------------------------------------------------------------

// Compatibility shim over the shared Intl-backed formatter (@breeze/shared
// `formatMoney`, #3777): kept as an export because contractTemplateRender.ts
// and routes/portal/quotes.test.ts import it from here. New code should import
// `formatMoney` from '@breeze/shared' directly. Locale precedence for PDFs:
// the document's stamped `document_locale` → branding.locale → 'en'.
export function formatMoney(amount: string | number | null | undefined, currency: string, locale?: string): string {
  return sharedFormatMoney(amount, currency, locale);
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

type DeviceSetLine = Pick<QuoteLine, 'contractLineType' | 'deviceRoles' | 'deviceGroupId' | 'deviceGroupName' | 'siteId' | 'siteName' | 'includedQuantity' | 'overageMode' | 'overageUnitPrice'>;

function deviceSetCustomerText(line: DeviceSetLine, currency: string, locale: string): string[] {
  if (!line.contractLineType || !['per_device', 'per_device_role', 'per_device_group', 'per_seat'].includes(line.contractLineType)) return [];
  let set = 'devices';
  if (line.contractLineType === 'per_device_role') {
    set = (line.deviceRoles ?? []).map((r) => DEVICE_ROLE_NOUNS[r as BillableDeviceRole] ?? r).join(', ') || 'devices';
  } else if (line.contractLineType === 'per_device_group') {
    // deviceGroupName is kept even after a retarget clears deviceGroupId (it
    // feeds the internal "re-select for this organization" drift chip) — only
    // print the stamped name on the customer document while the id it
    // describes still resolves in the current org.
    set = line.deviceGroupId ? `devices in “${line.deviceGroupName ?? ''}”` : 'devices';
  } else if (line.contractLineType === 'per_seat') {
    set = 'seats';
  }
  if (line.siteId && line.siteName) set = `${set} at ${line.siteName}`;
  const result = [`Estimated quantity — billed at the actual number of ${set} each billing period.`];
  if (line.includedQuantity != null && line.overageMode === 'bill' && line.overageUnitPrice != null) {
    result.push(`Includes ${Number(line.includedQuantity)}; additional units billed at ${formatMoneyForPdf(line.overageUnitPrice, currency, locale)} each.`);
  } else if (line.includedQuantity != null && line.overageMode === 'flag') {
    result.push(`Includes ${Number(line.includedQuantity)}; additional units are reported for review, not billed automatically.`);
  }
  return result;
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

type Rgb = [number, number, number];
const INK: Rgb = [17, 24, 39]; // #111827, the default heading/body ink
const DEFAULT_HEADING_COLOR = '#111827';

function parseHexRgb(hex: string): Rgb | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? m[1]!.split('').map((ch) => ch + ch).join('') : m[1]!;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

function contrastOnWhite(rgb: Rgb): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  return 1.05 / (lum + 0.05);
}

/** The accent prints as text (PROPOSAL eyebrow, the amount due, the
 *  AGREEMENT/TERMS labels) and as rules, bars and tints, so a light brand
 *  colour is darkened toward ink until it reaches WCAG AA (4.5:1) — the same
 *  rule report PDFs apply (paletteForBranding). A colour that already passes
 *  is returned unchanged. */
export function legibleAccent(hex: string): string {
  const rgb = parseHexRgb(hex);
  if (!rgb || contrastOnWhite(rgb) >= 4.5) return hex;
  let c: Rgb = rgb;
  for (let i = 0; i < 20 && contrastOnWhite(c) < 4.5; i++) {
    c = c.map((v, k) => v + (INK[k]! - v) * 0.12) as Rgb;
  }
  return rgbToHex(c);
}

/** A brand colour dark enough for headings (≥7:1 on white), else null. */
function brandHeadingColor(hex: string | null | undefined): string | null {
  const rgb = hex ? parseHexRgb(hex) : null;
  return rgb && contrastOnWhite(rgb) >= 7 ? hex!.trim() : null;
}

/** Whether pdfkit can draw this image without crashing the process.
 *
 *  pdfkit embeds JPEGs and opaque PNGs without decoding them, but a PNG with
 *  an alpha channel (colour types 4/6) or a tRNS transparency chunk has its
 *  pixels inflated ASYNCHRONOUSLY to split out the soft mask — after
 *  doc.image() has returned. Corrupt pixel data then throws outside every
 *  try/catch here, reaches the process's uncaughtException handler, and the
 *  document never ends. Inflate those PNGs synchronously first: if the data
 *  doesn't decompress, the caller skips the image. */
export function imageIsDrawable(data: Buffer): boolean {
  if (data.length < 8 || data.readUInt32BE(0) !== 0x89504e47) return true; // not a PNG (e.g. JPEG)
  let offset = 8;
  let colorType = -1;
  let transparency = false;
  const idat: Buffer[] = [];
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('latin1', offset + 4, offset + 8);
    const start = offset + 8;
    if (start + length > data.length) return false; // truncated chunk
    if (type === 'IHDR' && length >= 10) colorType = data[start + 9]!;
    else if (type === 'tRNS') transparency = true;
    else if (type === 'IDAT') idat.push(data.subarray(start, start + length));
    else if (type === 'IEND') break;
    offset = start + length + 4; // + CRC
  }
  if (colorType !== 4 && colorType !== 6 && !transparency) return true;
  try {
    zlib.inflateSync(Buffer.concat(idat));
    return true;
  } catch {
    return false;
  }
}

/** Load-time gate for every image this renderer draws: a buffer pdfkit would
 *  crash on (see imageIsDrawable) is reported and treated as missing. */
function drawableOrNull(img: { data: Buffer } | null, what: string): { data: Buffer } | null {
  if (!img?.data || imageIsDrawable(img.data)) return img;
  const err = new Error(`[quotePdf] undecodable PNG skipped: ${what}`);
  console.error(err.message);
  captureException(err);
  return null;
}

interface PdfLogo { data: Buffer; width: number; height: number }

/** An uploaded logo (PNG/JPEG data URL) as drawable bytes, or null. */
export function decodeLogo(logoUrl: string | null | undefined): PdfLogo | null {
  const m = logoUrl ? /^data:image\/(?:png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/i.exec(logoUrl.trim()) : null;
  if (!m) return null;
  const data = Buffer.from(m[1]!, 'base64');
  const dims = imageIntrinsicSize(data);
  if (!dims || !drawableOrNull({ data }, 'partner logo')) return null;
  return { data, ...dims };
}

/** Fit the logo in a maxW × maxH box at (x, y). Returns the drawn size, or
 *  null when pdfkit can't draw it (the caller falls back to the wordmark). */
function drawLogo(doc: PDFKit.PDFDocument, logo: PdfLogo, x: number, y: number, maxW: number, maxH: number): { width: number; height: number } | null {
  const scale = Math.min(maxW / logo.width, maxH / logo.height);
  const width = logo.width * scale;
  const height = logo.height * scale;
  try {
    doc.image(logo.data, x, y, { width, height });
    return { width, height };
  } catch (e) {
    console.error('[quotePdf] logo draw failed', e instanceof Error ? e.message : e);
    captureException(e instanceof Error ? e : new Error(String(e)));
    return null;
  }
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
  /** Uploaded logo as a PNG/JPEG data URL is drawn in the header and on the
   *  cover; anything else (e.g. an https URL) keeps the text wordmark — the
   *  renderer never fetches. */
  logoUrl?: string | null;
  primaryColor?: string | null;
  /** Headings take this colour when it reads as text on white (≥7:1). */
  secondaryColor?: string | null;
  footer?: string | null;
  currencyCode?: string | null;
  /** Render locale for money glyphs, used only when the quote carries no
   *  `document_locale` snapshot (drafts/legacy). Resolved from the partner's
   *  language by `resolvePartnerDocumentLocale`; defaults to 'en'. */
  locale?: string | null;
  // Optional so existing callers/tests compile unchanged; default classic/a4
  // when absent (registerThemeFonts/pdfPageSize both treat undefined the same
  // as an explicit 'classic'/'a4').
  theme?: DocumentThemeId;
  pageSize?: DocumentPageSize;
}

interface QuoteHeader {
  id: string;
  quoteNumber?: string | null;
  title?: string | null;
  status?: string | null;
  currencyCode?: string | null;
  /** Send-time locale snapshot (quotes.document_locale); null on drafts/legacy. */
  documentLocale?: string | null;
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
  // Even a single zero-valued recurring category is meaningful to customers.
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
  customerVisible?: boolean | null;
  itemType?: string | null;
  contractLineType?: string | null;
  deviceRoles?: string[] | null;
  deviceGroupId?: string | null;
  deviceGroupName?: string | null;
  siteId?: string | null;
  siteName?: string | null;
  includedQuantity?: string | number | null;
  overageMode?: 'bill' | 'flag' | null;
  overageUnitPrice?: string | number | null;
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

export interface QuotePdfColumns {
  left: number; right: number; contentWidth: number;
  colQtyX: number; colQtyW: number; colDescX: number; colDescW: number;
  colUnitX: number; colTaxX: number; colNumW: number; colAmtX: number; colAmtW: number;
  colSummaryAmtX: number; colSummaryNumW: number;
  showTax: boolean;
}

// When showTax is set the table carries a fifth column (qty | description | unit
// | tax | total) with 15.5%-wide money cells; the four-column layout gives each
// money cell 16%. TOTAL gets its own wider box (19%) because it is the one cell
// that renders money PLUS a recurrence suffix ("$12,000.00/mo") — sized to
// colNumW it character-wraps, and the wrapped second line overprints the next
// row (row height is measured from the description column only). The summary
// gets a 24% amount box for its 14pt emphasis figure; both it and TOTAL share
// the table's right edge so the amounts stay visually aligned.
//
// Boxes are sized for prefix-code currencies (#3777): the shared Intl
// formatter emits "CHF 888’888.88" (code + space + groupers) rather than a
// one-glyph "$", and money cells draw with lineBreak: false, so an undersized
// box overprints instead of wrapping. Measured at Helvetica 10 / Helvetica-Bold
// 14 on A4 (the narrower page) in quotePdf.test.ts; the taxed description
// column shrinks to 42% to pay for it.
export function columnsFor(doc: PDFKit.PDFDocument, showTax = false): QuotePdfColumns {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentWidth = right - left;
  const colDescX = left + contentWidth * 0.08;
  if (showTax) {
    return {
      left, right, contentWidth, showTax,
      colQtyX: left,
      colQtyW: contentWidth * 0.07,
      colDescX,
      colDescW: contentWidth * 0.42,
      colUnitX: left + contentWidth * 0.50,
      colTaxX: left + contentWidth * 0.655,
      colAmtX: left + contentWidth * 0.81,
      colNumW: contentWidth * 0.155,
      colAmtW: contentWidth * 0.19,
      colSummaryAmtX: left + contentWidth * 0.76,
      colSummaryNumW: contentWidth * 0.24,
    };
  }
  return {
    left, right, contentWidth, showTax,
    colQtyX: left,
    colQtyW: contentWidth * 0.07,
    colDescX,
    colDescW: contentWidth * 0.57,
    colUnitX: left + contentWidth * 0.65,
    colTaxX: left + contentWidth * 0.70, // unused when !showTax
    colAmtX: left + contentWidth * 0.81,
    colNumW: contentWidth * 0.16,
    colAmtW: contentWidth * 0.19,
    colSummaryAmtX: left + contentWidth * 0.76,
    colSummaryNumW: contentWidth * 0.24,
  };
}

/** CSS px → PDF pt. The web proposal sizes images (and everything else) in
 *  CSS px; a PDF point is 1/72in and a CSS px 1/96in. */
const PX_TO_PT = 0.75;
/** Web parity (quoteBlocks.tsx): images are rounded-lg with a 1px border. */
const IMAGE_RADIUS = 6;
const IMAGE_BORDER = '#e5e7eb';
const IMAGE_MAX_HEIGHT = 400;

/** Where an image block draws and how tall it is, matching the web's <img>:
 *  `content.width` is CSS px; without one the image shows at its natural
 *  size (pixels as CSS px); either way capped at the content width (the web's
 *  max-w-full). Height is capped too, so a tall portrait can't fill a page. */
function imageBlockGeometry(block: QuoteBlock, data: Buffer, contentWidth: number): { drawnWidth: number; drawnHeight: number } {
  const dims = imageIntrinsicSize(data);
  const widthPx = Number((block.content as { width?: number }).width);
  const wanted = widthPx > 0 ? widthPx * PX_TO_PT : dims ? dims.width * PX_TO_PT : contentWidth;
  const fitWidth = Math.min(wanted, contentWidth);
  if (!dims) return { drawnWidth: fitWidth, drawnHeight: IMAGE_MAX_HEIGHT };
  const scale = Math.min(fitWidth / dims.width, IMAGE_MAX_HEIGHT / dims.height);
  return { drawnWidth: dims.width * scale, drawnHeight: dims.height * scale };
}

/** Page room an image block reserves before drawing (also what a heading above
 *  it reserves to stay with it). */
function imageBlockHeight(block: QuoteBlock, data: Buffer, contentWidth: number, usableHeight: number): number {
  return Math.min(imageBlockGeometry(block, data, contentWidth).drawnHeight, usableHeight);
}

/** Minimum room every block asks for before drawing anything. */
const BLOCK_MIN_ROOM = 50;
/** Space between blocks — the web document's space-y-6 (24px). */
const BLOCK_GAP = 18;
/** Contents list: the CONTENTS label band and the gap under each entry. */
const TOC_LABEL_HEIGHT = 18;
const TOC_ROW_GAP = 5;
const TOC_PAGE_COL = 36;

/** Pricing table: header band height (labels + hairline + gap) and the space
 *  between rows, which holds the row hairline. */
const LINE_HEADER_HEIGHT = 22;
const LINE_ROW_GAP = 10;

/** Add a page if `y` is within the bottom margin band; returns the (possibly reset) y. */
function ensureSpace(doc: PDFKit.PDFDocument, y: number, needed = 40): number {
  if (y > doc.page.height - doc.page.margins.bottom - needed) {
    doc.addPage();
    return doc.page.margins.top;
  }
  return y;
}

/**
 * Intrinsic pixel dimensions of a PNG or JPEG buffer (the two formats pdfkit
 * can embed). PNG: IHDR is always the first chunk, width/height at bytes
 * 16/20. JPEG: scan marker segments for a frame header (SOF0–SOF15, minus the
 * DHT/DAC/RST family), height/width at offsets 5/7 of the segment payload.
 * Returns null for anything unparseable — callers fall back to the fit-box
 * height, trading whitespace for the guarantee that following content never
 * lands on top of the image (doc.image with explicit x/y does NOT advance
 * pdfkit's cursor, so the drawn height must be computed here).
 */
export function imageIntrinsicSize(buf: Buffer): { width: number; height: number } | null {
  try {
    if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('latin1', 12, 16) === 'IHDR') {
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf.readUInt8(off) !== 0xff) return null;
        const marker = buf.readUInt8(off + 1);
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { off += 2; continue; } // standalone markers
        const segLen = buf.readUInt16BE(off + 2);
        if (segLen < 2) return null;
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) {
          const height = buf.readUInt16BE(off + 5);
          const width = buf.readUInt16BE(off + 7);
          return width > 0 && height > 0 ? { width, height } : null;
        }
        off += 2 + segLen;
      }
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Line table: qty | description | unit | total. Right-aligned money columns,
// matching invoicePdf's table styling (uppercase grey headers, 1px rule).
// Returns the y position below the table.
// ---------------------------------------------------------------------------

const LINE_THUMB = 44;

/** Height a pricing-table row needs: bold-10 title, regular-8.5 blurb and any
 *  device-set lines, at least a thumbnail tall when the row has one. Measures
 *  each fragment at the SAME font/size it is drawn with — the blurb used to be
 *  measured while the font was still 10pt, over-reserving ~1.5pt per wrapped
 *  line (a visible gap below tall spec-list rows). */
function measureLineRow(doc: PDFKit.PDFDocument, l: QuoteLine, descW: number, fonts: PdfThemeFonts, currency: string, locale: string, hasImage: boolean) {
  // Title falls back to description for legacy lines that predate the name/description split.
  const title = (l.name ?? l.description ?? '').trim() || '—';
  const blurb = l.name ? (l.description ?? '').trim() : '';
  doc.font(fonts.body.bold).fontSize(10);
  const titleHeight = doc.heightOfString(title, { width: descW });
  doc.font(fonts.body.regular).fontSize(8.5);
  const blurbHeight = blurb ? doc.heightOfString(blurb, { width: descW, lineGap: 1 }) + 2 : 0;
  const deviceSetText = deviceSetCustomerText(l, currency, locale);
  const deviceSetHeight = deviceSetText.length
    ? deviceSetText.reduce((h, text) => h + doc.heightOfString(text, { width: descW, lineGap: 1 }) + 2, 0)
    : 0;
  return { title, blurb, titleHeight, blurbHeight, deviceSetText, rowHeight: Math.max(titleHeight + blurbHeight + deviceSetHeight, hasImage ? LINE_THUMB : 12) };
}

/** The label, column header and first row of a pricing table, which are
 *  reserved as one unit (capped at a page) — by the table itself and by a
 *  heading above it. `imageLines` holds the lines that will draw a thumbnail;
 *  any thumbnail narrows every row's description column. */
function lineTableLeadHeight(doc: PDFKit.PDFDocument, lines: QuoteLine[], label: string, fonts: PdfThemeFonts, currency: string, locale: string, showTax: boolean, imageLines: (l: QuoteLine) => boolean): number {
  const c = columnsFor(doc, showTax);
  const descW = c.colDescW - (lines.some(imageLines) ? LINE_THUMB + 8 : 0);
  const labelHeight = label ? (doc.font(fonts.heading.bold).fontSize(11).heightOfString(label, { width: c.contentWidth }) + 6) : 0;
  const first = lines[0];
  const firstRowHeight = first ? measureLineRow(doc, first, descW, fonts, currency, locale, imageLines(first)).rowHeight + LINE_ROW_GAP : 0;
  const usable = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
  return Math.min(labelHeight + LINE_HEADER_HEIGHT + firstRowHeight, usable);
}

async function renderLineTable(
  doc: PDFKit.PDFDocument,
  lines: QuoteLine[],
  currency: string,
  locale: string,
  startY: number,
  loadCatalogImage: LoadCatalogImage,
  loadQuoteImage: (imageId: string) => Promise<{ data: Buffer } | null>,
  fonts: PdfThemeFonts,
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
  const THUMB = LINE_THUMB;
  const imageByLine = new Map<string, Buffer>();
  for (const l of lines) {
    try {
      if (l.imageId) {
        const img = drawableOrNull(await loadQuoteImage(l.imageId), `line image ${l.imageId}`);
        if (img?.data) { imageByLine.set(l.id, img.data); continue; }
      }
      if (l.catalogItemId) {
        const img = drawableOrNull(await loadCatalogImage(l.catalogItemId), `catalog image ${l.catalogItemId}`);
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

  // Header row: muted uppercase labels over a hairline (web parity — the
  // portal's line table header has no fill, text-xs uppercase muted with a
  // bottom border). Extracted so it re-draws at the top of every page the
  // table spills onto — a continuation page without column headers forces the
  // reader to flip back to relearn the columns.
  const drawTableHeader = (headerY: number): number => {
    doc.fillColor('#6b7280').fontSize(8).font(fonts.heading.bold);
    const opts = { characterSpacing: 0.5 } as const;
    doc.text('QTY', c.colQtyX, headerY, { width: c.colQtyW, align: 'left', ...opts });
    doc.text('DESCRIPTION', c.colDescX, headerY, { width: c.colDescW, align: 'left', ...opts });
    doc.text('UNIT', c.colUnitX, headerY, { width: c.colNumW, align: 'right', ...opts });
    if (showTax) doc.text('TAX', c.colTaxX, headerY, { width: c.colNumW, align: 'right', ...opts });
    doc.text('TOTAL', c.colAmtX, headerY, { width: c.colAmtW, align: 'right', ...opts });
    doc.moveTo(c.left, headerY + 13).lineTo(c.right, headerY + 13).lineWidth(0.75).strokeColor('#e5e7eb').stroke();
    return headerY + LINE_HEADER_HEIGHT;
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

  const measureRow = (l: QuoteLine) => {
    const row = measureLineRow(doc, l, descW, fonts, currency, locale, imageByLine.has(l.id));
    return { ...row, img: imageByLine.get(l.id) };
  };

  // Keep the section label, the column header and the FIRST row together as one
  // unit. Reserving a flat minimum row (the old 52pt at the call site) breaks
  // whenever the first row is a tall spec list: the label + header fit the guess,
  // got drawn at the foot of the page, then the row-level break moved the row to
  // the next page and stranded them. Reserve the first row's real measured height
  // — with the same row gap the row loop asks for — capped to a page so a
  // taller-than-a-page row can't force a blank one.
  y = ensureSpace(doc, y, lineTableLeadHeight(doc, lines, label, fonts, currency, locale, showTax, (l) => imageByLine.has(l.id)));
  if (label) {
    doc.fillColor('#111827').fontSize(11).font(fonts.heading.bold).text(label, c.left, y, { width: c.contentWidth });
    y = doc.y + 6;
  }

  y = drawTableHeader(y);

  const descX = c.colDescX;
  for (const [rowIndex, l] of lines.entries()) {
    const { title, blurb, titleHeight, blurbHeight, deviceSetText, img, rowHeight } = measureRow(l);
    // Keep the whole row together: if it won't fit in the remaining page, break to
    // a fresh page (re-drawing the column header) rather than letting a long
    // description overflow into the footer band. (Old reserve was a flat 30/52pt,
    // so tall rows spilled past the bottom margin.)
    const rowY = ensureRowSpace(y, rowHeight + LINE_ROW_GAP);
    // Hairline between rows (web: row borders) — not above the first row, nor
    // at the top of a continuation page, where the column header sits.
    if (rowIndex > 0 && rowY === y) {
      doc.moveTo(c.left, y - LINE_ROW_GAP / 2).lineTo(c.right, y - LINE_ROW_GAP / 2).lineWidth(0.5).strokeColor('#f1f5f9').stroke();
    }
    y = rowY;
    doc.fillColor('#1f2937').font(fonts.body.regular).fontSize(10);
    doc.text(String(Number(l.quantity)), c.colQtyX, y, { width: c.colQtyW, align: 'left' });
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
    doc.fillColor('#1f2937').font(fonts.body.bold).fontSize(10).text(title, descX + gutter, y, { width: descW });
    if (blurb) {
      doc.fillColor('#6b7280').fontSize(8.5).font(fonts.body.regular).text(blurb, descX + gutter, y + titleHeight + 2, { width: descW, lineGap: 1 });
      doc.fillColor('#1f2937').fontSize(10);
    }
    if (deviceSetText.length) {
      let textY = y + titleHeight + blurbHeight + 2;
      for (const text of deviceSetText) {
        doc.fillColor('#6b7280').fontSize(8.5).font(fonts.body.regular).text(text, descX + gutter, textY, { width: descW, lineGap: 1 });
        textY = doc.y + 2;
      }
      doc.fillColor('#1f2937').fontSize(10);
    }
    // lineBreak: false on every money cell — row height is measured from the
    // description column only, so a wrapped amount would overprint the next
    // row. pdfkit TRUNCATES an over-wide single-line string (not a clip into
    // the gutter — "CHF 9'999'999'99" is a different number), and the boxes are
    // sized for ~1M while numeric(12,2) permits 9'999'999'999.99, so every
    // money cell shrinks its font to fit its box (#3777 review F10).
    const unitText = formatMoneyForPdf(l.unitPrice, currency, locale);
    doc.font(fonts.body.regular);
    fitFontSize(doc, unitText, c.colNumW, 10);
    // Unit price is secondary to the amount (web: muted).
    doc.fillColor('#6b7280').text(unitText, c.colUnitX, y, { width: c.colNumW, align: 'right', lineBreak: false });
    doc.fillColor('#1f2937');
    if (showTax) {
      const t = lineTax(l.lineTotal ?? Number(l.quantity) * Number(l.unitPrice), !!l.taxable, taxRate);
      const taxText = t === null ? '—' : formatMoneyForPdf(t, currency, locale);
      fitFontSize(doc, taxText, c.colNumW, 10);
      doc.fillColor('#6b7280').text(taxText, c.colTaxX, y, { width: c.colNumW, align: 'right', lineBreak: false });
      doc.fillColor('#1f2937');
    }
    const suffix = recurrenceSuffix(l.recurrence);
    const totalText = `${formatMoneyForPdf(l.lineTotal ?? Number(l.quantity) * Number(l.unitPrice), currency, locale)}${suffix}`;
    fitFontSize(doc, totalText, c.colAmtW, 10);
    doc.text(totalText, c.colAmtX, y, { width: c.colAmtW, align: 'right', lineBreak: false });
    doc.fontSize(10);
    y += rowHeight + LINE_ROW_GAP;
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
    if (lines.some((l) => l.recurrence !== 'monthly' && l.recurrence !== 'annual')) parts.push(formatMoneyForPdf(sums.one_time, currency, locale));
    if (lines.some((l) => l.recurrence === 'monthly')) parts.push(`${formatMoneyForPdf(sums.monthly, currency, locale)}/mo`);
    if (lines.some((l) => l.recurrence === 'annual')) parts.push(`${formatMoneyForPdf(sums.annual, currency, locale)}/yr`);
    if (parts.length) {
      const subtotalText = parts.join('  +  ');
      doc.font(fonts.body.bold).fontSize(9.5);
      const subtotalWidth = c.right - c.colUnitX;
      const labelWidth = doc.widthOfString('Subtotal');
      const inlineAmountWidth = subtotalWidth - labelWidth - 10;
      const stackAmount = doc.widthOfString(subtotalText) > inlineAmountWidth;
      const amountHeight = doc.heightOfString(subtotalText, { width: subtotalWidth, align: 'right' });
      const subtotalHeight = 6 + (stackAmount ? 14 + amountHeight + 6 : Math.max(12, amountHeight) + 6);
      y = ensureRowSpace(y, subtotalHeight);
      doc.moveTo(c.colUnitX, y).lineTo(c.right, y).lineWidth(0.5).strokeColor('#e5e7eb').stroke();
      y += 6;
      doc.font(fonts.body.bold).fontSize(9.5).fillColor('#374151').text('Subtotal', c.colUnitX, y, { width: c.contentWidth * 0.2, align: 'left' });
      if (stackAmount) {
        y += 14;
        doc.fillColor('#111827').text(subtotalText, c.colUnitX, y, { width: subtotalWidth, align: 'right' });
        y += amountHeight + 6;
      } else {
        const amountX = c.colUnitX + labelWidth + 10;
        doc.fillColor('#111827').text(subtotalText, amountX, y, { width: c.right - amountX, align: 'right' });
        y += Math.max(12, amountHeight) + 6;
      }
    }
  }
  return y;
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

/** Web parity (PublicQuoteView / QuoteDetailView): acceptance invoices the
 *  one-time charges only; recurring lines bill later through the contract. */
const FIRST_PERIOD_NOTE = 'Accepting this proposal bills only the one-time charges now. Recurring lines bill on their own schedule.';

function renderRecurringSummary(
  doc: PDFKit.PDFDocument,
  quote: QuoteHeader,
  currency: string,
  locale: string,
  primary: string,
  startY: number,
  fonts: PdfThemeFonts,
  showTax = false,
  recurringLines: { monthly: boolean; annual: boolean } = { monthly: false, annual: false },
  lines: QuoteLine[] = [],
): number {
  const c = columnsFor(doc, showTax);
  // Hoisted above ensureSpace so the page-break reservation can size itself to
  // the actual content drawn below.
  const breakdown = quote.categoryBreakdown ?? [];
  const depositDue = quote.depositDueTotal ?? quote.depositAmount;
  const hasDeposit = quote.depositType && quote.depositType !== 'none' && depositDue != null;
  const showMonthly = recurringLines.monthly;
  const showAnnual = recurringLines.annual;
  const showTaxRow = quote.taxTotal != null && Number(quote.taxTotal) > 0;
  const hasRecurring = recurringLines.monthly || recurringLines.annual;
  // 0.33, not 0.40: the label box ends at colSummaryAmtX (0.76 — widened for
  // prefix-code currencies, #3777), and the widest label — "Remaining balance
  // (due per terms)" at bold 12pt, ~200pt — needs the extra room. Rows advance
  // by the fixed constants below, so a wrapped label overprints the next row
  // exactly like a wrapped amount would.
  const sumX = c.left + c.contentWidth * 0.33;
  const labelX = sumX;
  const labelW = c.colSummaryAmtX - sumX - 8;
  const categoryAmountX = c.colSummaryAmtX - 60;
  const categoryAmountW = c.right - categoryAmountX;
  doc.font(fonts.body.regular).fontSize(9);
  const breakdownRows = breakdown.length > 1 ? breakdown.map((b) => {
    const label = b.category === 'other' ? 'Other' : b.category[0]!.toUpperCase() + b.category.slice(1);
    const parts: string[] = [];
    const categoryLines = lines.filter((l) => (l.itemType ?? 'other') === b.category && l.customerVisible !== false);
    const cadenceLines = categoryLines;
    if (cadenceLines.some((l) => l.recurrence !== 'monthly' && l.recurrence !== 'annual')) parts.push(formatMoneyForPdf(b.oneTimeTotal, currency, locale));
    if (cadenceLines.some((l) => l.recurrence === 'monthly')) parts.push(`${formatMoneyForPdf(b.monthlyTotal, currency, locale)}/mo`);
    if (cadenceLines.some((l) => l.recurrence === 'annual')) parts.push(`${formatMoneyForPdf(b.annualTotal, currency, locale)}/yr`);
    const amount = parts.join(' + ');
    const stacked = doc.widthOfString(amount) > categoryAmountW;
    const amountHeight = stacked ? doc.heightOfString(amount, { width: c.right - sumX, align: 'right' }) : 0;
    return { label, amount, stacked, amountHeight, height: stacked ? 12 + amountHeight + 5 : 14 };
  }) : [];

  // These advances are shared by the reservation and drawing code below. Keep
  // the arithmetic literal and exact: explicit-coordinate pdfkit text does not
  // auto-paginate, so under-reserving even one row can push the footer into the
  // bottom margin.
  const TOP_RULE_ADVANCE = 10;
  const BREAKDOWN_GAP = 5;
  const REGULAR_ROW_ADVANCE = 16;
  const BOLD_ROW_ADVANCE = 20;
  // Web parity: the amount due is text-2xl (24px → 18pt) under an accent rule.
  const EMPHASIS_ROW_ADVANCE = 26;
  const EMPHASIS_RULE_ADVANCE = 13;
  const NOTE_GAP = 2;
  // The first-period total and its note sit in a tinted box (web: rounded bg-muted p-3; padded a little tighter here).
  const PERIOD_BOX_PAD = 6;
  const PERIOD_BOX_GAP = 6;
  const rollupRows = 1 + Number(showMonthly) + Number(showAnnual) + Number(showTaxRow);
  const breakdownHeight = breakdownRows.length ? breakdownRows.reduce((total, row) => total + row.height, 0) + BREAKDOWN_GAP : 0;
  const emphasisHeight = hasDeposit
    ? BOLD_ROW_ADVANCE + EMPHASIS_ROW_ADVANCE + BOLD_ROW_ADVANCE
    : EMPHASIS_ROW_ADVANCE;
  // Under the first-period total: the same sentence the web views print, so
  // the PDF never implies the recurring amount is charged on acceptance.
  doc.font(fonts.body.regular).fontSize(8);
  const noteHeight = hasRecurring ? doc.heightOfString(FIRST_PERIOD_NOTE, { width: c.right - sumX }) + NOTE_GAP : 0;
  const periodBoxHeight = hasRecurring ? 2 * PERIOD_BOX_PAD + REGULAR_ROW_ADVANCE + noteHeight : 0;
  const needed = TOP_RULE_ADVANCE + breakdownHeight + rollupRows * REGULAR_ROW_ADVANCE +
    EMPHASIS_RULE_ADVANCE + emphasisHeight + (hasRecurring ? PERIOD_BOX_GAP + periodBoxHeight : 0);
  let y = ensureSpace(doc, startY + 6, needed);

  // Wider label column than the line table's so the emphasised "Due on
  // acceptance" figure (14pt) and the recurring labels never wrap/overlap.
  doc.moveTo(sumX, y).lineTo(c.right, y).lineWidth(1).strokeColor('#e5e7eb').stroke();
  y += TOP_RULE_ADVANCE;

  // Per-category subtotals (muted), including a lone zero-valued recurring
  // category. Drawn above the One-time/Monthly/Annual roll-up.
  if (breakdownRows.length) {
    for (const row of breakdownRows) {
      doc.font(fonts.body.regular).fontSize(9).fillColor('#9ca3af');
      doc.text(row.label, labelX, y, { width: labelW, align: 'left' });
      if (row.stacked) {
        y += 12;
        doc.text(row.amount, sumX, y, { width: c.right - sumX, align: 'right' });
        y += row.amountHeight + 5;
      } else {
        doc.text(row.amount, categoryAmountX, y, { width: categoryAmountW, align: 'right' });
        y += row.height;
      }
    }
    y += BREAKDOWN_GAP;
  }
  const drawRow = (
    label: string,
    amount: string | number | null | undefined,
    suffix: string,
    opts: { bold?: boolean; emphasis?: boolean } = {},
  ) => {
    const { bold = false, emphasis = false } = opts;
    const strong = bold || emphasis;
    const size = emphasis ? 18 : strong ? 12 : 10;
    // The emphasised label stays at 12pt beside the 18pt figure (the web uses
    // text-sm; 12pt holds up better next to the larger amount), dropped to sit
    // on the figure's baseline.
    const labelSize = emphasis ? 12 : size;
    doc.font(strong ? fonts.body.bold : fonts.body.regular).fontSize(labelSize).fillColor(strong ? '#111827' : '#6b7280');
    doc.text(label, labelX, emphasis ? y + 4 : y, { width: labelW, align: 'left' });
    doc.fontSize(size);
    // lineBreak: false — the y advances below are fixed constants shared with
    // the page-break reservation; a wrapped amount would silently break both.
    // Shrink-to-fit so a schema-maximum figure is never truncated by pdfkit.
    const amountText = `${formatMoneyForPdf(amount, currency, locale)}${suffix}`;
    fitFontSize(doc, amountText, c.colSummaryNumW, size);
    doc.fillColor(emphasis ? primary : strong ? '#111827' : '#1f2937').text(amountText, c.colSummaryAmtX, y, { width: c.colSummaryNumW, align: 'right', lineBreak: false });
    y += emphasis ? EMPHASIS_ROW_ADVANCE : strong ? BOLD_ROW_ADVANCE : REGULAR_ROW_ADVANCE;
  };

  drawRow('One-time', quote.oneTimeTotal, '');
  if (showMonthly) drawRow('Monthly', quote.monthlyRecurringTotal, '/mo');
  if (showAnnual) drawRow('Annual', quote.annualRecurringTotal, '/yr');
  if (showTaxRow) {
    drawRow(`Tax${quote.taxRate ? ` (${(Number(quote.taxRate) * 100).toFixed(2)}%)` : ''}`, quote.taxTotal, '');
  }
  // Separate the roll-up from the amount the customer pays now. The 4pt top
  // padding and 9pt bottom padding are included in EMPHASIS_RULE_ADVANCE.
  y += 4;
  doc.moveTo(sumX, y).lineTo(c.right, y).lineWidth(0.75).strokeColor(primary).stroke();
  y += 9;
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
    y += PERIOD_BOX_GAP;
    doc.save();
    doc.roundedRect(sumX - PERIOD_BOX_PAD, y, c.right - sumX + 2 * PERIOD_BOX_PAD, periodBoxHeight, 4).fill('#f3f4f6');
    doc.restore();
    y += PERIOD_BOX_PAD;
    drawRow('First-period total', quote.total, '');
    y += NOTE_GAP;
    doc.font(fonts.body.regular).fontSize(8).fillColor('#6b7280').text(FIRST_PERIOD_NOTE, sumX, y, { width: c.right - sumX });
    y = doc.y + PERIOD_BOX_PAD;
  }
  return y;
}

// ---------------------------------------------------------------------------
// Cover page (Task 14): a page-1 frame drawn ahead of every block when
// `quote.coverPage.enabled` — partner logo or wordmark, a hero cover image (top ~55%
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
  c: QuotePdfColumns,
  fonts: PdfThemeFonts,
  logo: PdfLogo | null = null,
  headingColor: string = DEFAULT_HEADING_COLOR,
): Promise<void> {
  const cp = (quote.coverPage ?? null) as CoverPage | null;
  if (!cp?.enabled) return;

  const partnerName = branding.partnerName ?? 'Proposal';
  const top = doc.page.margins.top;
  const pageBottom = doc.page.height - doc.page.margins.bottom;

  // Cover image: full-bleed page background (cover-fit, clipped to the page —
  // pdfkit's `cover` scales but does not crop). A failed/absent load degrades
  // to "no image" — never aborts the document (same discipline as every other
  // image draw in this file). Drawn FIRST so every text element paints on top.
  let hasBackground = false;
  if (cp.coverImageId) {
    let img: { data: Buffer } | null = null;
    try {
      img = drawableOrNull(await loadImage(cp.coverImageId), `cover image ${cp.coverImageId}`);
    } catch (e) {
      console.error('[quotePdf] cover image load failed', cp.coverImageId, e instanceof Error ? e.message : e);
      captureException(e instanceof Error ? e : new Error(String(e)));
    }
    if (img?.data) {
      // doc.save() must be paired with doc.restore() even when doc.image()
      // throws (e.g. a WebP blob stored before upload-time rejection shipped,
      // #3483) — otherwise the unmatched `q` graphics-state push corrupts the
      // page's content stream for every draw call after this one. restore()
      // now runs in `finally` so a failed draw still unwinds cleanly.
      doc.save();
      try {
        doc.rect(0, 0, doc.page.width, doc.page.height).clip();
        doc.image(img.data, 0, 0, { cover: [doc.page.width, doc.page.height] });
        hasBackground = true;
      } catch (e) {
        // A decode-at-draw failure must not be the one silent gap — report it
        // the same way the sibling doc.image() catches in this file do.
        console.error('[quotePdf] cover doc.image failed', cp.coverImageId, e instanceof Error ? e.message : e);
        captureException(e instanceof Error ? e : new Error(String(e)));
      } finally {
        doc.restore();
      }
    }
  }

  // Legibility scrim over arbitrary artwork: a near-opaque white band across
  // the bottom of the page carries the title + prepared-for/by (and the page
  // footer, which draws later in the same region). Skipped when there is no
  // background — plain white pages need no scrim.
  const bandTop = doc.page.height * 0.62;
  if (hasBackground) {
    doc.save();
    doc.fillOpacity(0.94);
    doc.rect(0, bandTop, doc.page.width, doc.page.height - bandTop).fill('#ffffff');
    doc.restore();
  }

  // Partner logo (an uploaded data-URL image) or, failing that, the text
  // wordmark. On a background image either sits on a translucent white pill
  // so it survives busy artwork.
  const LOGO_MAX_W = 200;
  const LOGO_MAX_H = 48;
  const logoSize = logo
    ? { width: logo.width * Math.min(LOGO_MAX_W / logo.width, LOGO_MAX_H / logo.height), height: logo.height * Math.min(LOGO_MAX_W / logo.width, LOGO_MAX_H / logo.height) }
    : null;
  if (hasBackground) {
    doc.save();
    doc.fontSize(16).font(fonts.heading.bold);
    const pillW = (logoSize?.width ?? doc.widthOfString(partnerName)) + 20;
    const pillH = (logoSize?.height ?? 18) + 16;
    doc.fillOpacity(0.85);
    doc.roundedRect(c.left - 10, top - 8, pillW, pillH, 6).fill('#ffffff');
    doc.restore();
  }
  const coverLogo = logo ? drawLogo(doc, logo, c.left, top, LOGO_MAX_W, LOGO_MAX_H) : null;
  if (!coverLogo) {
    doc.fillColor('#111827').fontSize(16).font(fonts.heading.bold).text(partnerName, c.left, top);
  }

  // Title (24pt bold): inside the bottom band on a background cover, else in
  // the classic position under the top margin.
  if (cp.title?.trim()) {
    const titleY = hasBackground ? bandTop + 28 : top + 54;
    doc.fillColor(headingColor).fontSize(24).font(fonts.heading.bold).text(cp.title.trim(), c.left, titleY, { width: c.contentWidth });
  }

  // Prepared for / Prepared by, side by side at the bottom of the page.
  const rowY = pageBottom - 90;
  const colW = c.contentWidth / 2 - 12;
  const rightX = c.left + colW + 24;

  const preparedForName = cp.preparedForName ?? quote.billToName ?? null;
  if (preparedForName) {
    doc.fillColor('#9ca3af').fontSize(9).font(fonts.heading.bold).text('PREPARED FOR', c.left, rowY);
    doc.fillColor('#111827').fontSize(12).font(fonts.heading.bold).text(preparedForName, c.left, rowY + 14, { width: colW });
    // Start the address at the name's real bottom edge (doc.y) — a name long
    // enough to wrap painted the address on top of its second line when this
    // assumed a fixed one-line name height.
    let addrY = Math.max(rowY + 30, doc.y + 4);
    doc.fillColor('#4b5563').fontSize(9).font(fonts.body.regular);
    for (const line of addressLines(quote.billToAddress as BillToAddress | null)) {
      doc.text(line, c.left, addrY, { width: colW });
      addrY += 12;
    }
  }

  // showPreparedBy defaults true at the validator layer; treat anything but an
  // explicit `false` as "show" so a legacy/loosely-typed value degrades safely.
  if (cp.showPreparedBy !== false) {
    const seller = (quote.sellerSnapshot as SellerSnapshot | null) ?? null;
    doc.fillColor('#9ca3af').fontSize(9).font(fonts.heading.bold).text('PREPARED BY', rightX, rowY);
    doc.fillColor('#111827').fontSize(12).font(fonts.heading.bold).text(seller?.name ?? partnerName, rightX, rowY + 14, { width: colW });
    let addrY = Math.max(rowY + 30, doc.y + 4); // same wrap-safe start as PREPARED FOR
    doc.fillColor('#4b5563').fontSize(9).font(fonts.body.regular);
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
  // Stamped send-time snapshot → partner-resolved branding locale → 'en'. Never
  // changes the number, only the glyphs (#3777).
  const locale = quote.documentLocale ?? branding.locale ?? 'en';
  const primary = legibleAccent(hexToColor(branding.primaryColor, '#2563eb'));
  // Brand headings only when the partner's secondary colour reads as text;
  // otherwise the classic ink, and rich-text subheads keep their own colour.
  const brandHeading = brandHeadingColor(branding.secondaryColor);
  const headingColor = brandHeading ?? DEFAULT_HEADING_COLOR;
  const logo = decodeLogo(branding.logoUrl);
  if (branding.logoUrl?.trim() && !logo) {
    // Report-PDF parity (reportBranding.ts): say why the name prints instead.
    console.warn('[quotePdf] partner logo is not an embeddable PNG/JPEG data URL; drawing the name instead', { quoteId: quote.id });
  }
  const partnerName = branding.partnerName ?? 'Proposal';
  // Per-line Tax column only when this quote carries tax (mirrors the summary).
  const taxRate = quote.taxRate ? Number(quote.taxRate) : 0;
  const showTax = Number(quote.taxTotal ?? 0) > 0;

  // bufferPages keeps every page addressable until the end so the footer pass
  // can stamp "Page X of Y" — the total isn't known while content is drawn.
  // Doc construction MUST come before registerThemeFonts — registerFont calls
  // on a not-yet-constructed PDFDocument aren't a thing pdfkit supports.
  const doc = new PDFDocument({ size: pdfPageSize(branding.pageSize ?? 'a4'), margin: 50, bufferPages: true });
  const themeId = branding.theme ?? 'classic';
  const fonts: PdfThemeFonts = registerThemeFonts(doc, themeId);
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (d: Buffer) => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const c = columnsFor(doc);

  // ---- Cover page (page 1, when enabled) — always ends with doc.addPage() ---
  await renderCoverPage(doc, quote, branding, loadImage, c, fonts, logo, headingColor);

  // ---- Header: partner logo or wordmark (left) + accent PROPOSAL eyebrow + number ---
  const headerLogo = logo ? drawLogo(doc, logo, c.left, 46, Math.min(180, c.contentWidth * 0.45), 44) : null;
  if (!headerLogo) {
    doc.fillColor('#111827').fontSize(20).font(fonts.heading.bold).text(partnerName, c.left, 50, { width: c.contentWidth * 0.55 });
  }
  doc.fillColor(primary).fontSize(10).font(fonts.heading.bold).text('PROPOSAL', c.left, 52, { width: c.contentWidth, align: 'right', characterSpacing: 1.5 });
  doc.fillColor('#111827').fontSize(20).font(fonts.heading.bold).text(quote.quoteNumber ?? 'Draft', c.left, 66, { width: c.contentWidth, align: 'right' });
  doc.moveTo(c.left, 100).lineTo(c.right, 100).lineWidth(2).strokeColor(primary).stroke();

  // ---- Quote title (tech-authored, e.g. "Office Network Refresh") -----------
  let y = 120;
  if (quote.title?.trim()) {
    doc.fillColor(headingColor).fontSize(15).font(fonts.heading.bold).text(quote.title.trim(), c.left, y - 6, { width: c.contentWidth });
    y = doc.y + 16;
  }

  // ---- From (seller) left column; Prepared For + dates right column ---------
  const seller = (quote.sellerSnapshot as SellerSnapshot | null) ?? null;
  const rightX = c.left + c.contentWidth * 0.55;
  const rightW = c.contentWidth * 0.45;

  doc.fillColor('#9ca3af').fontSize(9).font(fonts.heading.bold).text('FROM', c.left, y);
  doc.fillColor('#111827').fontSize(12).font(fonts.heading.bold).text(seller?.name ?? partnerName, c.left, y + 12, { width: c.contentWidth * 0.5 });
  let fromY = doc.y + 2;
  doc.fillColor('#4b5563').fontSize(10).font(fonts.body.regular);
  for (const aline of sellerAddressLines(seller)) {
    doc.text(aline, c.left, fromY, { width: c.contentWidth * 0.5 });
    fromY = doc.y + 1.5;
  }
  doc.fillColor('#6b7280').fontSize(9);
  if (seller?.phone) { doc.text(seller.phone, c.left, fromY, { width: c.contentWidth * 0.5 }); fromY = doc.y + 1.5; }
  if (seller?.email) { doc.text(seller.email, c.left, fromY, { width: c.contentWidth * 0.5 }); fromY = doc.y + 1.5; }
  if (seller?.website) { doc.text(seller.website, c.left, fromY, { width: c.contentWidth * 0.5 }); fromY = doc.y + 1.5; }

  let billY = y;
  if (quote.billToName) {
    doc.fillColor('#9ca3af').fontSize(9).font(fonts.heading.bold).text('PREPARED FOR', rightX, billY, { width: rightW });
    doc.fillColor('#111827').fontSize(12).font(fonts.heading.bold).text(quote.billToName, rightX, billY + 12, { width: rightW });
    billY = doc.y + 2;
  }
  doc.fillColor('#4b5563').fontSize(10).font(fonts.body.regular);
  for (const aline of addressLines(quote.billToAddress as BillToAddress | null)) {
    doc.text(aline, rightX, billY, { width: rightW });
    billY = doc.y + 1.5;
  }
  if (quote.billToTaxId) { doc.fillColor('#6b7280').fontSize(9).text(`Tax ID: ${quote.billToTaxId}`, rightX, billY, { width: rightW }); billY = doc.y + 1.5; }
  doc.fillColor('#4b5563').fontSize(10).font(fonts.body.regular);
  if (quote.issueDate) { doc.text(`Issued: ${formatDate(quote.issueDate)}`, rightX, billY, { width: rightW }); billY = doc.y + 2; }
  if (quote.expiryDate) { doc.text(`Valid until: ${formatDate(quote.expiryDate)}`, rightX, billY, { width: rightW }); billY = doc.y + 2; }

  y = Math.max(fromY, billY) + 28;
  doc.y = y;

  // Intro notes, if any (above the blocks).
  if (quote.introNotes) {
    // Web parity: text-sm at leading-relaxed (14px / 1.625 → 10.5pt).
    doc.fillColor('#4b5563').fontSize(10.5).font(fonts.body.regular);
    const introGap = Math.max(0, 1.625 * 10.5 - doc.currentLineHeight(true));
    doc.text(quote.introNotes, c.left, y, { width: c.contentWidth, lineGap: introGap });
    y = doc.y + BLOCK_GAP;
  }

  // ---- Walk blocks in sortOrder -------------------------------------------
  const sorted = [...blocks].sort((a, z) => a.sortOrder - z.sortOrder);

  // Agreements: contract blocks, drawn after the price (below), not in block
  // order. contractRenderData[b.id] is pre-fetched by the route (Task 14's
  // loadContractPdfInputs) — never a DB read here, keeping the renderer pure.
  // A missing entry (render data load failed upstream, or an injected-empty Map
  // in a caller that doesn't pass one) degrades to the uploaded marker rather
  // than throwing.
  const agreements = sorted
    .filter((b) => b.blockType === 'contract')
    .map((b) => {
      const raw = b.content && typeof b.content === 'object' && !Array.isArray(b.content) ? (b.content as Record<string, unknown>) : {};
      const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : undefined;
      const data = contractRenderData.get(b.id);
      return { label, templateName: data?.templateName || 'Contract', html: data?.html || null };
    });

  // ---- Contents: sections → pages -------------------------------------------
  // Every top-level section heading, authored agreement and the T&C get a PDF
  // bookmark (the viewer's sidebar) and a named destination. With
  // coverPage.showContents the same entries are also listed, with page numbers
  // and links, under the intro. Page numbers are only known once everything is
  // drawn, so the list's space is reserved here and filled in at the end
  // (bufferPages keeps every page writable).
  const headingText = (b: QuoteBlock) => String((b.content as { text?: string }).text ?? '').trim();
  const headingLevel = (b: QuoteBlock) => Number((b.content as { level?: number }).level ?? 1);
  const sectionLevel = Math.min(...sorted.filter((b) => b.blockType === 'heading' && headingText(b)).map(headingLevel));
  const tocTitles = [
    ...sorted.filter((b) => b.blockType === 'heading' && headingText(b) && headingLevel(b) === sectionLevel).map(headingText),
    ...agreements.filter((a) => a.html).map((a) => a.label ?? a.templateName),
    ...(quote.termsAndConditions ? ['Terms & Conditions'] : []),
  ];
  const tocEntries: { title: string; page: number; dest: string }[] = [];
  // Pages are only ever appended while drawing, so the current page is the last.
  const currentPageNumber = () => doc.bufferedPageRange().count;
  const markSection = (title: string, atY: number): void => {
    const dest = `section-${tocEntries.length + 1}`;
    doc.addNamedDestination(dest, 'XYZ', null, atY, null);
    doc.outline.addItem(title);
    tocEntries.push({ title, page: currentPageNumber(), dest });
  };
  const tocTitleWidth = c.contentWidth - TOC_PAGE_COL;
  doc.font(fonts.body.regular).fontSize(10.5);
  const tocRowHeights = tocTitles.map((t) => doc.heightOfString(t, { width: tocTitleWidth }) + TOC_ROW_GAP);
  let tocSlot: { pageIndex: number; y: number; shown: number } | null = null;
  if ((quote.coverPage as CoverPage | null)?.showContents === true && tocTitles.length > 0) {
    // The list never runs past one page: when it would, it stops after the
    // entries that fit and ends with "…and N more" (the bookmarks still list
    // every section). Drawn later onto a reserved slot, an overflowing list
    // would otherwise spill a trail of one-entry pages after the T&C.
    const pageBody = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
    const moreRowHeight = doc.heightOfString('…', { width: tocTitleWidth }) + TOC_ROW_GAP;
    const full = tocRowHeights.reduce((sum, h) => sum + h, 0);
    let shown = tocRowHeights.length;
    let rowsHeight = full;
    if (TOC_LABEL_HEIGHT + full > pageBody) {
      // Too long for any page: fill what's left of this one (or a fresh page
      // when less than half a page remains) rather than leaving it blank.
      const pageBottom = doc.page.height - doc.page.margins.bottom;
      const room = pageBottom - y >= pageBody / 2 ? pageBottom - y : pageBody;
      rowsHeight = 0;
      shown = 0;
      while (shown < tocRowHeights.length && TOC_LABEL_HEIGHT + rowsHeight + tocRowHeights[shown]! + moreRowHeight <= room) {
        rowsHeight += tocRowHeights[shown]!;
        shown++;
      }
      rowsHeight += moreRowHeight;
    }
    const tocHeight = TOC_LABEL_HEIGHT + rowsHeight;
    y = ensureSpace(doc, y, tocHeight);
    tocSlot = { pageIndex: currentPageNumber() - 1, y, shown };
    y += tocHeight + BLOCK_GAP;
  }
  // Shared by the 'table' and 'callout' branches below — both need the richer
  // {y, didBreak} contract (table redraws its header on break; callout needs
  // to know whether its chrome landed on a fresh page), unlike the plain
  // y-only ensureRoom closures the 'rich_text' branch and the agreements use.
  const ensureRoomRich: EnsureRoomRich = (needed) => {
    const before = doc.y;
    y = ensureSpace(doc, doc.y, needed);
    return { y, didBreak: doc.y !== before };
  };
  // Block images are loaded once: a heading measures the image after it (to
  // keep the two together) before the image branch draws it.
  const imageCache = new Map<string, Promise<{ data: Buffer } | null>>();
  const loadBlockImage = (imageId: string): Promise<{ data: Buffer } | null> => {
    let pending = imageCache.get(imageId);
    if (!pending) {
      // loadImage performs DB I/O and can reject; a failed fetch must degrade to
      // skip-the-image rather than escaping renderQuotePdf (which would skip
      // doc.end() and surface as a 500).
      pending = loadImage(imageId).then((img) => drawableOrNull(img, `image ${imageId}`)).catch((e) => {
        console.error('[quotePdf] loadImage failed', imageId, e instanceof Error ? e.message : e);
        captureException(e instanceof Error ? e : new Error(String(e)));
        return null;
      });
      imageCache.set(imageId, pending);
    }
    return pending;
  };
  const drawable = sorted.filter((b) => b.blockType !== 'contract');
  const usableHeight = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
  // Room the block after a heading reserves before it draws — the heading
  // asks for that much too, so it moves to the next page WITH its content
  // instead of being left as the last line of this one (Q-2026-0027 shipped
  // eight such headings). Every follower is measured the way it will reserve:
  // image, rich text, table, callout (its whole box) and pricing table (label
  // + header + first row) exactly; a following heading recurses one level so
  // "section, subsection, paragraph" holds together too.
  const headingSize = (b: QuoteBlock) => {
    const level = headingLevel(b);
    // Portal sizes: text-2xl / text-xl / text-lg (24/20/18px).
    return level <= 1 ? 18 : level === 2 ? 15 : 13.5;
  };
  const headingBlockHeight = (b: QuoteBlock) =>
    doc.fontSize(headingSize(b)).font(fonts.heading.bold).heightOfString(headingText(b), { width: c.contentWidth });
  // Every block first passes the loop's flat ensureSpace(y, BLOCK_MIN_ROOM),
  // so whatever follows a heading needs at least that much as well.
  const leadHeightOf = async (at: number, depth = 0): Promise<number> => {
    const next = visible[at];
    if (!next) return 0;
    return Math.max(BLOCK_MIN_ROOM, await ownLeadHeight(next, at, depth));
  };
  const ownLeadHeight = async (next: QuoteBlock, at: number, depth: number): Promise<number> => {
    if (next.blockType === 'heading') {
      const own = headingBlockHeight(next);
      return depth >= 1 ? own : own + BLOCK_GAP + await leadHeightOf(at + 1, depth + 1);
    }
    if (next.blockType === 'image') {
      const imageId = (next.content as { imageId?: string }).imageId;
      const img = imageId ? await loadBlockImage(imageId) : null;
      return img?.data ? imageBlockHeight(next, img.data, c.contentWidth, usableHeight) : 0;
    }
    if (next.blockType === 'rich_text') {
      const html = String((next.content as { html?: string }).html ?? '');
      return html.trim() ? measureRichTextLead(doc, html, c.contentWidth, fonts.body, WEB_TYPOGRAPHY, fonts.heading.bold) : 0;
    }
    if (next.blockType === 'table') {
      const model = parseTable(next.content, c.contentWidth);
      return model ? tableLeadHeight(measureTable(doc, model, fonts)) : 0;
    }
    if (next.blockType === 'callout') return measureCalloutLead(doc, next.content, c.contentWidth, fonts);
    if (next.blockType === 'line_items') {
      const label = String((next.content as { label?: string }).label ?? '').trim();
      const blockLines = lines.filter((l) => l.blockId === next.id);
      // Thumbnails aren't loaded yet; assume one wherever a line could have one
      // (a narrower description column only ever over-reserves).
      return lineTableLeadHeight(doc, blockLines, label, fonts, currency, locale, showTax, (l) => !!(l.imageId || l.catalogItemId));
    }
    return 0;
  };
  // Whether a block draws anything — an empty one gets no gap around it, and
  // a heading measures the next block that actually draws.
  const drawsSomething = async (b: QuoteBlock): Promise<boolean> => {
    const content = (b.content ?? {}) as Record<string, unknown>;
    if (b.blockType === 'heading') return String(content.text ?? '').trim().length > 0;
    // An empty editor saves "<p></p>": nothing visible, so it's skipped
    // rather than drawn as a blank line a heading would be kept with.
    if (b.blockType === 'rich_text') {
      return parseRichText(String(content.html ?? '')).some((rb) => rb.kind === 'table' || rb.runs.some((r) => r.text.trim().length > 0));
    }
    if (b.blockType === 'image') return typeof content.imageId === 'string' && !!(await loadBlockImage(content.imageId))?.data;
    if (b.blockType === 'line_items') return lines.some((l) => l.blockId === b.id);
    return b.blockType === 'table' || b.blockType === 'callout';
  };
  const visible: QuoteBlock[] = [];
  for (const b of drawable) if (await drawsSomething(b)) visible.push(b);
  let drewBlock = false;
  for (const [index, b] of visible.entries()) {
    if (drewBlock) y += BLOCK_GAP;
    drewBlock = true;
    y = ensureSpace(doc, y, BLOCK_MIN_ROOM);
    if (b.blockType === 'heading') {
      const level = headingLevel(b);
      const text = headingText(b);
      const size = headingSize(b);
      const headingHeight = headingBlockHeight(b) + BLOCK_GAP;
      // A follower that can't share any page with the heading (taller than
      // the page body) gets no reservation — moving the heading would only
      // strand it alone on a fresh page.
      const lead = await leadHeightOf(index + 1);
      y = ensureSpace(doc, y, headingHeight + (lead <= usableHeight - headingHeight ? lead : 0));
      if (level === sectionLevel) markSection(text, y);
      doc.fillColor(headingColor).fontSize(size).font(fonts.heading.bold).text(text, c.left, y, { width: c.contentWidth });
      y = doc.y;
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
        y = renderRichTextIntoPdf(doc, html, { x: c.left, width: c.contentWidth, startY: y, ensureRoom, fonts: fonts.body, headingColor: brandHeading ?? undefined, headingFont: fonts.heading.bold, typography: WEB_TYPOGRAPHY });
      }
    } else if (b.blockType === 'image') {
      const imageId = (b.content as { imageId?: string }).imageId;
      const img = imageId ? await loadBlockImage(imageId) : null;
      if (img?.data) {
        const { drawnWidth, drawnHeight } = imageBlockGeometry(b, img.data, c.contentWidth);
        y = ensureSpace(doc, y, imageBlockHeight(b, img.data, c.contentWidth, usableHeight));
        // Rounded corners: clip to the rounded box, then draw the hairline
        // border over the edge. save/restore stays paired even when doc.image
        // throws, so a failed draw can't leak the clip into later content.
        doc.save();
        try {
          doc.roundedRect(c.left, y, drawnWidth, drawnHeight, IMAGE_RADIUS).clip();
          doc.image(img.data, c.left, y, { width: drawnWidth, height: drawnHeight });
          doc.restore();
          doc.roundedRect(c.left, y, drawnWidth, drawnHeight, IMAGE_RADIUS).lineWidth(0.75).strokeColor(IMAGE_BORDER).stroke();
          y += drawnHeight;
        } catch (e) {
          doc.restore();
          // A corrupt/unsupported image (e.g. a WebP blob stored before
          // upload-time rejection shipped, #3483) must not abort the whole
          // document — but it must not be silent either, so report it.
          console.error('[quotePdf] doc.image failed', imageId, e instanceof Error ? e.message : e);
          captureException(e instanceof Error ? e : new Error(String(e)));
        }
        const caption = (b.content as { caption?: string }).caption;
        if (caption) {
          // Web: figcaption mt-2 text-xs muted (8px / 12px).
          doc.fillColor('#6b7280').fontSize(9).font(fonts.body.regular).text(caption, c.left, y + 6, { width: c.contentWidth });
          y = doc.y;
        }
        doc.fillColor('#111827');
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
        y = await renderLineTable(doc, blockLines, currency, locale, y, loadCatalogImage, loadImage, fonts, taxRate, showTax, showSubtotal, label);
      }
    } else if (b.blockType === 'table') {
      const model = parseTable(b.content, c.contentWidth);
      if (model) {
        const measured = measureTable(doc, model, fonts);
        y = renderTableIntoPdf(doc, measured, { x: c.left, startY: y, accent: primary, fonts, ensureRoom: ensureRoomRich });
      }
    } else if (b.blockType === 'callout') {
      y = renderCalloutIntoPdf(doc, b.content, { x: c.left, width: c.contentWidth, startY: y, accent: primary, fonts, ensureRoom: ensureRoomRich });
    }
  }

  if (drewBlock) y += BLOCK_GAP;

  // ---- Trailing default table for lines with no block ----------------------
  const orphanLines = lines.filter((l) => !l.blockId);
  if (orphanLines.length) y = await renderLineTable(doc, orphanLines, currency, locale, y, loadCatalogImage, loadImage, fonts, taxRate, showTax);

  // ---- Recurring summary footer -------------------------------------------
  y = renderRecurringSummary(doc, quote, currency, locale, primary, y, fonts, showTax, {
    monthly: lines.some((line) => line.recurrence === 'monthly'),
    annual: lines.some((line) => line.recurrence === 'annual'),
  }, lines);

  // ---- Closing terms (content, not chrome) ----------------------------------
  // Ends the proposal proper, right under the price — the portal shows it in
  // the same place, above the sign panel. The branding footer is no longer
  // drawn inline — it lives in the per-page footer band below, on EVERY page.
  if (quote.terms) {
    // Web parity (documentShell.tsx): a rule, a small TERMS label, then the
    // text at text-xs leading-relaxed (12px / 1.625 → 9pt).
    y = ensureSpace(doc, y + 18, 70);
    doc.moveTo(c.left, y).lineTo(c.right, y).lineWidth(0.5).strokeColor('#e5e7eb').stroke();
    y += 14;
    doc.fillColor('#6b7280').fontSize(8).font(fonts.heading.bold).text('TERMS', c.left, y, { width: c.contentWidth, characterSpacing: 1 });
    y = doc.y + 4;
    doc.fillColor('#6b7280').fontSize(9).font(fonts.body.regular);
    const termsGap = Math.max(0, 1.625 * 9 - doc.currentLineHeight(true));
    doc.text(quote.terms, c.left, y, { width: c.contentWidth, lineGap: termsGap });
    y = doc.y;
  }

  // ---- Agreements (computed above, with the contents) -----------------------
  // Uploaded: pdfkit can't draw an existing PDF's pages (see pdfMerge.ts), and
  // the route appends them after this whole document via
  // mergeUploadedContractPdfs. The one-line marker is a pointer, so it closes
  // the proposal here rather than sitting under another agreement's heading.
  for (const a of agreements) {
    if (a.html) continue;
    y = ensureSpace(doc, y + 14, 30);
    doc.fillColor('#111827').fontSize(11).font(fonts.heading.bold).text(contractUploadedMarker(a.templateName), c.left, y, { width: c.contentWidth });
    y = doc.y;
  }

  // Authored: an agreement is its own document, so each opens a fresh page (the
  // proposal and its price stay together ahead of it). Heading = template name
  // unless a block-level label overrides it, then the substituted rich text via
  // the same renderer/pagination discipline the rich_text block branch uses.
  let onAgreementPage = false;
  for (const a of agreements) {
    if (!a.html) continue;
    doc.addPage();
    y = doc.page.margins.top;
    markSection(a.label ?? a.templateName, y);
    doc.fillColor(primary).fontSize(9).font(fonts.heading.bold).text('AGREEMENT', c.left, y, { width: c.contentWidth, characterSpacing: 1.5 });
    y = doc.y + 4;
    doc.fillColor(headingColor).fontSize(15).font(fonts.heading.bold).text(a.label ?? a.templateName, c.left, y, { width: c.contentWidth });
    y = doc.y + 10;
    const ensureRoom = (needed: number): number => {
      y = ensureSpace(doc, doc.y, needed);
      return y;
    };
    y = renderRichTextIntoPdf(doc, a.html, { x: c.left, width: c.contentWidth, startY: y, ensureRoom, fonts: fonts.body, headingColor: brandHeading ?? undefined, headingFont: fonts.heading.bold, typography: WEB_TYPOGRAPHY });
    onAgreementPage = true;
  }

  // ---- Terms & Conditions --------------------------------------------------
  // After an authored agreement the T&C gets its own page — on the agreement's
  // last page it would read as part of that agreement.
  if (quote.termsAndConditions && onAgreementPage) {
    // Its own page, headed like the agreement pages before it.
    doc.addPage();
    y = doc.page.margins.top;
    markSection('Terms & Conditions', y);
    doc.fillColor(primary).fontSize(9).font(fonts.heading.bold).text('TERMS', c.left, y, { width: c.contentWidth, characterSpacing: 1.5 });
    y = doc.y + 4;
    doc.fillColor(headingColor).fontSize(15).font(fonts.heading.bold).text('Terms & Conditions', c.left, y, { width: c.contentWidth });
    y = doc.y + 10;
    doc.fillColor('#374151').fontSize(10).font(fonts.body.regular).text(quote.termsAndConditions, c.left, y, { width: c.contentWidth });
    y = doc.y;
  } else if (quote.termsAndConditions) {
    y = ensureSpace(doc, y + 14, 60);
    markSection('Terms & Conditions', y);
    doc.fillColor('#9ca3af').fontSize(9).font(fonts.heading.bold).text('TERMS & CONDITIONS', c.left, y); y = doc.y + 4;
    doc.fillColor('#6b7280').fontSize(9).font(fonts.body.regular).text(quote.termsAndConditions, c.left, y, { width: c.contentWidth });
    y = doc.y;
  }

  // ---- Contents list, now that every section's page is known ----------------
  if (tocSlot) {
    doc.switchToPage(tocSlot.pageIndex);
    let ty = tocSlot.y;
    doc.fillColor('#6b7280').fontSize(8).font(fonts.heading.bold).text('CONTENTS', c.left, ty, { width: c.contentWidth, characterSpacing: 1, lineBreak: false });
    ty += TOC_LABEL_HEIGHT;
    tocEntries.slice(0, tocSlot.shown).forEach((entry, i) => {
      doc.font(fonts.body.regular).fontSize(10.5).fillColor('#374151')
        .text(entry.title, c.left, ty, { width: tocTitleWidth, goTo: entry.dest });
      doc.fillColor('#6b7280')
        .text(String(entry.page), c.left + tocTitleWidth, ty, { width: TOC_PAGE_COL, align: 'right', goTo: entry.dest, lineBreak: false });
      ty += tocRowHeights[i]!;
    });
    const hidden = tocEntries.length - tocSlot.shown;
    if (hidden > 0) {
      doc.font(fonts.body.regular).fontSize(10.5).fillColor('#6b7280')
        .text(`…and ${hidden} more`, c.left, ty, { width: tocTitleWidth, lineBreak: false });
    }
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
    doc.fillColor('#9ca3af').fontSize(7.5).font(fonts.body.regular);
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
