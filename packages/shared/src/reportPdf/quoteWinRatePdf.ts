/**
 * Quote win rate PDF (#9828 W2), mirror of aiUsageByClientPdf.ts.
 *
 * The generator is `apps/api/src/services/businessReports/quoteWinRateReport.ts`.
 *
 * THREE RULES THIS FILE OBEYS (arAgingPdf.ts / aiUsageByClientPdf.ts precedent):
 *  1. Money is printed only through `formatMoney`, one entry per currency, and
 *     NEVER totalled across currencies.
 *  2. `summary.notes` is printed verbatim, before any number.
 *  3. An unmeasured rate prints N/A (`formatPercent`), never 0%: with nothing
 *     decided there IS no win rate. The headline is decided-only (OD5-A) and
 *     always prints the still-open count beside it.
 *
 * Declared `PdfChrome`, not imported: importing reportPdf.ts from here would be
 * a module cycle (same shape as arAgingPdf.ts).
 */
import type { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type {
  QuoteWinRateDetailRow,
  QuoteWinRateGroupBy,
  QuoteWinRateGroupRow,
  QuoteWinRateMoneyRow,
  QuoteWinRateSummary,
  ReportScopeMeta,
} from '../types/businessReports';
import { detailDisclosure } from './detailDisclosure';
import { formatMoney, formatPercent } from './moneyFormat';

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

export type QuoteWinRatePdfOpts = {
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

/** "Nothing to print" in a cell. */
const NONE = '-';

const GROUP_BY_LABEL: Record<QuoteWinRateGroupBy, string> = {
  organization: 'organization',
  author: 'author',
  currency: 'currency',
};

const OUTCOME_LABEL: Record<QuoteWinRateDetailRow['outcome'], string> = {
  won: 'Won',
  lost: 'Lost',
  expired: 'Expired',
  open: 'Open',
  anomaly: 'Anomaly',
};

const count = (n: number): string => Math.trunc(n).toLocaleString('en-US');
const days = (v: number | null): string => (v === null ? NONE : `${v.toFixed(1)} days`);
const day = (iso: string | null): string => (iso ? iso.slice(0, 10) : NONE);

function wrapText(doc: jsPDF, text: string, width: number): string[] {
  return doc.splitTextToSize(text, width) as string[];
}

/** Start a fresh page (with chrome) when `needed` mm will not fit. */
function ensureSpace(doc: jsPDF, chrome: PdfChrome, y: number, needed: number): number {
  if (y + needed <= chrome.PAGE.footY - 6) return y;
  doc.addPage();
  chrome.drawHeaderBand(doc);
  chrome.drawFooter(doc);
  return chrome.PAGE.bandH + 10;
}

/** Section heading that never lands in the footer: keeps ~30 mm for what follows. */
function heading(doc: jsPDF, chrome: PdfChrome, text: string, y: number): number {
  return chrome.drawSectionHeading(doc, text, ensureSpace(doc, chrome, y, 30));
}

function drawProse(doc: jsPDF, chrome: PdfChrome, text: string, y0: number, size = 9.5, color?: RGB): number {
  const { C, PAGE } = chrome;
  const width = PAGE.w - PAGE.mx * 2;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(size);
  ink(doc, color ?? C.ink);
  const lines = wrapText(doc, text, width);
  const lineH = size * 0.56;
  let y = y0;
  lines.forEach((line) => {
    y = ensureSpace(doc, chrome, y, lineH);
    doc.text(line, PAGE.mx, y);
    y += lineH;
  });
  return y + 2.5;
}

function scopeLabel(scope: ReportScopeMeta): string {
  return scope.kind === 'organization'
    ? (scope.orgName ?? '')
    : `Partner-wide · ${scope.orgCount} organization${scope.orgCount === 1 ? '' : 's'}`;
}

function finalY(doc: jsPDF, fallback: number): number {
  return ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? fallback) + 6;
}

/** One cell listing each currency's figure on its own line, each formatted for
 *  its OWN currency; nothing is summed. */
function perCurrency(money: readonly QuoteWinRateMoneyRow[], pick: (m: QuoteWinRateMoneyRow) => string): string {
  return money.length === 0 ? NONE : money.map(pick).join('\n');
}

const TABLE_STYLE = (C: PdfChrome['C'], size: number) => ({
  styles: { font: 'helvetica', fontSize: size, cellPadding: 1.6, textColor: C.ink, lineColor: C.rule, lineWidth: 0.1 },
  headStyles: { fillColor: C.panel, textColor: C.ink, fontStyle: 'bold' as const },
  alternateRowStyles: { fillColor: C.zebra },
});

export function renderQuoteWinRateReport(
  doc: jsPDF,
  summary: QuoteWinRateSummary,
  opts: QuoteWinRatePdfOpts,
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
    'Quote win rate',
    scopeLabel(summary.scope),
    `${summary.period.label} · ${summary.period.timeZone} · Prepared ${opts.generatedAt}`,
    PAGE.bandH + 14,
  );

  // --- Basis ---------------------------------------------------------------
  y = heading(doc, chrome, 'Basis', y + 6);
  for (const note of summary.notes) {
    y = drawProse(doc, chrome, note, y + 1, 8.6, C.muted);
  }

  // --- Headline: decided-only win rate, the open count beside it ----------
  const o = summary.overall;
  const decided = o.won + o.lost + o.expired;
  y = heading(doc, chrome, 'Win rate', y + 4);
  y = drawProse(
    doc,
    chrome,
    `${formatPercent(o.winRate)} win rate · ${count(o.won)} won of ${count(decided)} decided · ${count(o.open)} still open`,
    y + 1, 12,
  );
  y = drawProse(
    doc,
    chrome,
    `${count(o.lineages)} opportunities · close rate ${formatPercent(o.closeRate)} (won of all) · `
    + `viewed rate ${formatPercent(o.viewedRate)} · median ${days(o.medianDaysToWin)} to win · median ${days(o.medianDaysToLoss)} to loss`,
    y, 9,
  );
  y = drawProse(
    doc,
    chrome,
    `${count(o.won)} won · ${count(o.lost)} lost · ${count(o.expired)} expired · ${count(o.open)} open`
    + (o.anomalies > 0 ? ` · ${count(o.anomalies)} anomalies (excluded)` : ''),
    y, 9, C.muted,
  );

  // --- Per currency ------------------------------------------------------------
  y = heading(doc, chrome, 'Value per currency', y + 2);
  if (o.money.length === 0) {
    y = drawProse(doc, chrome, 'No quoted value in any currency.', y + 1, 9, C.muted);
  } else {
    autoTable(doc, {
      startY: y + 1,
      margin,
      head: [['Currency', 'Quoted one-time', 'Won one-time', 'Quoted monthly recurring', 'Won monthly recurring', 'Value win rate']],
      body: o.money.map((m) => [
        m.currencyCode,
        formatMoney(m.quotedOneTime, m.currencyCode),
        formatMoney(m.wonOneTime, m.currencyCode),
        formatMoney(m.quotedMonthlyRecurring, m.currencyCode),
        formatMoney(m.wonMonthlyRecurring, m.currencyCode),
        formatPercent(m.valueWinRate),
      ]),
      ...TABLE_STYLE(C, 7.4),
      didDrawPage,
    });
    y = finalY(doc, y);
  }

  // --- By <groupBy> ------------------------------------------------------------
  y = heading(doc, chrome, `By ${GROUP_BY_LABEL[summary.groupBy]}`, y + 2);
  if (summary.groups.length === 0) {
    y = drawProse(doc, chrome, 'No quotes were sent in the covered scope for this period.', y + 1, 9, C.muted);
  } else {
    autoTable(doc, {
      startY: y + 1,
      margin,
      head: [[GROUP_BY_LABEL[summary.groupBy], 'Opportunities', 'Won', 'Lost', 'Expired', 'Open', 'Win rate', 'Close rate',
        'Viewed rate', 'Median days to win', 'Median days to loss', 'Won one-time', 'Won monthly recurring', 'Value win rate']],
      body: summary.groups.map((g: QuoteWinRateGroupRow) => [
        g.groupLabel,
        count(g.lineages),
        count(g.won),
        count(g.lost),
        count(g.expired),
        count(g.open),
        formatPercent(g.winRate),
        formatPercent(g.closeRate),
        formatPercent(g.viewedRate),
        days(g.medianDaysToWin),
        days(g.medianDaysToLoss),
        perCurrency(g.money, (m) => formatMoney(m.wonOneTime, m.currencyCode)),
        perCurrency(g.money, (m) => formatMoney(m.wonMonthlyRecurring, m.currencyCode)),
        perCurrency(g.money, (m) => `${m.currencyCode} ${formatPercent(m.valueWinRate)}`),
      ]),
      ...TABLE_STYLE(C, 6.8),
      didDrawPage,
    });
    y = finalY(doc, y);
  }

  // --- Detail ---------------------------------------------------------------------
  const disclosure = detailDisclosure({
    base: 'Opportunities',
    inHand: summary.rows.length,
    total: summary.detail.truncated ? summary.detail.available : summary.rows.length,
    pdfMax: DETAIL_TABLE_MAX,
    storedCap: summary.detail.cap,
  });
  y = heading(doc, chrome, disclosure.heading, y + 2);
  if (disclosure.note) y = drawProse(doc, chrome, disclosure.note, y + 1, 8.6, C.muted);
  if (summary.rows.length === 0) {
    drawProse(doc, chrome, 'No quotes were sent in the covered scope for this period.', y + 1, 9, C.muted);
  } else {
    autoTable(doc, {
      startY: y + 1,
      margin,
      head: [['Quote', 'Organization', 'Author', 'Versions', 'First sent', 'Outcome', 'Outcome date', 'Currency',
        'One-time', 'Monthly recurring', 'Decline reason']],
      body: summary.rows.slice(0, DETAIL_TABLE_MAX).map((r: QuoteWinRateDetailRow) => [
        r.quoteNumber ?? NONE,
        r.orgName ?? r.orgId,
        r.authorName,
        count(r.versions),
        day(r.firstSentAt),
        OUTCOME_LABEL[r.outcome],
        day(r.outcomeAt),
        r.currencyCode,
        formatMoney(r.oneTimeTotal, r.currencyCode),
        formatMoney(r.monthlyRecurringValue, r.currencyCode),
        r.declineReason ?? NONE,
      ]),
      ...TABLE_STYLE(C, 6.6),
      didDrawPage,
    });
  }
}
