// Table block PDF support for the proposal presentation system (Task 8).
//
// Two pure-ish exports:
//  - parseTable(content, availableWidth): validates `content` against Task 2's
//    quoteTableContentSchema (safeParse → null on out-of-contract input, never
//    throws) and distributes column widths by weight over availableWidth.
//    No PDF involved — pure data transform, unit-testable without a doc.
//  - measureTable(doc, model, fonts): fills in header/row heights using a real
//    PDFDocument for text metrics (Task 7's measureInlineRuns), restoring the
//    doc's font state before returning.
//
// renderTableIntoPdf (drawing, Task 9) draws a measured TableModel with:
//  - header repetition on every page the table spills onto (mirrors
//    renderLineTable's drawTableHeader/ensureRowSpace pattern in quotePdf.ts),
//  - a per-row "does the WHOLE row fit on a fresh page" degrade check BEFORE
//    drawing (never mid-row) — rows never split, so a row taller than a full
//    usable page degrades to a stacked "label: value" paragraph via
//    renderRichTextIntoPdf, which paginates itself,
//  - zebra striping and accent/plain header fills.

import { quoteTableContentSchema } from '@breeze/shared';
import { measureInlineRuns, renderInlineRunsIntoPdf, renderRichTextIntoPdf } from './richTextPdf';
import type { PdfThemeFonts } from './documentThemes';

export const MIN_COLUMN_WIDTH = 40;
export const CELL_PADDING = 6;
const BODY_FONT_SIZE = 10;

export interface TableModel {
  columns: { label: string; align: 'left' | 'center' | 'right'; width: number }[];
  rows: { cells: string[]; height: number }[];
  headerHeight: number;
  caption?: string;
  zebra: boolean;
  headerStyle: 'accent' | 'plain';
}

/** Richer page-break contract than quotePdf.ts's plain `ensureSpace` (which
 *  only returns the possibly-reset y): callers that need to redraw a table
 *  header after a page break (renderTableIntoPdf) or know whether a callout's
 *  chrome landed on a fresh page also need the `didBreak` signal. */
export interface EnsureRoomRich {
  (needed: number): { y: number; didBreak: boolean };
}

/** doc._font / doc._fontSize aren't part of pdfkit's public TS surface, but
 *  they're exactly what doc.font()/doc.fontSize() mutate — save/restore them
 *  directly so measuring never leaks a font change into the caller's doc.
 *  Mirrors the same pattern in richTextPdf.ts. */
interface PdfDocFontState {
  _font: unknown;
  _fontSize: number;
}

function saveFontState(doc: PDFKit.PDFDocument): PdfDocFontState {
  const d = doc as unknown as PdfDocFontState;
  return { _font: d._font, _fontSize: d._fontSize };
}

function restoreFontState(doc: PDFKit.PDFDocument, saved: PdfDocFontState): void {
  const d = doc as unknown as PdfDocFontState;
  d._font = saved._font;
  d._fontSize = saved._fontSize;
}

/** Distribute `availableWidth` across columns proportionally to their weight
 *  (default 1), then bump any column under MIN_COLUMN_WIDTH up to the floor.
 *  The floor deliberately does not re-balance the columns it didn't touch —
 *  extreme configurations (e.g. 8 skinny columns at a narrow width) may sum
 *  to more than availableWidth; layout simply overflows in that case, same
 *  as any other fixed-width table with too many columns. */
function distributeColumnWidths(weights: number[], availableWidth: number): number[] {
  const totalWeight = weights.reduce((sum, w) => sum + w, 0) || weights.length;
  const raw = weights.map((w) => (availableWidth * w) / totalWeight);
  return raw.map((w) => Math.max(MIN_COLUMN_WIDTH, Math.round(w)));
}

/** Validate `content` against the same Zod shape the write path enforces
 *  (quoteTableContentSchema) and turn it into a TableModel with column widths
 *  distributed by weight over availableWidth. Returns null — never throws —
 *  on out-of-contract input, so callers can skip rendering a malformed table
 *  block rather than crashing PDF generation. Row/header heights are left at
 *  0 here; measureTable fills them in (this function never touches a doc). */
export function parseTable(content: unknown, availableWidth: number): TableModel | null {
  const parsed = quoteTableContentSchema.safeParse(content);
  if (!parsed.success) return null;
  const data = parsed.data;

  const weights = data.columns.map((c) => c.weight ?? 1);
  const widths = distributeColumnWidths(weights, availableWidth);

  const columns = data.columns.map((c, i) => ({
    label: c.label,
    align: c.align ?? ('left' as const),
    width: widths[i]!,
  }));

  const rows = data.rows.map((r) => ({ cells: r.cells, height: 0 }));

  return {
    columns,
    rows,
    headerHeight: 0,
    ...(data.caption !== undefined ? { caption: data.caption } : {}),
    zebra: data.zebra ?? false,
    headerStyle: data.headerStyle ?? 'accent',
  };
}

/** Height a single cell/header value occupies at BODY_FONT_SIZE within
 *  `width` minus 2x CELL_PADDING, via Task 7's per-run measurer (so a
 *  bold-heavy cell measures at its actual bold glyph widths, not a flattened
 *  regular-face approximation). `forceBold` must match whatever the paired
 *  draw call passes to renderInlineRunsIntoPdf — header cells are always
 *  drawn bold (see drawHeader below), so they must also be MEASURED bold: a
 *  themed bold face can have taller line metrics than its regular face,
 *  under-measuring the header height otherwise. */
function measureCellHeight(doc: PDFKit.PDFDocument, text: string, width: number, fonts: PdfThemeFonts, forceBold = false): number {
  const innerWidth = Math.max(0, width - 2 * CELL_PADDING);
  return measureInlineRuns(doc, text, innerWidth, BODY_FONT_SIZE, fonts.body, forceBold) + 2 * CELL_PADDING;
}

/** Fill in `model.headerHeight` and every row's `height` (max cell height in
 *  that row/header, including padding) by measuring each cell's HTML at
 *  BODY_FONT_SIZE against its column's width. Returns a new TableModel (does
 *  not mutate the input) — doc font state is saved/restored, matching
 *  measureRichText/measureInlineRuns's own contract. */
export function measureTable(doc: PDFKit.PDFDocument, model: TableModel, fonts: PdfThemeFonts): TableModel {
  const saved = saveFontState(doc);
  try {
    const headerHeight = model.columns.reduce(
      (max, col) => Math.max(max, measureCellHeight(doc, col.label, col.width, fonts, true)),
      0,
    );

    const rows = model.rows.map((row) => {
      const height = row.cells.reduce((max, cell, i) => {
        const col = model.columns[i];
        if (!col) return max;
        return Math.max(max, measureCellHeight(doc, cell, col.width, fonts));
      }, 0);
      return { cells: row.cells, height };
    });

    return { ...model, headerHeight, rows };
  } finally {
    restoreFontState(doc, saved);
  }
}

// ---------------------------------------------------------------------------
// Rendering (Task 9)
// ---------------------------------------------------------------------------

const ZEBRA_FILL = '#f8fafc';
const PLAIN_HEADER_FILL = '#f1f5f9';
const HEADER_TEXT_ON_ACCENT = '#ffffff';
const HEADER_TEXT_ON_PLAIN = '#111827';
const BODY_TEXT_COLOR = '#1f2937';
const BODY_FONT_SIZE_DRAW = 10;

export interface RenderTableOpts {
  x: number;
  startY: number;
  /** Table header fill when headerStyle === 'accent' (usually the document's
   *  branding primary color); the degrade path's rich-text isn't affected. */
  accent: string;
  fonts: PdfThemeFonts;
  /** Caller's page-break helper — see EnsureRoomRich above. quotePdf.ts's
   *  block-walk branch wires this to its own ensureSpace. */
  ensureRoom: EnsureRoomRich;
}

/** Draws a measured TableModel (see measureTable) into `doc` starting at
 *  opts.startY. Returns the new y cursor, matching every other quotePdf
 *  block-type branch's convention (gap-after-block included).
 *
 *  Header repeats on every page the table spans (ensureRoom's `didBreak`
 *  signal). Rows never split: a row that would still overflow a FRESH page
 *  (row.height > usable page height - header height) degrades BEFORE
 *  drawing to a stacked "label: value" paragraph per cell via
 *  renderRichTextIntoPdf, which paginates itself — this can never loop,
 *  since the degrade branch always advances past the row (draws it via
 *  richtext, `continue`s) rather than re-attempting ensureRoom(row.height). */
export function renderTableIntoPdf(doc: PDFKit.PDFDocument, model: TableModel, opts: RenderTableOpts): number {
  const { x, fonts, accent, ensureRoom } = opts;
  const totalWidth = model.columns.reduce((sum, col) => sum + col.width, 0);
  const usablePageHeight = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;

  const drawHeader = (atY: number): void => {
    doc.save();
    const fill = model.headerStyle === 'accent' ? accent : PLAIN_HEADER_FILL;
    doc.rect(x, atY, totalWidth, model.headerHeight).fill(fill);
    doc.restore();
    const textColor = model.headerStyle === 'accent' ? HEADER_TEXT_ON_ACCENT : HEADER_TEXT_ON_PLAIN;
    let cx = x;
    for (const col of model.columns) {
      // col.label is already-sanitized inline HTML (quoteService.ts's
      // sanitizeTableContent runs it through the inline profile on both
      // write and read) — draw it AS HTML, not escaped-then-wrapped: the
      // previous `<strong>${escapeHtml(label)}</strong>` treatment escaped
      // any real <strong>/<em>/<u>/<a> tags already in the label into
      // literal visible text. forceBold=true keeps every header cell bold
      // regardless of the label's own formatting, matching measureCellHeight's
      // forceBold=true above.
      renderInlineRunsIntoPdf(
        doc,
        col.label,
        cx + CELL_PADDING,
        atY + CELL_PADDING,
        Math.max(0, col.width - 2 * CELL_PADDING),
        BODY_FONT_SIZE_DRAW,
        fonts.body,
        col.align,
        textColor,
        true,
      );
      cx += col.width;
    }
  };

  const drawRow = (cells: string[], atY: number, height: number, zebraFill: string | null): void => {
    if (zebraFill) {
      doc.save();
      doc.rect(x, atY, totalWidth, height).fill(zebraFill);
      doc.restore();
    }
    let cx = x;
    model.columns.forEach((col, i) => {
      renderInlineRunsIntoPdf(
        doc,
        cells[i] ?? '',
        cx + CELL_PADDING,
        atY + CELL_PADDING,
        Math.max(0, col.width - 2 * CELL_PADDING),
        BODY_FONT_SIZE_DRAW,
        fonts.body,
        col.align,
        BODY_TEXT_COLOR,
      );
      cx += col.width;
    });
  };

  // ensureRoom's underlying implementation (quotePdf.ts's ensureRoomRich)
  // bases its page-break decision on doc.y — pdfkit's OWN cursor — not on any
  // y this function tracks itself. That cursor gets clobbered by every
  // doc.text() call drawHeader/drawRow make (one per COLUMN), so after
  // drawing a row it's left wherever the LAST-drawn column's cell ended, not
  // at this row's true bottom (`y + row.height`). Since row height is the MAX
  // across cells, whenever the last-drawn (highest-index) column's cell is
  // SHORTER than another column's in the same row, ensureRoom's next call
  // would silently substitute that stale, too-small doc.y as the next row's
  // start — collapsing rows on top of each other. Explicitly resyncing
  // doc.y = y immediately before every ensureRoom call (mirroring
  // renderRichTextIntoPdf's own `doc.y = opts.startY` on entry) keeps
  // ensureRoom's decision — and its returned y — anchored to the position
  // THIS function actually tracks.
  doc.y = opts.startY;
  const headerRoom = ensureRoom(model.headerHeight);
  let y = headerRoom.y;
  drawHeader(y);
  y += model.headerHeight;

  model.rows.forEach((row, i) => {
    doc.y = y;
    const rowRoom = ensureRoom(row.height);
    y = rowRoom.y;
    if (rowRoom.didBreak) {
      drawHeader(y);
      y += model.headerHeight;
    }

    // Degrade BEFORE drawing: a row that wouldn't fit a completely fresh page
    // (net of the header it must share the page with) would otherwise loop
    // ensureRoom forever trying to find room that doesn't exist.
    if (row.height > usablePageHeight - model.headerHeight) {
      model.columns.forEach((col, idx) => {
        const cellHtml = row.cells[idx] ?? '';
        // col.label is already-sanitized inline HTML (see drawHeader above) —
        // concatenate it raw, not escaped, so any real formatting tags in the
        // label draw as formatting rather than literal text. The `<strong>`
        // wrapper here only needs to survive nesting a label that may already
        // contain its own <strong>/<em>/etc., which the tokenizer handles fine.
        const html = `<strong>${col.label}:</strong> ${cellHtml}`;
        const numberAdapter = (needed: number): number => ensureRoom(needed).y;
        y = renderRichTextIntoPdf(doc, html, { x, width: totalWidth, startY: y, ensureRoom: numberAdapter, fonts: fonts.body });
      });
      return;
    }

    drawRow(row.cells, y, row.height, model.zebra && i % 2 === 1 ? ZEBRA_FILL : null);
    y += row.height;
  });

  return y + 6;
}
