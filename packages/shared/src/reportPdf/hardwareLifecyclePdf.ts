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
  buildAtAGlanceFacts,
  buildReplacementSchedule,
  capNames,
  countByReplacement,
  HARDWARE_LIFECYCLE_DEFAULT_SERVER_REPLACE_AGE_YEARS,
  humanJoin,
  monthYear,
  quarterLabel,
  REPLACEMENT_BAND_DESCRIPTIONS,
  REPLACEMENT_LABELS,
  REPLACEMENT_STATUS_ORDER,
  rowLabel,
  rowMention,
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
  contactEmail?: string | null;
  contactName?: string | null;
};

const fill = (doc: jsPDF, c: RGB) => doc.setFillColor(c[0], c[1], c[2]);
const ink = (doc: jsPDF, c: RGB) => doc.setTextColor(c[0], c[1], c[2]);
const mix = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * t)) as RGB;

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
  { key: 'warrantyEndDate', label: 'Warranty', w: 29, halign: 'left' },
  { key: 'replaceBy', label: 'Status', w: 38, halign: 'left' },
  { key: 'runway', label: 'Replacement timeline', w: 62, halign: 'left' },
];
const DEVICE_COL = COLUMNS.findIndex((c) => c.key === 'device');
const OS_COL = COLUMNS.findIndex((c) => c.key === 'os');
const STATUS_COL = COLUMNS.findIndex((c) => c.key === 'replaceBy');
const WARRANTY_COL = COLUMNS.findIndex((c) => c.key === 'warrantyEndDate');
const RUNWAY_COL = COLUMNS.findIndex((c) => c.key === 'runway');

const BODY_FONT = 8;
const SUB_FONT = 6.8;
const ROW_MIN_H = 9.4;
const EM_DASH = '-';

/** Strip edition suffixes a customer does not need ("Windows 11 Pro 24H2" → "Windows 11"). */
function customerOs(os: string): string {
  return os
    .replace(/\b(Standard|Datacenter|Essentials|Pro|Professional|Home|Enterprise|Education|Workstation)\b.*$/i, '')
    .replace(/\s+\d{2}H\d\b.*$/, '')
    .trim();
}

/**
 * The timeline every row shares: one cell per quarter, from two years before
 * today to three years after (five years in all). Today sits at a fixed column so the reader's
 * eye lines the rows up; a device's replace-by date is a solid cell on that
 * grid, its planned life the shaded run leading up to it.
 */
const TIMELINE_QUARTERS_BEFORE = 8;
const TIMELINE_QUARTERS_AFTER = 12;
const TIMELINE_QUARTERS = TIMELINE_QUARTERS_BEFORE + TIMELINE_QUARTERS_AFTER;

/** Whole quarters from `fromIso` to `toIso` (negative when `toIso` is earlier). */
function quartersBetween(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso.slice(0, 10)}T00:00:00Z`);
  const b = new Date(`${toIso.slice(0, 10)}T00:00:00Z`);
  const qa = a.getUTCFullYear() * 4 + Math.floor(a.getUTCMonth() / 3);
  const qb = b.getUTCFullYear() * 4 + Math.floor(b.getUTCMonth() / 3);
  return qb - qa;
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

function ageCell(row: HardwareLifecycleDeviceRow): string {
  if (row.ageYears == null || row.ageYears <= 0) return EM_DASH;
  if (row.ageYears < 1) return '<1 yr';
  return `${Math.floor(row.ageYears)} yr`;
}

function cellText(row: HardwareLifecycleDeviceRow, key: string, today: string): string {
  switch (key) {
    case 'ageYears': return ageCell(row);
    case 'purchaseDate': return row.purchaseDate ? `${monthYear(row.purchaseDate)}${row.purchaseDateSource === 'vendor' ? ' *' : ''}` : EM_DASH;
    case 'warrantyEndDate': {
      // #5764 — a failed vendor lookup (network/expired key/quota) and a
      // genuine "no coverage" result both land here with warrantyEndDate
      // null; flag the former rather than let it read as confirmed.
      const marker = row.warrantyLookupFailed ? ' †' : '';
      if (!row.warrantyEndDate) return row.warrantyLookupFailed ? `Unable to verify${marker}` : EM_DASH;
      const label = row.warrantyEndDate < today ? `Expired ${monthYear(row.warrantyEndDate)}` : monthYear(row.warrantyEndDate);
      return `${label}${marker}`;
    }
    case 'replaceBy':
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
  const lineH = size * 0.56;
  lines.forEach((line, i) => doc.text(line, PAGE.mx, y + i * lineH));
  return y + lines.length * lineH + 2.5;
}

/**
 * The status split as one object: each band's big number and label sit on
 * top of its own segment of a proportional bar. Numbers, words and colour
 * carry the same fact once.
 */
function drawStatusBar(doc: jsPDF, chrome: PdfChrome, counts: Record<ReplacementStatus, number>, y: number): number {
  const { C, PAGE } = chrome;
  const colors = bandColors(C);
  const order: ReplacementStatus[] = ['replace', 'due_soon', 'supported', 'unknown'];
  const visible = order.filter((s) => (counts[s] ?? 0) > 0);
  const total = visible.reduce((a, s) => a + (counts[s] ?? 0), 0);
  const width = PAGE.w - PAGE.mx * 2;
  const labelH = 11;
  const barH = 6;
  const barY = y + labelH + 1.5;
  if (total === 0) {
    fill(doc, C.rule);
    doc.rect(PAGE.mx, barY, width, barH, 'F');
    return barY + barH + 3;
  }
  const gap = 0.6;
  const usable = width - gap * (visible.length - 1);
  let x = PAGE.mx;
  // Labels sit on an even grid; the bar below carries the proportion. Each
  // label repeats its segment's colour so the two rows read as one object.
  const slot = width / visible.length;
  for (const [i, s] of visible.entries()) {
    const n = counts[s] ?? 0;
    const w = usable * (n / total);
    const lx = PAGE.mx + slot * i;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    ink(doc, colors[s]);
    const num = String(n);
    doc.text(num, lx, y + 7);
    const nw = doc.getTextWidth(num);
    doc.setFontSize(9);
    ink(doc, C.ink);
    doc.text(REPLACEMENT_LABELS[s], lx + nw + 2.2, y + 3.4);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    ink(doc, C.muted);
    doc.text(REPLACEMENT_BAND_DESCRIPTIONS[s], lx + nw + 2.2, y + 7.2);
    // Segment: tint above a solid stripe, both the full segment width.
    fill(doc, mix(colors[s], C.white, 0.82));
    doc.rect(x, barY, w, barH - 1.1, 'F');
    fill(doc, colors[s]);
    doc.rect(x, barY + barH - 1.1, w, 1.1, 'F');
    x += w + gap;
  }
  return barY + barH + 3;
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

/** Paint the three hand-drawn cells: identity, OS with risk tag, service life. */
function drawHandCell(doc: jsPDF, chrome: PdfChrome, row: HardwareLifecycleDeviceRow, data: CellHookData, today: string): void {
  const { C } = chrome;
  const colors = bandColors(C);
  const padX = 1.8;
  const x = data.cell.x + padX;
  const w = data.cell.width - padX * 2;
  const midY = data.cell.y + data.cell.height / 2;

  if (data.column.index === DEVICE_COL) {
    const label = rowLabel(row);
    const sub = rowSecondary(row) ?? '';
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

  if (data.column.index === STATUS_COL) {
    // Just the word; the service-life column carries the timing.
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(BODY_FONT);
    ink(doc, colors[row.replacement]);
    doc.text(REPLACEMENT_LABELS[row.replacement] ?? '', x, midY + 1);
    return;
  }

  if (data.column.index === RUNWAY_COL) {
    // Status already says "Purchase date unknown"; the timeline stays quiet.
    if (!row.replaceBy) return;
    const labelW = 13;
    const gridW = w - labelW;
    const cellW = gridW / TIMELINE_QUARTERS;
    const h = 3.6;
    const yy = midY - h / 2;
    const gap = 0.35;
    const todayQ = TIMELINE_QUARTERS_BEFORE; // index of the quarter containing today
    const dueQ = todayQ + quartersBetween(today, row.replaceBy);
    const boughtQ = row.purchaseDate ? todayQ + quartersBetween(today, row.purchaseDate) : Number.NEGATIVE_INFINITY;
    const tone = colors[row.replacement];
    // Grid: every quarter is a cell. Planned life (purchase → due) is a soft
    // tint; the due quarter is solid; everything past due through today is
    // solid too, so an overdue row reads as a run of colour up to the line.
    for (let q = 0; q < TIMELINE_QUARTERS; q += 1) {
      const cx = x + q * cellW;
      const inLife = q >= boughtQ && q < dueQ;
      const isDue = q === dueQ;
      const overdueRun = dueQ < todayQ && q > dueQ && q <= todayQ;
      if (isDue || overdueRun) fill(doc, mix(tone, C.white, 0.25));
      else if (inLife) fill(doc, mix(tone, C.white, 0.78));
      else fill(doc, C.rule);
      doc.rect(cx, yy, Math.max(cellW - gap, 0.3), h, 'F');
    }
    // Today: a dark rule through the grid on every row, at the same x.
    const todayX = x + (todayQ + 0.5) * cellW;
    fill(doc, C.ink);
    doc.rect(todayX - 0.25, yy - 1.1, 0.5, h + 2.2, 'F');
    // Label to the right: when, in words a budget uses.
    const years = yearsBetween(today, row.replaceBy);
    const overdue = row.replaceBy <= today;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    ink(doc, overdue ? mix(C.danger, C.ink, 0.25) : C.muted);
    // The grid already shows the quarter; the label only adds what it cannot:
    // how far past for overdue rows, and "beyond the grid" for far-out ones.
    const text = overdue
      ? (years < 1 / 24 ? 'now' : `${yearsLabel(years)} over`)
      : dueQ >= TIMELINE_QUARTERS ? `${yearsLabel(years)} out` : '';
    if (text) {
      if (doc.getTextWidth(text) > labelW - 1.5) doc.setFontSize(SUB_FONT);
      doc.text(text, x + gridW + 1.5, midY + 1);
    }
  }
}

/** One line under the legend: the grid's span and the meaning of the dark rule. */
function drawTimelineKey(doc: jsPDF, chrome: PdfChrome, today: string, y: number): number {
  const { C, PAGE } = chrome;
  const first = quarterLabel(addQuarters(today, -TIMELINE_QUARTERS_BEFORE));
  const last = quarterLabel(addQuarters(today, TIMELINE_QUARTERS_AFTER - 1));
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  ink(doc, C.muted);
  doc.text(`Replacement timeline: one cell per quarter, ${first} to ${last}. The dark line is today; the solid cell is the replace-by quarter.`, PAGE.mx, y + 2.6);
  return y + 4.5;
}

function addQuarters(iso: string, n: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  const m = d.getUTCMonth() + n * 3;
  const out = new Date(Date.UTC(d.getUTCFullYear() + Math.floor(m / 12), ((m % 12) + 12) % 12, 1));
  return out.toISOString().slice(0, 10);
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

  let y = chrome.drawTitleBlock(
    doc,
    'Hardware Lifecycle Report',
    summary.org?.name ?? '',
    `Prepared ${opts.generatedAt}   ·   ${rows.length} computer${rows.length === 1 ? '' : 's'}${other.length ? `   ·   ${other.length} other device${other.length === 1 ? '' : 's'}` : ''}`,
    PAGE.bandH + 14,
  );

  // --- At a glance -----------------------------------------------------------
  // Numbers first, then the bar that proportions them, then one paragraph of
  // framing. The legend lives with each table, next to the rows it explains.
  y = chrome.drawSectionHeading(doc, 'At a glance', y + 6);
  y = drawStatusBar(doc, chrome, counts, y + 2);
  const facts = buildAtAGlanceFacts(rows);
  if (facts) y = drawProse(doc, chrome, facts, y + 3);

  // --- Replacement schedule ----------------------------------------------------
  // The plan grouped the way a budget is approved: due now, then each of the
  // next quarters, then later, then the undated. Counts and names only — no
  // pricing claims.
  const workstations = rows.filter((r) => r.deviceKind !== 'server');
  const servers = rows.filter((r) => r.deviceKind === 'server');
  // A legacy snapshot predating this field has no serverReplaceAgeYears of its
  // own — fall back to the documented server default (5), never to the
  // workstation's replaceAgeYears, which would silently mislabel the server
  // plan whenever the two ages diverge.
  const serverAge = summary.serverReplaceAgeYears ?? HARDWARE_LIFECYCLE_DEFAULT_SERVER_REPLACE_AGE_YEARS;
  const schedule = buildReplacementSchedule(workstations, today);
  const serverLine = servers
    .filter((r) => r.replaceBy)
    .map((r) => `${rowMention(r)} (${r.replaceBy! <= today ? 'past due' : quarterLabel(r.replaceBy!)})`);
  const serversNow = servers.filter((r) => r.replaceBy && r.replaceBy <= today).length;
  const scheduleRows: { label: string; text: string; urgent: boolean }[] = schedule
    .filter((g) => !g.countOnly || servers.length > 0 || schedule.some((x) => !x.countOnly))
    .map((g) => {
      const n = g.rows.length;
      // The Now line reconciles with the fleet-wide number above it.
      const withServers = g.label === 'Now' && serversNow > 0 ? ` and ${serversNow} server${serversNow === 1 ? '' : 's'}` : '';
      const count = `${n} computer${n === 1 ? '' : 's'}${withServers}`;
      return { label: g.label, text: g.countOnly ? count : `${count}: ${capNames(g.rows.map(rowMention))}`, urgent: g.label === 'Now' };
    });
  if (serverLine.length > 0) {
    scheduleRows.push({ label: 'Servers', text: `${capNames(serverLine, 8)}; planned separately, outside business hours`, urgent: false });
  }
  // A fleet with nothing due in the next year has no schedule to show.
  if (schedule.some((g) => !g.countOnly) || serverLine.length > 0) {
    y = ensureSpace(doc, chrome, y, 16 + scheduleRows.length * 6);
    y = chrome.drawSectionHeading(doc, 'Replacement schedule', y + 6);
    const labelW = 40;
    const textW = PAGE.w - PAGE.mx * 2 - labelW;
    y += 2;
    for (const item of scheduleRows) {
      doc.setFontSize(9.5);
      doc.setFont('helvetica', 'normal');
      const lines = wrapText(doc, item.text, textW);
      y = ensureSpace(doc, chrome, y, lines.length * 5.2 + 1);
      doc.setFont('helvetica', 'bold');
      ink(doc, C.ink);
      doc.text(item.label, PAGE.mx, y + 3.6);
      doc.setFont('helvetica', 'normal');
      ink(doc, C.ink);
      lines.forEach((line, i) => doc.text(line, PAGE.mx + labelW, y + 3.6 + i * 5.2));
      y += lines.length * 5.2 + 1.4;
    }
    y += 2;
  }

  // --- Device replacement plan -------------------------------------------------

  const drawPlanTable = (tableRows: HardwareLifecycleDeviceRow[], heading: string, rule: string, firstColumn: string, startY: number): number => {
    let ty = chrome.drawSectionHeading(doc, heading, startY);
    // The rule that justifies every red row, at body size — not a disclaimer.
    ty = drawProse(doc, chrome, rule, ty + 1);
    if (tableRows.length === 0) {
      return drawProse(doc, chrome, 'No computers to plan for in this scope.', ty + 1);
    }
    // The legend counts this table's rows, so it always reconciles with them.
    const tableCounts = countByReplacement(tableRows);
    ty = drawLegend(doc, chrome, tableCounts, ty + 1.5);
    ty = drawTimelineKey(doc, chrome, today, ty + 0.5);
    const contentW = PAGE.w - PAGE.mx * 2;
    const scale = contentW / COLUMNS.reduce((a, c) => a + c.w, 0);
    const columnStyles: Record<number, { cellWidth: number; halign: Col['halign'] }> = {};
    COLUMNS.forEach((c, i) => { columnStyles[i] = { cellWidth: c.w * scale, halign: c.halign }; });
    // Continuation pages restate the heading and legend above the table so a
    // page read on its own still explains its colours.
    const continuationTop = PAGE.bandH + 6 + 19;

    autoTable(doc, {
      startY: ty + 1,
      margin: { top: continuationTop, left: PAGE.mx, right: PAGE.mx, bottom: 16 },
      head: [COLUMNS.map((c, i) => ({ content: i === DEVICE_COL ? firstColumn : c.label, styles: { halign: c.halign } }))],
      body: tableRows.map((r) => COLUMNS.map((c) => cellText(r, c.key, today))),
      theme: 'grid',
      rowPageBreak: 'avoid',
      styles: { fontSize: BODY_FONT, cellPadding: { top: 1.4, bottom: 1.4, left: 1.8, right: 1.8 }, minCellHeight: ROW_MIN_H, lineColor: C.rule, lineWidth: 0.1, textColor: C.ink, valign: 'middle' },
      headStyles: { fillColor: C.panel, textColor: C.ink, fontStyle: 'bold', fontSize: 7.5, lineColor: C.rule, lineWidth: 0.1, minCellHeight: 7 },
      alternateRowStyles: { fillColor: C.zebra },
      columnStyles,
      didParseCell: (data: CellHookData) => {
        if (data.section !== 'body') return;
        const row = tableRows[data.row.index];
        if (!row) return;
        if (data.column.index === WARRANTY_COL && row.warrantyEndDate && row.warrantyEndDate < today) {
          data.cell.styles.textColor = C.muted;
        } else if (row.replacement === 'unknown' && data.column.index !== DEVICE_COL) {
          data.cell.styles.textColor = C.faint;
        }
      },
      didDrawCell: (data: CellHookData) => {
        if (data.section !== 'body') return;
        const row = tableRows[data.row.index];
        if (!row) return;
        drawHandCell(doc, chrome, row, data, today);
      },
      // Table-relative page 1 is the page the table started on, whose chrome
      // is already drawn; continuation pages need chrome plus their own context.
      didDrawPage: (data) => {
        if (data.pageNumber <= 1) return;
        chrome.drawHeaderBand(doc);
        chrome.drawFooter(doc);
        const hy = chrome.drawSectionHeading(doc, `${heading} (continued)`, PAGE.bandH + 10);
        drawTimelineKey(doc, chrome, today, drawLegend(doc, chrome, tableCounts, hy + 1.5) + 0.5);
      },
    });
    const t = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable;
    return typeof t?.finalY === 'number' ? t.finalY : ty;
  };

  const workstationHeading = servers.length > 0 ? 'Workstations and laptops' : 'Device replacement plan';
  // Heading, rule, table head and at least four rows stay together; a table
  // that would open with two orphan rows starts on the next page instead.
  const footnote = (tableRows: HardwareLifecycleDeviceRow[], at: number): number => {
    const hasVendorDate = tableRows.some((r) => r.purchaseDateSource === 'vendor');
    const hasFailedLookup = tableRows.some((r) => r.warrantyLookupFailed);
    if (!hasVendorDate && !hasFailedLookup) return at;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    ink(doc, C.faint);
    let y = at;
    if (hasVendorDate) {
      doc.text("* Purchase date taken from the manufacturer's ship record.", PAGE.mx, y + 3.8);
      y += 4.5;
    }
    if (hasFailedLookup) {
      doc.text('† Warranty status could not be verified during the last sync attempt.', PAGE.mx, y + 3.8);
      y += 4.5;
    }
    return y;
  };
  const minTableBlock = 26 + 7 + ROW_MIN_H * Math.min(3, Math.max(1, workstations.length));
  y = ensureSpace(doc, chrome, y + 6, minTableBlock);
  y = drawPlanTable(
    workstations,
    workstationHeading,
    `We plan to replace a computer ${replaceAge} years after purchase, or when its warranty ends if it is still covered past that point.`,
    'Computer',
    y,
  );
  y = footnote(workstations, y);
  if (servers.length > 0) {
    y = ensureSpace(doc, chrome, y + 10, 30 + 7 + ROW_MIN_H * Math.min(3, servers.length));
    y = drawPlanTable(
      servers,
      'Servers',
      `We plan to replace a server ${serverAge} years after purchase, or when its warranty ends if it is still covered past that point. Server replacements are scheduled outside your business hours.`,
      'Server',
      y,
    );
    y = footnote(servers, y);
  }
  y += 8;

  // --- Other equipment ---------------------------------------------------------
  if (other.length > 0) {
    y = ensureSpace(doc, chrome, y, 24);
    y = chrome.drawSectionHeading(doc, 'Other equipment we manage', y + 4);
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
    // Measure with the face the lines are drawn in; a bold left over from the
    // heading would wrap them too wide and run past the margin.
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    const width = PAGE.w - PAGE.mx * 2 - 6;
    const closingNeeded = opts.contactEmail?.trim() ? 16 : 0;
    const wrapped = recs.map((rec) => wrapText(doc, rec, width));
    const blockH = 14 + wrapped.reduce((a, l) => a + l.length * 5.2 + 1.6, 0) + closingNeeded;
    // A block that fits in half a page moves as one; a longer one may split,
    // but then the new page gets the heading again.
    y = ensureSpace(doc, chrome, y, Math.min(blockH, 90));
    y = chrome.drawSectionHeading(doc, 'What we recommend', y + 4);
    wrapped.forEach((lines, idx) => {
      const pageBefore = doc.getNumberOfPages();
      y = ensureSpace(doc, chrome, y, lines.length * 5.2 + 2 + (idx === recs.length - 1 ? closingNeeded : 0));
      if (doc.getNumberOfPages() !== pageBefore) {
        y = chrome.drawSectionHeading(doc, 'What we recommend (continued)', y);
      }
      // The heading call above changes the font; restore the measured face.
      doc.setFontSize(9.5);
      ink(doc, C.primary);
      doc.setFont('helvetica', 'bold');
      doc.text('›', PAGE.mx + 1, y);
      ink(doc, C.ink);
      doc.setFont('helvetica', 'normal');
      lines.forEach((line, i) => doc.text(line, PAGE.mx + 6, y + i * 5.2));
      y += lines.length * 5.2 + 1.6;
    });
  }

  // --- How to act --------------------------------------------------------------
  const contact = opts.contactEmail?.trim();
  if (contact) {
    const who = opts.contactName?.trim() ? `${opts.contactName.trim()} (${contact})` : contact;
    y = ensureSpace(doc, chrome, y + 2, 12);
    y = drawProse(doc, chrome, `To approve or discuss this plan, contact ${who}. We will send quotes for the "Now" group first.`, y + 3);
  }

  // --- Data note -----------------------------------------------------------------
  // A one-line note never earns a page of its own: when it does not fit, it
  // sits just above the footer rule instead.
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  ink(doc, C.faint);
  const note = `Figures come from live device records as of ${opts.generatedAt}.`;
  const noteY = y + 4 <= PAGE.footY - 6 ? y + 4 : PAGE.footY - 2.5;
  doc.text(note, PAGE.mx, noteY);
}
