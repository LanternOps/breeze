/**
 * Ticket SLA attainment PDF (#3198 W02 R1, spec §3.4).
 *
 * Attainment is recomputed at generation time (see
 * `apps/api/src/services/businessReports/ticketSlaReport.ts`), not read off the
 * `sla_breached_at` stamp — the sweep only marks tickets still open and
 * unanswered when it runs, so the two disagree, and that disagreement is
 * printed rather than hidden (OD-2, OD-3).
 *
 * THREE RULES THIS FILE OBEYS (identityAccessPdf.ts precedent):
 *  1. A null ratio prints N/A via `formatPercent(null)`, never 0%.
 *  2. Money — there is none in this type; nothing here sums across currencies.
 *  3. `summary.notes` is printed verbatim, before any number.
 *
 * Declared `PdfChrome`, not imported: importing reportPdf.ts from here would
 * be a module cycle (same shape as identityAccessPdf.ts:43-53).
 */
import type { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type {
  DetailRowMeta,
  ReportScopeMeta,
  SlaOutcome,
  TicketSlaDetailRow,
  TicketSlaGroupRow,
  TicketSlaSummary,
} from '../types/businessReports';
import { formatPercent } from './moneyFormat';

type RGB = [number, number, number];

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

export type TicketSlaPdfOpts = {
  generatedAt: string;
  partnerName: string | null;
  contactEmail?: string | null;
  contactName?: string | null;
  previous?: { generatedAt?: string | null; summary?: unknown };
};

const ink = (doc: jsPDF, c: RGB) => doc.setTextColor(c[0], c[1], c[2]);

/** The one string that stands for "we did not measure this". Never `0`. */
const NA = 'N/A';

/** Rows of the breached-tickets table beyond this are dropped from the PDF
 *  only; the generator already capped and disclosed the underlying set. */
const DETAIL_TABLE_MAX = 500;

const GROUP_BY_LABEL: Record<TicketSlaSummary['groupBy'], string> = {
  organization: 'organization',
  priority: 'priority',
  technician: 'technician',
  category: 'category',
};

const OUTCOME_LABEL: Record<SlaOutcome, string> = {
  met: 'Met',
  missed: 'Missed',
  pending: 'Pending',
  no_target: 'No target',
};

function wrapText(doc: jsPDF, text: string, width: number): string[] {
  return doc.splitTextToSize(text, width) as string[];
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

/** A row of "big number / label" tiles. A null value prints N/A, in muted ink,
 *  so an unmeasured tile is visually distinct from a measured zero. */
function drawTiles(
  doc: jsPDF,
  chrome: PdfChrome,
  tiles: Array<{ value: string; label: string; unmeasured?: boolean }>,
  y: number,
): number {
  const { C, PAGE } = chrome;
  if (tiles.length === 0) return y;
  const width = PAGE.w - PAGE.mx * 2;
  const tileW = width / tiles.length;
  tiles.forEach((tile, i) => {
    const x = PAGE.mx + i * tileW;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    ink(doc, tile.unmeasured ? C.faint : C.primary);
    doc.text(tile.value, x, y + 6);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.6);
    ink(doc, C.muted);
    wrapText(doc, tile.label, tileW - 4).slice(0, 2).forEach((line, li) => {
      doc.text(line, x, y + 11 + li * 4);
    });
  });
  return y + 22;
}

function scopeLabel(scope: ReportScopeMeta): string {
  return scope.kind === 'organization'
    ? (scope.orgName ?? '')
    : `Partner-wide · ${scope.orgCount} organization${scope.orgCount === 1 ? '' : 's'}`;
}

function dateOnly(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : NA;
}

/** Discloses truncation with BOTH numbers, in one sentence, whichever cap bit:
 *  the generator's stored/available cap (`detail.truncated`) takes priority
 *  since it already accounts for this module's own MAX; otherwise, when only
 *  the module-local slice below MAX kicks in, that pair is reported instead. */
function detailHeading(base: string, totalRows: number, detail: DetailRowMeta): string {
  if (detail.truncated) return `${base} (showing ${detail.stored} of ${detail.available})`;
  if (totalRows > DETAIL_TABLE_MAX) return `${base} (showing ${DETAIL_TABLE_MAX} of ${totalRows})`;
  return base;
}

function finalY(doc: jsPDF, fallback: number): number {
  return ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? fallback) + 6;
}

export function renderTicketSlaReport(
  doc: jsPDF,
  summary: TicketSlaSummary,
  opts: TicketSlaPdfOpts,
  chrome: PdfChrome,
): void {
  const { C, PAGE } = chrome;

  let y = chrome.drawTitleBlock(
    doc,
    'Ticket SLA attainment',
    scopeLabel(summary.scope),
    `${summary.period.label} · ${summary.period.timeZone} · Prepared ${opts.generatedAt}`,
    PAGE.bandH + 14,
  );

  // --- What this measures ------------------------------------------------------
  // The five approximations, verbatim and before any number: they are the
  // price of shipping this report honestly (OD-2, OD-3).
  y = chrome.drawSectionHeading(doc, 'What this measures', y + 6);
  for (const note of summary.notes) {
    y = drawProse(doc, chrome, note, y + 1, 8.6, C.muted);
  }

  // --- Headline ------------------------------------------------------------
  y = chrome.drawSectionHeading(doc, 'Headline', y + 4);
  y = drawTiles(doc, chrome, [
    { value: formatPercent(summary.overall.responseAttainment), label: 'Response attainment', unmeasured: summary.overall.responseAttainment == null },
    { value: formatPercent(summary.overall.resolutionAttainment), label: 'Resolution attainment', unmeasured: summary.overall.resolutionAttainment == null },
    { value: String(summary.overall.breaches), label: 'Breaches' },
    { value: String(summary.overall.noSlaTickets), label: 'Tickets with no SLA' },
  ], y + 2);

  // --- By <groupBy> ----------------------------------------------------------
  y = chrome.drawSectionHeading(doc, `By ${GROUP_BY_LABEL[summary.groupBy]}`, y + 4);
  if (summary.groups.length === 0) {
    y = drawProse(doc, chrome, 'No tickets in the covered window.', y + 1, 9, C.muted);
  } else {
    autoTable(doc, {
      startY: y + 1,
      margin: { left: PAGE.mx, right: PAGE.mx, top: PAGE.bandH + 8, bottom: 14 },
      head: [[GROUP_BY_LABEL[summary.groupBy], 'Tickets', 'Response %', 'Resolution %', 'Breaches', 'No SLA']],
      body: summary.groups.map((g: TicketSlaGroupRow) => [
        g.groupLabel,
        String(g.ticketsTotal),
        formatPercent(g.responseAttainment),
        formatPercent(g.resolutionAttainment),
        String(g.breaches),
        String(g.noSlaTickets),
      ]),
      styles: { font: 'helvetica', fontSize: 7.6, cellPadding: 1.8, textColor: C.ink, lineColor: C.rule, lineWidth: 0.1 },
      headStyles: { fillColor: C.panel, textColor: C.ink, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: C.zebra },
      didDrawPage: () => {
        chrome.drawHeaderBand(doc);
        chrome.drawFooter(doc);
      },
    });
    y = finalY(doc, y);
  }

  // --- Recompute vs stamped ----------------------------------------------------
  y = chrome.drawSectionHeading(doc, 'Recompute vs stamped', y + 2);
  y = drawProse(
    doc,
    chrome,
    `Recomputed breaches not stamped — ${summary.stampDiscrepancy.recomputedBreachNotStamped}`
    + `   ·   Stamped breaches not recomputed — ${summary.stampDiscrepancy.stampedNotRecomputedBreach}`,
    y + 1, 9, C.muted,
  );

  // --- Breached tickets --------------------------------------------------------
  const breachedRows = summary.rows.filter((r: TicketSlaDetailRow) => r.responseOutcome === 'missed' || r.resolutionOutcome === 'missed');
  y = chrome.drawSectionHeading(doc, detailHeading('Breached tickets', summary.rows.length, summary.detail), y + 2);
  if (breachedRows.length === 0) {
    y = drawProse(doc, chrome, 'No breached tickets in the covered window.', y + 1, 9, C.muted);
  } else {
    autoTable(doc, {
      startY: y + 1,
      margin: { left: PAGE.mx, right: PAGE.mx, top: PAGE.bandH + 8, bottom: 14 },
      head: [['Ticket', 'Organization', 'Priority', 'Assignee', 'Created', 'Response', 'Resolution', 'Stamped reason']],
      body: breachedRows.slice(0, DETAIL_TABLE_MAX).map((r: TicketSlaDetailRow) => [
        r.ticketNumber ?? r.internalNumber ?? r.ticketId,
        r.orgName ?? NA,
        r.priority,
        r.assignedToName ?? 'Unassigned',
        dateOnly(r.createdAt),
        OUTCOME_LABEL[r.responseOutcome],
        OUTCOME_LABEL[r.resolutionOutcome],
        r.stampedBreachReason ?? NA,
      ]),
      styles: { font: 'helvetica', fontSize: 7.2, cellPadding: 1.8, textColor: C.ink, lineColor: C.rule, lineWidth: 0.1 },
      headStyles: { fillColor: C.panel, textColor: C.ink, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: C.zebra },
      didDrawPage: () => {
        chrome.drawHeaderBand(doc);
        chrome.drawFooter(doc);
      },
    });
    y = finalY(doc, y);
  }
}
