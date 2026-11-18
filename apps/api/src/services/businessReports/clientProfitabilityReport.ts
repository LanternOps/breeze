import { sql, type SQL } from 'drizzle-orm';
import {
  CLIENT_PROFITABILITY_REVENUE_CATEGORIES,
  emptyClientProfitabilitySummary,
  fromMinorUnits,
  laborHours,
  multiplyToCurrency,
  roundToCurrency,
  toMinorUnits,
  type ClientProfitabilityDetailRow,
  type ClientProfitabilityGroupBy,
  type ClientProfitabilityHoursAttribution,
  type ClientProfitabilityOrgRow,
  type ClientProfitabilityRevenueCategory,
  type ClientProfitabilitySourceRow,
  type ClientProfitabilitySummary,
  type ProfitabilityHours,
  type ProfitabilityMoneyRow,
} from '@breeze/shared';
import { db } from '../../db';
import { sqlUuidArray } from '../../db/sqlValues';
import { clientProfitabilityConfigSchema, type ClientProfitabilityConfig } from '../reportConfigSchemas';
import type { ReportResult } from '../reportGenerationService';
import { reportTypeDef } from '../reportRegistry';
import { reportOwnerOfScope, runInReportScope, type ReportScope } from '../reportScope';
import type { ReportGenerationAuthority } from '../siteScope';
import {
  hoursQuery,
  invoiceDetailQuery,
  invoiceLineFoldQuery,
  localPeriodDates,
  type HoursRow,
  type InvoiceDetailRow,
  type LineFoldRow,
} from './clientProfitabilityQueries';
import { NO_ORGS_NOTE, PARTNER_ORG_LIST_NOTE, ratio, rowsOf, SITE_RESTRICTED_NOTE } from './common';
import { resolveReportOwnerTimezone, resolveReportPeriod, type ResolvedReportPeriod } from './period';

/**
 * Client profitability (`client_profitability`, #9828 W3; spec §3.1, OD1-A /
 * OD2-B / OD3-A, Gate B 6/7/11/12).
 *
 * Per client, in the period: what was billed (issued invoice lines, billed
 * basis at `issue_date`), what the billed goods and services cost (the
 * invoice-line cost snapshot, with the share of revenue it covers), the
 * revenue mix, and the technician hours the client consumed. The fold and the
 * hours live in clientProfitabilityQueries.ts; this file rounds, attributes
 * hours to a currency and applies the optional uniform labor rate.
 *
 * Money: the SQL returns exact sums; every figure here is built from integer
 * minor units and printed once per currency. Never summed across currencies,
 * no FX.
 *
 * Hours ↔ currency (Gate B 7): a client's hours attach to its currency row
 * only when its revenue is in exactly one currency and every completed entry
 * is stamped in that currency. Otherwise the hours print once on the client
 * and every rate / estimate figure is null, with a note. Hours are never split
 * or duplicated across currency rows.
 *
 * Labor estimate (OD2-B, Gate B 6/12): only when `laborCostPerHour` is set and
 * in the attributed currency. Labor cost = all completed hours (billable,
 * included and non-billable) × the rate; the contribution formula is
 * `contributionAfterLabor` — the one place it lives.
 *
 * Tenancy: ONE `runInReportScope`; every statement carries the explicit org
 * allowlist and, on partner-axis tables (`invoices`, `time_entries`,
 * `organizations`), the partner axis. RLS is the backstop.
 */

const DETAIL_ROW_CAP = reportTypeDef('client_profitability').detailRowCap;

export type { ClientProfitabilityConfig };
type Category = ClientProfitabilityRevenueCategory;
type LaborRate = { amount: string; currencyCode: string };

/** The label every surface prints for the estimate (OD2-B). */
export const LABOR_ESTIMATE_LABEL = 'Estimated contribution after labor (uniform rate)';

export const BILLED_BASIS_NOTE =
  'Revenue is what issued invoices billed in the period, by invoice issue date (billed basis, not accrual): an annual contract invoiced in one month counts entirely in that month. Draft and void invoices are excluded.';
export const PER_CURRENCY_NOTE =
  'Money is reported per invoice currency; amounts in different currencies are never added together and no FX conversion is applied.';
export const UNKNOWN_COST_NOTE =
  'A line with no recorded cost (time, hour-block overage, AI usage and most contract lines) is unknown cost, not zero cost. Gross margin and margin % cover only lines with a recorded cost; cost coverage is the share of revenue they represent.';
export const ARREARS_NOTE =
  'Hours are counted when they were worked. The invoice for that work can fall in a later period, so a period\'s hours and its labor revenue need not match.';
export const QUOTE_COST_FORWARD_ONLY_NOTE =
  'Products sold through a quote carry their cost only if the quote was accepted after quote costs began to be copied onto invoices; earlier ones count as unknown cost.';
export const AI_COST_NOTE =
  'AI usage lines carry no cost here: what Breeze charged for AI is in USD and is never combined with a charge in the invoice currency. The AI usage by client report shows that cost beside the charges.';
export const MULTI_CURRENCY_HOURS_NOTE =
  'A client billed in more than one currency, or whose time entries are in a different currency from its revenue, cannot have its hours attributed to one currency: its hours are shown once and its rate and labor-estimate figures are blank.';
export const NO_REVENUE_HOURS_NOTE =
  'A client with hours but no billed revenue in the period has no rate or labor-estimate figures; its hours are still shown.';
export const UNATTRIBUTED_HOURS_NOTE =
  'Time entries with no organization (internal work) are shown once as unattributed time; they are not spread across clients.';
export const PARTNER_RATE_SCOPE_NOTE =
  'Partner-wide rate and labor-estimate figures for a currency are blank when any client billed in it cannot have its hours attributed to it, so they always cover the same clients as the margin beside them. '
  + 'They never include internal time or the hours of clients with no revenue in the period.';
export const NO_HOURS_NOTE =
  'A client with revenue but no completed time logged in the period has no rate or labor estimate: unlogged time is not zero labor cost.';
export const partialBundleNote = (n: number): string =>
  `${n} bundle ${n === 1 ? 'line has' : 'lines have'} a component with no recorded cost; ${n === 1 ? 'it counts' : 'they count'} as unknown cost here, while the invoice margin panel counts the missing component as zero.`;
export const LABOR_RATE_CURRENCY_NOTE = (currencyCode: string): string =>
  `The labor rate is in ${currencyCode}; clients billed in another currency have no labor estimate (no FX conversion is applied).`;
export const laborEstimateNote = (rate: LaborRate): string =>
  `${LABOR_ESTIMATE_LABEL} = gross margin + labor and recurring revenue with no recorded cost − all completed hours × ${rate.amount} ${rate.currencyCode} per hour. `
  + 'It is an estimate: one blended rate for every technician, with non-billable and included time counted, and it assumes no labor is already inside a line\'s cost. '
  + 'Recurring revenue with no recorded cost is treated as service revenue and shown separately; product, AI and other revenue with no recorded cost is left out.';

// ---------------------------------------------------------------------------
// Exact money: integer minor units per currency.
// ---------------------------------------------------------------------------

type Acc = {
  revenue: number; costBearing: number; cost: number; missing: number; partial: number;
  mix: Record<Category, number>;
  unknown: Record<Category, number>;
};
const zeroByCategory = (): Record<Category, number> => ({ recurring: 0, labor: 0, product: 0, ai: 0, other: 0 });
const newAcc = (): Acc => ({ revenue: 0, costBearing: 0, cost: 0, missing: 0, partial: 0, mix: zeroByCategory(), unknown: zeroByCategory() });

function addFold(acc: Acc, r: LineFoldRow, currency: string): void {
  const m = (v: string) => toMinorUnits(String(v), currency);
  const category = r.category as Category;
  acc.revenue += m(r.revenue);
  acc.costBearing += m(r.cost_bearing_revenue);
  acc.cost += m(r.cost);
  acc.missing += Number(r.lines_missing_cost);
  acc.partial += Number(r.partial_cost_bundles);
  acc.mix[category] += m(r.revenue);
  acc.unknown[category] += m(r.unknown_cost_revenue);
}

function mergeAcc(into: Acc, from: Acc): void {
  into.revenue += from.revenue;
  into.costBearing += from.costBearing;
  into.cost += from.cost;
  into.missing += from.missing;
  into.partial += from.partial;
  for (const c of CLIENT_PROFITABILITY_REVENUE_CATEGORIES) {
    into.mix[c] += from.mix[c];
    into.unknown[c] += from.unknown[c];
  }
}

/**
 * Gate B 6 — THE contribution formula (Opus variant): gross margin, plus the
 * revenue with no recorded cost in `labor` (time entries, block overage) and
 * `recurring` (managed contracts, whose delivery cost is the included time
 * being costed), minus the estimated labor cost. Switching to the
 * labor-only variant means dropping `acc.unknown.recurring` here.
 */
function contributionAfterLabor(acc: Acc, laborCostMinor: number): number {
  const grossMargin = acc.costBearing - acc.cost;
  const nullCostServiceRevenue = acc.unknown.labor + acc.unknown.recurring;
  return grossMargin + nullCostServiceRevenue - laborCostMinor;
}

/** A per-hour figure in the currency, rounded once; null with no hours. */
function perHour(minor: number, minutes: number, currency: string): number | null {
  if (minutes <= 0) return null;
  return Number(roundToCurrency(Number(fromMinorUnits(minor, currency)) / (minutes / 60), currency));
}

/** Hours × rate, the labor rule: minutes → hours at 2 dp → × rate → one round. */
const laborCostMinor = (minutes: number, rate: LaborRate, currency: string): number =>
  toMinorUnits(multiplyToCurrency(laborHours(minutes), rate.amount, currency), currency);

type Labor = { minutes: number; serviceMinor: number; revenueMinor: number; laborCost: number | null; contribution: number | null };

function moneyRow(currency: string, acc: Acc, labor: Labor | null): ProfitabilityMoneyRow {
  const s = (minor: number) => fromMinorUnits(minor, currency);
  const grossMargin = acc.costBearing - acc.cost;
  const mix = Object.fromEntries(CLIENT_PROFITABILITY_REVENUE_CATEGORIES.map((c) => [c, s(acc.mix[c])])) as Record<Category, string>;
  return {
    currencyCode: currency,
    revenue: s(acc.revenue),
    costBearingRevenue: s(acc.costBearing),
    cost: s(acc.cost),
    grossMargin: s(grossMargin),
    marginPct: ratio(grossMargin, acc.costBearing),
    costCoveragePct: ratio(acc.costBearing, acc.revenue),
    unknownCostRevenue: s(acc.revenue - acc.costBearing),
    linesMissingCost: acc.missing,
    partialCostBundles: acc.partial,
    mix,
    effectiveServiceRate: labor ? perHour(labor.serviceMinor, labor.minutes, currency) : null,
    revenuePerHour: labor ? perHour(labor.revenueMinor, labor.minutes, currency) : null,
    estimatedLaborCost: labor && labor.laborCost !== null ? s(labor.laborCost) : null,
    estimatedContributionAfterLabor: labor && labor.contribution !== null ? s(labor.contribution) : null,
    nullCostRecurringRevenue: s(acc.unknown.recurring),
    excludedUnknownCostRevenue: s(acc.unknown.product + acc.unknown.ai + acc.unknown.other),
  };
}

/** One attributed client's labor figures in its currency. */
function laborFor(acc: Acc, minutes: number, rate: LaborRate | null, currency: string): Labor {
  // No completed time is "not measured", never a zero labor cost: a client
  // whose technicians forgot to log time must not look like the best margin.
  const laborCost = rate !== null && rate.currencyCode === currency && minutes > 0
    ? laborCostMinor(minutes, rate, currency)
    : null;
  return {
    minutes,
    serviceMinor: acc.mix.recurring + acc.mix.labor,
    revenueMinor: acc.revenue,
    laborCost,
    contribution: laborCost === null ? null : contributionAfterLabor(acc, laborCost),
  };
}

// ---------------------------------------------------------------------------
// Hours
// ---------------------------------------------------------------------------

type Minutes = { billable: number; included: number; nonBillable: number; currencies: Set<string> };
const newMinutes = (): Minutes => ({ billable: 0, included: 0, nonBillable: 0, currencies: new Set() });
const totalMinutes = (m: Minutes): number => m.billable + m.included + m.nonBillable;

function hoursOf(m: Minutes): ProfitabilityHours {
  const h = (minutes: number) => Number(laborHours(minutes));
  return { total: h(totalMinutes(m)), billable: h(m.billable), included: h(m.included), nonBillable: h(m.nonBillable) };
}

// ---------------------------------------------------------------------------
// Result shaping
// ---------------------------------------------------------------------------

function toResult(summary: ClientProfitabilitySummary): ReportResult {
  return {
    rows: summary.rows as unknown as Record<string, unknown>[],
    rowCount: summary.rows.length,
    generatedAt: summary.generatedAt,
    summary: summary as unknown as Record<string, unknown>,
  };
}

function scopeMeta(scope: ReportScope, orgName: string | null): ClientProfitabilitySummary['scope'] {
  return scope.kind === 'partner'
    ? { kind: 'partner', partnerId: scope.partnerId, orgCount: scope.orgIds.length }
    : { kind: 'organization', orgId: scope.orgId, orgName };
}

function periodMeta(period: ResolvedReportPeriod): ClientProfitabilitySummary['period'] {
  return { kind: period.kind, start: period.start.toISOString(), end: period.end.toISOString(), label: period.label, timeZone: period.timeZone };
}

const EMPTY_DETAIL_ROW: Omit<ClientProfitabilityDetailRow, 'orgId' | 'orgName'> = {
  invoiceId: null, invoiceNumber: null, issueDate: null, currencyCode: null,
  revenue: null, cost: null, grossMargin: null, marginPct: null, costCoveragePct: null, unknownCostRevenue: null,
  recurringRevenue: null, laborRevenue: null, productRevenue: null, aiRevenue: null, otherRevenue: null,
  hoursTotal: null, hoursBillable: null, hoursIncluded: null, hoursNonBillable: null,
  effectiveServiceRate: null, estimatedContributionAfterLabor: null,
};

/**
 * The detail rows ARE the CSV/XLSX: `rowsToCsv` takes its header from the first
 * row's key order, so the order here is the column order a customer sees.
 * Client first, then revenue -> cost -> margin, then the mix, hours and estimate.
 */
const DETAIL_COLUMN_ORDER = [
  'orgName', 'orgId', 'invoiceNumber', 'invoiceId', 'issueDate', 'currencyCode',
  'revenue', 'cost', 'grossMargin', 'marginPct', 'costCoveragePct', 'unknownCostRevenue',
  'recurringRevenue', 'laborRevenue', 'productRevenue', 'aiRevenue', 'otherRevenue',
  'hoursTotal', 'hoursBillable', 'hoursIncluded', 'hoursNonBillable',
  'effectiveServiceRate', 'estimatedContributionAfterLabor',
] as const satisfies ReadonlyArray<keyof ClientProfitabilityDetailRow>;

/** A 0..1 ratio rounded to one decimal of a percent (0.33334 -> 0.333). */
const roundRatio = (v: number | null): number | null => (v === null ? null : Math.round(v * 1000) / 1000);

/** Fixed column order and a display-rounded marginPct, for the exported rows only. */
function exportDetailRow(r: ClientProfitabilityDetailRow): ClientProfitabilityDetailRow {
  const out = {} as Record<string, unknown>;
  for (const k of DETAIL_COLUMN_ORDER) out[k] = r[k];
  out.marginPct = roundRatio(r.marginPct);
  return out as ClientProfitabilityDetailRow;
}

const hoursColumns = (h: ProfitabilityHours) =>
  ({ hoursTotal: h.total, hoursBillable: h.billable, hoursIncluded: h.included, hoursNonBillable: h.nonBillable });

function moneyColumns(m: ProfitabilityMoneyRow) {
  return {
    currencyCode: m.currencyCode,
    revenue: m.revenue, cost: m.cost, grossMargin: m.grossMargin, marginPct: m.marginPct, costCoveragePct: m.costCoveragePct,
    unknownCostRevenue: m.unknownCostRevenue,
    recurringRevenue: m.mix.recurring, laborRevenue: m.mix.labor, productRevenue: m.mix.product, aiRevenue: m.mix.ai, otherRevenue: m.mix.other,
    effectiveServiceRate: m.effectiveServiceRate,
    estimatedContributionAfterLabor: m.estimatedContributionAfterLabor,
  };
}

function invoiceRow(r: InvoiceDetailRow, orgId: string, orgName: string | null): ClientProfitabilityDetailRow {
  const currency = String(r.currency_code);
  const acc = newAcc();
  const m = (v: string) => toMinorUnits(String(v), currency);
  acc.revenue = m(r.revenue);
  acc.costBearing = m(r.cost_bearing_revenue);
  acc.cost = m(r.cost);
  acc.missing = Number(r.lines_missing_cost);
  acc.partial = Number(r.partial_cost_bundles);
  acc.mix = {
    recurring: m(r.recurring_revenue), labor: m(r.labor_revenue), product: m(r.product_revenue),
    ai: m(r.ai_revenue), other: m(r.other_revenue),
  };
  const money = moneyRow(currency, acc, null);
  return {
    ...EMPTY_DETAIL_ROW,
    orgId,
    orgName,
    invoiceId: String(r.invoice_id),
    invoiceNumber: r.invoice_number ?? null,
    issueDate: String(r.issue_date),
    ...moneyColumns(money),
  };
}

const sortedKeys = <V>(m: Map<string, V>): string[] => [...m.keys()].sort();

export async function generateClientProfitabilityReport(
  scope: ReportScope,
  rawConfig: Record<string, unknown>,
  authority: ReportGenerationAuthority,
): Promise<ReportResult> {
  // Parse BEFORE any query: a stored config the type rejects never runs.
  const config = clientProfitabilityConfigSchema.parse(rawConfig ?? {});
  const groupBy: ClientProfitabilityGroupBy = config.groupBy ?? (scope.kind === 'partner' ? 'organization' : 'source');
  const rate: LaborRate | null = config.laborCostPerHour ?? null;
  const generatedAt = new Date();
  const header = { generatedAt: generatedAt.toISOString(), groupBy, laborCostPerHour: rate };

  // Invoices and time entries have no site axis; a restricted authority (any
  // number of sites) queries nothing (ruling T7a — the dispatcher guards this too).
  if (authority.scope.kind === 'restricted') {
    return toResult({
      ...emptyClientProfitabilitySummary(SITE_RESTRICTED_NOTE),
      ...header,
      scope: scopeMeta(scope, null),
      detail: { cap: DETAIL_ROW_CAP, stored: 0, available: 0, truncated: false },
    });
  }

  // ONE scoped block for the whole report (ruling P6).
  return runInReportScope(scope, async () => {
    const timeZone = await resolveReportOwnerTimezone(reportOwnerOfScope(scope));
    const period = resolveReportPeriod(config.period, timeZone, generatedAt);

    const notes = [BILLED_BASIS_NOTE, PER_CURRENCY_NOTE, UNKNOWN_COST_NOTE, ARREARS_NOTE, QUOTE_COST_FORWARD_ONLY_NOTE, AI_COST_NOTE];
    if (period.timeZoneNote) notes.push(period.timeZoneNote);
    if (scope.kind === 'partner') notes.push(PARTNER_ORG_LIST_NOTE);

    if (scope.kind === 'partner' && scope.orgIds.length === 0) {
      return toResult({
        ...emptyClientProfitabilitySummary(NO_ORGS_NOTE),
        ...header,
        period: periodMeta(period),
        scope: scopeMeta(scope, null),
        detail: { cap: DETAIL_ROW_CAP, stored: 0, available: 0, truncated: false },
        notes: [NO_ORGS_NOTE, ...notes],
      });
    }

    const nameQuery: SQL = scope.kind === 'partner'
      ? sql`/* profitability:org_names */ SELECT o.id::text AS id, o.name FROM organizations o
          WHERE o.id = ANY(${sqlUuidArray(scope.orgIds)}) AND o.partner_id = ${scope.partnerId}`
      : sql`/* profitability:org_names */ SELECT o.id::text AS id, o.name FROM organizations o WHERE o.id = ${scope.orgId}`;
    const orgNames = new Map(rowsOf<{ id: string; name: string }>(await db.execute(nameQuery)).map((r) => [String(r.id), String(r.name)]));
    const orgNameOf = (orgId: string): string | null => orgNames.get(orgId) ?? null;

    const { startDate, endDate } = localPeriodDates(period);
    const foldRows = rowsOf<LineFoldRow>(await db.execute(invoiceLineFoldQuery({ scope, periodStartDate: startDate, periodEndDate: endDate })));
    const hourRows = rowsOf<HoursRow>(await db.execute(hoursQuery({ scope, periodStart: period.start, periodEnd: period.end })));

    // ---- accumulate --------------------------------------------------------
    const byOrg = new Map<string, Map<string, Acc>>(); // org -> currency -> acc
    const bySource = new Map<string, Acc>();            // `${category}|${currency}`
    for (const r of foldRows) {
      const orgId = String(r.org_id);
      const currency = String(r.currency_code);
      const perCurrency = byOrg.get(orgId) ?? new Map<string, Acc>();
      byOrg.set(orgId, perCurrency);
      const acc = perCurrency.get(currency) ?? newAcc();
      perCurrency.set(currency, acc);
      addFold(acc, r, currency);
      const sourceKey = `${r.category}|${currency}`;
      const source = bySource.get(sourceKey) ?? newAcc();
      bySource.set(sourceKey, source);
      addFold(source, r, currency);
    }

    const minutesByOrg = new Map<string, Minutes>();
    const unattributed = newMinutes();
    for (const r of hourRows) {
      const target = r.org_id === null ? unattributed : (minutesByOrg.get(String(r.org_id)) ?? newMinutes());
      if (r.org_id !== null) minutesByOrg.set(String(r.org_id), target);
      target.billable += Number(r.billable_minutes);
      target.included += Number(r.included_minutes);
      target.nonBillable += Number(r.non_billable_minutes);
      // Only the org-less (internal) row can have a NULL currency: the CHECK
      // time_entries_currency_required_when_org_chk stamps every org entry.
      if (r.currency_code !== null) target.currencies.add(String(r.currency_code));
    }

    // ---- per client ----------------------------------------------------------
    const orgIds = new Set<string>([...byOrg.keys(), ...minutesByOrg.keys()]);
    if (scope.kind === 'organization') orgIds.add(scope.orgId);
    const orgs: ClientProfitabilityOrgRow[] = [];
    const attributedByCurrency = new Map<string, Labor[]>();
    /** Currencies billed to at least one client whose hours are NOT attributed to them. */
    const partialCurrencies = new Set<string>();
    for (const orgId of orgIds) {
      const perCurrency = byOrg.get(orgId) ?? new Map<string, Acc>();
      const minutes = minutesByOrg.get(orgId) ?? newMinutes();
      const currencies = sortedKeys(perCurrency);
      const attribution: ClientProfitabilityHoursAttribution = currencies.length === 0
        ? 'no_revenue'
        : currencies.length === 1 && [...minutes.currencies].every((c) => c === currencies[0])
          ? 'single_currency'
          : 'multi_currency';
      const money = currencies.map((currency) => {
        const acc = perCurrency.get(currency)!;
        if (attribution !== 'single_currency') {
          partialCurrencies.add(currency);
          return moneyRow(currency, acc, null);
        }
        const labor = laborFor(acc, totalMinutes(minutes), rate, currency);
        attributedByCurrency.set(currency, [...(attributedByCurrency.get(currency) ?? []), labor]);
        return moneyRow(currency, acc, labor);
      });
      orgs.push({ orgId, orgName: orgNameOf(orgId), hours: hoursOf(minutes), money, hoursAttribution: attribution });
    }
    orgs.sort((a, b) => (a.orgName ?? '￿').localeCompare(b.orgName ?? '￿') || a.orgId.localeCompare(b.orgId));

    // ---- per currency (aggregates before any cap) ------------------------------
    const currencyAcc = new Map<string, Acc>();
    for (const perCurrency of byOrg.values()) {
      for (const [currency, acc] of perCurrency) {
        const total = currencyAcc.get(currency) ?? newAcc();
        currencyAcc.set(currency, total);
        mergeAcc(total, acc);
      }
    }
    const byCurrency = sortedKeys(currencyAcc).map((currency) => {
      const attributed = attributedByCurrency.get(currency) ?? [];
      // Partner-wide rate and estimate figures must cover the same clients as
      // the revenue and margin on the row: blank when any client billed in
      // this currency is not attributed to it.
      if (attributed.length === 0 || partialCurrencies.has(currency)) return moneyRow(currency, currencyAcc.get(currency)!, null);
      const sum = (pick: (l: Labor) => number) => attributed.reduce((t, l) => t + pick(l), 0);
      const estimated = attributed.every((l) => l.laborCost !== null);
      return moneyRow(currency, currencyAcc.get(currency)!, {
        minutes: sum((l) => l.minutes),
        serviceMinor: sum((l) => l.serviceMinor),
        revenueMinor: sum((l) => l.revenueMinor),
        laborCost: estimated ? sum((l) => l.laborCost!) : null,
        contribution: estimated ? sum((l) => l.contribution!) : null,
      });
    });

    const categoryIndex = (c: string) => CLIENT_PROFITABILITY_REVENUE_CATEGORIES.indexOf(c as Category);
    const sources: ClientProfitabilitySourceRow[] = [...bySource.entries()]
      .map(([key, acc]) => {
        const [category, currency] = key.split('|') as [Category, string];
        const m = moneyRow(currency, acc, null);
        return {
          category, currencyCode: currency, revenue: m.revenue, costBearingRevenue: m.costBearingRevenue, cost: m.cost,
          grossMargin: m.grossMargin, marginPct: m.marginPct, costCoveragePct: m.costCoveragePct,
          unknownCostRevenue: m.unknownCostRevenue, linesMissingCost: m.linesMissingCost, partialCostBundles: m.partialCostBundles,
        };
      })
      .sort((a, b) => categoryIndex(a.category) - categoryIndex(b.category) || a.currencyCode.localeCompare(b.currencyCode));

    const unattributedHours = scope.kind === 'partner' && totalMinutes(unattributed) > 0 ? hoursOf(unattributed) : null;

    // ---- notes -------------------------------------------------------------
    const partialBundles = [...currencyAcc.values()].reduce((t, a) => t + a.partial, 0);
    if (partialBundles > 0) notes.push(partialBundleNote(partialBundles));
    const withHours = orgs.filter((o) => o.hours.total > 0);
    if (orgs.some((o) => o.hoursAttribution === 'multi_currency')) notes.push(MULTI_CURRENCY_HOURS_NOTE);
    if (withHours.some((o) => o.hoursAttribution === 'no_revenue')) notes.push(NO_REVENUE_HOURS_NOTE);
    if (orgs.some((o) => o.money.length > 0 && o.hours.total === 0)) notes.push(NO_HOURS_NOTE);
    if (unattributedHours !== null) notes.push(UNATTRIBUTED_HOURS_NOTE);
    if (scope.kind === 'partner'
      && (partialCurrencies.size > 0 || unattributedHours !== null || withHours.some((o) => o.hoursAttribution === 'no_revenue'))) {
      notes.push(PARTNER_RATE_SCOPE_NOTE);
    }
    if (rate !== null) {
      notes.push(laborEstimateNote(rate));
      if (byCurrency.some((m) => m.currencyCode !== rate.currencyCode)) notes.push(LABOR_RATE_CURRENCY_NOTE(rate.currencyCode));
    }

    // ---- detail rows ---------------------------------------------------------
    let rows: ClientProfitabilityDetailRow[];
    let detail: ClientProfitabilitySummary['detail'];
    if (scope.kind === 'organization') {
      const invoiceRows = rowsOf<InvoiceDetailRow>(await db.execute(invoiceDetailQuery({
        orgId: scope.orgId, periodStartDate: startDate, periodEndDate: endDate, limit: DETAIL_ROW_CAP + 1,
      })));
      rows = invoiceRows.slice(0, DETAIL_ROW_CAP).map((r) => invoiceRow(r, scope.orgId, orgNameOf(scope.orgId)));
      const available = invoiceRows.length > 0 ? Number(invoiceRows[0]!.available) : 0;
      detail = { cap: DETAIL_ROW_CAP, stored: rows.length, available, truncated: available > rows.length };
    } else {
      // One row per (client, currency). A client's hours sit on its money row
      // when it has exactly one; otherwise on one hours-only row — never twice.
      const all: ClientProfitabilityDetailRow[] = [];
      for (const o of orgs) {
        const base = { ...EMPTY_DETAIL_ROW, orgId: o.orgId, orgName: o.orgName };
        const hoursOnMoneyRow = o.money.length === 1;
        for (const m of o.money) {
          all.push({ ...base, ...moneyColumns(m), ...(hoursOnMoneyRow ? hoursColumns(o.hours) : {}) });
        }
        if (!hoursOnMoneyRow && o.hours.total > 0) all.push({ ...base, ...hoursColumns(o.hours) });
      }
      if (unattributedHours !== null) all.push({ ...EMPTY_DETAIL_ROW, orgId: null, orgName: null, ...hoursColumns(unattributedHours) });
      rows = all.slice(0, DETAIL_ROW_CAP);
      detail = { cap: DETAIL_ROW_CAP, stored: rows.length, available: all.length, truncated: all.length > rows.length };
    }

    return toResult({
      ...header,
      period: periodMeta(period),
      scope: scopeMeta(scope, scope.kind === 'organization' ? orgNameOf(scope.orgId) : null),
      byCurrency,
      orgs,
      sources,
      unattributedHours,
      detail,
      notes,
      rows: rows.map(exportDetailRow),
    });
  });
}
