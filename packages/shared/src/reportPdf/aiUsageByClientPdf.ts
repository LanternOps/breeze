/**
 * AI usage by client PDF (#7608 W10), mirror of arAgingPdf.ts.
 *
 * The generator is `apps/api/src/services/businessReports/aiUsageByClientReport.ts`.
 *
 * THREE RULES THIS FILE OBEYS (arAgingPdf.ts / identityAccessPdf.ts precedent):
 *  1. Money is printed only through `formatMoney`, one entry per currency, and
 *     NEVER totalled across currencies. Breeze cost is USD and is its own
 *     column; it is never added to a chargeable amount.
 *  2. `summary.notes` is printed verbatim, before any number.
 *  3. A group with no chargeable amount prints '-', not 0.00: "nothing to
 *     charge" is a statement, a zero in a currency the client may not even use
 *     is an invented figure.
 *
 * Declared `PdfChrome`, not imported: importing reportPdf.ts from here would be
 * a module cycle (same shape as arAgingPdf.ts).
 */
import type { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type {
  AiUsageByClientChargeRow,
  AiUsageByClientDetailRow,
  AiUsageByClientGroupRow,
  AiUsageByClientSummary,
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

export type AiUsageByClientPdfOpts = {
  generatedAt: string;
  partnerName: string | null;
  contactEmail?: string | null;
  contactName?: string | null;
  previous?: { generatedAt?: string | null; summary?: unknown };
};

const ink = (doc: jsPDF, c: RGB) => doc.setTextColor(c[0], c[1], c[2]);

/** Rows of the detail table beyond this are dropped from the PDF only; the
 *  generator already capped and disclosed the underlying set. */
const DETAIL_TABLE_MAX = 500;

/** "No charge to print" in a money cell. */
const NONE = '-';

const GROUP_BY_LABEL: Record<AiUsageByClientSummary['groupBy'], string> = {
  organization: 'organization',
  model: 'model',
};

const count = (n: number): string => Math.trunc(n).toLocaleString('en-US');

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

function finalY(doc: jsPDF, fallback: number): number {
  return ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? fallback) + 6;
}

/** One cell listing each currency's figure on its own line. Each line is
 *  formatted for that line's OWN currency; nothing is summed. */
function moneyCell(charges: readonly AiUsageByClientChargeRow[], field: 'amount' | 'billed' | 'unbilled'): string {
  if (charges.length === 0) return NONE;
  return charges.map((c) => formatMoney(c[field], c.currencyCode)).join('\n');
}

/** A detail row's single (nullable) currency figure. */
function detailMoney(value: string | null, currency: string | null): string {
  return value === null || currency === null ? NONE : formatMoney(value, currency);
}

function tokenCells(r: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): string[] {
  return [count(r.inputTokens), count(r.outputTokens), count(r.cacheReadTokens), count(r.cacheWriteTokens)];
}

const TABLE_STYLE = (C: PdfChrome['C'], size: number) => ({
  styles: { font: 'helvetica', fontSize: size, cellPadding: 1.6, textColor: C.ink, lineColor: C.rule, lineWidth: 0.1 },
  headStyles: { fillColor: C.panel, textColor: C.ink, fontStyle: 'bold' as const },
  alternateRowStyles: { fillColor: C.zebra },
});

export function renderAiUsageByClientReport(
  doc: jsPDF,
  summary: AiUsageByClientSummary,
  opts: AiUsageByClientPdfOpts,
  chrome: PdfChrome,
): void {
  const { C, PAGE } = chrome;
  const margin = { left: PAGE.mx, right: PAGE.mx, top: PAGE.bandH + 8, bottom: 14 };
  const didDrawPage = () => {
    chrome.drawHeaderBand(doc);
    chrome.drawFooter(doc);
  };

  let y = chrome.drawTitleBlock(
    doc,
    'AI usage by client',
    scopeLabel(summary.scope),
    `${summary.period.label} · ${summary.period.timeZone} · Prepared ${opts.generatedAt}`,
    PAGE.bandH + 14,
  );

  // --- Basis ---------------------------------------------------------------
  y = chrome.drawSectionHeading(doc, 'Basis', y + 6);
  for (const note of summary.notes) {
    y = drawProse(doc, chrome, note, y + 1, 8.6, C.muted);
  }

  // --- Totals ----------------------------------------------------------------
  const o = summary.overall;
  y = chrome.drawSectionHeading(doc, 'Totals', y + 4);
  y = drawProse(
    doc,
    chrome,
    `${count(o.requests)} requests · ${count(o.inputTokens + o.outputTokens + o.cacheReadTokens + o.cacheWriteTokens)} tokens · `
    + `Breeze cost ${formatMoney(o.costUsd, 'USD')} · included usage cost ${formatMoney(o.includedCostUsd, 'USD')} · `
    + `${count(o.unpricedRequests)} unpriced`,
    y + 1, 9,
  );

  // --- Per currency ------------------------------------------------------------
  y = chrome.drawSectionHeading(doc, 'Per currency', y + 2);
  if (o.charges.length === 0) {
    y = drawProse(doc, chrome, 'No chargeable amount in any currency.', y + 1, 9, C.muted);
  } else {
    autoTable(doc, {
      startY: y + 1,
      margin,
      head: [['Currency', 'Chargeable', 'Billed', 'Unbilled']],
      body: o.charges.map((c) => [
        c.currencyCode,
        formatMoney(c.amount, c.currencyCode),
        formatMoney(c.billed, c.currencyCode),
        formatMoney(c.unbilled, c.currencyCode),
      ]),
      ...TABLE_STYLE(C, 7.4),
      didDrawPage,
    });
    y = finalY(doc, y);
  }

  // --- By <groupBy> ------------------------------------------------------------
  y = chrome.drawSectionHeading(doc, `By ${GROUP_BY_LABEL[summary.groupBy]}`, y + 2);
  if (summary.groups.length === 0) {
    y = drawProse(doc, chrome, 'No AI usage in the covered scope for this period.', y + 1, 9, C.muted);
  } else {
    autoTable(doc, {
      startY: y + 1,
      margin,
      head: [[GROUP_BY_LABEL[summary.groupBy], 'Requests', 'Input tokens', 'Output tokens', 'Cache read', 'Cache write',
        'Breeze cost (USD)', 'Chargeable', 'Billed', 'Unbilled', 'Included cost (USD)', 'Unpriced']],
      body: summary.groups.map((g: AiUsageByClientGroupRow) => [
        g.groupLabel,
        count(g.requests),
        ...tokenCells(g),
        formatMoney(g.costUsd, 'USD'),
        moneyCell(g.charges, 'amount'),
        moneyCell(g.charges, 'billed'),
        moneyCell(g.charges, 'unbilled'),
        formatMoney(g.includedCostUsd, 'USD'),
        count(g.unpricedRequests),
      ]),
      ...TABLE_STYLE(C, 6.8),
      didDrawPage,
    });
    y = finalY(doc, y);
  }

  // --- Detail ---------------------------------------------------------------------
  const disclosure = detailDisclosure({
    base: 'Organization x model',
    inHand: summary.rows.length,
    total: summary.detail.truncated ? summary.detail.available : summary.rows.length,
    pdfMax: DETAIL_TABLE_MAX,
    storedCap: summary.detail.cap,
  });
  y = chrome.drawSectionHeading(doc, disclosure.heading, y + 2);
  if (disclosure.note) y = drawProse(doc, chrome, disclosure.note, y + 1, 8.6, C.muted);
  if (summary.rows.length === 0) {
    y = drawProse(doc, chrome, 'No AI usage in the covered scope for this period.', y + 1, 9, C.muted);
  } else {
    autoTable(doc, {
      startY: y + 1,
      margin,
      head: [['Organization', 'Model', 'Currency', 'Requests', 'Input tokens', 'Output tokens', 'Cache read', 'Cache write',
        'Breeze cost (USD)', 'Chargeable', 'Billed', 'Unbilled', 'Unpriced']],
      body: summary.rows.slice(0, DETAIL_TABLE_MAX).map((r: AiUsageByClientDetailRow) => [
        r.orgName ?? r.orgId,
        r.model,
        r.currencyCode ?? NONE,
        count(r.requests),
        ...tokenCells(r),
        formatMoney(r.costUsd, 'USD'),
        detailMoney(r.amount, r.currencyCode),
        detailMoney(r.billed, r.currencyCode),
        detailMoney(r.unbilled, r.currencyCode),
        count(r.unpricedRequests),
      ]),
      ...TABLE_STYLE(C, 6.6),
      didDrawPage,
    });
    y = finalY(doc, y);
  }
}
