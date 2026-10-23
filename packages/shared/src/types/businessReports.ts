/**
 * Shared summary types for the business report generators
 * (ticket_sla_attainment, technician_time_billability, ar_aging — #3198 W02;
 * ai_usage_by_client — #7608 W10). This is the contract between the generators
 * (apps/api/src/services/businessReports/), the PDF renderers
 * (packages/shared/src/reportPdf/) and the web components.
 */

/** Money is ALWAYS a per-currency array. There is no single-currency field
 *  anywhere in these types, by construction (Open Decision 4 = A). */
export type CurrencyAmountRow = { currencyCode: string; amount: string };

export type ReportPeriodMeta = { kind: string; start: string; end: string; label: string; timeZone: string };
export type ReportScopeMeta =
  | { kind: 'organization'; orgId: string; orgName: string | null }
  | { kind: 'partner'; partnerId: string; orgCount: number };
export type DetailRowMeta = { cap: number; stored: number; available: number; truncated: boolean };

/** The period INPUT contract. It lives in `@breeze/shared`, not in
 *  `apps/api/src/services/businessReports/period.ts`, because W03's three
 *  options forms build exactly this object and a second hand-kept copy on the
 *  web side would drift. `period.ts` owns the RESOLUTION (`ResolvedReportPeriod`,
 *  which carries `Date`s and a timezone) and imports these. */
export type ReportPeriodKind = 'last_full_month' | 'last_30_days' | 'last_quarter' | 'custom';
export type ReportPeriodInput = { kind: ReportPeriodKind; start?: string; end?: string };

export type SlaOutcome = 'met' | 'missed' | 'pending' | 'no_target';

export type TicketSlaGroupRow = {
  groupKey: string;
  groupLabel: string;
  ticketsTotal: number;
  noSlaTickets: number;
  responseEligible: number;
  responseMet: number;
  responseAttainment: number | null;
  resolutionEligible: number;
  resolutionMet: number;
  resolutionAttainment: number | null;
  breaches: number;
};

export type TicketSlaDetailRow = {
  ticketId: string;
  ticketNumber: string | null;
  internalNumber: string | null;
  orgId: string;
  orgName: string | null;
  subject: string;
  priority: string;
  category: string | null;
  /** The CURRENT assignee's id; null only when the ticket is unassigned.
   *  A non-null id with a null name is an assignee whose `users` row the
   *  generating context could not read — not "unassigned". */
  assignedToId: string | null;
  assignedToName: string | null;
  createdAt: string;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  responseSlaMinutes: number | null;
  resolutionSlaMinutes: number | null;
  slaPausedMinutes: number;
  responseOutcome: SlaOutcome;
  resolutionOutcome: SlaOutcome;
  stampedBreachAt: string | null;
  stampedBreachReason: string | null;
};

export type TicketSlaSummary = {
  generatedAt: string;
  period: ReportPeriodMeta;
  scope: ReportScopeMeta;
  groupBy: 'organization' | 'priority' | 'technician' | 'category';
  overall: Omit<TicketSlaGroupRow, 'groupKey' | 'groupLabel'>;
  groups: TicketSlaGroupRow[];
  worstGroupLabel: string | null;
  /** Recomputed-vs-stamped disagreement, surfaced not hidden (OD-2 = A). */
  stampDiscrepancy: { recomputedBreachNotStamped: number; stampedNotRecomputedBreach: number };
  detail: DetailRowMeta;
  notes: string[];
  rows: TicketSlaDetailRow[];
};

export type TechnicianTimeGroupRow = {
  groupKey: string;
  groupLabel: string;
  loggedMinutes: number;
  capacityMinutes: number | null;
  utilization: number | null;
  billableMinutes: number;
  includedMinutes: number;
  nonBillableMinutes: number;
  billablePercent: number | null;
  billedMinutes: number;
  billingConversion: number | null;
  billableValue: CurrencyAmountRow[];
  averageRate: CurrencyAmountRow[];
};

export type TechnicianTimeDetailRow = {
  entryId: string;
  startedAt: string;
  userId: string;
  userName: string | null;
  orgId: string | null;
  orgName: string | null;
  workTypeName: string | null;
  durationMinutes: number | null;
  billableMinutes: number | null;
  coverage: 'billable' | 'included' | 'non_billable';
  billingStatus: string;
  isApproved: boolean;
  hourlyRate: string | null;
  currencyCode: string | null;
};

export type TechnicianTimeSummary = {
  generatedAt: string;
  period: ReportPeriodMeta;
  scope: ReportScopeMeta;
  groupBy: 'technician' | 'organization' | 'work_type';
  weeklyCapacityHours: number;
  workingDays: number;
  overall: Omit<TechnicianTimeGroupRow, 'groupKey' | 'groupLabel'>;
  groups: TechnicianTimeGroupRow[];
  zeroTimeTechnicians: number;
  /** Billable-coverage time with no hourly rate or no currency: it cannot be
   *  valued, so it is absent from every `billableValue` row. Counted here (in
   *  billed-quantity minutes) so the gap is disclosed, never silent. */
  unpricedBillable: { minutes: number; entries: number };
  detail: DetailRowMeta;
  notes: string[];
  rows: TechnicianTimeDetailRow[];
};

export type ArAgingBucket = 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus' | 'no_due_date';

export type ArAgingGroupRow = {
  groupKey: string;
  groupLabel: string;
  currencyCode: string;
  buckets: Record<ArAgingBucket, string>; // numeric strings, never numbers
  openTotal: string;
  invoiceCount: number;
};

export type ArAgingDetailRow = {
  invoiceId: string;
  invoiceNumber: string | null;
  orgId: string;
  orgName: string | null;
  currencyCode: string;
  status: string;
  issueDate: string | null;
  dueDate: string | null;
  total: string;
  amountPaid: string;
  balance: string;
  daysOverdue: number | null;
  bucket: ArAgingBucket;
  lastPaymentAt: string | null;
};

export type ArAgingSummary = {
  generatedAt: string;
  asOf: string;
  timeZone: string;
  scope: ReportScopeMeta;
  groupBy: 'organization' | 'currency';
  byCurrency: ArAgingGroupRow[]; // one per currency, groupKey = currency
  groups: ArAgingGroupRow[]; // per groupBy axis, per currency
  /** Reconciliation line: balance > 0 in a status the AR-open set does not
   *  admit (draft / paid / void). Bucket totals + this = total open balance. */
  otherOpenBalance: CurrencyAmountRow[];
  detail: DetailRowMeta;
  notes: string[];
  rows: ArAgingDetailRow[];
};

export type AiUsageByClientGroupBy = 'organization' | 'model';

/** One currency's chargeable money. Rounded once at the currency's minor unit
 *  (`roundToCurrency`) from an exact numeric(20,6) sum. NEVER summed across
 *  currencies — there is no single-currency field anywhere in this type. */
export type AiUsageByClientChargeRow = {
  currencyCode: string;
  /** Chargeable amount (coverage 'billable', priced). */
  amount: string;
  /** Part of `amount` already on an issued invoice (charge.billing_status = 'billed'). */
  billed: string;
  /** `amount` not yet billed: not yet invoiced, or not yet aggregated into a charge. */
  unbilled: string;
};

export type AiUsageByClientTotals = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** What the platform paid, USD, SUM(cost_cents) / 100 as numeric(14,2). Not what the client is charged. */
  costUsd: string;
  /** Breeze cost (USD) of usage whose profile coverage was 'included'. */
  includedCostUsd: string;
  /** Chargeable requests on a billable profile with no rate for the model. Counted, never treated as free. */
  unpricedRequests: number;
};

export type AiUsageByClientGroupRow = AiUsageByClientTotals & {
  groupKey: string;
  groupLabel: string;
  charges: AiUsageByClientChargeRow[];
};

/** Detail grain: organization x served model x charge currency (NULL currency =
 *  usage that carries no charge: included, non-billable, not eligible). */
export type AiUsageByClientDetailRow = AiUsageByClientTotals & {
  orgId: string;
  orgName: string | null;
  model: string;
  currencyCode: string | null;
  amount: string | null;
  billed: string | null;
  unbilled: string | null;
};

export type AiUsageByClientSummary = {
  generatedAt: string;
  period: ReportPeriodMeta;
  scope: ReportScopeMeta;
  groupBy: AiUsageByClientGroupBy;
  overall: AiUsageByClientTotals & { charges: AiUsageByClientChargeRow[] };
  groups: AiUsageByClientGroupRow[];
  detail: DetailRowMeta;
  notes: string[];
  rows: AiUsageByClientDetailRow[];
};

// ---- MRR & renewals (`mrr_renewals`, #9828 W1) ------------------------------
// Measured at run time: contracts keep no status history, so there is no
// period and no backdating. Money is a per-currency decimal string, never
// summed across currencies.

export type MrrRenewalsGroupBy = 'organization' | 'contract';
export type MrrRenewalsHorizonDays = 30 | 60 | 90 | 180;
/** How a detail row was valued: live (`active`, `paused`, `draft`) or from the
 *  invoice of a billed final term (`billed_final_term`). */
export type MrrContractBasis = 'active' | 'billed_final_term' | 'paused' | 'draft';

export type MrrCurrencyTotals = {
  currencyCode: string;
  /** In-term contracts (`active` + `billed_final_term`). mrr = baseMrr + overageMrr. */
  mrr: string;
  baseMrr: string;
  /** Billed allowance overage of `active` rows only (a billed final term is not split). */
  overageMrr: string;
  /** The `billed_final_term` share of `mrr`. */
  finalTermMrr: string;
  /** mrr × 12. */
  arr: string;
  contractCount: number;
  /** Beside MRR, never in it. */
  pausedMrr: string;
  pausedCount: number;
  /** Draft contracts, beside MRR, never in it. */
  pendingActivationMrr: string;
  pendingActivationCount: number;
  /** In-term contracts with no end date (part of `mrr`). */
  evergreenMrr: string;
  evergreenCount: number;
};
export type MrrGroupRow = MrrCurrencyTotals & { groupKey: string; groupLabel: string };
export type MrrRenewalTotals = {
  currencyCode: string; autoRenewMrr: string; autoRenewCount: number; manualMrr: string; manualCount: number;
};
/** Billed recurring revenue in one calendar month (owner timezone): issued
 *  contract invoice lines, a period's line spread evenly over its months.
 *  Billed, not MRR. `partial` marks the run month. */
export type MrrBilledMonth = { month: string; currencyCode: string; amount: string; partial: boolean };
export type MrrContractDetailRow = {
  contractId: string;
  contractName: string;
  orgId: string;
  orgName: string | null;
  status: string;
  basis: MrrContractBasis;
  intervalMonths: number;
  currencyCode: string;
  baseMonthly: string;
  /** Null for a billed final term (billed as a lump, never split). */
  overageMonthly: string | null;
  mrr: string;
  startDate: string;
  endDate: string | null;
  /** Days from asOf to endDate; null when open-ended. */
  daysRemaining: number | null;
  autoRenew: boolean;
  renewalTermMonths: number | null;
  inRenewalWindow: boolean;
  /** When the advance renewal notice for THIS end date was sent; looked up for
   *  renewal-window rows only, null otherwise. */
  advanceNoticeSentAt: string | null;
};
export type MrrRenewalsSummary = {
  generatedAt: string;
  /** False when nothing was queried (site-restricted authority, or a partner
   *  with no organizations): every figure below is unmeasured, not zero. */
  measured: boolean;
  /** UTC calendar date of the run (contract dates are UTC, like billing). */
  asOf: string;
  /** The report owner's timezone (billed-series months and notes only). */
  timeZone: string;
  scope: ReportScopeMeta;
  groupBy: MrrRenewalsGroupBy;
  renewalHorizonDays: MrrRenewalsHorizonDays;
  byCurrency: MrrCurrencyTotals[];
  groups: MrrGroupRow[];
  /** `contractIds`: rows with inRenewalWindow, end date ascending. */
  renewals: { totals: MrrRenewalTotals[]; contractIds: string[] };
  activeNotInTerm: {
    contractId: string; contractName: string; orgName: string | null; reason: string; startDate: string; endDate: string | null;
  }[];
  /** Contracts that should count but could not be valued; excluded from MRR. */
  skipped: { contractId: string; contractName: string; orgName: string | null; reason: string }[];
  billedRecurring: MrrBilledMonth[];
  detail: DetailRowMeta;
  notes: string[];
  rows: MrrContractDetailRow[];
};

const EMPTY_DETAIL: DetailRowMeta = { cap: 5000, stored: 0, available: 0, truncated: false };

export function emptyTicketSlaSummary(note: string): TicketSlaSummary {
  return {
    generatedAt: new Date().toISOString(),
    period: { kind: 'custom', start: '', end: '', label: '', timeZone: 'UTC' },
    scope: { kind: 'organization', orgId: '', orgName: null },
    groupBy: 'organization',
    overall: {
      ticketsTotal: 0,
      noSlaTickets: 0,
      responseEligible: 0,
      responseMet: 0,
      responseAttainment: null,
      resolutionEligible: 0,
      resolutionMet: 0,
      resolutionAttainment: null,
      breaches: 0,
    },
    groups: [],
    worstGroupLabel: null,
    stampDiscrepancy: { recomputedBreachNotStamped: 0, stampedNotRecomputedBreach: 0 },
    detail: { ...EMPTY_DETAIL },
    notes: [note],
    rows: [],
  };
}

export function emptyTechnicianTimeSummary(note: string): TechnicianTimeSummary {
  return {
    generatedAt: new Date().toISOString(),
    period: { kind: 'custom', start: '', end: '', label: '', timeZone: 'UTC' },
    scope: { kind: 'organization', orgId: '', orgName: null },
    groupBy: 'technician',
    weeklyCapacityHours: 0,
    workingDays: 0,
    overall: {
      loggedMinutes: 0,
      capacityMinutes: null,
      utilization: null,
      billableMinutes: 0,
      includedMinutes: 0,
      nonBillableMinutes: 0,
      billablePercent: null,
      billedMinutes: 0,
      billingConversion: null,
      billableValue: [],
      averageRate: [],
    },
    groups: [],
    zeroTimeTechnicians: 0,
    unpricedBillable: { minutes: 0, entries: 0 },
    detail: { ...EMPTY_DETAIL },
    notes: [note],
    rows: [],
  };
}

export function emptyArAgingSummary(note: string): ArAgingSummary {
  return {
    generatedAt: new Date().toISOString(),
    // A calendar date like every real run's asOf (UTC: an empty summary has
    // no owner timezone), never a full timestamp.
    asOf: new Date().toISOString().slice(0, 10),
    timeZone: 'UTC',
    scope: { kind: 'organization', orgId: '', orgName: null },
    groupBy: 'organization',
    byCurrency: [],
    groups: [],
    otherOpenBalance: [],
    detail: { ...EMPTY_DETAIL },
    notes: [note],
    rows: [],
  };
}

export function emptyAiUsageByClientSummary(note: string): AiUsageByClientSummary {
  return {
    generatedAt: new Date().toISOString(),
    period: { kind: 'custom', start: '', end: '', label: '', timeZone: 'UTC' },
    scope: { kind: 'organization', orgId: '', orgName: null },
    groupBy: 'organization',
    overall: {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: '0.00',
      includedCostUsd: '0.00',
      unpricedRequests: 0,
      charges: [],
    },
    groups: [],
    detail: { ...EMPTY_DETAIL },
    notes: [note],
    rows: [],
  };
}

export function emptyMrrRenewalsSummary(note: string): MrrRenewalsSummary {
  return {
    generatedAt: new Date().toISOString(),
    measured: false,
    // A UTC calendar date like every real run's asOf, never a full timestamp.
    asOf: new Date().toISOString().slice(0, 10),
    timeZone: 'UTC',
    scope: { kind: 'organization', orgId: '', orgName: null },
    groupBy: 'organization',
    renewalHorizonDays: 90,
    byCurrency: [],
    groups: [],
    renewals: { totals: [], contractIds: [] },
    activeNotInTerm: [],
    skipped: [],
    billedRecurring: [],
    detail: { ...EMPTY_DETAIL },
    notes: [note],
    rows: [],
  };
}

// ---------------------------------------------------------------------------
// quote_win_rate (#9828 W2): win rate over quote REVISION LINEAGES (one
// lineage = one opportunity). The headline is decided-only (OD5-A); money is
// per currency and never summed across currencies.
// ---------------------------------------------------------------------------

export type QuoteWinRateGroupBy = 'organization' | 'author' | 'currency';
export type QuoteOutcome = 'won' | 'lost' | 'expired' | 'open' | 'anomaly';
export type QuoteWinRateCounts = {
  lineages: number; won: number; lost: number; expired: number; open: number; anomalies: number; viewed: number;
};
export type QuoteWinRateRates = {
  /** won / (won + lost + expired) — the headline (OD5-A). null with no decided lineage, never 0. */
  winRate: number | null;
  /** won / lineages */
  closeRate: number | null;
  /** viewed / lineages */
  viewedRate: number | null;
  medianDaysToWin: number | null;
  medianDaysToLoss: number | null;
};
export type QuoteWinRateMoneyRow = {
  currencyCode: string;
  quotedOneTime: string; wonOneTime: string;
  quotedMonthlyRecurring: string; wonMonthlyRecurring: string;
  /** (wonOneTime + wonMRV) / (decided one-time + decided MRV), per currency. null when nothing is decided. */
  valueWinRate: number | null;
};
export type QuoteWinRateGroupRow = QuoteWinRateCounts & QuoteWinRateRates & {
  groupKey: string; groupLabel: string; money: QuoteWinRateMoneyRow[];
};
export type QuoteWinRateDetailRow = {
  rootQuoteId: string; terminalQuoteId: string; quoteNumber: string | null;
  orgId: string; orgName: string | null; authorName: string;
  versions: number; firstSentAt: string; outcome: QuoteOutcome; outcomeAt: string | null;
  currencyCode: string; oneTimeTotal: string; monthlyRecurringValue: string; declineReason: string | null;
};
export type QuoteWinRateSummary = {
  generatedAt: string;
  period: ReportPeriodMeta;
  scope: ReportScopeMeta;
  groupBy: QuoteWinRateGroupBy;
  overall: QuoteWinRateCounts & QuoteWinRateRates & { money: QuoteWinRateMoneyRow[] };
  groups: QuoteWinRateGroupRow[];
  diagnostics: { unreachable: number; depthCapped: number };
  detail: DetailRowMeta;
  notes: string[];
  rows: QuoteWinRateDetailRow[];
};

export function emptyQuoteWinRateSummary(note: string): QuoteWinRateSummary {
  return {
    generatedAt: new Date().toISOString(),
    period: { kind: 'custom', start: '', end: '', label: '', timeZone: 'UTC' },
    scope: { kind: 'organization', orgId: '', orgName: null },
    groupBy: 'organization',
    overall: {
      lineages: 0, won: 0, lost: 0, expired: 0, open: 0, anomalies: 0, viewed: 0,
      winRate: null, closeRate: null, viewedRate: null, medianDaysToWin: null, medianDaysToLoss: null,
      money: [],
    },
    groups: [],
    diagnostics: { unreachable: 0, depthCapped: 0 },
    detail: { ...EMPTY_DETAIL },
    notes: [note],
    rows: [],
  };
}

// ---------------------------------------------------------------------------
// Client profitability (`client_profitability`, #9828 W3; spec §3.1)
// ---------------------------------------------------------------------------

/** Revenue mix categories, in print order. A category is the invoice line's
 *  source: contract → recurring (hour-block overage → labor), time entry →
 *  labor, part / catalog / bundle / a quote-sold catalog line → product,
 *  AI usage → ai, anything else → other. */
export const CLIENT_PROFITABILITY_REVENUE_CATEGORIES = ['recurring', 'labor', 'product', 'ai', 'other'] as const;
export type ClientProfitabilityRevenueCategory = (typeof CLIENT_PROFITABILITY_REVENUE_CATEGORIES)[number];
export type ClientProfitabilityGroupBy = 'organization' | 'source';

/**
 * One currency's billed money (per client, or partner-wide). Money is a
 * decimal string rounded once to the currency; ratios are fractions (0..1)
 * and null when unmeasured, never 0.
 *
 * Margin is measured over cost-bearing lines only: a line with no recorded
 * cost is unknown cost, never zero cost, so `costCoveragePct` (the share of
 * revenue the margin is measured on) is printed beside every margin.
 *
 * The rate and labor-estimate fields are null unless the client's hours are
 * attributed to this currency (`hoursAttribution: 'single_currency'`) and
 * some completed time was logged; the estimate fields are also null when no
 * labor rate is set or it is in another currency. On a partner-wide
 * `byCurrency` row they are null when any client billed in the currency is
 * not attributed to it, so they cover the same clients as the margin. `estimatedContributionAfterLabor` = grossMargin + NULL-cost labor
 * and recurring revenue − estimatedLaborCost (Gate B 6).
 */
export type ProfitabilityMoneyRow = {
  currencyCode: string;
  revenue: string;
  costBearingRevenue: string;
  cost: string;
  grossMargin: string;
  marginPct: number | null;
  costCoveragePct: number | null;
  unknownCostRevenue: string;
  linesMissingCost: number;
  partialCostBundles: number;
  mix: Record<ClientProfitabilityRevenueCategory, string>;
  /** (recurring + labor revenue) ÷ hours worked. */
  effectiveServiceRate: number | null;
  /** All revenue ÷ hours worked. */
  revenuePerHour: number | null;
  /** All completed hours × the uniform labor rate. */
  estimatedLaborCost: string | null;
  estimatedContributionAfterLabor: string | null;
  /** Recurring revenue with no recorded cost — the share of the estimate's
   *  service revenue that is an assumption (a resold licence would sit here). */
  nullCostRecurringRevenue: string;
  /** Product, AI and other revenue with no recorded cost: never in the estimate. */
  excludedUnknownCostRevenue: string;
};

/** Hours worked (completed entries, 2 dp), split by effective coverage. */
export type ProfitabilityHours = { total: number; billable: number; included: number; nonBillable: number };

export type ClientProfitabilityHoursAttribution = 'single_currency' | 'multi_currency' | 'no_revenue';

export type ClientProfitabilityOrgRow = {
  orgId: string;
  orgName: string | null;
  /** Printed once per client, never per currency row. */
  hours: ProfitabilityHours;
  money: ProfitabilityMoneyRow[];
  hoursAttribution: ClientProfitabilityHoursAttribution;
};

/** Per (revenue category, currency): the `source` grouping. */
export type ClientProfitabilitySourceRow = {
  category: ClientProfitabilityRevenueCategory;
  currencyCode: string;
  revenue: string;
  costBearingRevenue: string;
  cost: string;
  grossMargin: string;
  marginPct: number | null;
  costCoveragePct: number | null;
  unknownCostRevenue: string;
  linesMissingCost: number;
  partialCostBundles: number;
};

/**
 * One per (client, currency) at partner scope, plus one hours-only row
 * (`currencyCode` null, money null) for a client whose hours cannot sit on a
 * single money row, and one for internal (no-organization) time; one per
 * invoice at org scope (hours null there).
 */
export type ClientProfitabilityDetailRow = {
  orgId: string | null;
  orgName: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  issueDate: string | null;
  currencyCode: string | null;
  revenue: string | null;
  cost: string | null;
  grossMargin: string | null;
  marginPct: number | null;
  costCoveragePct: number | null;
  unknownCostRevenue: string | null;
  recurringRevenue: string | null;
  laborRevenue: string | null;
  productRevenue: string | null;
  aiRevenue: string | null;
  otherRevenue: string | null;
  hoursTotal: number | null;
  hoursBillable: number | null;
  hoursIncluded: number | null;
  hoursNonBillable: number | null;
  effectiveServiceRate: number | null;
  estimatedContributionAfterLabor: string | null;
};

export type ClientProfitabilitySummary = {
  generatedAt: string;
  period: ReportPeriodMeta;
  scope: ReportScopeMeta;
  groupBy: ClientProfitabilityGroupBy;
  /** The report's uniform labor rate, or null (hours only, no estimate). */
  laborCostPerHour: { amount: string; currencyCode: string } | null;
  byCurrency: ProfitabilityMoneyRow[];
  orgs: ClientProfitabilityOrgRow[];
  sources: ClientProfitabilitySourceRow[];
  /** Partner scope: time entries with no organization, printed once. */
  unattributedHours: ProfitabilityHours | null;
  detail: DetailRowMeta;
  notes: string[];
  rows: ClientProfitabilityDetailRow[];
};

export function emptyClientProfitabilitySummary(note: string): ClientProfitabilitySummary {
  return {
    generatedAt: new Date().toISOString(),
    period: { kind: 'custom', start: '', end: '', label: '', timeZone: 'UTC' },
    scope: { kind: 'organization', orgId: '', orgName: null },
    groupBy: 'organization',
    laborCostPerHour: null,
    byCurrency: [],
    orgs: [],
    sources: [],
    unattributedHours: null,
    detail: { ...EMPTY_DETAIL },
    notes: [note],
    rows: [],
  };
}
