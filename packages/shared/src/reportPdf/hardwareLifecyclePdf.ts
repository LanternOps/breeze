/**
 * Hardware Lifecycle report PDF — the customer-facing device replacement plan,
 * ported from the LanternOps portal generator onto the Breeze report design
 * system (header band, footer, title block, section headings come in through
 * `chrome` so this module never imports reportPdf.ts back).
 *
 * Pure rendering over the persisted `HardwareLifecycleSummary` snapshot: every
 * band, count and recommendation was computed at generation time by the
 * shared rules, so an old snapshot re-renders identically. Prose here is
 * re-derived from the rows with the same shared helpers only because a
 * sentence is not worth persisting.
 */
import type { jsPDF } from 'jspdf';
import autoTable, { type CellHookData } from 'jspdf-autotable';
import type {
  HardwareLifecycleDeviceRow,
  HardwareLifecycleSummary,
  ReplacementStatus,
} from '../types/hardwareLifecycleReport';
import {
  buildAtAGlanceProse,
  buildOsProse,
  countByReplacement,
  humanJoin,
  monthYear,
  REPLACEMENT_BAND_DESCRIPTIONS,
  REPLACEMENT_LABELS,
  REPLACEMENT_STATUS_ORDER,
  replaceByLabel,
} from '../utils/hardwareLifecycle';

type RGB = [number, number, number];

/** The pieces of reportPdf.ts's design system this renderer needs. */
export type PdfChrome = {
  C: {
    ink: RGB; primary: RGB; success: RGB; danger: RGB; warning: RGB;
    muted: RGB; faint: RGB; rule: RGB; zebra: RGB; panel: RGB; white: RGB;
  };
  PAGE: { w: number; h: number; mx: number; bandH: number; footY: number };
  drawHeaderBand: (doc: jsPDF) => void;
  drawFooter: (doc: jsPDF) => void;
  drawTitleBlock: (doc: jsPDF, title: string, subtitle: string, meta: string, top: number) => number;
  drawSectionHeading: (doc: jsPDF, text: string, y: number) => number;
};

export type HardwareLifecyclePdfOpts = {
  generatedAt: string;
  partnerName: string | null;
};

const fill = (doc: jsPDF, c: RGB) => doc.setFillColor(c[0], c[1], c[2]);
const stroke = (doc: jsPDF, c: RGB) => doc.setDrawColor(c[0], c[1], c[2]);
const ink = (doc: jsPDF, c: RGB) => doc.setTextColor(c[0], c[1], c[2]);

function bandColors(C: PdfChrome['C']): Record<ReplacementStatus, RGB> {
  return { supported: C.success, due_soon: C.warning, replace: C.danger, unknown: C.faint };
}

type Col = { key: string; label: string; w: number; halign: 'left' | 'right' | 'center' };
const COLUMNS: Col[] = [
  { key: 'name', label: 'Device', w: 34, halign: 'left' },
  { key: 'manufacturer', label: 'Make', w: 22, halign: 'left' },
  { key: 'model', label: 'Model', w: 32, halign: 'left' },
  { key: 'serialNumber', label: 'Serial', w: 26, halign: 'left' },
  { key: 'os', label: 'Operating system', w: 36, halign: 'left' },
  { key: 'ageYears', label: 'Age (yrs)', w: 14, halign: 'right' },
  { key: 'purchaseDate', label: 'Purchased', w: 18, halign: 'left' },
  { key: 'warrantyEndDate', label: 'Warranty', w: 18, halign: 'left' },
  { key: 'replacement', label: 'Status', w: 22, halign: 'left' },
  { key: 'replaceBy', label: 'Replace by', w: 18, halign: 'left' },
  { key: 'lifeUsed', label: 'Life used', w: 29, halign: 'center' },
];
const LIFE_COL = COLUMNS.findIndex((c) => c.key === 'lifeUsed');
const STATUS_COL = COLUMNS.findIndex((c) => c.key === 'replacement');
const OS_COL = COLUMNS.findIndex((c) => c.key === 'os');

function truncate(value: string | null | undefined, limit: number): string {
  const v = value ?? '';
  return v.length > limit ? `${v.slice(0, limit - 1)}…` : v;
}

function cellText(row: HardwareLifecycleDeviceRow, key: string, today: string): string {
  switch (key) {
    case 'name': return truncate(row.name, 24);
    case 'manufacturer': return truncate(row.manufacturer, 14);
    case 'model': return truncate(row.model, 22);
    case 'serialNumber': return truncate(row.serialNumber, 18);
    case 'os': return truncate(row.os, 26);
    case 'ageYears': return row.ageYears != null && row.ageYears > 0 ? row.ageYears.toFixed(1) : '';
    case 'purchaseDate': return row.purchaseDate ? `${monthYear(row.purchaseDate)}${row.purchaseDateSource === 'vendor' ? '*' : ''}` : '';
    case 'warrantyEndDate': return monthYear(row.warrantyEndDate);
    case 'replacement': return REPLACEMENT_LABELS[row.replacement] ?? '';
    case 'replaceBy': return replaceByLabel(row.replaceBy, today);
    case 'lifeUsed': return '';
    default: return '';
  }
}

function wrapText(doc: jsPDF, text: string, width: number): string[] {
  return doc.splitTextToSize(text, width) as string[];
}

/** Wrapped body paragraph; returns the y below it. */
function drawProse(doc: jsPDF, chrome: PdfChrome, text: string, y: number, size = 9.5): number {
  const { C, PAGE } = chrome;
  const width = PAGE.w - PAGE.mx * 2;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(size);
  ink(doc, C.ink);
  const lines = wrapText(doc, text, width);
  const lineH = size * 0.5;
  lines.forEach((line, i) => doc.text(line, PAGE.mx, y + i * lineH));
  return y + lines.length * lineH + 1.5;
}

function drawFleetBar(doc: jsPDF, chrome: PdfChrome, counts: Record<ReplacementStatus, number>, y: number): number {
  const { C, PAGE } = chrome;
  const colors = bandColors(C);
  const total = REPLACEMENT_STATUS_ORDER.reduce((a, s) => a + (counts[s] ?? 0), 0);
  const width = PAGE.w - PAGE.mx * 2;
  const barH = 4.5;
  if (total > 0) {
    const visible = REPLACEMENT_STATUS_ORDER.filter((s) => (counts[s] ?? 0) > 0);
    const gap = 0.6;
    const usable = width - gap * (visible.length - 1);
    let x = PAGE.mx;
    for (const s of visible) {
      const w = usable * ((counts[s] ?? 0) / total);
      fill(doc, colors[s]);
      doc.roundedRect(x, y, w, barH, 0.8, 0.8, 'F');
      x += w + gap;
    }
  } else {
    fill(doc, C.rule);
    doc.roundedRect(PAGE.mx, y, width, barH, 0.8, 0.8, 'F');
  }
  // Legend under the bar: "● 4 Replace now (past due)".
  let ly = y + barH + 4.2;
  doc.setFontSize(8);
  let x = PAGE.mx;
  for (const s of REPLACEMENT_STATUS_ORDER) {
    const n = counts[s] ?? 0;
    if (n === 0) continue;
    fill(doc, colors[s]);
    doc.circle(x + 1.1, ly - 1.1, 1.1, 'F');
    x += 3.4;
    doc.setFont('helvetica', 'bold');
    ink(doc, C.ink);
    const lead = `${n} ${REPLACEMENT_LABELS[s]}`;
    doc.text(lead, x, ly);
    x += doc.getTextWidth(lead) + 1;
    doc.setFont('helvetica', 'normal');
    ink(doc, C.muted);
    const tail = `(${REPLACEMENT_BAND_DESCRIPTIONS[s]})`;
    doc.text(tail, x, ly);
    x += doc.getTextWidth(tail) + 6;
  }
  ly += 2.5;
  return ly;
}

function ensureSpace(doc: jsPDF, chrome: PdfChrome, y: number, needed: number): number {
  if (y + needed <= chrome.PAGE.footY - 6) return y;
  doc.addPage();
  chrome.drawHeaderBand(doc);
  chrome.drawFooter(doc);
  return chrome.PAGE.bandH + 10;
}

export function renderHardwareLifecycleReport(
  doc: jsPDF,
  summary: HardwareLifecycleSummary,
  opts: HardwareLifecyclePdfOpts,
  chrome: PdfChrome,
): void {
  const { C, PAGE } = chrome;
  const rows = Array.isArray(summary.rows) ? summary.rows : [];
  const other = Array.isArray(summary.other) ? summary.other : [];
  const today = (summary.generatedAt ?? new Date().toISOString()).slice(0, 10);
  const replaceAge = summary.replaceAgeYears ?? 4;
  const counts = countByReplacement(rows);
  const colors = bandColors(C);
  const preparedBy = opts.partnerName?.trim() || 'Breeze';

  let y = chrome.drawTitleBlock(
    doc,
    'Hardware Lifecycle Report',
    summary.org?.name ?? '',
    `Prepared ${opts.generatedAt}   ·   ${rows.length} computer${rows.length === 1 ? '' : 's'}${other.length ? `   ·   ${other.length} other device${other.length === 1 ? '' : 's'}` : ''}`,
    PAGE.bandH + 8,
  );

  // --- At a glance -----------------------------------------------------------
  y = chrome.drawSectionHeading(doc, 'At a glance', y + 2);
  y = drawProse(doc, chrome, buildAtAGlanceProse(rows, other.length), y + 1);
  const osProse = buildOsProse(rows);
  if (osProse) y = drawProse(doc, chrome, osProse, y);
  y = drawFleetBar(doc, chrome, counts, y + 1);

  // --- Device replacement plan -------------------------------------------------
  y = chrome.drawSectionHeading(doc, 'Device replacement plan', y + 3);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  ink(doc, C.muted);
  const note = `A device's replacement date is ${replaceAge} years after purchase, or the end of its warranty if covered longer. Bars show how much of that runway has been used: green more than a year out, amber due within a year, red past due. Devices without a purchase date show an empty bar.${rows.some((r) => r.purchaseDateSource === 'vendor') ? ' * Purchase date taken from the manufacturer’s ship record.' : ''}`;
  const noteLines = wrapText(doc, note, PAGE.w - PAGE.mx * 2);
  noteLines.forEach((line, i) => doc.text(line, PAGE.mx, y + i * 4));
  y += noteLines.length * 4 + 1;

  if (rows.length === 0) {
    y = drawProse(doc, chrome, 'No computers to plan for in this scope.', y + 1);
  } else {
    const contentW = PAGE.w - PAGE.mx * 2;
    const scale = contentW / COLUMNS.reduce((a, c) => a + c.w, 0);
    const columnStyles: Record<number, { cellWidth: number; halign: Col['halign'] }> = {};
    COLUMNS.forEach((c, i) => { columnStyles[i] = { cellWidth: c.w * scale, halign: c.halign }; });

    autoTable(doc, {
      startY: y,
      margin: { top: PAGE.bandH + 6, left: PAGE.mx, right: PAGE.mx, bottom: 16 },
      head: [COLUMNS.map((c) => ({ content: c.label, styles: { halign: c.halign } }))],
      body: rows.map((r) => COLUMNS.map((c) => cellText(r, c.key, today))),
      theme: 'grid',
      rowPageBreak: 'avoid',
      styles: { fontSize: 7.5, cellPadding: 1.6, lineColor: C.rule, lineWidth: 0.1, textColor: C.ink, valign: 'middle' },
      headStyles: { fillColor: C.primary, textColor: C.white, fontStyle: 'bold', fontSize: 7.5, lineColor: C.white, lineWidth: 0.15 },
      alternateRowStyles: { fillColor: C.zebra },
      columnStyles,
      didParseCell: (data: CellHookData) => {
        if (data.section !== 'body') return;
        const row = rows[data.row.index];
        if (!row) return;
        if (data.column.index === STATUS_COL) {
          data.cell.styles.textColor = colors[row.replacement];
          data.cell.styles.fontStyle = 'bold';
        } else if (data.column.index === OS_COL && (row.osSupport === 'ended' || row.osSupport === 'ending')) {
          data.cell.styles.textColor = row.osSupport === 'ended' ? C.danger : C.warning;
        }
      },
      didDrawCell: (data: CellHookData) => {
        if (data.section !== 'body' || data.column.index !== LIFE_COL) return;
        const row = rows[data.row.index];
        if (!row) return;
        const pad = 2.2;
        const x = data.cell.x + pad;
        const w = data.cell.width - pad * 2;
        const h = 2.6;
        const yy = data.cell.y + (data.cell.height - h) / 2;
        fill(doc, C.rule);
        doc.roundedRect(x, yy, w, h, 1.2, 1.2, 'F');
        if (row.lifeUsed != null && row.lifeUsed > 0) {
          fill(doc, colors[row.replacement]);
          doc.roundedRect(x, yy, Math.max(w * Math.min(row.lifeUsed, 1), 2), h, 1.2, 1.2, 'F');
        }
      },
      // Table-relative page 1 is the cover, whose chrome the caller already
      // drew; only continuation pages need it here.
      didDrawPage: (data) => {
        if (data.pageNumber <= 1) return;
        chrome.drawHeaderBand(doc);
        chrome.drawFooter(doc);
      },
    });
    const t = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable;
    y = (typeof t?.finalY === 'number' ? t.finalY : y) + 6;
  }

  // --- Other equipment ---------------------------------------------------------
  if (other.length > 0) {
    y = ensureSpace(doc, chrome, y, 22);
    y = chrome.drawSectionHeading(doc, 'Other equipment we manage', y + 2);
    const names = other.map((o) => [o.manufacturer, o.model].filter(Boolean).join(' ') || o.name);
    const listed = names.length <= 8 ? humanJoin(names) : `${names.slice(0, 8).join(', ')} and ${names.length - 8} more`;
    y = drawProse(
      doc,
      chrome,
      `${listed}. Network and print hardware is covered by your management agreement; computer replacement timelines do not apply.`,
      y + 1,
      9,
    );
  }

  // --- What we recommend -------------------------------------------------------
  const recs = Array.isArray(summary.recommendations) ? summary.recommendations : [];
  if (recs.length > 0) {
    y = ensureSpace(doc, chrome, y, 12 + recs.length * 5.5);
    y = chrome.drawSectionHeading(doc, 'What we recommend', y + 2);
    doc.setFontSize(9.5);
    const width = PAGE.w - PAGE.mx * 2 - 6;
    for (const rec of recs) {
      const lines = wrapText(doc, rec, width);
      y = ensureSpace(doc, chrome, y, lines.length * 4.8 + 2);
      ink(doc, C.primary);
      doc.setFont('helvetica', 'bold');
      doc.text('›', PAGE.mx + 1, y);
      ink(doc, C.ink);
      doc.setFont('helvetica', 'normal');
      lines.forEach((line, i) => doc.text(line, PAGE.mx + 6, y + i * 4.8));
      y += lines.length * 4.8 + 1;
    }
  }

  // --- Data note -----------------------------------------------------------------
  y = ensureSpace(doc, chrome, y, 8);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  ink(doc, C.faint);
  stroke(doc, C.rule);
  doc.text(`Prepared by ${preparedBy} from live device records, ${opts.generatedAt}.`, PAGE.mx, y + 3);
}
