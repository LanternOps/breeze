/**
 * Client profitability PDF (#9828 W3), mirror of mrrRenewalsPdf.ts.
 *
 * The generator is `apps/api/src/services/businessReports/clientProfitabilityReport.ts`.
 *
 * RULES THIS FILE OBEYS:
 *  1. Money is printed only through `formatMoney`, one row per currency, and
 *     NEVER totalled across currencies.
 *  2. A margin % is NEVER printed without the cost coverage % in the column
 *     right beside it (margin is measured over cost-bearing lines only; a line
 *     with no recorded cost is unknown cost, not zero cost).
 *  3. An unmeasured ratio/rate (null) prints N/A, never 0%. A null estimate
 *     figure prints a dash.
 *  4. `summary.notes` is printed verbatim, before any number.
 *  5. The labor-estimate block exists only when a labor rate was set, and is
 *     badged "Estimate".
 *
 * Declared `PdfChrome` (not imported) to avoid a module cycle with reportPdf.ts.
 */
import type { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type {
  ClientProfitabilityDetailRow,
  ClientProfitabilityOrgRow,
  ClientProfitabilityRevenueCategory,
  ClientProfitabilitySummary,
  ProfitabilityHours,
  ProfitabilityMoneyRow,
  ReportScopeMeta,
} from '../types/businessReports';
import { CLIENT_PROFITABILITY_REVENUE_CATEGORIES } from '../types/businessReports';
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

export type ClientProfitabilityPdfOpts = {
  generatedAt: string;
  partnerName: string | null;
  contactEmail?: string | null;
  contactName?: string | null;
};

const NA = 'N/A';
const DASH = '-';
/** Invoice rows beyond this are dropped from the PDF only. */
const DETAIL_TABLE_MAX = 500;

const CATEGORY_LABEL: Record<ClientProfitabilityRevenueCategory, string> = {
  recurring: 'Recurring',
  labor: 'Labor',
  product: 'Product',
  ai: 'AI',
  other: 'Other',
};

const ink = (doc: jsPDF, c: RGB) => doc.setTextColor(c[0], c[1], c[2]);

function drawProse(doc: jsPDF, chrome: PdfChrome, text: string, y: number, size = 9.5, color?: RGB): number {
  const { C, PAGE } = chrome;
  const width = PAGE.w - PAGE.mx * 2;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(size);
  ink(doc, color ?? C.ink);
  const lines = doc.splitTextToSize(text, width) as string[];
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

const TABLE_STYLE = (C: PdfChrome['C'], size: number) => ({
  styles: { font: 'helvetica', fontSize: size, cellPadding: 1.6, textColor: C.ink, lineColor: C.rule, lineWidth: 0.1 },
  headStyles: { fillColor: C.panel, textColor: C.ink, fontStyle: 'bold' as const },
  alternateRowStyles: { fillColor: C.zebra },
});

/** Page break for the hand-drawn (non-table) elements. */
function ensureSpace(doc: jsPDF, chrome: PdfChrome, y: number, need: number): number {
  if (y + need <= chrome.PAGE.footY - 8) return y;
  doc.addPage();
  chrome.drawHeaderBand(doc);
  chrome.drawFooter(doc);
  return chrome.PAGE.bandH + 10;
}

/** Section heading that never lands in the footer: keeps ~30 mm for what follows. */
function heading(doc: jsPDF, chrome: PdfChrome, text: string, y: number): number {
  return chrome.drawSectionHeading(doc, text, ensureSpace(doc, chrome, y, 30));
}

// --- cell formatters --------------------------------------------------------

const orgLabel = (o: { orgName: string | null; orgId: string }): string => o.orgName ?? o.orgId;
const hoursCell = (n: number | null | undefined): string => (n === null || n === undefined ? NA : n.toFixed(2));
const moneyOrNa = (v: string | null | undefined, cur: string | null): string =>
  v === null || v === undefined || cur === null ? NA : formatMoney(v, cur);
/** Estimate figures: null means no estimate, so a dash, never a measured zero. */
const moneyOrDash = (v: string | null | undefined, cur: string): string =>
  v === null || v === undefined ? DASH : formatMoney(v, cur);
const rateCell = (rate: number | null, cur: string): string =>
  rate === null ? NA : `${formatMoney(rate, cur)}/h`;

function margins(r: { grossMargin: string | null; marginPct: number | null; costCoveragePct: number | null }, cur: string | null) {
  // margin % and coverage % are always emitted as an adjacent pair.
  return [moneyOrNa(r.grossMargin, cur), formatPercent(r.marginPct), formatPercent(r.costCoveragePct)];
}

const MARGIN_HEAD = ['Gross margin', 'Margin %', 'Cost coverage %'];

// --- sections ---------------------------------------------------------------

function drawScorecard(doc: jsPDF, chrome: PdfChrome, s: ClientProfitabilitySummary, startY: number): number {
  const { C, PAGE } = chrome;
  if (s.byCurrency.length === 0) {
    return drawProse(doc, chrome, 'No billed revenue in the covered scope for this period.', startY + 1, 9, C.muted);
  }
  autoTable(doc, {
    startY: startY + 1,
    margin: { left: PAGE.mx, right: PAGE.mx, top: PAGE.bandH + 8, bottom: 14 },
    head: [['Currency', 'Revenue', 'Margin %', 'Cost coverage %', 'Effective service rate']],
    body: s.byCurrency.map((m) => [
      m.currencyCode,
      formatMoney(m.revenue, m.currencyCode),
      formatPercent(m.marginPct),
      formatPercent(m.costCoveragePct),
      rateCell(m.effectiveServiceRate, m.currencyCode),
    ]),
    ...TABLE_STYLE(C, 8),
    didDrawPage: () => { chrome.drawHeaderBand(doc); chrome.drawFooter(doc); },
  });
  let y = finalY(doc, startY);
  y = drawProse(
    doc, chrome,
    'Margin is measured over cost-bearing revenue only; cost coverage is the share of revenue that margin is measured on. '
    + 'Effective service rate is recurring plus labor revenue per hour worked.',
    y, 8.2, C.muted,
  );
  return y;
}

function drawByClient(doc: jsPDF, chrome: PdfChrome, s: ClientProfitabilitySummary, startY: number): number {
  const { C, PAGE } = chrome;
  let y = heading(doc, chrome, 'By client', startY + 2);
  if (s.orgs.length === 0) return drawProse(doc, chrome, 'No clients in the covered scope.', y + 1, 9, C.muted);
  const body: string[][] = [];
  for (const o of s.orgs) {
    if (o.money.length === 0) {
      // no revenue: the client's hours still print; money is unmeasured (N/A), never blank or 0
      body.push([orgLabel(o), NA, NA, NA, NA, NA, NA, NA, hoursCell(o.hours.total), NA]);
      continue;
    }
    for (const m of o.money) {
      body.push([
        orgLabel(o), m.currencyCode,
        formatMoney(m.revenue, m.currencyCode), formatMoney(m.cost, m.currencyCode),
        ...margins(m, m.currencyCode),
        formatMoney(m.unknownCostRevenue, m.currencyCode),
        o.hoursAttribution === 'single_currency' ? hoursCell(o.hours.total) : (o.hoursAttribution === 'multi_currency' ? 'see hours table' : hoursCell(o.hours.total)),
        rateCell(m.effectiveServiceRate, m.currencyCode),
      ]);
    }
  }
  autoTable(doc, {
    startY: y + 1,
    margin: { left: PAGE.mx, right: PAGE.mx, top: PAGE.bandH + 8, bottom: 14 },
    head: [['Client', 'Currency', 'Revenue', 'Cost', ...MARGIN_HEAD, 'Unknown-cost revenue', 'Hours', 'Effective service rate']],
    body,
    ...TABLE_STYLE(C, 6.8),
    didDrawPage: () => { chrome.drawHeaderBand(doc); chrome.drawFooter(doc); },
  });
  y = finalY(doc, y);
  return y;
}

function drawBySource(doc: jsPDF, chrome: PdfChrome, s: ClientProfitabilitySummary, startY: number): number {
  const { C, PAGE } = chrome;
  const y = heading(doc, chrome, 'By revenue source', startY + 2);
  if (s.sources.length === 0) return drawProse(doc, chrome, 'No billed revenue in the covered scope.', y + 1, 9, C.muted);
  autoTable(doc, {
    startY: y + 1,
    margin: { left: PAGE.mx, right: PAGE.mx, top: PAGE.bandH + 8, bottom: 14 },
    head: [['Category', 'Currency', 'Revenue', 'Cost', ...MARGIN_HEAD, 'Unknown-cost revenue']],
    body: s.sources.map((r) => [
      CATEGORY_LABEL[r.category] ?? r.category, r.currencyCode,
      formatMoney(r.revenue, r.currencyCode), formatMoney(r.cost, r.currencyCode),
      ...margins(r, r.currencyCode),
      formatMoney(r.unknownCostRevenue, r.currencyCode),
    ]),
    ...TABLE_STYLE(C, 7.2),
    didDrawPage: () => { chrome.drawHeaderBand(doc); chrome.drawFooter(doc); },
  });
  return finalY(doc, y);
}

function drawInvoices(doc: jsPDF, chrome: PdfChrome, s: ClientProfitabilitySummary, startY: number): number {
  const { C, PAGE } = chrome;
  const invoices = s.rows.filter((r: ClientProfitabilityDetailRow) => r.invoiceId !== null);
  const disclosure = detailDisclosure({
    base: 'Invoices',
    inHand: invoices.length,
    total: s.detail.truncated ? s.detail.available : invoices.length,
    pdfMax: DETAIL_TABLE_MAX,
    storedCap: s.detail.cap,
    noun: 'invoices',
  });
  let y = heading(doc, chrome, disclosure.heading, startY + 2);
  if (disclosure.note) y = drawProse(doc, chrome, disclosure.note, y + 1, 8.6, C.muted);
  if (invoices.length === 0) return drawProse(doc, chrome, 'No invoices issued in this period.', y + 1, 9, C.muted);
  autoTable(doc, {
    startY: y + 1,
    margin: { left: PAGE.mx, right: PAGE.mx, top: PAGE.bandH + 8, bottom: 14 },
    head: [['Invoice', 'Issued', 'Currency', 'Revenue', 'Cost', ...MARGIN_HEAD]],
    body: invoices.slice(0, DETAIL_TABLE_MAX).map((r) => [
      r.invoiceNumber ?? NA,
      r.issueDate ? r.issueDate.slice(0, 10) : NA,
      r.currencyCode ?? NA,
      moneyOrNa(r.revenue, r.currencyCode),
      moneyOrNa(r.cost, r.currencyCode),
      ...margins(r, r.currencyCode),
    ]),
    ...TABLE_STYLE(C, 7),
    didDrawPage: () => { chrome.drawHeaderBand(doc); chrome.drawFooter(doc); },
  });
  return finalY(doc, y);
}

function drawMixBars(doc: jsPDF, chrome: PdfChrome, s: ClientProfitabilitySummary, startY: number): number {
  const { C, PAGE } = chrome;
  const entries: Array<{ label: string; m: ProfitabilityMoneyRow }> = [];
  if (s.groupBy === 'organization') {
    for (const o of s.orgs) for (const m of o.money) entries.push({ label: `${orgLabel(o)} · ${m.currencyCode}`, m });
  } else {
    for (const m of s.byCurrency) entries.push({ label: `All sources · ${m.currencyCode}`, m });
  }
  const shown = entries.filter((e) => Number(e.m.revenue) > 0);
  if (shown.length === 0) return startY;

  const colors: Record<ClientProfitabilityRevenueCategory, RGB> = {
    recurring: C.primary, labor: C.success, product: C.warning, ai: C.danger, other: C.faint,
  };
  let y = ensureSpace(doc, chrome, startY, 24);
  y = heading(doc, chrome, 'Revenue mix', y + 2);

  // legend
  let lx = PAGE.mx;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.4);
  for (const cat of CLIENT_PROFITABILITY_REVENUE_CATEGORIES) {
    doc.setFillColor(...colors[cat]);
    doc.rect(lx, y - 2.4, 3, 3, 'F');
    ink(doc, C.ink);
    doc.text(CATEGORY_LABEL[cat], lx + 4.2, y);
    lx += 28;
  }
  y += 5;

  const labelW = 70;
  const barW = PAGE.w - PAGE.mx * 2 - labelW - 4;
  for (const { label, m } of shown) {
    y = ensureSpace(doc, chrome, y, 7);
    ink(doc, C.ink);
    doc.setFontSize(7.6);
    doc.text(doc.splitTextToSize(label, labelW - 2)[0] as string, PAGE.mx, y + 2.6);
    const total = CLIENT_PROFITABILITY_REVENUE_CATEGORIES.reduce((a, c) => a + Math.max(0, Number(m.mix[c]) || 0), 0);
    let x = PAGE.mx + labelW;
    if (total > 0) {
      for (const cat of CLIENT_PROFITABILITY_REVENUE_CATEGORIES) {
        const part = Math.max(0, Number(m.mix[cat]) || 0);
        if (part <= 0) continue;
        const w = (part / total) * barW;
        doc.setFillColor(...colors[cat]);
        doc.rect(x, y, w, 3.6, 'F');
        x += w;
      }
    }
    y += 6.4;
  }
  return y + 2;
}

function drawHours(doc: jsPDF, chrome: PdfChrome, s: ClientProfitabilitySummary, startY: number): number {
  const { C, PAGE } = chrome;
  const row = (label: string, h: ProfitabilityHours) => [
    label, hoursCell(h.billable), hoursCell(h.included), hoursCell(h.nonBillable), hoursCell(h.total),
  ];
  const body = s.orgs.map((o: ClientProfitabilityOrgRow) => row(orgLabel(o), o.hours));
  if (s.unattributedHours) body.push(row('Internal / unattributed time', s.unattributedHours));
  if (body.length === 0) return startY;
  const y = heading(doc, chrome, 'Hours by coverage', startY + 2);
  autoTable(doc, {
    startY: y + 1,
    margin: { left: PAGE.mx, right: PAGE.mx, top: PAGE.bandH + 8, bottom: 14 },
    head: [['Client', 'Billable h', 'Included h', 'Non-billable h', 'Total h']],
    body,
    ...TABLE_STYLE(C, 7.2),
    didDrawPage: () => { chrome.drawHeaderBand(doc); chrome.drawFooter(doc); },
  });
  return finalY(doc, y);
}

function drawEstimate(
  doc: jsPDF,
  chrome: PdfChrome,
  s: ClientProfitabilitySummary,
  rate: { amount: string; currencyCode: string },
  startY: number,
): number {
  const { C, PAGE } = chrome;
  let y = ensureSpace(doc, chrome, startY, 30);
  y = heading(doc, chrome, 'Estimated contribution after labor (uniform rate)', y + 2);

  // "Estimate" badge
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.4);
  doc.setFillColor(...C.warning);
  doc.roundedRect(PAGE.mx, y - 1.5, 17, 5.2, 1.2, 1.2, 'F');
  ink(doc, C.white);
  doc.text('Estimate', PAGE.mx + 2.2, y + 2);
  doc.setFont('helvetica', 'normal');
  ink(doc, C.ink);
  doc.setFontSize(8.6);
  doc.text(
    `Uniform labor rate ${formatMoney(rate.amount, rate.currencyCode)} per hour (${rate.currencyCode}) applied to all completed hours.`,
    PAGE.mx + 20, y + 2,
  );
  y += 8;

  const body: string[][] = [];
  if (s.groupBy === 'organization') {
    for (const o of s.orgs) {
      for (const m of o.money) body.push(estimateRow(orgLabel(o), m));
    }
  }
  for (const m of s.byCurrency) body.push(estimateRow('All clients', m));
  autoTable(doc, {
    startY: y,
    margin: { left: PAGE.mx, right: PAGE.mx, top: PAGE.bandH + 8, bottom: 14 },
    head: [[
      'Client', 'Currency', 'Estimated labor cost', 'Estimated contribution after labor',
      'of which recurring revenue with no recorded cost', 'Excluded unknown-cost product / AI / other revenue',
    ]],
    body,
    ...TABLE_STYLE(C, 7),
    didDrawPage: () => { chrome.drawHeaderBand(doc); chrome.drawFooter(doc); },
  });
  y = finalY(doc, y);
  return drawProse(
    doc, chrome,
    'Estimate only: it assumes every completed hour costs the uniform rate. Recurring revenue with no recorded cost is counted '
    + 'in the contribution as an assumption; unknown-cost product, AI and other revenue is excluded from it.',
    y, 8.2, C.muted,
  );
}

function estimateRow(label: string, m: ProfitabilityMoneyRow): string[] {
  const cur = m.currencyCode;
  const hasEstimate = m.estimatedContributionAfterLabor !== null;
  return [
    label, cur,
    moneyOrDash(m.estimatedLaborCost, cur),
    moneyOrDash(m.estimatedContributionAfterLabor, cur),
    hasEstimate ? formatMoney(m.nullCostRecurringRevenue, cur) : DASH,
    moneyOrDash(m.excludedUnknownCostRevenue, cur),
  ];
}

export function renderClientProfitabilityReport(
  doc: jsPDF,
  summary: ClientProfitabilitySummary,
  opts: ClientProfitabilityPdfOpts,
  chrome: PdfChrome,
): void {
  const { C } = chrome;

  let y = chrome.drawTitleBlock(
    doc,
    'Client Profitability',
    scopeLabel(summary.scope),
    `${summary.period.label} · ${summary.period.timeZone} · Prepared ${opts.generatedAt}`,
    chrome.PAGE.bandH + 14,
  );

  // --- Basis (notes verbatim, before any number) ------------------------------
  y = heading(doc, chrome, 'Basis', y + 6);
  for (const note of summary.notes) y = drawProse(doc, chrome, note, y + 1, 8.6, C.muted);

  // --- Scorecard --------------------------------------------------------------
  y = heading(doc, chrome, 'Profitability per currency', y + 4);
  y = drawScorecard(doc, chrome, summary, y);

  // --- Main table -------------------------------------------------------------
  y = summary.groupBy === 'source' ? drawBySource(doc, chrome, summary, y) : drawByClient(doc, chrome, summary, y);

  // --- Invoices (organization scope) ------------------------------------------
  if (summary.scope.kind === 'organization') {
    y = drawInvoices(doc, chrome, summary, y);
  } else if (summary.detail.truncated) {
    y = drawProse(
      doc, chrome,
      `Stored detail rows are capped at ${summary.detail.cap} of ${summary.detail.available}; every figure above is computed over all of them.`,
      y, 8.6, C.muted,
    );
  }

  // --- Revenue mix, hours -----------------------------------------------------
  y = drawMixBars(doc, chrome, summary, y);
  y = drawHours(doc, chrome, summary, y);

  // --- Labor estimate (only when a rate was set) ------------------------------
  if (summary.laborCostPerHour !== null) {
    drawEstimate(doc, chrome, summary, summary.laborCostPerHour, y);
  }
}
