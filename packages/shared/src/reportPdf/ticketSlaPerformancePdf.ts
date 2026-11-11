/**
 * SLA performance PDF (`ticket_sla_performance`, #11018): the customer-facing
 * document. It prints only customer-safe fields: ticket numbers, never internal
 * numbers or assignees, and subjects only when the definition opted in.
 *
 * A null ratio prints N/A via `formatPercent(null)` and a null duration prints
 * an em dash, never 0: an empty sample is unmeasured, not instant.
 *
 * `PdfChrome` is imported as a type only: importing reportPdf.ts by value from
 * here would be a module cycle.
 */
import type { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import {
  formatSlaMinutes,
  type SlaTargetKind,
  type TicketSlaBreachRow,
  type TicketSlaPerformanceRow,
  type TicketSlaPerformanceSummary,
} from '../types/ticketSlaPerformance';
import { detailDisclosure } from './detailDisclosure';
import { formatPercent } from './moneyFormat';
import type { PdfChrome } from './ticketSlaPdf';

export { formatSlaMinutes };

export type TicketSlaPerformancePdfOpts = {
  generatedAt: string;
};

type RGB = [number, number, number];

/** Rows of the breach table beyond this are dropped from the PDF only; the
 *  generator already capped and disclosed the stored set. */
const BREACH_TABLE_MAX = 500;

const PRIORITY_LABEL: Record<TicketSlaPerformanceRow['priority'], string> = {
  all: 'All priorities',
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};

const TARGET_LABEL: Record<SlaTargetKind, string> = {
  response: 'Response',
  resolution: 'Resolution',
};

function drawProse(doc: jsPDF, chrome: PdfChrome, text: string, y: number, size = 8.6): number {
  const { C, PAGE } = chrome;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(size);
  doc.setTextColor(...(C.muted as RGB));
  const lines = doc.splitTextToSize(text, PAGE.w - PAGE.mx * 2) as string[];
  const lineH = size * 0.56;
  lines.forEach((line, i) => doc.text(line, PAGE.mx, y + i * lineH));
  return y + lines.length * lineH + 2.5;
}

function drawNotes(doc: jsPDF, chrome: PdfChrome, notes: readonly string[], y: number): number {
  let next = chrome.drawSectionHeading(doc, 'What this measures', y);
  for (const note of notes) next = drawProse(doc, chrome, note, next + 1);
  return next;
}

function drawTiles(
  doc: jsPDF,
  chrome: PdfChrome,
  tiles: ReadonlyArray<{ value: string; label: string; unmeasured?: boolean }>,
  y: number,
): number {
  const { C, PAGE } = chrome;
  const tileW = (PAGE.w - PAGE.mx * 2) / tiles.length;
  tiles.forEach((tile, i) => {
    const x = PAGE.mx + i * tileW;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.setTextColor(...((tile.unmeasured ? C.faint : C.primary) as RGB));
    doc.text(tile.value, x, y + 6);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.6);
    doc.setTextColor(...(C.muted as RGB));
    doc.text(tile.label, x, y + 11);
  });
  return y + 17;
}

function targetCell(minutes: number | null, varies: boolean): string {
  const text = formatSlaMinutes(minutes);
  return varies ? `${text} (varies)` : text;
}

function priorityCells(r: TicketSlaPerformanceRow): string[] {
  return [
    PRIORITY_LABEL[r.priority],
    String(r.ticketsOpened),
    targetCell(r.responseTargetMinutes, r.responseTargetVaries),
    String(r.responseMeasured),
    formatPercent(r.responseAttainment),
    formatSlaMinutes(r.responseMedianMinutes),
    formatSlaMinutes(r.responseMeanMinutes),
    targetCell(r.resolutionTargetMinutes, r.resolutionTargetVaries),
    String(r.resolutionMeasured),
    formatPercent(r.resolutionAttainment),
    formatSlaMinutes(r.resolutionMedianMinutes),
    formatSlaMinutes(r.resolutionMeanMinutes),
  ];
}

function instant(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

function breachCells(r: TicketSlaBreachRow, summary: TicketSlaPerformanceSummary): string[] {
  const { timeZone } = summary.period;
  return [
    r.ticketNumber,
    ...(summary.includeSubjects ? [r.subject ?? ''] : []),
    PRIORITY_LABEL[r.priority],
    TARGET_LABEL[r.target],
    formatSlaMinutes(r.targetMinutes),
    instant(r.dueAt, timeZone),
    r.completedAt ? instant(r.completedAt, timeZone) : 'Still open',
    formatSlaMinutes(r.elapsedSlaMinutes),
    formatSlaMinutes(r.overByMinutes),
  ];
}

export function renderTicketSlaPerformanceReport(
  doc: jsPDF,
  summary: TicketSlaPerformanceSummary,
  opts: TicketSlaPerformancePdfOpts,
  chrome: PdfChrome,
): void {
  const { C, PAGE } = chrome;
  const measured = summary.period.start !== '';
  const orgName = summary.org?.orgName ?? '';
  // A run during its own period counted nothing after it ran; say so on the face.
  const clipped = measured && summary.period.measuredThrough < summary.period.end;
  const through = clipped
    ? ` · Measured through ${new Intl.DateTimeFormat('en-US', { timeZone: summary.period.timeZone, dateStyle: 'medium' }).format(new Date(summary.period.measuredThrough))}`
    : '';
  const meta = measured
    ? `${summary.period.label} · ${summary.period.timeZone}${through} · Prepared ${opts.generatedAt}`
    : `Prepared ${opts.generatedAt}`;

  let y = chrome.drawTitleBlock(doc, 'Service Level Performance', orgName, meta, PAGE.bandH + 14);

  // Nothing was queried: the reason is the whole document, because tiles of
  // zeros under it would read as a month with no tickets.
  if (!measured) {
    drawNotes(doc, chrome, summary.notes, y + 6);
    return;
  }

  const tableStyles = {
    styles: { font: 'helvetica', fontSize: 7.6, cellPadding: 1.8, textColor: C.ink, lineColor: C.rule, lineWidth: 0.1 },
    headStyles: { fillColor: C.panel, textColor: C.ink, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: C.zebra },
    margin: { left: PAGE.mx, right: PAGE.mx, top: PAGE.bandH + 8, bottom: 14 },
    didDrawPage: () => {
      chrome.drawHeaderBand(doc);
      chrome.drawFooter(doc);
    },
  } as const;
  const finalY = (fallback: number) =>
    ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? fallback) + 6;

  // --- Headline --------------------------------------------------------------
  y = chrome.drawSectionHeading(doc, 'Overall', y + 6);
  y = drawTiles(doc, chrome, [
    { value: formatPercent(summary.overall.responseAttainment), label: 'First response within SLA', unmeasured: summary.overall.responseAttainment == null },
    { value: formatPercent(summary.overall.resolutionAttainment), label: 'Resolution within SLA', unmeasured: summary.overall.resolutionAttainment == null },
    { value: String(summary.overall.ticketsOpened), label: 'Tickets opened' },
    { value: String(summary.breaches.available), label: 'Breaches' },
  ], y + 2);

  // --- By priority -----------------------------------------------------------
  y = chrome.drawSectionHeading(doc, 'By priority', y + 4);
  autoTable(doc, {
    ...tableStyles,
    startY: y + 1,
    head: [
      [
        { content: '', colSpan: 2 },
        { content: 'First response', colSpan: 5, styles: { halign: 'center' } },
        { content: 'Resolution', colSpan: 5, styles: { halign: 'center' } },
      ],
      ['Priority', 'Tickets opened', 'Target', 'Measured', '% within SLA', 'Median', 'Mean', 'Target', 'Measured', '% within SLA', 'Median', 'Mean'],
    ],
    body: [...summary.priorities, summary.overall].map(priorityCells),
  });
  y = finalY(y);

  // --- Breaches --------------------------------------------------------------
  const disclosure = detailDisclosure({
    base: 'Breaches',
    inHand: summary.breaches.rows.length,
    total: summary.breaches.available,
    pdfMax: BREACH_TABLE_MAX,
    storedCap: summary.breaches.cap,
    noun: 'breaches',
  });
  y = chrome.drawSectionHeading(doc, disclosure.heading, y + 2);
  if (disclosure.note) y = drawProse(doc, chrome, disclosure.note, y + 1);
  if (summary.breaches.rows.length === 0) {
    if (summary.breaches.available === 0) y = drawProse(doc, chrome, 'No breaches in this period.', y + 1, 9);
  } else {
    autoTable(doc, {
      ...tableStyles,
      startY: y + 1,
      head: [[
        'Ticket',
        ...(summary.includeSubjects ? ['Subject'] : []),
        'Priority', 'Target', 'SLA', 'Due', 'Completed', 'Time on SLA clock', 'Over by',
      ]],
      body: summary.breaches.rows.slice(0, BREACH_TABLE_MAX).map((r) => breachCells(r, summary)),
    });
    y = finalY(y);
  }

  // --- Notes -----------------------------------------------------------------
  // A long table can leave too little of the page for even the heading.
  if (y > PAGE.footY - 20) {
    doc.addPage();
    chrome.drawHeaderBand(doc);
    chrome.drawFooter(doc);
    y = PAGE.bandH + 8;
  }
  drawNotes(doc, chrome, summary.notes, y + 2);
}
