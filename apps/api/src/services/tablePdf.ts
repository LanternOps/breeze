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
// renderTableIntoPdf (drawing) is Task 9 — deliberately not implemented here.

import { quoteTableContentSchema } from '@breeze/shared';
import { measureInlineRuns } from './richTextPdf';
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

/** Pending — implemented in Task 9. */
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
 *  regular-face approximation). */
function measureCellHeight(doc: PDFKit.PDFDocument, text: string, width: number, fonts: PdfThemeFonts): number {
  const innerWidth = Math.max(0, width - 2 * CELL_PADDING);
  return measureInlineRuns(doc, text, innerWidth, BODY_FONT_SIZE, fonts.body) + 2 * CELL_PADDING;
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
      (max, col) => Math.max(max, measureCellHeight(doc, col.label, col.width, fonts)),
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
