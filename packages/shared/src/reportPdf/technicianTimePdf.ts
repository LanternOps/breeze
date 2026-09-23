/**
 * Technician time & billability PDF (#3198 W02 R2, spec §3.3 R2 as amended
 * 2026-09-21).
 *
 * Minutes semantics mirror the generator
 * (`apps/api/src/services/businessReports/technicianTimeReport.ts`):
 * utilization and billable % use `duration_minutes`; billing conversion uses
 * `billable_minutes` on both sides; money is per currency, never summed
 * across currencies (OD-4 = A).
 *
 * THREE RULES THIS FILE OBEYS (identityAccessPdf.ts precedent):
 *  1. A null ratio prints N/A via `formatPercent(null)`/`formatMinutes(null)`,
 *     never 0% / 0m.
 *  2. Money is printed only through `formatMoney`, one row per currency, and
 *     never totalled across rows in this renderer.
 *  3. `summary.notes` is printed verbatim, before any number.
 *
 * Declared `PdfChrome`, not imported: importing reportPdf.ts from here would
 * be a module cycle (same shape as identityAccessPdf.ts:43-53).
 */
import type { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type {
  CurrencyAmountRow,
  ReportScopeMeta,
  TechnicianTimeDetailRow,
  TechnicianTimeGroupRow,
  TechnicianTimeSummary,
} from '../types/businessReports';
import { detailDisclosure } from './detailDisclosure';
import { formatMinutes, formatMoney, formatPercent } from './moneyFormat';

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

export type TechnicianTimePdfOpts = {
  generatedAt: string;
  partnerName: string | null;
  contactEmail?: string | null;
  contactName?: string | null;
  previous?: { generatedAt?: string | null; summary?: unknown };
};

const ink = (doc: jsPDF, c: RGB) => doc.setTextColor(c[0], c[1], c[2]);

/** The one string that stands for "we did not measure this". Never `0`. */
const NA = 'N/A';

/** Rows of the entries table beyond this are dropped from the PDF only; the
 *  generator already capped and disclosed the underlying set. */
const DETAIL_TABLE_MAX = 500;

const GROUP_BY_LABEL: Record<TechnicianTimeSummary['groupBy'], string> = {
  technician: 'technician',
  organization: 'organization',
  work_type: 'work type',
};

function wrapText(doc: jsPDF, text: string, width: number): string[] {
  return doc.splitTextToSize(text, width) as string[];
}

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

function dateTime(value: string | null | undefined): string {
  if (!value) return NA;
  return `${value.slice(0, 10)} ${value.slice(11, 16)}`;
}

function finalY(doc: jsPDF, fallback: number): number {
  return ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? fallback) + 6;
}

/** `rate` matched to the same currency as `value`, or `null` when there is
 *  none (a currency can have billable value with no averaged rate row). */
function rateFor(rate: CurrencyAmountRow[], currencyCode: string): string | null {
  return rate.find((r) => r.currencyCode === currencyCode)?.amount ?? null;
}

export function renderTechnicianTimeReport(
  doc: jsPDF,
  summary: TechnicianTimeSummary,
  opts: TechnicianTimePdfOpts,
  chrome: PdfChrome,
): void {
  const { C, PAGE } = chrome;

  let y = chrome.drawTitleBlock(
    doc,
    'Technician time & billability',
    scopeLabel(summary.scope),
    `${summary.period.label} · ${summary.period.timeZone} · Prepared ${opts.generatedAt}`,
    PAGE.bandH + 14,
  );

  // --- How these numbers are built ---------------------------------------------
  y = chrome.drawSectionHeading(doc, 'How these numbers are built', y + 6);
  for (const note of summary.notes) {
    y = drawProse(doc, chrome, note, y + 1, 8.6, C.muted);
  }

  // --- Headline ----------------------------------------------------------------
  y = chrome.drawSectionHeading(doc, 'Headline', y + 4);
  y = drawTiles(doc, chrome, [
    { value: formatPercent(summary.overall.utilization), label: 'Utilization', unmeasured: summary.overall.utilization == null },
    { value: formatPercent(summary.overall.billablePercent), label: 'Billable %', unmeasured: summary.overall.billablePercent == null },
    { value: formatPercent(summary.overall.billingConversion), label: 'Billing conversion', unmeasured: summary.overall.billingConversion == null },
    { value: String(summary.zeroTimeTechnicians), label: 'Zero-time technicians' },
  ], y + 2);

  // --- By <groupBy> --------------------------------------------------------------
  y = chrome.drawSectionHeading(doc, `By ${GROUP_BY_LABEL[summary.groupBy]}`, y + 4);
  if (summary.groups.length === 0) {
    y = drawProse(doc, chrome, 'No time logged in the covered window.', y + 1, 9, C.muted);
  } else {
    autoTable(doc, {
      startY: y + 1,
      margin: { left: PAGE.mx, right: PAGE.mx, top: PAGE.bandH + 8, bottom: 14 },
      head: [[GROUP_BY_LABEL[summary.groupBy], 'Logged', 'Capacity', 'Utilization', 'Billable', 'Included', 'Non-billable', 'Billable %', 'Billed', 'Billing conv.']],
      body: summary.groups.map((g: TechnicianTimeGroupRow) => [
        g.groupLabel,
        formatMinutes(g.loggedMinutes),
        formatMinutes(g.capacityMinutes),
        formatPercent(g.utilization),
        formatMinutes(g.billableMinutes),
        formatMinutes(g.includedMinutes),
        formatMinutes(g.nonBillableMinutes),
        formatPercent(g.billablePercent),
        formatMinutes(g.billedMinutes),
        formatPercent(g.billingConversion),
      ]),
      styles: { font: 'helvetica', fontSize: 7, cellPadding: 1.6, textColor: C.ink, lineColor: C.rule, lineWidth: 0.1 },
      headStyles: { fillColor: C.panel, textColor: C.ink, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: C.zebra },
      didDrawPage: () => {
        chrome.drawHeaderBand(doc);
        chrome.drawFooter(doc);
      },
    });
    y = finalY(doc, y);
  }

  // --- Billable value, one row per currency -------------------------------------
  y = chrome.drawSectionHeading(doc, 'Billable value', y + 2);
  // Fix round item 3: unpriced billable time is excluded from every value row,
  // so an empty value table is NOT "no billable value" when such time exists.
  const unpriced = summary.unpricedBillable ?? { minutes: 0, entries: 0 };
  if (unpriced.minutes > 0 || unpriced.entries > 0) {
    y = drawProse(
      doc,
      chrome,
      `${unpriced.minutes} billable minutes (${unpriced.entries} entr${unpriced.entries === 1 ? 'y' : 'ies'}) have no hourly rate or currency and are not valued below.`,
      y + 1, 9, C.warning,
    );
  }
  if (summary.overall.billableValue.length === 0) {
    y = drawProse(
      doc,
      chrome,
      unpriced.minutes > 0 || unpriced.entries > 0
        ? 'No priced billable time in the covered window.'
        : 'No billable value recorded in the covered window.',
      y + 1, 9, C.muted,
    );
  } else {
    autoTable(doc, {
      startY: y + 1,
      margin: { left: PAGE.mx, right: PAGE.mx, top: PAGE.bandH + 8, bottom: 14 },
      head: [['Currency', 'Billable value', 'Average rate']],
      body: summary.overall.billableValue.map((v: CurrencyAmountRow) => [
        v.currencyCode,
        formatMoney(v.amount, v.currencyCode),
        (() => {
          const r = rateFor(summary.overall.averageRate, v.currencyCode);
          return r === null ? NA : formatMoney(r, v.currencyCode);
        })(),
      ]),
      styles: { font: 'helvetica', fontSize: 8, cellPadding: 1.8, textColor: C.ink, lineColor: C.rule, lineWidth: 0.1 },
      headStyles: { fillColor: C.panel, textColor: C.ink, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: C.zebra },
      didDrawPage: () => {
        chrome.drawHeaderBand(doc);
        chrome.drawFooter(doc);
      },
    });
    y = finalY(doc, y);
  }

  // --- Entries -------------------------------------------------------------------
  const disclosure = detailDisclosure({
    base: 'Entries',
    inHand: summary.rows.length,
    total: summary.detail.truncated ? summary.detail.available : summary.rows.length,
    pdfMax: DETAIL_TABLE_MAX,
    storedCap: summary.detail.cap,
  });
  y = chrome.drawSectionHeading(doc, disclosure.heading, y + 2);
  if (disclosure.note) y = drawProse(doc, chrome, disclosure.note, y + 1, 8.6, C.muted);
  if (summary.rows.length === 0) {
    y = drawProse(doc, chrome, 'No time entries in the covered window.', y + 1, 9, C.muted);
  } else {
    autoTable(doc, {
      startY: y + 1,
      margin: { left: PAGE.mx, right: PAGE.mx, top: PAGE.bandH + 8, bottom: 14 },
      head: [['Started', 'Technician', 'Organization', 'Work type', 'Duration', 'Billable', 'Coverage', 'Billing status', 'Approved', 'Rate']],
      body: summary.rows.slice(0, DETAIL_TABLE_MAX).map((r: TechnicianTimeDetailRow) => [
        dateTime(r.startedAt),
        r.userName ?? NA,
        r.orgName ?? (r.orgId ? 'Unknown organization' : 'No organization'),
        r.workTypeName ?? NA,
        formatMinutes(r.durationMinutes),
        formatMinutes(r.billableMinutes),
        r.coverage,
        r.billingStatus,
        r.isApproved ? 'Yes' : 'No',
        r.hourlyRate && r.currencyCode ? formatMoney(r.hourlyRate, r.currencyCode) : NA,
      ]),
      styles: { font: 'helvetica', fontSize: 7, cellPadding: 1.6, textColor: C.ink, lineColor: C.rule, lineWidth: 0.1 },
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
