/**
 * AR aging PDF (#3198 W02 R3, spec §3.3 R3).
 *
 * The bucket set matches the generator
 * (`apps/api/src/services/businessReports/arAgingReport.ts`) exactly: current,
 * 1-30, 31-60, 61-90, 90+ and no-due-date, all AR-open (sent /
 * partially_paid / overdue). Any open balance outside that set is reported on
 * the `otherOpenBalance` reconciliation line, so buckets + other open balance
 * = total open balance, per currency.
 *
 * THREE RULES THIS FILE OBEYS (identityAccessPdf.ts precedent):
 *  1. There is no unmeasured ratio in this type; N/A does not apply here.
 *  2. Money is printed only through `formatMoney`, one row per currency, and
 *     NEVER totalled across currencies — not in the per-currency table, not
 *     anywhere else in this file.
 *  3. `summary.notes` is printed verbatim, before any number.
 *
 * Declared `PdfChrome`, not imported: importing reportPdf.ts from here would
 * be a module cycle (same shape as identityAccessPdf.ts:43-53).
 */
import type { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type {
  ArAgingBucket,
  ArAgingDetailRow,
  ArAgingGroupRow,
  ArAgingSummary,
  CurrencyAmountRow,
  ReportScopeMeta,
} from '../types/businessReports';
import { detailDisclosure } from './detailDisclosure';
import { formatMoney } from './moneyFormat';

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

export type ArAgingPdfOpts = {
  generatedAt: string;
  partnerName: string | null;
  contactEmail?: string | null;
  contactName?: string | null;
  previous?: { generatedAt?: string | null; summary?: unknown };
};

const ink = (doc: jsPDF, c: RGB) => doc.setTextColor(c[0], c[1], c[2]);

/** The one string that stands for "we did not measure this". Never `0`. */
const NA = 'N/A';

/** Rows of the open-invoices table beyond this are dropped from the PDF only;
 *  the generator already capped and disclosed the underlying set. */
const DETAIL_TABLE_MAX = 500;

const BUCKETS: readonly ArAgingBucket[] = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus', 'no_due_date'];
const BUCKET_LABEL: Record<ArAgingBucket, string> = {
  current: 'Current',
  d1_30: '1-30',
  d31_60: '31-60',
  d61_90: '61-90',
  d90_plus: '90+',
  no_due_date: 'No due date',
};

const GROUP_BY_LABEL: Record<ArAgingSummary['groupBy'], string> = {
  organization: 'organization',
  currency: 'currency',
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

function scopeLabel(scope: ReportScopeMeta): string {
  return scope.kind === 'organization'
    ? (scope.orgName ?? '')
    : `Partner-wide · ${scope.orgCount} organization${scope.orgCount === 1 ? '' : 's'}`;
}

function dateOnly(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : NA;
}

function finalY(doc: jsPDF, fallback: number): number {
  return ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? fallback) + 6;
}

/** One bucket row's cells, formatted through `formatMoney` for that row's OWN
 *  currency only — never summed with any other row's amount. */
function bucketCells(row: ArAgingGroupRow): string[] {
  return [
    ...BUCKETS.map((b) => formatMoney(row.buckets[b], row.currencyCode)),
    formatMoney(row.openTotal, row.currencyCode),
    String(row.invoiceCount),
  ];
}

export function renderArAgingReport(
  doc: jsPDF,
  summary: ArAgingSummary,
  opts: ArAgingPdfOpts,
  chrome: PdfChrome,
): void {
  const { C, PAGE } = chrome;

  let y = chrome.drawTitleBlock(
    doc,
    'AR aging',
    scopeLabel(summary.scope),
    `As of ${summary.asOf} (${summary.timeZone})`,
    PAGE.bandH + 14,
  );

  // --- Basis ---------------------------------------------------------------
  y = chrome.drawSectionHeading(doc, 'Basis', y + 6);
  for (const note of summary.notes) {
    y = drawProse(doc, chrome, note, y + 1, 8.6, C.muted);
  }

  const bucketHead = [['Currency', ...BUCKETS.map((b) => BUCKET_LABEL[b]), 'Open total', 'Invoices']];

  // --- Per currency ----------------------------------------------------------
  y = chrome.drawSectionHeading(doc, 'Per currency', y + 4);
  if (summary.byCurrency.length === 0) {
    y = drawProse(doc, chrome, 'No open invoices in any currency.', y + 1, 9, C.muted);
  } else {
    autoTable(doc, {
      startY: y + 1,
      margin: { left: PAGE.mx, right: PAGE.mx, top: PAGE.bandH + 8, bottom: 14 },
      head: bucketHead,
      body: summary.byCurrency.map((row: ArAgingGroupRow) => [row.currencyCode, ...bucketCells(row)]),
      styles: { font: 'helvetica', fontSize: 7.2, cellPadding: 1.6, textColor: C.ink, lineColor: C.rule, lineWidth: 0.1 },
      headStyles: { fillColor: C.panel, textColor: C.ink, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: C.zebra },
      didDrawPage: () => {
        chrome.drawHeaderBand(doc);
        chrome.drawFooter(doc);
      },
    });
    y = finalY(doc, y);
  }

  // --- By <groupBy> ------------------------------------------------------------
  y = chrome.drawSectionHeading(doc, `By ${GROUP_BY_LABEL[summary.groupBy]}`, y + 2);
  if (summary.groups.length === 0) {
    y = drawProse(doc, chrome, 'No open invoices in the covered scope.', y + 1, 9, C.muted);
  } else {
    autoTable(doc, {
      startY: y + 1,
      margin: { left: PAGE.mx, right: PAGE.mx, top: PAGE.bandH + 8, bottom: 14 },
      head: [[GROUP_BY_LABEL[summary.groupBy], 'Currency', ...BUCKETS.map((b) => BUCKET_LABEL[b]), 'Open total', 'Invoices']],
      body: summary.groups.map((row: ArAgingGroupRow) => [row.groupLabel, row.currencyCode, ...bucketCells(row)]),
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

  // --- Other open balance — only when non-empty ---------------------------------
  if (summary.otherOpenBalance.length > 0) {
    y = chrome.drawSectionHeading(doc, 'Other open balance', y + 2);
    const parts = summary.otherOpenBalance.map((r: CurrencyAmountRow) => formatMoney(r.amount, r.currencyCode)).join('   ·   ');
    y = drawProse(
      doc,
      chrome,
      `${parts} carries an open balance in a status outside the AR-open set (draft, paid or void). `
      + 'The buckets above plus this line reconcile to total open balance, per currency.',
      y + 1, 9, C.warning,
    );
  }

  // --- Open invoices ----------------------------------------------------------
  const disclosure = detailDisclosure({
    base: 'Open invoices',
    inHand: summary.rows.length,
    total: summary.detail.truncated ? summary.detail.available : summary.rows.length,
    pdfMax: DETAIL_TABLE_MAX,
    storedCap: summary.detail.cap,
  });
  y = chrome.drawSectionHeading(doc, disclosure.heading, y + 2);
  if (disclosure.note) y = drawProse(doc, chrome, disclosure.note, y + 1, 8.6, C.muted);
  if (summary.rows.length === 0) {
    y = drawProse(doc, chrome, 'No open invoices in the covered scope.', y + 1, 9, C.muted);
  } else {
    autoTable(doc, {
      startY: y + 1,
      margin: { left: PAGE.mx, right: PAGE.mx, top: PAGE.bandH + 8, bottom: 14 },
      head: [['Invoice', 'Organization', 'Currency', 'Issue date', 'Due date', 'Total', 'Paid', 'Balance', 'Days overdue', 'Bucket', 'Last payment']],
      body: summary.rows.slice(0, DETAIL_TABLE_MAX).map((r: ArAgingDetailRow) => [
        r.invoiceNumber ?? r.invoiceId,
        r.orgName ?? NA,
        r.currencyCode,
        dateOnly(r.issueDate),
        dateOnly(r.dueDate),
        formatMoney(r.total, r.currencyCode),
        formatMoney(r.amountPaid, r.currencyCode),
        formatMoney(r.balance, r.currencyCode),
        r.daysOverdue === null ? NA : String(r.daysOverdue),
        BUCKET_LABEL[r.bucket],
        dateOnly(r.lastPaymentAt),
      ]),
      styles: { font: 'helvetica', fontSize: 6.8, cellPadding: 1.5, textColor: C.ink, lineColor: C.rule, lineWidth: 0.1 },
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
