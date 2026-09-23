/**
 * Shared summary types for the three business report generators
 * (ticket_sla_attainment, technician_time_billability, ar_aging — #3198 W02).
 * This is the contract between the generators (Task 7-9), the PDF renderers
 * (Task 10) and W03's web components.
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
    detail: { ...EMPTY_DETAIL },
    notes: [note],
    rows: [],
  };
}

export function emptyArAgingSummary(note: string): ArAgingSummary {
  return {
    generatedAt: new Date().toISOString(),
    asOf: new Date().toISOString(),
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
