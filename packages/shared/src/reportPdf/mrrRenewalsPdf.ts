/**
 * MRR & renewals PDF (#9828), mirror of arAgingPdf.ts.
 *
 * The generator is `apps/api/src/services/businessReports/mrrRenewalsReport.ts`.
 * MRR is measured at run time (contracts keep no status history), so the only
 * comparison offered is "vs previous observation": the prior run's own figures,
 * never a "last month" claim.
 *
 * RULES THIS FILE OBEYS (arAgingPdf.ts precedent):
 *  1. Money is printed only through `formatMoney`, one row per currency, and
 *     NEVER totalled across currencies.
 *  2. `summary.notes` is printed verbatim, before any number.
 *  3. The previous-observation chip appears only when the prior summary has the
 *     same shape (`asOf` string + `byCurrency` array) and the same currency.
 *
 * Declared `PdfChrome`, not imported: importing reportPdf.ts from here would be
 * a module cycle (same shape as arAgingPdf.ts).
 */
import type { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type {
  MrrBilledMonth,
  MrrContractDetailRow,
  MrrCurrencyTotals,
  MrrRenewalsSummary,
  ReportScopeMeta,
} from '../types/businessReports';
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

export type MrrRenewalsPdfOpts = {
  generatedAt: string;
  partnerName: string | null;
  contactEmail?: string | null;
  contactName?: string | null;
  previous?: { generatedAt?: string | null; summary?: unknown };
};

const ink = (doc: jsPDF, c: RGB) => doc.setTextColor(c[0], c[1], c[2]);

const NA = 'N/A';

/** Renewal-window rows beyond this are dropped from the PDF only. */
const RENEWAL_TABLE_MAX = 500;

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
  const lines = doc.splitTextToSize(text, width) as string[];
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

function dateOnly(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : NA;
}

function finalY(doc: jsPDF, fallback: number): number {
  return ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? fallback) + 6;
}

const TABLE_STYLE = (C: PdfChrome['C'], size: number) => ({
  styles: { font: 'helvetica', fontSize: size, cellPadding: 1.6, textColor: C.ink, lineColor: C.rule, lineWidth: 0.1 },
  headStyles: { fillColor: C.panel, textColor: C.ink, fontStyle: 'bold' as const },
  alternateRowStyles: { fillColor: C.zebra },
});

/** The prior observation's per-currency totals, or null when it is not an MRR
 *  summary of the same shape. */
function previousTotals(previous: MrrRenewalsPdfOpts['previous']): MrrCurrencyTotals[] | null {
  const s = previous?.summary as { asOf?: unknown; byCurrency?: unknown } | null | undefined;
  if (!s || typeof s !== 'object') return null;
  if (typeof s.asOf !== 'string' || !Array.isArray(s.byCurrency)) return null;
  return s.byCurrency as MrrCurrencyTotals[];
}

function previousDate(previous: MrrRenewalsPdfOpts['previous']): string {
  const fromRun = previous?.generatedAt ? previous.generatedAt.slice(0, 10) : '';
  if (fromRun) return fromRun;
  const asOf = (previous?.summary as { asOf?: unknown } | undefined)?.asOf;
  return typeof asOf === 'string' ? asOf.slice(0, 10) : NA;
}

/** Signed per-currency delta; null when either side is not a finite number. */
function signedMoneyDelta(current: string, prior: string, currencyCode: string): string | null {
  const c = Number(current);
  const p = Number(prior);
  if (!Number.isFinite(c) || !Number.isFinite(p)) return null;
  const diff = Math.round((c - p) * 100) / 100;
  const sign = diff > 0 ? '+' : diff < 0 ? '-' : '';
  return `${sign}${formatMoney(Math.abs(diff).toFixed(2), currencyCode)}`;
}

function drawScorecard(
  doc: jsPDF,
  chrome: PdfChrome,
  summary: MrrRenewalsSummary,
  opts: MrrRenewalsPdfOpts,
  startY: number,
): number {
  const { C, PAGE } = chrome;
  let y = startY;
  const prior = previousTotals(opts.previous);
  const priorDate = previousDate(opts.previous);

  if (summary.byCurrency.length === 0) {
    return drawProse(doc, chrome, 'No in-term contracts in the covered scope.', y + 1, 9, C.muted);
  }

  autoTable(doc, {
    startY: y + 1,
    margin: { left: PAGE.mx, right: PAGE.mx, top: PAGE.bandH + 8, bottom: 14 },
    head: [['Currency', 'MRR', 'ARR', 'Contracts', 'Paused', 'Pending activation']],
    body: summary.byCurrency.map((t) => [
      t.currencyCode,
      formatMoney(t.mrr, t.currencyCode),
      formatMoney(t.arr, t.currencyCode),
      String(t.contractCount),
      `${t.pausedCount} (${formatMoney(t.pausedMrr, t.currencyCode)})`,
      `${t.pendingActivationCount} (${formatMoney(t.pendingActivationMrr, t.currencyCode)})`,
    ]),
    ...TABLE_STYLE(C, 7.4),
    didDrawPage: () => {
      chrome.drawHeaderBand(doc);
      chrome.drawFooter(doc);
    },
  });
  y = finalY(doc, y);

  if (prior) {
    for (const t of summary.byCurrency) {
      const match = prior.find((p) => p && p.currencyCode === t.currencyCode);
      if (!match) continue;
      const delta = signedMoneyDelta(t.mrr, match.mrr, t.currencyCode);
      if (delta === null) continue;
      y = drawProse(
        doc,
        chrome,
        `vs previous observation (${priorDate}): ${t.currencyCode} MRR ${delta}`,
        y,
        8.6,
        C.muted,
      );
    }
  }
  return y;
}

function drawRenewals(doc: jsPDF, chrome: PdfChrome, summary: MrrRenewalsSummary, startY: number): number {
  const { C, PAGE } = chrome;
  let y = heading(
    doc,
    chrome,
    `Renewals in the next ${summary.renewalHorizonDays} days`,
    startY + 2,
  );
  const byId = new Map<string, MrrContractDetailRow>();
  for (const r of summary.rows) if (r.inRenewalWindow) byId.set(r.contractId, r);
  const ordered = summary.renewals.contractIds
    .map((id) => byId.get(id))
    .filter((r): r is MrrContractDetailRow => r !== undefined);

  if (ordered.length === 0) {
    y = drawProse(doc, chrome, 'No contracts reach their end date inside this window.', y + 1, 9, C.muted);
  } else {
    autoTable(doc, {
      startY: y + 1,
      margin: { left: PAGE.mx, right: PAGE.mx, top: PAGE.bandH + 8, bottom: 14 },
      head: [['Contract', 'Organization', 'MRR', 'Ends', 'Days left', 'Renewal', 'Notice sent']],
      body: ordered.slice(0, RENEWAL_TABLE_MAX).map((r) => [
        r.contractName,
        r.orgName ?? NA,
        formatMoney(r.mrr, r.currencyCode),
        dateOnly(r.endDate),
        r.daysRemaining === null ? NA : String(r.daysRemaining),
        r.autoRenew ? 'Auto' : 'Manual',
        dateOnly(r.advanceNoticeSentAt),
      ]),
      ...TABLE_STYLE(C, 7),
      didDrawPage: () => {
        chrome.drawHeaderBand(doc);
        chrome.drawFooter(doc);
      },
    });
    y = finalY(doc, y);
  }

  // Window contracts past the stored detail cap (not in summary.rows) or past
  // the table's own row limit are still in the totals; count them out loud.
  const notListed = summary.renewals.contractIds.length - Math.min(ordered.length, RENEWAL_TABLE_MAX);
  if (notListed > 0) {
    y = drawProse(
      doc, chrome,
      `${notListed} more renewing contract${notListed === 1 ? ' is' : 's are'} not listed (detail rows are capped); `
      + `${notListed === 1 ? 'it is' : 'they are'} in the totals below.`,
      y + 1, 8.6, C.muted,
    );
  }

  for (const t of summary.renewals.totals) {
    y = drawProse(
      doc,
      chrome,
      `${t.currencyCode}: auto-renew ${t.autoRenewCount} (${formatMoney(t.autoRenewMrr, t.currencyCode)} MRR), `
      + `manual ${t.manualCount} (${formatMoney(t.manualMrr, t.currencyCode)} MRR)`,
      y,
      8.6,
    );
  }
  return y;
}

function drawBilled(doc: jsPDF, chrome: PdfChrome, summary: MrrRenewalsSummary, startY: number): number {
  const { C, PAGE } = chrome;
  let y = heading(doc, chrome, 'Billed recurring revenue', startY + 2);
  y = drawProse(
    doc,
    chrome,
    'Issued contract invoice lines by month. This is billed revenue, not MRR.',
    y + 1,
    8.6,
    C.muted,
  );
  if (summary.billedRecurring.length === 0) {
    return drawProse(doc, chrome, 'No recurring contract invoice lines in the last 12 months.', y, 9, C.muted);
  }
  autoTable(doc, {
    startY: y + 1,
    margin: { left: PAGE.mx, right: PAGE.mx, top: PAGE.bandH + 8, bottom: 14 },
    head: [['Month', 'Currency', 'Billed']],
    body: summary.billedRecurring.map((m: MrrBilledMonth) => [
      m.partial ? `${m.month} (partial month)` : m.month,
      m.currencyCode,
      formatMoney(m.amount, m.currencyCode),
    ]),
    ...TABLE_STYLE(C, 7.2),
    didDrawPage: () => {
      chrome.drawHeaderBand(doc);
      chrome.drawFooter(doc);
    },
  });
  return finalY(doc, y);
}

export function renderMrrRenewalsReport(
  doc: jsPDF,
  summary: MrrRenewalsSummary,
  opts: MrrRenewalsPdfOpts,
  chrome: PdfChrome,
): void {
  const { C } = chrome;

  let y = chrome.drawTitleBlock(
    doc,
    'MRR & Renewals',
    scopeLabel(summary.scope),
    `As of ${summary.asOf} (UTC)`,
    chrome.PAGE.bandH + 14,
  );

  // --- Basis (notes verbatim, before any number) -------------------------------
  y = heading(doc, chrome, 'Basis', y + 6);
  for (const note of summary.notes) {
    y = drawProse(doc, chrome, note, y + 1, 8.6, C.muted);
  }

  // Nothing was queried (site-restricted authority, no organizations): every
  // section below would print an unmeasured result as "none". Say so instead.
  // A stored run from before the flag existed has no `measured` and was measured.
  if (summary.measured === false) {
    y = heading(doc, chrome, 'Not measured', y + 4);
    drawProse(doc, chrome, 'Not measured: nothing was queried for this run, for the reason given above. The figures are unknown, not zero.', y + 1, 9, C.muted);
    return;
  }

  // --- Scorecard ---------------------------------------------------------------
  y = heading(doc, chrome, 'Recurring revenue per currency', y + 4);
  y = drawScorecard(doc, chrome, summary, opts, y);

  // --- Renewals ----------------------------------------------------------------
  y = drawRenewals(doc, chrome, summary, y);

  // --- Billed recurring revenue ------------------------------------------------
  y = drawBilled(doc, chrome, summary, y);

  // --- Reconciliation ----------------------------------------------------------
  y = heading(doc, chrome, 'Reconciliation', y + 2);
  let any = false;
  if (summary.activeNotInTerm.length > 0) {
    any = true;
    y = drawProse(doc, chrome, 'Active but not in term (excluded from MRR):', y + 1, 9);
    for (const r of summary.activeNotInTerm) {
      y = drawProse(
        doc, chrome,
        `${r.contractName} (${r.orgName ?? NA}): ${r.reason}; ${dateOnly(r.startDate)} to ${dateOnly(r.endDate)}`,
        y, 8.6, C.warning,
      );
    }
  }
  if (summary.skipped.length > 0) {
    any = true;
    y = drawProse(doc, chrome, 'Skipped, could not be valued (excluded from MRR):', y + 1, 9);
    for (const r of summary.skipped) {
      y = drawProse(doc, chrome, `${r.contractName} (${r.orgName ?? NA}): ${r.reason}`, y, 8.6, C.warning);
    }
  }
  for (const t of summary.byCurrency) {
    if (t.evergreenCount > 0) {
      any = true;
      y = drawProse(
        doc, chrome,
        `${t.currencyCode}: ${t.evergreenCount} evergreen contract${t.evergreenCount === 1 ? '' : 's'} with no end date `
        + `(${formatMoney(t.evergreenMrr, t.currencyCode)} MRR, included above)`,
        y + 1, 8.6,
      );
    }
  }
  if (!any) {
    drawProse(doc, chrome, 'Nothing to reconcile: every active contract is in term and valued.', y + 1, 9, C.muted);
  }
}
