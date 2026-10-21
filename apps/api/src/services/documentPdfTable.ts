/**
 * The shared PDF line table (#9414 W3a, spec §3.8): column geometry, row
 * measuring and drawing, pagination with a repeating column header, and the
 * totals box. It draws the SAME view-model types the screen renders
 * (`DocumentLineTableModel`, `DocumentTotalsModel` from `@breeze/shared/documents`),
 * so the PDF prints the strings the screen prints, in the document's language.
 *
 * Money is the one exception to "print the model's text": the PDF re-formats
 * `DocumentMoney.amount` through `formatMoneyForPdf` so a glyph pdfkit's WinAnsi
 * Helvetica cannot encode never reaches the page.
 *
 * The module owns geometry and drawing only. Each document kind's totals
 * semantics (deposit, balance, recurring) stay in its builder, and the headers
 * (invoice FROM/BILL TO, quote cover) stay with the service (OD-6).
 *
 * Callers pass the document's `PdfThemeFonts` (`registerThemeFonts`), so a
 * condensed-theme document draws its rows in the condensed face (fixes D4).
 */
import type {
  DocumentGroupHeader, DocumentLineRow, DocumentLineTableModel, DocumentMoney, DocumentTotalsModel, DocumentTotalsRow,
} from '@breeze/shared/documents';
import { formatMoneyForPdf } from './pdfMoney';
import { fitFontSize } from './pdfFitText';
import type { PdfThemeFonts } from './documentThemes';

type AnyRow = DocumentLineRow<DocumentMoney | 'exempt' | null>;

/** Fonts, language and accent a caller draws the table with. */
export interface DocumentPdfStyle {
  fonts: PdfThemeFonts;
  /** The document locale (money glyphs). */
  locale: string;
  /** Accent colour for the emphasis row. */
  accent: string;
  /** "Category: X" under a ticket group header (a document label). */
  categoryLabel: (category: string) => string;
}

export interface DocumentPdfColumns {
  left: number;
  right: number;
  contentWidth: number;
  showTax: boolean;
  /** Description column width (starts at `left`). */
  colDescW: number;
  /** UNIT PRICE / TAX / AMOUNT share one right-aligned box width. */
  colNumW: number;
  /** QTY box is narrower than the money boxes — a quantity never needs a currency's width. */
  colQtyW: number;
  colQtyX: number;
  colUnitX: number;
  /** Only drawn when `showTax`; equals colUnitX otherwise so callers need no branch. */
  colTaxX: number;
  colAmtX: number;
  /** Totals block amount box — wider than the line rows because the emphasised
   *  row draws at bold 14. */
  colSummaryNumW: number;
  colSummaryAmtX: number;
  /** Totals block label box; independent of colQtyX so "Balance due" at bold 14
   *  never wraps into the next row in the untaxed layout. */
  colSummaryLabelX: number;
  colSummaryLabelW: number;
}

/**
 * One geometry for every document. Money columns are sized for prefix-code
 * currencies (Intl renders e.g. "CHF 888'888.88" — ~73pt at Helvetica 10, wider
 * than any "$" figure): taxed layout gives unit price | tax | amount 0.155 each,
 * qty 0.08, description 0.42; untaxed gives money 0.16, qty 0.085, description
 * 0.57 (#9401). The totals block gets its own wider box (0.24) for the bold-14
 * emphasis row ("CHF 1'000'000.00" is ~113pt there). The AMOUNT column and the
 * summary box both end at the table's right edge so the figures line up.
 */
export function documentColumnsFor(doc: PDFKit.PDFDocument, opts: { showTax: boolean }): DocumentPdfColumns {
  const { showTax } = opts;
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentWidth = right - left;
  const colSummaryNumW = contentWidth * 0.24;
  const colSummaryAmtX = right - colSummaryNumW;
  const colSummaryLabelX = colSummaryAmtX - contentWidth * 0.30;
  const colSummaryLabelW = colSummaryAmtX - colSummaryLabelX - 4;
  const summary = { colSummaryNumW, colSummaryAmtX, colSummaryLabelX, colSummaryLabelW };
  if (showTax) {
    return {
      left, right, contentWidth, showTax,
      colDescW: contentWidth * 0.42,
      colNumW: contentWidth * 0.155,
      colQtyW: contentWidth * 0.08,
      colQtyX: left + contentWidth * 0.43,
      colUnitX: left + contentWidth * 0.53,
      colTaxX: left + contentWidth * 0.69,
      colAmtX: left + contentWidth * 0.845,
      ...summary,
    };
  }
  return {
    left, right, contentWidth, showTax,
    colDescW: contentWidth * 0.57,
    colNumW: contentWidth * 0.16,
    colQtyW: contentWidth * 0.085,
    colQtyX: left + contentWidth * 0.575,
    colUnitX: left + contentWidth * 0.665,
    colTaxX: left + contentWidth * 0.665,
    colAmtX: left + contentWidth * 0.84,
    ...summary,
  };
}

const INK = '#1f2937';
const MUTED = '#6b7280';
const SUB = 8.5;       // sub-line size (date, blurb, note, descriptor)
const ROW_GAP = 6;
const MIN_ROW = 12;
const COLUMN_HEADER_H = 24;

const money = (m: DocumentMoney, locale: string) => formatMoneyForPdf(m.amount, m.currency, locale);

/** Sub-lines under a row's title, in the order they are drawn. */
function subLines(row: AnyRow): string[] {
  const out: string[] = [];
  if (row.workDate) out.push(row.workDate.text);
  if (row.blurb) out.push(row.blurb);
  if (row.note) out.push(row.note);
  for (const d of row.descriptor) out.push(d);
  return out;
}

export interface MeasuredRow {
  titleHeight: number;
  /** Height of each sub-line block (already +2 padding), in `subLines` order. */
  subHeights: number[];
  descHeight: number;
  /** Vertical advance for the row, gap included. */
  rowHeight: number;
}

/**
 * Measure a row with each fragment in the font and size it is drawn with. The
 * title is drawn bold, so when its bold measure needs MORE LINES than regular
 * the bold one is used — measured regular, a long title overprinted the next row.
 */
export function measureDocumentLineRow(doc: PDFKit.PDFDocument, row: AnyRow, cols: DocumentPdfColumns, fonts: PdfThemeFonts): MeasuredRow {
  const w = cols.colDescW;
  doc.font(fonts.body.regular).fontSize(10);
  const regular = doc.heightOfString(row.title, { width: w });
  doc.font(fonts.body.bold);
  const bold = doc.heightOfString(row.title, { width: w });
  const titleHeight = bold > regular + 1 ? bold : regular;
  doc.font(fonts.body.regular).fontSize(SUB);
  const subHeights = subLines(row).map((t) => doc.heightOfString(t, { width: w }) + 2);
  const descHeight = titleHeight + subHeights.reduce((a, b) => a + b, 0);
  return { titleHeight, subHeights, descHeight, rowHeight: Math.max(descHeight, MIN_ROW) + ROW_GAP };
}

export interface RowDrawOpts { cols: DocumentPdfColumns; style: DocumentPdfStyle; showTax: boolean }

/** A money cell: single line, shrink-to-fit (pdfkit TRUNCATES an over-wide
 *  `lineBreak:false` string — a different number on a legal document). */
function moneyCell(doc: PDFKit.PDFDocument, text: string, x: number, y: number, w: number, size: number, font: string, color: string) {
  doc.font(font);
  fitFontSize(doc, text, w, size);
  doc.fillColor(color).text(text, x, y, { width: w, align: 'right', lineBreak: false });
}

/**
 * Draw one row at `y` (the caller has already broken the page if it did not
 * fit) and return the y below it. All cells share the row's baseline.
 */
export function drawDocumentLineRow(doc: PDFKit.PDFDocument, row: AnyRow, y: number, opts: RowDrawOpts, measured?: MeasuredRow): number {
  const { cols, style, showTax } = opts;
  const { fonts, locale } = style;
  const m = measured ?? measureDocumentLineRow(doc, row, cols, fonts);

  doc.fillColor(INK).fontSize(10).font(fonts.body.bold).text(row.title, cols.left, y, { width: cols.colDescW });
  let sy = y + m.titleHeight;
  const texts = subLines(row);
  texts.forEach((t, i) => {
    doc.fillColor(MUTED).fontSize(SUB).font(fonts.body.regular).text(t, cols.left, sy + 2, { width: cols.colDescW });
    sy += m.subHeights[i]!;
  });

  doc.fillColor(INK).fontSize(10).font(fonts.body.regular)
    .text(String(Number(row.qty)), cols.colQtyX, y, { width: cols.colQtyW, align: 'right', lineBreak: false });
  moneyCell(doc, money(row.unit, locale), cols.colUnitX, y, cols.colNumW, 10, fonts.body.regular, MUTED);
  if (showTax) {
    const tax = row.tax;
    const taxText = tax === 'exempt' || tax === null ? '—' : money(tax, locale);
    moneyCell(doc, taxText, cols.colTaxX, y, cols.colNumW, 10, fonts.body.regular, MUTED);
  }
  moneyCell(doc, money(row.amount, locale), cols.colAmtX, y, cols.colNumW, 10, fonts.body.regular, INK);
  doc.fillColor(INK).fontSize(10).font(fonts.body.regular);
  return y + m.rowHeight;
}

/** The shaded column-header band; returns the y below it. */
export function drawDocumentColumnHeader(doc: PDFKit.PDFDocument, table: DocumentLineTableModel, y: number, opts: RowDrawOpts): number {
  const { cols, style } = opts;
  doc.save();
  doc.rect(cols.left - 6, y - 5, cols.contentWidth + 12, 22).fill('#f8fafc');
  doc.restore();
  doc.fillColor(MUTED).fontSize(8.5).font(style.fonts.body.bold);
  const c = table.columns;
  doc.text(c.description.toUpperCase(), cols.left, y, { lineBreak: false });
  doc.text(c.qty.toUpperCase(), cols.colQtyX, y, { width: cols.colQtyW, align: 'right', lineBreak: false });
  doc.text(c.unitPrice.toUpperCase(), cols.colUnitX, y, { width: cols.colNumW, align: 'right', lineBreak: false });
  if (c.tax !== null) doc.text(c.tax.toUpperCase(), cols.colTaxX, y, { width: cols.colNumW, align: 'right', lineBreak: false });
  doc.text(c.amount.toUpperCase(), cols.colAmtX, y, { width: cols.colNumW, align: 'right', lineBreak: false });
  return y + COLUMN_HEADER_H;
}

function measureGroupHeader(doc: PDFKit.PDFDocument, header: DocumentGroupHeader, cols: DocumentPdfColumns, style: DocumentPdfStyle): number {
  if (!header) return 0;
  doc.font(style.fonts.body.bold).fontSize(9.5);
  if (header.kind === 'ticket') {
    const h = doc.heightOfString(header.title, { width: cols.colDescW });
    return header.category ? h + 14 : h + 4;
  }
  return doc.heightOfString(header.label, { width: cols.colDescW }) + 4;
}

function drawGroupHeader(doc: PDFKit.PDFDocument, header: DocumentGroupHeader, y: number, cols: DocumentPdfColumns, style: DocumentPdfStyle): number {
  if (!header) return y;
  const text = header.kind === 'ticket' ? header.title : header.label;
  doc.fillColor(INK).fontSize(9.5).font(style.fonts.body.bold).text(text, cols.left, y, { width: cols.colDescW });
  const h = doc.heightOfString(text, { width: cols.colDescW });
  if (header.kind === 'ticket' && header.category) {
    doc.fillColor(MUTED).fontSize(SUB).font(style.fonts.body.regular).text(style.categoryLabel(header.category), cols.left, y + h + 1, { width: cols.colDescW });
    return y + h + 14;
  }
  return y + h + 4;
}

const DAY_HEADER_H = 15;

/**
 * Draw the whole table from `startY` and return the y below it. Pagination:
 * a row (with the group/day header that introduces it) that will not fit moves
 * whole to the next page BEFORE any cell is drawn, so a tall row's numbers never
 * stay behind; the column header repeats at the top of every continuation page.
 * A row taller than a page is the one allowed overflow.
 */
export function drawDocumentLineTable(
  doc: PDFKit.PDFDocument,
  table: DocumentLineTableModel,
  startY: number,
  opts: { cols: DocumentPdfColumns; style: DocumentPdfStyle },
): number {
  const { cols, style } = opts;
  const rowOpts: RowDrawOpts = { cols, style, showTax: table.columns.tax !== null };
  const top = doc.page.margins.top;
  let y = drawDocumentColumnHeader(doc, table, startY, rowOpts);
  let contentTop = y;

  // Start a new page when `needed` does not fit below y; the continuation page
  // opens with the column header.
  const ensure = (needed: number) => {
    const pageBottom = doc.page.height - doc.page.margins.bottom;
    if (y > contentTop && y + needed > pageBottom) {
      doc.addPage();
      y = drawDocumentColumnHeader(doc, table, top, rowOpts);
      contentTop = y;
    }
  };

  const groups = table.groups as { key: string; header: DocumentGroupHeader; days: { key: string; header: { date: { text: string }; hours: string; total: DocumentMoney } | null; rows: AnyRow[] }[] }[];
  if (groups.every((g) => g.days.every((d) => d.rows.length === 0))) {
    if (table.emptyText) {
      doc.fillColor(MUTED).fontSize(10).font(style.fonts.body.regular).text(table.emptyText, cols.left, y, { width: cols.contentWidth });
      y = doc.y + 6;
    }
    return y;
  }

  for (const group of groups) {
    let pendingHeader: DocumentGroupHeader = group.header;
    for (const day of group.days) {
      let pendingDay = day.header;
      for (const row of day.rows) {
        const measured = measureDocumentLineRow(doc, row, cols, style.fonts);
        const headH = measureGroupHeader(doc, pendingHeader, cols, style) + (pendingDay ? DAY_HEADER_H : 0);
        ensure(headH + Math.max(measured.descHeight, MIN_ROW));
        if (pendingHeader) { y = drawGroupHeader(doc, pendingHeader, y, cols, style); pendingHeader = null; }
        if (pendingDay) {
          doc.fillColor('#4b5563').fontSize(9).font(style.fonts.body.bold)
            .text(pendingDay.date.text, cols.left, y, { width: cols.colDescW, lineBreak: false });
          doc.font(style.fonts.body.regular)
            .text(pendingDay.hours, cols.colQtyX, y, { width: cols.colQtyW, align: 'right', lineBreak: false });
          moneyCell(doc, money(pendingDay.total, style.locale), cols.colAmtX, y, cols.colNumW, 9, style.fonts.body.bold, '#4b5563');
          y += DAY_HEADER_H;
          pendingDay = null;
        }
        y = drawDocumentLineRow(doc, row, y, rowOpts, measured);
      }
    }
  }
  return y;
}

// ---------------------------------------------------------------------------
// Totals box
// ---------------------------------------------------------------------------

interface WeightStyle { size: number; font: 'regular' | 'bold'; labelColor: string; valueColor: 'ink' | 'accent'; advance: number }
const WEIGHTS: Record<DocumentTotalsRow['weight'], WeightStyle> = {
  muted:   { size: 10, font: 'regular', labelColor: MUTED, valueColor: 'ink', advance: 14 },
  regular: { size: 10, font: 'regular', labelColor: MUTED, valueColor: 'ink', advance: 14 },
  strong:  { size: 12, font: 'bold', labelColor: '#111827', valueColor: 'ink', advance: 18 },
  hero:    { size: 14, font: 'bold', labelColor: '#111827', valueColor: 'accent', advance: 20 },
};

function valueParts(row: DocumentTotalsRow, locale: string): string[] {
  const list = Array.isArray(row.value) ? row.value : [row.value];
  const parts = list.map((m) => money(m, locale));
  // The minus is a hyphen: U+2212 is not WinAnsi-encodable.
  return row.sign === 'minus' ? parts.map((p) => `-${p}`) : parts;
}

/**
 * Draw the totals box from `y` and return the y below it. The block moves whole
 * to a new page when it will not fit, so a Total is never orphaned from its
 * Subtotal. Rows advance by fixed constants, so each figure is single-line and
 * shrink-to-fit in the summary box; a value list that is too wide for one line
 * stacks, one part per line.
 */
export function drawDocumentTotals(
  doc: PDFKit.PDFDocument,
  totals: DocumentTotalsModel,
  startY: number,
  opts: { cols: DocumentPdfColumns; style: DocumentPdfStyle },
): number {
  const { cols, style } = opts;
  const { fonts, locale, accent } = style;
  const fontOf = (w: WeightStyle) => (w.font === 'bold' ? fonts.body.bold : fonts.body.regular);

  // Plan the rows first (stacking decided at the row's own font) so the block can be placed whole.
  const planned = totals.rows.map((row) => {
    const w = WEIGHTS[row.weight];
    doc.font(fontOf(w)).fontSize(w.size);
    const parts = valueParts(row, locale);
    const joined = parts.join(' + ');
    const stacked = parts.length > 1 && doc.widthOfString(joined) > cols.colSummaryNumW;
    const lines = stacked ? parts : [joined];
    const rule = row.ruleAbove === 'none' ? 0 : 10;
    return { row, w, lines, height: rule + w.advance + (lines.length - 1) * 14, rule };
  });
  const blockHeight = 14 + planned.reduce((a, p) => a + p.height, 0);
  const pageBottom = doc.page.height - doc.page.margins.bottom;
  let y = startY;
  if (y > doc.page.margins.top && y + blockHeight > pageBottom) {
    doc.addPage();
    y = doc.page.margins.top;
  }

  y += 6;
  doc.moveTo(cols.colSummaryLabelX, y).lineTo(cols.right, y).lineWidth(1).strokeColor('#e5e7eb').stroke();
  y += 8;
  for (const { row, w, lines, rule } of planned) {
    if (rule) {
      y += 2;
      doc.moveTo(cols.colSummaryLabelX, y).lineTo(cols.right, y).lineWidth(row.ruleAbove === 'accent' ? 1.5 : 1)
        .strokeColor(row.ruleAbove === 'accent' ? accent : '#e5e7eb').stroke();
      y += rule - 2;
    }
    doc.font(fontOf(w)).fontSize(w.size).fillColor(w.labelColor)
      .text(row.label, cols.colSummaryLabelX, y, { width: cols.colSummaryLabelW, align: 'left' });
    lines.forEach((text, i) => {
      doc.font(fontOf(w));
      fitFontSize(doc, text, cols.colSummaryNumW, w.size);
      doc.fillColor(w.valueColor === 'accent' ? accent : w.font === 'bold' ? '#111827' : INK)
        .text(text, cols.colSummaryAmtX, y + i * 14, { width: cols.colSummaryNumW, align: 'right', lineBreak: false });
    });
    y += w.advance + (lines.length - 1) * 14;
  }
  doc.fontSize(10).font(fonts.body.regular).fillColor(INK);
  return y;
}
