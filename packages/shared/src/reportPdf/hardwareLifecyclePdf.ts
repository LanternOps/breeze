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
 *
 * The reader is the customer's office manager, not a technician. Rows lead
 * with the person and the model, the plan table carries only what informs a
 * budget decision, and every colour is paired with a word.
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
  quarterLabel,
  REPLACEMENT_BAND_DESCRIPTIONS,
  REPLACEMENT_LABELS,
  REPLACEMENT_STATUS_ORDER,
  rowLabel,
  rowSecondary,
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
const ink = (doc: jsPDF, c: RGB) => doc.setTextColor(c[0], c[1], c[2]);

function bandColors(C: PdfChrome['C']): Record<ReplacementStatus, RGB> {
  return { supported: C.success, due_soon: C.warning, replace: C.danger, unknown: C.faint };
}

/** Second line under the OS name so support risk is a word, not just a colour. */
const OS_RISK_TAG: Partial<Record<HardwareLifecycleDeviceRow['osSupport'], string>> = {
  ended: 'No security updates',
  ending: 'Support ending',
};

type Col = { key: string; label: string; w: number; halign: 'left' | 'right' | 'center' };
// Widths are relative; scaled to the content width. Serial and make are not
// budget inputs — make rides under the device name, serial stays in the app.
const COLUMNS: Col[] = [
  { key: 'device', label: 'Computer', w: 66, halign: 'left' },
  { key: 'os', label: 'Operating system', w: 40, halign: 'left' },
  { key: 'ageYears', label: 'Age', w: 13, halign: 'right' },
  { key: 'purchaseDate', label: 'Purchased', w: 21, halign: 'left' },
  { key: 'warrantyEndDate', label: 'Warranty until', w: 21, halign: 'left' },
  { key: 'replacement', label: 'Status', w: 24, halign: 'left' },
  { key: 'replaceBy', label: 'Replace by', w: 22, halign: 'left' },
  { key: 'runway', label: 'Service life used', w: 62, halign: 'left' },
];
const DEVICE_COL = COLUMNS.findIndex((c) => c.key === 'device');
const OS_COL = COLUMNS.findIndex((c) => c.key === 'os');
const STATUS_COL = COLUMNS.findIndex((c) => c.key === 'replacement');
const RUNWAY_COL = COLUMNS.findIndex((c) => c.key === 'runway');

const BODY_FONT = 8;
const SUB_FONT = 6.8;
const ROW_MIN_H = 9.4;
const EM_DASH = '—';

/** Strip edition suffixes a customer does not need ("Windows 11 Pro 24H2" → "Windows 11"). */
function customerOs(os: string): string {
  return os
    .replace(/\b(Standard|Datacenter|Essentials|Pro|Professional|Home|Enterprise|Education|Workstation)\b.*$/i, '')
    .replace(/\s+\d{2}H\d\b.*$/, '')
    .trim();
}

function yearsBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${toIso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.abs(b - a) / (365.25 * 86_400_000);
}

/** "3 months" under a year, half-years above it — the precision a budget needs. */
function yearsLabel(years: number): string {
  if (years < 1) {
    const months = Math.max(1, Math.round(years * 12));
    return `${months} month${months === 1 ? '' : 's'}`;
  }
  const v = Math.round(years * 2) / 2;
  return `${v} yr`;
}

/** "Overdue" is the Status column's job; here the reader gets the date. */
function replaceByCell(row: HardwareLifecycleDeviceRow, today: string): string {
  if (!row.replaceBy) return EM_DASH;
  return row.replaceBy <= today ? monthYear(row.replaceBy) : quarterLabel(row.replaceBy);
}

function ageCell(row: HardwareLifecycleDeviceRow): string {
  if (row.ageYears == null || row.ageYears <= 0) return EM_DASH;
  if (row.ageYears < 1) return '<1 yr';
  return `${Math.round(row.ageYears)} yr`;
}

function cellText(row: HardwareLifecycleDeviceRow, key: string, today: string): string {
  switch (key) {
    case 'ageYears': return ageCell(row);
    case 'purchaseDate': return row.purchaseDate ? `${monthYear(row.purchaseDate)}${row.purchaseDateSource === 'vendor' ? ' *' : ''}` : EM_DASH;
    case 'warrantyEndDate': return row.warrantyEndDate ? monthYear(row.warrantyEndDate) : EM_DASH;
    case 'replacement': return REPLACEMENT_LABELS[row.replacement] ?? '';
    case 'replaceBy': return replaceByCell(row, today);
    // Drawn by hand in didDrawCell; the cell keeps its text for extraction and
    // screen readers but paints nothing itself.
    case 'device':
    case 'os':
    case 'runway':
    default: return '';
  }
}

function wrapText(doc: jsPDF, text: string, width: number): string[] {
  return doc.splitTextToSize(text, width) as string[];
}

/** Trim a single line to fit a width with an ellipsis, measuring real glyphs. */
function fitLine(doc: jsPDF, text: string, width: number): string {
  if (doc.getTextWidth(text) <= width) return text;
  let v = text;
  while (v.length > 1 && doc.getTextWidth(`${v}…`) > width) v = v.slice(0, -1);
  return `${v.trimEnd()}…`;
}

/** Wrapped body paragraph; returns the y below it. */
function drawProse(doc: jsPDF, chrome: PdfChrome, text: string, y: number, size = 9.5, color?: RGB): number {
  const { C, PAGE } = chrome;
  const width = PAGE.w - PAGE.mx * 2;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(size);
  ink(doc, color ?? C.ink);
  const lines = wrapText(doc, text, width);
  const lineH = size * 0.5;
  lines.forEach((line, i) => doc.text(line, PAGE.mx, y + i * lineH));
  return y + lines.length * lineH + 1.5;
}

/** One-line legend: "● 4 On track (more than a year out)   ● 2 Due soon …". Returns y below it. */
function drawLegend(doc: jsPDF, chrome: PdfChrome, counts: Record<ReplacementStatus, number>, y: number): number {
  const { C, PAGE } = chrome;
  const colors = bandColors(C);
  doc.setFontSize(8);
  let x = PAGE.mx;
  for (const s of REPLACEMENT_STATUS_ORDER) {
    const n = counts[s] ?? 0;
    if (n === 0) continue;
    fill(doc, colors[s]);
    doc.circle(x + 1.1, y - 1.1, 1.1, 'F');
    x += 3.4;
    doc.setFont('helvetica', 'bold');
    ink(doc, C.ink);
    const lead = `${n} ${REPLACEMENT_LABELS[s]}`;
    doc.text(lead, x, y);
    x += doc.getTextWidth(lead) + 1;
    doc.setFont('helvetica', 'normal');
    ink(doc, C.muted);
    const tail = `(${REPLACEMENT_BAND_DESCRIPTIONS[s]})`;
    doc.text(tail, x, y);
    x += doc.getTextWidth(tail) + 6;
  }
  return y + 2.5;
}

function drawFleetBar(doc: jsPDF, chrome: PdfChrome, counts: Record<ReplacementStatus, number>, y: number): number {
  const { C, PAGE } = chrome;
  const colors = bandColors(C);
  const total = REPLACEMENT_STATUS_ORDER.reduce((a, s) => a + (counts[s] ?? 0), 0);
  const width = PAGE.w - PAGE.mx * 2;
  const barH = 5.2;
  if (total > 0) {
    const visible = REPLACEMENT_STATUS_ORDER.filter((s) => (counts[s] ?? 0) > 0);
    const gap = 0.6;
    const usable = width - gap * (visible.length - 1);
    let x = PAGE.mx;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    for (const s of visible) {
      const n = counts[s] ?? 0;
      const w = usable * (n / total);
      fill(doc, colors[s]);
      doc.roundedRect(x, y, w, barH, 0.8, 0.8, 'F');
      // Count on the segment itself, so the bar reads without the legend.
      const label = String(n);
      if (doc.getTextWidth(label) + 3 <= w) {
        ink(doc, C.white);
        doc.text(label, x + w / 2, y + barH / 2 + 0.95, { align: 'center' });
      }
      x += w + gap;
    }
  } else {
    fill(doc, C.rule);
    doc.roundedRect(PAGE.mx, y, width, barH, 0.8, 0.8, 'F');
  }
  return drawLegend(doc, chrome, counts, y + barH + 4.2);
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
  const hasVendorDates = rows.some((r) => r.purchaseDateSource === 'vendor');

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
  const planHeading = 'Device replacement plan';
  y = chrome.drawSectionHeading(doc, planHeading, y + 3);
  // The rule that justifies every red row, at body size — not a disclaimer.
  y = drawProse(
    doc,
    chrome,
    `We plan to replace a computer ${replaceAge} years after purchase, or when its warranty ends if that is later.`,
    y + 1,
  );

  if (rows.length === 0) {
    y = drawProse(doc, chrome, 'No computers to plan for in this scope.', y + 1);
  } else {
    const contentW = PAGE.w - PAGE.mx * 2;
    const scale = contentW / COLUMNS.reduce((a, c) => a + c.w, 0);
    const columnStyles: Record<number, { cellWidth: number; halign: Col['halign'] }> = {};
    COLUMNS.forEach((c, i) => { columnStyles[i] = { cellWidth: c.w * scale, halign: c.halign }; });
    // Continuation pages restate the heading and legend above the table so a
    // page read on its own still explains its colours.
    const continuationTop = PAGE.bandH + 6 + 14;

    autoTable(doc, {
      startY: y,
      margin: { top: continuationTop, left: PAGE.mx, right: PAGE.mx, bottom: 16 },
      head: [COLUMNS.map((c) => ({ content: c.label, styles: { halign: c.halign } }))],
      body: rows.map((r) => COLUMNS.map((c) => cellText(r, c.key, today))),
      theme: 'grid',
      rowPageBreak: 'avoid',
      styles: { fontSize: BODY_FONT, cellPadding: { top: 1.4, bottom: 1.4, left: 1.8, right: 1.8 }, minCellHeight: ROW_MIN_H, lineColor: C.rule, lineWidth: 0.1, textColor: C.ink, valign: 'middle' },
      headStyles: { fillColor: C.panel, textColor: C.ink, fontStyle: 'bold', fontSize: 7.5, lineColor: C.rule, lineWidth: 0.1, minCellHeight: 7 },
      alternateRowStyles: { fillColor: C.zebra },
      columnStyles,
      didParseCell: (data: CellHookData) => {
        if (data.section !== 'body') return;
        const row = rows[data.row.index];
        if (!row) return;
        if (data.column.index === STATUS_COL) {
          data.cell.styles.textColor = colors[row.replacement];
          data.cell.styles.fontStyle = 'bold';
        } else if (row.replacement === 'unknown' && data.column.index !== DEVICE_COL) {
          data.cell.styles.textColor = C.faint;
        }
      },
      didDrawCell: (data: CellHookData) => {
        if (data.section !== 'body') return;
        const row = rows[data.row.index];
        if (!row) return;
        const padX = 1.8;
        const x = data.cell.x + padX;
        const w = data.cell.width - padX * 2;
        const midY = data.cell.y + data.cell.height / 2;

        if (data.column.index === DEVICE_COL) {
          const label = rowLabel(row);
          const sub = [rowSecondary(row), row.manufacturer].filter(Boolean).join('  ·  ');
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(BODY_FONT);
          ink(doc, C.ink);
          if (sub) {
            doc.text(fitLine(doc, label, w), x, midY - 0.6);
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(SUB_FONT);
            ink(doc, C.muted);
            doc.text(fitLine(doc, sub, w), x, midY + 2.4);
          } else {
            doc.text(fitLine(doc, label, w), x, midY + 1);
          }
          return;
        }

        if (data.column.index === OS_COL) {
          const os = customerOs(row.os) || (row.kind === 'manual_asset' ? EM_DASH : '');
          const tag = OS_RISK_TAG[row.osSupport];
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(BODY_FONT);
          ink(doc, row.replacement === 'unknown' ? C.faint : C.ink);
          if (tag) {
            doc.text(fitLine(doc, os, w), x, midY - 0.6);
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(SUB_FONT);
            ink(doc, row.osSupport === 'ended' ? C.danger : C.warning);
            doc.text(tag, x, midY + 2.4);
          } else {
            doc.text(fitLine(doc, os, w), x, midY + 1);
          }
          return;
        }

        if (data.column.index === RUNWAY_COL) {
          // Track = the planned service life. Fill = how much is used. The
          // number beside it says what the bar cannot: how far past, or how
          // long left. Undated rows get a word, not an empty shape.
          const trackW = w * 0.42;
          const h = 2.8;
          const yy = midY - h / 2;
          doc.setFontSize(7.5);
          if (row.lifeUsed == null || !row.replaceBy) {
            doc.setFont('helvetica', 'normal');
            ink(doc, C.faint);
            doc.text('No purchase date', x, midY + 1);
            return;
          }
          const years = yearsBetween(today, row.replaceBy);
          const overdue = row.replaceBy <= today;
          // Planned life is the track; time past the plan runs on beyond it
          // (capped at three years) so 5 years overdue looks different from 1.
          const overrunW = overdue ? trackW * 0.5 * Math.min(years / 3, 1) : 0;
          fill(doc, C.rule);
          doc.roundedRect(x, yy, trackW, h, 1.2, 1.2, 'F');
          if (row.lifeUsed > 0) {
            fill(doc, colors[row.replacement]);
            doc.roundedRect(x, yy, Math.max(trackW * Math.min(row.lifeUsed, 1), 2), h, 1.2, 1.2, 'F');
          }
          if (overrunW > 1) {
            // Lighter overrun segment: same hue, marked off from the plan by a gap.
            fill(doc, colors[row.replacement]);
            doc.roundedRect(x + trackW + 0.7, yy + 0.7, overrunW, h - 1.4, 0.7, 0.7, 'F');
          }
          doc.setFont('helvetica', overdue ? 'bold' : 'normal');
          ink(doc, overdue ? C.danger : C.muted);
          const text = overdue
            ? (years < 1 / 24 ? 'Due now' : `${yearsLabel(years)} past due`)
            : `${yearsLabel(years)} left`;
          doc.text(text, x + trackW + overrunW + (overrunW > 1 ? 3.2 : 2.5), midY + 1);
        }
      },
      // Table-relative page 1 is the cover, whose chrome the caller already
      // drew; continuation pages need chrome plus their own context line.
      didDrawPage: (data) => {
        if (data.pageNumber <= 1) return;
        chrome.drawHeaderBand(doc);
        chrome.drawFooter(doc);
        const hy = chrome.drawSectionHeading(doc, `${planHeading} (continued)`, PAGE.bandH + 10);
        drawLegend(doc, chrome, counts, hy + 1.5);
      },
    });
    const t = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable;
    y = typeof t?.finalY === 'number' ? t.finalY : y;
    if (hasVendorDates) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      ink(doc, C.faint);
      doc.text("* Purchase date taken from the manufacturer's ship record.", PAGE.mx, y + 3.6);
      y += 4;
    }
    y += 6;
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
    // Reserve the heading plus the first item so the heading is never orphaned;
    // each further item checks its own space and flows onto the next page.
    y = ensureSpace(doc, chrome, y, 18);
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
  doc.text(`Figures come from live device records as of ${opts.generatedAt}.`, PAGE.mx, y + 3);
}
