// Callout block PDF rendering for the proposal presentation system (Task 9).
//
// A callout is a tinted, rounded-rect card with a 3pt left accent bar, an
// optional bold title, and a rich-text body — the PDF equivalent of the
// web/portal "info/accent/warn" callout component. Unlike table rows, a
// callout is never split mid-box: if its full height (title + body + padding)
// wouldn't fit even a completely fresh page, it degrades to plain rich text
// (title folded in as an <h4>) with NO tinted chrome, and lets
// renderRichTextIntoPdf's own pagination carry it across pages — the same
// "degrade before drawing, never mid-draw" discipline tablePdf.ts's
// renderTableIntoPdf uses for oversized rows.

import { quoteCalloutContentSchema } from '@breeze/shared';
import { measureRichText, measureRichTextLead, renderRichTextIntoPdf, WEB_TYPOGRAPHY } from './richTextPdf';
import type { PdfThemeFonts } from './documentThemes';
import type { EnsureRoomRich } from './tablePdf';

const CALLOUT_PAD = 12;
const CALLOUT_BAR_WIDTH = 3;
const CALLOUT_RADIUS = 6;
// Web parity (quoteBlocks.tsx / QuoteDocument.tsx): title text-sm semibold in
// the body face (14px → 10.5pt) with mb-1, body at the web rich-text size, a
// 10% tint of the variant colour (the web's accent/warn tints; its info
// callout is a neutral muted fill, which the grey tint approximates).
const TITLE_FONT_SIZE = 10.5;
const TITLE_GAP = 3;
const TITLE_COLOR = '#111827';
const TINT_ALPHA = 0.1;

const VARIANT_BASE_COLOR: Record<'info' | 'accent' | 'warn', string> = {
  info: '#6b7280',
  accent: '', // resolved from opts.accent at render time
  warn: '#d97706',
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const v = hex.replace('#', '');
  const full = v.length === 3 ? v.split('').map((c) => c + c).join('') : v;
  const num = parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(num)) return { r: 0, g: 0, b: 0 };
  return { r: (num >> 16) & 0xff, g: (num >> 8) & 0xff, b: num & 0xff };
}

function toHexByte(n: number): string {
  return clampByte(n).toString(16).padStart(2, '0');
}

/** Mix `hex` at `ratio` (0..1) over `base` — e.g. mixHex(accent, '#ffffff', 0.1)
 *  is an 8%-opacity accent tint over white, without needing pdf-lib/pdfkit
 *  alpha support (pdfkit fill colors are opaque; the tint is baked into the
 *  hex instead). */
function mixHex(hex: string, base: string, ratio: number): string {
  const a = parseHexColor(hex);
  const b = parseHexColor(base);
  const r = a.r * ratio + b.r * (1 - ratio);
  const g = a.g * ratio + b.g * (1 - ratio);
  const bl = a.b * ratio + b.b * (1 - ratio);
  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(bl)}`;
}

function barColorFor(variant: 'info' | 'accent' | 'warn', accent: string): string {
  return variant === 'accent' ? accent : VARIANT_BASE_COLOR[variant];
}

export interface RenderCalloutOpts {
  x: number;
  width: number;
  startY: number;
  /** Bar/tint color for the 'accent' variant (usually the document's
   *  branding primary color). */
  accent: string;
  fonts: PdfThemeFonts;
  /** Caller's richer page-break helper — see tablePdf.ts's EnsureRoomRich. */
  ensureRoom: EnsureRoomRich;
}

/** Draws a `callout` quote block's content (validated here against
 *  quoteCalloutContentSchema — same defense-in-depth null-on-invalid
 *  discipline as tablePdf.ts's parseTable) into `doc` starting at
 *  opts.startY. Returns the y just below the callout (box or degraded text),
 *  with no trailing gap — the block walk spaces blocks. Out-of-contract content is
 *  skipped entirely (returns opts.startY unchanged) rather than throwing. */
/** Box geometry shared by drawing and measuring. A box taller than a page
 *  degrades to plain rich text (`plainHtml`, title folded in as an h4). */
function calloutLayout(doc: PDFKit.PDFDocument, title: string | undefined, html: string, width: number, fonts: PdfThemeFonts) {
  const innerWidth = Math.max(0, width - 2 * CALLOUT_PAD - CALLOUT_BAR_WIDTH);
  doc.font(fonts.body.bold).fontSize(TITLE_FONT_SIZE);
  const titleHeight = title ? doc.heightOfString(title, { width: innerWidth }) + TITLE_GAP : 0;
  const bodyHeight = measureRichText(doc, html, innerWidth, fonts.body, WEB_TYPOGRAPHY);
  const boxHeight = titleHeight + bodyHeight + 2 * CALLOUT_PAD;
  const usablePageHeight = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
  const plainHtml = (title ? `<h4>${escapeHtml(title)}</h4>` : '') + html;
  return { innerWidth, boxHeight, degrades: boxHeight > usablePageHeight, plainHtml };
}

/** Room a callout asks for before it draws anything: its whole box (a box
 *  never splits), or — when it degrades to plain text — that text's first
 *  block. quotePdf reserves this under a heading so the two stay together. */
export function measureCalloutLead(doc: PDFKit.PDFDocument, content: unknown, width: number, fonts: PdfThemeFonts): number {
  const parsed = quoteCalloutContentSchema.safeParse(content);
  if (!parsed.success) return 0;
  const layout = calloutLayout(doc, parsed.data.title, parsed.data.html, width, fonts);
  return layout.degrades
    ? measureRichTextLead(doc, layout.plainHtml, width, fonts.body, WEB_TYPOGRAPHY)
    : layout.boxHeight;
}

export function renderCalloutIntoPdf(doc: PDFKit.PDFDocument, content: unknown, opts: RenderCalloutOpts): number {
  const parsed = quoteCalloutContentSchema.safeParse(content);
  if (!parsed.success) return opts.startY;
  const { variant, title, html } = parsed.data;
  const { x, width, fonts, accent } = opts;
  const { innerWidth, boxHeight, degrades, plainHtml } = calloutLayout(doc, title, html, width, fonts);

  if (degrades) {
    // Degrade before drawing: plain rich text (title folded in as a heading),
    // no tinted chrome, in the same web typography as the boxed body.
    // renderRichTextIntoPdf paginates itself, so this can legitimately span
    // multiple pages without looping.
    const ensureRoomPlain = (needed: number): number => opts.ensureRoom(needed).y;
    return renderRichTextIntoPdf(doc, plainHtml, { x, width, startY: opts.startY, ensureRoom: ensureRoomPlain, fonts: fonts.body, typography: WEB_TYPOGRAPHY });
  }

  // Resync doc.y to our own tracked position before the page-break decision —
  // ensureRoom's underlying implementation (quotePdf.ts's ensureRoomRich)
  // reads pdfkit's OWN doc.y cursor, which may be trailing opts.startY by
  // whatever gap the block walk added before this block (BLOCK_GAP isn't drawn
  // as text, so doc.y sits short of the outer y the walk advanced to). See renderTableIntoPdf in
  // tablePdf.ts for the same fix against the same class of staleness.
  doc.y = opts.startY;
  const room = opts.ensureRoom(boxHeight);
  const y = room.y;
  const barColor = barColorFor(variant, accent);
  const tint = mixHex(barColor, '#ffffff', TINT_ALPHA);

  doc.save();
  doc.roundedRect(x, y, width, boxHeight, CALLOUT_RADIUS).fill(tint);
  doc.restore();
  doc.save();
  doc.rect(x, y, CALLOUT_BAR_WIDTH, boxHeight).fill(barColor);
  doc.restore();

  const textX = x + CALLOUT_PAD + CALLOUT_BAR_WIDTH;
  const textWidth = innerWidth;
  let cy = y + CALLOUT_PAD;
  if (title) {
    doc.font(fonts.body.bold).fontSize(TITLE_FONT_SIZE).fillColor(TITLE_COLOR).text(title, textX, cy, { width: textWidth });
    cy = doc.y + TITLE_GAP;
  }
  // The box height already reserves exactly titleHeight + bodyHeight + padding
  // via opts.ensureRoom(boxHeight) above, so the body never needs a REAL page
  // break — this inner ensureRoom is a no-op that just echoes doc.y back.
  renderRichTextIntoPdf(doc, html, { x: textX, width: textWidth, startY: cy, ensureRoom: () => doc.y, fonts: fonts.body, typography: WEB_TYPOGRAPHY });
  doc.fillColor(TITLE_COLOR);

  return y + boxHeight;
}
