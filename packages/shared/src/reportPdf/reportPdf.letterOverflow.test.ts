/**
 * #12048 item 4: every report PDF type, rendered at US Letter landscape
 * (usable width 251.4 mm vs 269 mm on A4), must keep every drawn string inside
 * the page's right edge. Fixtures are copied (adapted) from the per-type test
 * files and stressed with long-but-plausible names.
 */
import { describe, expect, it, vi } from 'vitest';
import { jsPDF } from 'jspdf';
import { buildReportPdf, type BuildOpts, type ReportBranding } from './reportPdf';
import type { ExecutiveSummary, PostureSummary } from '../types';
import type { ThreatDetectionSummary } from '../types/threatDetectionReport';
import type { VulnerabilityManagementSummary } from '../types/vulnerabilityManagementReport';
import type { EndpointManagementSummary } from '../types/endpointManagementReport';
import type { HardwareLifecycleDeviceRow, HardwareLifecycleSummary } from '../types/hardwareLifecycleReport';
import type { BackupHealthRow } from '../types/backupHealth';
import type { BackupStatusReportData } from '../types/backupStatusReport';
import type { IdentityAccessSummary } from '../types/identityAccessReport';
import type { OrgNarrativeReportSummary } from '../types/orgNarrativeReport';
import { NARRATIVE_SECTION_KEYS, NARRATIVE_SECTION_TITLES } from '../types/orgNarrativeReport';
import type { FleetDesignReportSummary, FleetDesignSubmission } from '../types/fleetDesign';
import { fleetDesignOutcomeFromSubmission, type FleetDesignOutcomeRefs } from '../validators/fleetDesign';
import type {
  ArAgingSummary, AiUsageByClientSummary, MrrCurrencyTotals, MrrRenewalsSummary, QuoteWinRateSummary,
  TechnicianTimeSummary, TicketSlaSummary, ClientProfitabilityDetailRow, ClientProfitabilityOrgRow,
  ClientProfitabilitySummary, ProfitabilityMoneyRow,
} from '../types/businessReports';
import { emptyClientProfitabilitySummary } from '../types/businessReports';
import { emptyTicketSlaPerformanceSummary, type TicketSlaBreachRow, type TicketSlaPerformanceSummary } from '../types/ticketSlaPerformance';

const endpoint = (() => {
const SUMMARY: EndpointManagementSummary = {
  orgId: 'o1',
  orgName: 'Harlow & Pierce P.C.',
  generatedAt: '2026-09-30T06:00:00.000Z',
  period: { start: '2026-09-01', end: '2026-09-30' },
  freshness: {
    intune_devices: { asOf: '2026-09-30T04:00:00.000Z', lastStatus: 'success', truncated: false, stale: false, note: '' },
    skus: { asOf: '2026-09-30T04:00:00.000Z', lastStatus: 'success', truncated: false, stale: false, note: '' },
  },
  enrolment: { intuneDevices: 42, breezeDevices: 45, breezeWithoutIntune: 4, intuneWithoutBreezeLink: 1 },
  compliance: {
    byState: { compliant: 38, noncompliant: 2, inGracePeriod: 1, unknown: 1 },
    trend: [
      { date: '2026-09-01', compliant: 34, noncompliant: 5, inGrace: 2, unknown: 1 },
      { date: '2026-09-30', compliant: 38, noncompliant: 2, inGrace: 1, unknown: 1 },
    ],
  },
  staleEnrolments: { count: 3, thresholdDays: 14 },
  licences: [
    { skuPartNumber: 'SPE_E3', consumedUnits: 40, prepaidEnabled: 45, prepaidWarning: 0, prepaidSuspended: 0, capabilityStatus: 'Enabled' },
  ],
  rows: [
    {
      id: 'a', deviceName: 'LT-001', operatingSystem: 'Windows', osVersion: '10.0.22631',
      userPrincipalName: 'sam@acme.test', ownerType: 'company',
      lastIntuneSyncAt: '2026-09-30T03:00:00.000Z', complianceState: 'noncompliant',
      jailBroken: 'Unknown', breezeDeviceId: 'd1',
    },
  ],
  dataGaps: [],
  historyCaveat: 'Shows current inventory and daily trend; device-level change history is not available.',
};

  return SUMMARY;
})();

const hardware = (() => {
function row(partial: Partial<HardwareLifecycleDeviceRow> & { name: string }): HardwareLifecycleDeviceRow {
  return {
    id: partial.name, kind: 'device', os: 'Windows 11 Pro', osSupport: 'supported',
    purchaseDate: null, purchaseDateSource: null, warrantyEndDate: null, ageYears: null,
    replaceBy: null, replacement: 'unknown', warrantyExtended: false, lifeUsed: null,
    ...partial,
  };
}

const summary: HardwareLifecycleSummary = {
  org: { id: 'o1', name: 'Harlow & Pierce P.C.' },
  generatedAt: '2026-06-10T12:00:00.000Z',
  replaceAgeYears: 4,
  computers: { total: 3, byReplacement: { replace: 1, due_soon: 1, unknown: 1 }, byOsSupport: { supported: 1, ending: 1, ended: 1 } },
  otherEquipmentCount: 2,
  rows: [
    row({ name: 'SAM4', user: 'CORP\\sam.lee', manufacturer: 'Dell Inc.', model: 'OptiPlex 3050', serialNumber: '255P3W2', os: 'Windows 10 Pro', osSupport: 'ended', purchaseDate: '2019-04-01', purchaseDateSource: 'manual', warrantyEndDate: '2022-04-01', ageYears: 7.1, replaceBy: '2023-04-01', replacement: 'replace', lifeUsed: 1 }),
    row({ name: 'LAW-SRV', deviceKind: 'server', manufacturer: 'Dell Inc.', model: 'PowerEdge T340', os: 'Windows Server 2019', osSupport: 'ending', purchaseDate: '2021-10-01', purchaseDateSource: 'vendor', warrantyEndDate: '2026-11-30', ageYears: 4.7, replaceBy: '2026-11-30', replacement: 'due_soon', warrantyExtended: true, lifeUsed: 0.9 }),
    row({ name: 'MacBook-Air.local', manufacturer: 'Apple Inc.', os: 'macOS 26.3.1' }),
  ],
  other: [
    { id: 'p1', kind: 'manual_asset', name: 'Copier', manufacturer: 'Ricoh', model: 'IM C6010', category: 'printer' },
    { id: 'f1', kind: 'device', name: 'fw', manufacturer: 'SonicWALL', model: 'TZ300', category: 'firewall' },
  ],
  recommendations: [
    'Plan replacements for SAM4 this quarter, starting with SAM4 (7 years old).',
    'LAW-SRV is covered by warranty until November 2026; budget to replace it when coverage ends.',
  ],
};

  return summary;
})();

const backup = (() => {
function row(partial: Partial<BackupHealthRow> & { key: string; name: string }): BackupHealthRow {
  return {
    source: 'breeze', providerKey: null, providerLabel: null, orgId: 'o1', orgName: 'Acme Legal',
    siteId: null, deviceId: 'd1', computerName: null, osType: 'workstation', accountType: 'endpoint',
    status: 'completed', health: 'healthy', recency: 'under_24h', covered: true, stale: false,
    lastSuccessAt: null, lastSessionAt: null, selectedBytes: null, usedBytes: null, errorsCount: 0,
    dataSources: [], history28d: [], agentOnline: null,
    verifiedBootableAt: null, verifiedBootable: null, verifiedBootableFailedChecks: null,
    ...partial,
  } as BackupHealthRow;
}

const data: BackupStatusReportData = {
  org: { id: 'o1', name: 'Harlow & Pierce P.C.' },
  asOf: '2026-09-15T12:00:00.000Z',
  generatedAt: '2026-09-15T12:00:00.000Z',
  summary: {
    endpoints: { total: 3, covered: 1, uncovered: 2 },
    providerOnly: 1,
    m365Accounts: 0,
    byStatus: {
      completed: 1, completed_with_errors: 0, failed: 1, in_progress: 0,
      interrupted: 0, over_quota: 0, no_selection: 0, not_started: 1,
      no_backups: 0, unknown: 0,
    },
    byHealth: { healthy: 1, warning: 0, critical: 1, unknown: 1 },
    byRecency: { under_24h: 1, under_48h: 0, over_48h: 1, never: 1 },
  } as BackupStatusReportData['summary'],
  // Six buckets, `in_progress` (not `in_process`) — the shared W01
  // `BACKUP_STATUS_BUCKET_IDS` order. `other` is present here because the
  // fixture includes a `not_started` row (folded into `other`); Task 4's
  // builder omits this bucket entirely when its count is zero.
  statusBuckets: [
    { key: 'no_backups', count: 0, pct: 0 },
    { key: 'completed', count: 1, pct: 33.3 },
    { key: 'completed_with_errors', count: 0, pct: 0 },
    { key: 'in_progress', count: 0, pct: 0 },
    { key: 'unsuccessful', count: 1, pct: 33.3 },
    { key: 'other', count: 1, pct: 33.4 },
  ],
  recencyBuckets: [
    { key: 'never', count: 1, pct: 33.3 },
    { key: 'under_24h', count: 1, pct: 33.3 },
    { key: 'under_48h', count: 0, pct: 0 },
    { key: 'over_48h', count: 1, pct: 33.4 },
  ],
  rows: [
    row({
      key: 'provider:p1', name: 'LAW-SRV', source: 'provider', providerLabel: 'Cove Data Protection',
      computerName: 'LAW-SRV', osType: 'server', status: 'failed', health: 'critical', recency: 'over_48h',
      covered: false, selectedBytes: 5_000_000_000, usedBytes: 4_800_000_000, errorsCount: 3,
      dataSources: ['files', 'mssql'],
      history28d: [{ day: '2026-09-13', status: 'failed' }, { day: '2026-09-14', status: 'failed' }],
    }),
    row({
      key: 'breeze:d2', name: 'WKS-2', computerName: 'WKS-2', status: 'not_started', health: 'unknown',
      recency: 'never', selectedBytes: null, usedBytes: null,
    }),
    row({
      key: 'breeze:d1', name: 'SAM4', computerName: 'SAM4', status: 'completed', health: 'healthy',
      recency: 'under_24h', selectedBytes: 100_000_000, usedBytes: 90_000_000,
    }),
  ],
  truncated: false,
  options: { includeDevicesWithoutBackup: true, sources: ['breeze', 'provider'] },
};

  return data;
})();

const arAging = (() => {
const NOTES = [
  'As of 2026-09-30 in America/Chicago.',
  'Invoices with no due date are reported in their own bucket and are never counted as current.',
  'Totals are reported per currency; no FX conversion is applied.',
];

function bucketRow(currencyCode: string, current: string, openTotal: string, invoiceCount: number) {
  return {
    groupKey: currencyCode,
    groupLabel: currencyCode,
    currencyCode,
    buckets: {
      current,
      d1_30: '0.00',
      d31_60: '0.00',
      d61_90: '0.00',
      d90_plus: '0.00',
      no_due_date: '0.00',
    } as const,
    openTotal,
    invoiceCount,
  };
}

const SUMMARY: ArAgingSummary = {
  generatedAt: '2026-09-30T05:18:00.000Z',
  asOf: '2026-09-30',
  timeZone: 'America/Chicago',
  scope: { kind: 'organization', orgId: 'o1', orgName: 'Acme Co' },
  groupBy: 'organization',
  byCurrency: [
    bucketRow('USD', '500.00', '700.13', 3),
    bucketRow('EUR', '100.00', '100.42', 1),
  ],
  groups: [
    { ...bucketRow('USD', '500.00', '700.13', 3), groupKey: 'o1', groupLabel: 'Acme Co' },
    { ...bucketRow('EUR', '100.00', '100.42', 1), groupKey: 'o1', groupLabel: 'Acme Co' },
  ],
  otherOpenBalance: [],
  detail: { cap: 5000, stored: 4, available: 4, truncated: false },
  notes: NOTES,
  rows: [
    {
      invoiceId: 'i1', invoiceNumber: 'INV-1', orgId: 'o1', orgName: 'Acme Co', currencyCode: 'USD',
      status: 'sent', issueDate: '2026-09-01', dueDate: '2026-09-15', total: '500.00',
      amountPaid: '0.00', balance: '500.00', daysOverdue: -10, bucket: 'current', lastPaymentAt: null,
    },
    {
      invoiceId: 'i2', invoiceNumber: 'INV-2', orgId: 'o1', orgName: 'Acme Co', currencyCode: 'EUR',
      status: 'overdue', issueDate: '2026-08-01', dueDate: '2026-08-15', total: '100.00',
      amountPaid: '0.00', balance: '100.00', daysOverdue: 20, bucket: 'current', lastPaymentAt: null,
    },
  ],
};

  return SUMMARY;
})();

const profit = (() => {
function money(over: Partial<ProfitabilityMoneyRow> = {}): ProfitabilityMoneyRow {
  return {
    currencyCode: 'USD',
    revenue: '1000.00',
    costBearingRevenue: '800.00',
    cost: '500.00',
    grossMargin: '300.00',
    marginPct: 0.375,
    costCoveragePct: 0.8,
    unknownCostRevenue: '200.00',
    linesMissingCost: 2,
    partialCostBundles: 0,
    mix: { recurring: '600.00', labor: '200.00', product: '100.00', ai: '50.00', other: '50.00' },
    effectiveServiceRate: 100,
    revenuePerHour: 125,
    estimatedLaborCost: null,
    estimatedContributionAfterLabor: null,
    nullCostRecurringRevenue: '0.00',
    excludedUnknownCostRevenue: '0.00',
    ...over,
  };
}

const HOURS = { total: 8, billable: 4, included: 3, nonBillable: 1 };

function orgRow(name: string, m: ProfitabilityMoneyRow[]): ClientProfitabilityOrgRow {
  return {
    orgId: name, orgName: name, hours: HOURS, money: m,
    hoursAttribution: m.length === 0 ? 'no_revenue' : 'single_currency',
  };
}

function invoiceRow(): ClientProfitabilityDetailRow {
  return {
    orgId: 'o1', orgName: 'Acme Co', invoiceId: 'i1', invoiceNumber: 'INV-0042', issueDate: '2026-09-05',
    currencyCode: 'USD', revenue: '500.00', cost: '200.00', grossMargin: '300.00', marginPct: 0.6,
    costCoveragePct: 0.9, unknownCostRevenue: '50.00', recurringRevenue: null, laborRevenue: null,
    productRevenue: null, aiRevenue: null, otherRevenue: null, hoursTotal: null, hoursBillable: null,
    hoursIncluded: null, hoursNonBillable: null, effectiveServiceRate: null, estimatedContributionAfterLabor: null,
  };
}

function partnerSummary(over: Partial<ClientProfitabilitySummary> = {}): ClientProfitabilitySummary {
  return {
    ...emptyClientProfitabilitySummary('Margin is measured over cost-bearing lines only.'),
    period: { kind: 'last_full_month', start: '2026-09-01', end: '2026-09-30', label: 'September 2026', timeZone: 'UTC' },
    scope: { kind: 'partner', partnerId: 'p1', orgCount: 2 },
    byCurrency: [money({ revenue: '1900.00', grossMargin: '560.00' })],
    orgs: [
      orgRow('Acme Co', [money()]),
      orgRow('Globex Inc', [money({ revenue: '900.00', grossMargin: '260.00', marginPct: 0.4, costCoveragePct: 0.72 })]),
    ],
    detail: { cap: 5000, stored: 0, available: 0, truncated: false },
    ...over,
  };
}

  return partnerSummary();
})();

const mrr = (() => {
function totals(currencyCode: string, mrr: string): MrrCurrencyTotals {
  return {
    currencyCode, mrr, baseMrr: mrr, overageMrr: '0.00', finalTermMrr: '0.00', arr: '15000.00',
    contractCount: 3, pausedMrr: '0.00', pausedCount: 1, pendingActivationMrr: '0.00', pendingActivationCount: 2,
    evergreenMrr: '0.00', evergreenCount: 0,
  };
}

const SUMMARY: MrrRenewalsSummary = {
  generatedAt: '2026-10-23T05:00:00.000Z',
  measured: true,
  asOf: '2026-10-23',
  timeZone: 'UTC',
  scope: { kind: 'organization', orgId: 'o1', orgName: 'Acme Co' },
  groupBy: 'organization',
  renewalHorizonDays: 90,
  byCurrency: [totals('USD', '1250.00'), totals('EUR', '400.00')],
  groups: [],
  renewals: {
    totals: [{ currencyCode: 'USD', autoRenewMrr: '1000.00', autoRenewCount: 2, manualMrr: '250.00', manualCount: 1 }],
    contractIds: ['c1'],
  },
  activeNotInTerm: [
    { contractId: 'c9', contractName: 'Lapsed Support', orgName: 'Acme Co', reason: 'ended before the run date', startDate: '2025-01-01', endDate: '2026-09-01' },
  ],
  skipped: [
    { contractId: 'c8', contractName: 'Mystery Retainer', orgName: 'Acme Co', reason: 'no billing interval' },
  ],
  billedRecurring: [
    { month: '2026-09', currencyCode: 'USD', amount: '1200.00', partial: false },
    { month: '2026-10', currencyCode: 'USD', amount: '600.00', partial: true },
  ],
  detail: { cap: 5000, stored: 1, available: 1, truncated: false },
  notes: ['MRR is measured at run time; contracts keep no status history.'],
  rows: [
    {
      contractId: 'c1', contractName: 'Managed Services Gold', orgId: 'o1', orgName: 'Acme Co', status: 'active',
      basis: 'active', intervalMonths: 1, currencyCode: 'USD', baseMonthly: '1250.00', overageMonthly: '0.00',
      mrr: '1250.00', startDate: '2025-12-01', endDate: '2026-12-01', daysRemaining: 39, autoRenew: true,
      renewalTermMonths: 12, inRenewalWindow: true, advanceNoticeSentAt: null,
    },
  ],
};

  return SUMMARY;
})();

const quote = (() => {
const NOTES = [
  'Win rate counts decided opportunities only: won divided by won, lost and expired. Opportunities still open are shown beside it and are not in the denominator.',
  'Values are reported per quote currency; no FX conversion is applied.',
  'Accepted quotes create draft contracts, and this report does not follow them further. See the MRR & renewals report (pending activation) for contracts waiting to go live.',
];

const counts = { lineages: 10, won: 4, lost: 2, expired: 1, open: 3, anomalies: 0, viewed: 8 };
const rates = { winRate: 4 / 7, closeRate: 0.4, viewedRate: 0.8, medianDaysToWin: 4.3, medianDaysToLoss: 2 };
const usd = { currencyCode: 'USD', quotedOneTime: '1100.00', wonOneTime: '400.00', quotedMonthlyRecurring: '40.00', wonMonthlyRecurring: '40.00', valueWinRate: 0.423 };
const eur = { currencyCode: 'EUR', quotedOneTime: '250.00', wonOneTime: '0.00', quotedMonthlyRecurring: '0.00', wonMonthlyRecurring: '0.00', valueWinRate: 0 };

const SUMMARY: QuoteWinRateSummary = {
  generatedAt: '2026-09-15T12:00:00.000Z',
  period: { kind: 'last_full_month', start: '2026-08-01T05:00:00.000Z', end: '2026-09-01T05:00:00.000Z', label: 'August 2026', timeZone: 'America/Chicago' },
  scope: { kind: 'partner', partnerId: 'p1', orgCount: 2 },
  groupBy: 'organization',
  overall: { ...counts, ...rates, money: [eur, usd] },
  groups: [
    { groupKey: 'o1', groupLabel: 'Acme Co', ...counts, ...rates, lineages: 8, won: 4, money: [usd] },
    { groupKey: 'o2', groupLabel: 'Globex', ...counts, ...rates, lineages: 2, won: 0, winRate: null, closeRate: 0, money: [eur] },
  ],
  diagnostics: { unreachable: 0, depthCapped: 0 },
  detail: { cap: 5000, stored: 2, available: 2, truncated: false },
  notes: NOTES,
  rows: [
    { rootQuoteId: 'r1', terminalQuoteId: 't1', quoteNumber: 'Q-1-R2', orgId: 'o1', orgName: 'Acme Co', authorName: 'Dana Tech',
      versions: 2, firstSentAt: '2026-08-02T10:00:00.000Z', outcome: 'won', outcomeAt: '2026-08-12T10:00:00.000Z',
      currencyCode: 'USD', oneTimeTotal: '400.00', monthlyRecurringValue: '40.00', declineReason: null },
    { rootQuoteId: 'r2', terminalQuoteId: 't2', quoteNumber: 'Q-2', orgId: 'o2', orgName: 'Globex', authorName: 'Unknown user',
      versions: 1, firstSentAt: '2026-08-10T10:00:00.000Z', outcome: 'lost', outcomeAt: '2026-08-14T10:00:00.000Z',
      currencyCode: 'EUR', oneTimeTotal: '250.00', monthlyRecurringValue: '0.00', declineReason: 'Went with another vendor' },
  ],
};

  return SUMMARY;
})();

const tech = (() => {
const NOTES = [
  'Utilization assumes a uniform 40h week prorated over 21 working days; PTO, part-time schedules and public holidays are not modelled.',
  'Billing conversion is approved-and-billed minutes over billable minutes. It is not financial realization — no fee-schedule baseline exists to compute one.',
  "Billable, included and non-billable minutes follow each entry's coverage; entries recorded before billing profiles fall back to their billable flag. Running timers are not counted.",
  'Organization-scoped: ticket-linked time only. Time entries with no organization are not included, and technicians who logged none of this organization\'s time do not appear.',
  'Time entries are partner-internal records: an organization-scoped sign-in cannot read them, so when this report runs under one it shows no time at all. Run it from the partner to see this organization\'s time.',
];

const SUMMARY: TechnicianTimeSummary = {
  generatedAt: '2026-09-30T05:18:00.000Z',
  period: {
    kind: 'last_full_month',
    start: '2026-09-01T00:00:00.000Z',
    end: '2026-10-01T00:00:00.000Z',
    label: 'September 2026',
    timeZone: 'America/Chicago',
  },
  scope: { kind: 'organization', orgId: 'o1', orgName: 'Acme Co' },
  groupBy: 'technician',
  weeklyCapacityHours: 40,
  workingDays: 21,
  overall: {
    loggedMinutes: 5000, capacityMinutes: 5040, utilization: 5000 / 5040,
    billableMinutes: 4000, includedMinutes: 500, nonBillableMinutes: 500,
    billablePercent: 4000 / 5000, billedMinutes: 3800, billingConversion: 3800 / 4000,
    billableValue: [{ currencyCode: 'USD', amount: '1234.56' }],
    averageRate: [{ currencyCode: 'USD', amount: '95.00' }],
  },
  groups: [
    {
      groupKey: 'u1', groupLabel: 'Jamie Lee',
      loggedMinutes: 2500, capacityMinutes: 2520, utilization: 2500 / 2520,
      billableMinutes: 2000, includedMinutes: 250, nonBillableMinutes: 250,
      billablePercent: 2000 / 2500, billedMinutes: 1900, billingConversion: 1900 / 2000,
      billableValue: [{ currencyCode: 'USD', amount: '617.28' }],
      averageRate: [{ currencyCode: 'USD', amount: '95.00' }],
    },
    {
      groupKey: 'u2', groupLabel: 'Morgan Diaz',
      loggedMinutes: 2500, capacityMinutes: null, utilization: null,
      billableMinutes: 2000, includedMinutes: 250, nonBillableMinutes: 250,
      billablePercent: 0.8, billedMinutes: 1900, billingConversion: 0.95,
      billableValue: [{ currencyCode: 'USD', amount: '617.28' }],
      averageRate: [{ currencyCode: 'USD', amount: '95.00' }],
    },
  ],
  zeroTimeTechnicians: 1,
  unpricedBillable: { minutes: 0, entries: 0 },
  detail: { cap: 5000, stored: 2, available: 2, truncated: false },
  notes: NOTES,
  rows: [
    {
      entryId: 'e1', startedAt: '2026-09-05T10:00:00.000Z', userId: 'u1', userName: 'Jamie Lee',
      orgId: 'o1', orgName: 'Acme Co', workTypeName: 'Support', durationMinutes: 60,
      billableMinutes: 60, coverage: 'billable', billingStatus: 'billed', isApproved: true,
      hourlyRate: '95.00', currencyCode: 'USD',
    },
    {
      entryId: 'e2', startedAt: '2026-09-06T10:00:00.000Z', userId: 'u2', userName: 'Morgan Diaz',
      orgId: 'o1', orgName: 'Acme Co', workTypeName: 'Project', durationMinutes: 30,
      billableMinutes: null, coverage: 'non_billable', billingStatus: 'not_billable', isApproved: false,
      hourlyRate: null, currencyCode: null,
    },
  ],
};

  return SUMMARY;
})();

const aiUsage = (() => {
const NOTES = [
  'Charges bill by UTC calendar month of the ledger write; this report\'s period is in America/Chicago so month-edge rows can differ from the invoice.',
  'Chargeable amounts are reported per billing-profile currency; no FX conversion is applied.',
];

const totals = (over: Partial<AiUsageByClientSummary['overall']> = {}) => ({
  requests: 4, inputTokens: 4000, outputTokens: 800, cacheReadTokens: 40, cacheWriteTokens: 20,
  costUsd: '15.90', includedCostUsd: '5.00', unpricedRequests: 1, charges: [], ...over,
});

const SUMMARY: AiUsageByClientSummary = {
  generatedAt: '2026-09-01T05:18:00.000Z',
  period: { kind: 'last_full_month', start: '2026-08-01T05:00:00.000Z', end: '2026-09-01T05:00:00.000Z', label: 'August 2026', timeZone: 'America/Chicago' },
  scope: { kind: 'partner', partnerId: 'p1', orgCount: 2 },
  groupBy: 'organization',
  overall: totals({
    requests: 6, costUsd: '31.90',
    charges: [
      { currencyCode: 'EUR', amount: '20.01', billed: '0.00', unbilled: '20.01' },
      { currencyCode: 'USD', amount: '15.45', billed: '12.35', unbilled: '3.10' },
    ],
  }),
  groups: [
    { groupKey: 'o1', groupLabel: 'Acme Co', ...totals({ charges: [{ currencyCode: 'USD', amount: '15.45', billed: '12.35', unbilled: '3.10' }] }) },
    { groupKey: 'o2', groupLabel: 'Globex', ...totals({ requests: 2, costUsd: '16.00', includedCostUsd: '0.00', unpricedRequests: 0,
      charges: [{ currencyCode: 'EUR', amount: '20.01', billed: '0.00', unbilled: '20.01' }] }) },
  ],
  detail: { cap: 5000, stored: 2, available: 2, truncated: false },
  notes: NOTES,
  rows: [
    { orgId: 'o1', orgName: 'Acme Co', model: 'model-alpha', currencyCode: 'USD', amount: '15.45', billed: '12.35', unbilled: '3.10', ...totals() },
    { orgId: 'o2', orgName: 'Globex', model: 'model-beta', currencyCode: 'EUR', amount: '20.01', billed: '0.00', unbilled: '20.01', ...totals({ requests: 1 }) },
  ],
};

  return SUMMARY;
})();

const narrative = (() => {
function fullNarrativeFixture(): OrgNarrativeReportSummary {
  return {
    narrative: {
      version: 1,
      headline: 'A quiet, healthy week across the fleet.',
      orgName: 'Acme Corp',
      partnerName: 'Northwind MSP',
      periodStart: '2026-06-22T00:00:00Z',
      periodEnd: '2026-06-28T23:59:59Z',
      generatedAt: '2026-06-29T09:00:00Z',
      runId: 'run_123',
      agentName: 'Ops Narrator',
      sections: NARRATIVE_SECTION_KEYS.map((key) => ({
        key,
        title: `SHOULD BE IGNORED (${key})`,
        bullets: [`Bullet one for ${key}`, `Bullet two for ${key}`],
      })),
      markdown: '# THIS MARKDOWN MUST NEVER RENDER\n- secret bullet',
    },
  };
}

  return fullNarrativeFixture();
})();

const sla = (() => {

const NOTES = [
  'Attainment is recomputed from ticket timestamps and the SLA targets stored on each ticket, not from the sla_breached_at stamp: the SLA sweep only marks tickets that are still open and unanswered when it runs, so a late-but-eventually-answered ticket is never stamped.',
  'sla_paused_minutes is a lifetime total, so pause time that occurred after first response slightly flatters response attainment.',
  'Tickets with no SLA target are excluded from the attainment denominators and counted separately.',
  'Planned work (work_kind other than support) carries a due date, not an SLA, and is excluded.',
  "The technician axis uses the ticket's CURRENT assignee; reassignment history is not tracked.",
];

const SUMMARY: TicketSlaSummary = {
  generatedAt: '2026-09-30T05:18:00.000Z',
  period: {
    kind: 'last_full_month',
    start: '2026-09-01T00:00:00.000Z',
    end: '2026-10-01T00:00:00.000Z',
    label: 'September 2026',
    timeZone: 'America/Chicago',
  },
  scope: { kind: 'organization', orgId: 'o1', orgName: 'Acme Co' },
  groupBy: 'priority',
  overall: {
    ticketsTotal: 120,
    noSlaTickets: 10,
    responseEligible: 110,
    responseMet: 100,
    responseAttainment: 100 / 110,
    resolutionEligible: 110,
    resolutionMet: 95,
    resolutionAttainment: 95 / 110,
    breaches: 15,
  },
  groups: [
    {
      groupKey: 'urgent', groupLabel: 'Urgent', ticketsTotal: 20, noSlaTickets: 1,
      responseEligible: 19, responseMet: 15, responseAttainment: 15 / 19,
      resolutionEligible: 19, resolutionMet: 16, resolutionAttainment: 16 / 19, breaches: 4,
    },
    {
      groupKey: 'normal', groupLabel: 'Normal', ticketsTotal: 100, noSlaTickets: 9,
      responseEligible: 91, responseMet: 85, responseAttainment: 85 / 91,
      resolutionEligible: 91, resolutionMet: 79, resolutionAttainment: 79 / 91, breaches: 11,
    },
  ],
  worstGroupLabel: 'Urgent',
  stampDiscrepancy: { recomputedBreachNotStamped: 3, stampedNotRecomputedBreach: 1 },
  detail: { cap: 5000, stored: 2, available: 2, truncated: false },
  notes: NOTES,
  rows: [
    {
      ticketId: 't1', ticketNumber: 'T-1', internalNumber: null, orgId: 'o1', orgName: 'Acme Co',
      subject: 'Server down', priority: 'urgent', category: 'infrastructure', assignedToId: 'u1', assignedToName: 'Jamie Lee',
      createdAt: '2026-09-05T10:00:00.000Z', firstResponseAt: '2026-09-05T12:00:00.000Z',
      resolvedAt: '2026-09-06T10:00:00.000Z', responseSlaMinutes: 60, resolutionSlaMinutes: 480,
      slaPausedMinutes: 0, responseOutcome: 'missed', resolutionOutcome: 'met',
      stampedBreachAt: null, stampedBreachReason: null,
    },
    {
      ticketId: 't2', ticketNumber: 'T-2', internalNumber: null, orgId: 'o1', orgName: 'Acme Co',
      subject: 'Password reset', priority: 'normal', category: null, assignedToId: null, assignedToName: null,
      createdAt: '2026-09-10T10:00:00.000Z', firstResponseAt: '2026-09-10T10:30:00.000Z',
      resolvedAt: '2026-09-10T11:00:00.000Z', responseSlaMinutes: 120, resolutionSlaMinutes: 240,
      slaPausedMinutes: 0, responseOutcome: 'met', resolutionOutcome: 'met',
      stampedBreachAt: null, stampedBreachReason: null,
    },
  ],
};

function makeRow(i: number, breached: boolean): TicketSlaSummary['rows'][number] {
  return {
    ticketId: `t${i}`, ticketNumber: `T-${i}`, internalNumber: null, orgId: 'o1', orgName: 'Acme Co',
    subject: `Ticket ${i}`, priority: 'normal', category: null, assignedToId: null, assignedToName: null,
    createdAt: '2026-09-10T10:00:00.000Z', firstResponseAt: '2026-09-10T10:30:00.000Z',
    resolvedAt: '2026-09-10T11:00:00.000Z', responseSlaMinutes: 120, resolutionSlaMinutes: 240,
    slaPausedMinutes: 0,
    responseOutcome: breached ? 'missed' : 'met',
    resolutionOutcome: 'met',
    stampedBreachAt: null, stampedBreachReason: null,
  };
}

  return SUMMARY;
})();

const slaPerf = (() => {
const BREACH: TicketSlaBreachRow = {
  ticketId: 't1', ticketNumber: 'T-1001', subject: 'Printer offline on the third floor',
  priority: 'urgent', target: 'response', targetMinutes: 60,
  createdAt: '2026-10-05T09:00:00.000Z', dueAt: '2026-10-05T10:00:00.000Z',
  completedAt: '2026-10-05T11:05:00.000Z', elapsedSlaMinutes: 125, overByMinutes: 65,
};

function summary(over: Partial<TicketSlaPerformanceSummary> = {}): TicketSlaPerformanceSummary {
  const base = emptyTicketSlaPerformanceSummary('Times are measured on each ticket\'s SLA clock.');
  const urgent = {
    ...base.priorities[0]!,
    ticketsOpened: 12,
    responseTargetMinutes: 60, responseTargetVaries: true,
    responseMeasured: 10, responseMet: 9, responseMissed: 1,
    responseAttainment: 0.9, responseMedianMinutes: 38, responseMeanMinutes: 125, responseTimedSample: 10,
  };
  const priorities = [urgent, base.priorities[1]!, base.priorities[2]!, base.priorities[3]!];
  return {
    ...base,
    period: {
      kind: 'last_full_month', start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z',
      label: 'October 2026', timeZone: 'America/Chicago', measuredThrough: '2026-11-01T00:00:00.000Z',
    },
    org: { orgId: 'o1', orgName: 'Acme Co' },
    overall: { ...urgent, priority: 'all' },
    priorities,
    rows: priorities,
    breaches: { cap: 1000, stored: 1, available: 1, truncated: false, rows: [BREACH] },
    ...over,
  };
}

  return summary();
})();

const identity = (() => {
const SUMMARY: IdentityAccessSummary = {
  orgId: 'o1',
  orgName: 'Harlow & Pierce P.C.',
  generatedAt: '2026-09-30T05:18:00.000Z',
  coverage: {
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    coveredFrom: '2026-09-01T00:00:00.000Z',
    coveredTo: '2026-09-30T05:00:00.000Z',
    generatedAt: '2026-09-30T05:18:00.000Z',
    asOf: '2026-09-30T05:00:00.000Z',
    lastStatus: 'success',
    unlicensed: false,
    note: '',
  },
  identity: {
    usersTotal: 42, usersEnabled: 40, usersDisabled: 2, admins: 4,
    mfaRegistered: 38, mfaUnknown: 2, adminsWithoutMfa: 1, adminsMfaUnknown: 1,
  },
  dormant: {
    thresholdDays: 45,
    rows: [{
      userPrincipalName: 'old@acme.example', displayName: 'Old Account',
      lastSuccessfulSignInAt: null, isAdmin: false, mfaRegistered: null,
    }],
  },
  signins: {
    total: 1204, distinctUsers: 39, failures: 22,
    failuresByErrorCode: { '50126': 20, '53003': 2 },
    outsideHomeCountries: 3,
    legacyAuth: { IMAP4: 4 },
    conditionalAccessFailures: 2,
    byRiskLevel: { none: 1200, low: 4 },
  },
  adminSignins: [{
    signedInAt: '2026-09-10T09:00:00.000Z',
    userPrincipalName: 'root@acme.example',
    appDisplayName: 'Azure Portal',
    clientAppUsed: 'Browser',
    ipAddress: '203.0.113.10',
    locationCity: 'Austin',
    locationCountry: 'US',
    conditionalAccessStatus: 'success',
    statusErrorCode: 0,
    riskLevelAggregated: 'none',
  }],
  conditionalAccess: {
    policies: [
      { displayName: 'MFA for admins', state: 'enabled', changedThisPeriod: true, isStale: false },
      { displayName: 'Old rule', state: 'disabled', changedThisPeriod: false, isStale: true },
    ],
    changedThisPeriod: 1,
  },
  remoteAccess: {
    byProvider: { tailscale: 3 },
    caveat: 'Client presence only; no policy or peer data is collected.',
  },
  rows: [],
  dataGaps: [],
};

  return SUMMARY;
})();

const fleet = (() => {
// Copied from validators/fleetDesign.test.ts's validSubmission() so this file
// doesn't depend on another test module's fixtures. Intentionally loosely
// typed (inferred, not annotated FleetDesignSubmission) — see that file for why.
const FD1 = '11111111-1111-4111-8111-111111111111';
const FD2 = '22222222-2222-4222-8222-222222222222';

function validFleetDesignSubmission() {
  return {
    found: {
      summary: ['12 devices across 2 sites.'],
      findings: [{ title: 'Shared local admin on 4 workstations', deviceCount: 4, evidence: ['posture:localAdmin'] }],
    },
    functions: [
      { functionKey: 'file_server', deviceIds: [FD1], confidence: 0.9, evidence: ['SMB listener; 2 TB data volume'] },
    ],
    monitoring: [
      {
        functionKey: 'file_server',
        watches: [{ watchType: 'service', name: 'LanmanServer', alertOnStop: true, autoRestart: true, rationale: 'SMB is the function.' }],
        alertRules: [{
          name: 'File server disk over 85%', severity: 'high',
          conditions: [{ type: 'metric', metric: 'disk', operator: 'gt', value: 85, durationMinutes: 15 }],
          cooldownMinutes: 60, rationale: 'Data volume growth is the failure mode.', action: 'none', paging: 'business_hours',
        }],
      },
    ],
    retired: [{ kind: 'watch', policyId: 'p1', policyName: 'Legacy monitoring', itemName: 'Print Spooler', reason: 'No print server function detected.' }],
    automation: [{ functionKey: 'file_server', playbooks: [{ builtInName: 'Restart stopped service' }], scripts: [] }],
    legacy: [{ scriptId: 's1', scriptName: 'cleanup.ps1', intent: 'Disk cleanup', bucket: 'covered', coveredBy: 'Automation: file_server', notes: 'Superseded by the new automation.' }],
    baseline: { notes: ['Alert rate is dominated by disk warnings.'] },
    unsure: {
      lowConfidenceFunctions: [{ functionKey: 'kiosk', deviceIds: [FD2], confidence: 0.4, evidence: ['single logon user'] }],
      unreachableDevices: [], needsHuman: [], roleCorrections: [],
    },
  };
}

const fleetDesignRefs: FleetDesignOutcomeRefs = {
  deviceIds: new Set([FD1, FD2]),
  baseline: { alertsPer100EndpointsPerMonth: 42, ticketsPerMonth: 7, precursors: [{ condition: 'disk_used_over_threshold', deviceCount: 3 }] },
  generatedAt: '2026-09-12T00:00:00.000Z',
};
  return fleetDesignOutcomeFromSubmission(validFleetDesignSubmission() as unknown as FleetDesignSubmission, fleetDesignRefs);
})();

const exec: ExecutiveSummary = {
  org: { id: 'o1', name: 'Example Client' },
  devices: { total: 12, online: 9, offline: 3, healthPercentage: 75 },
  alerts: { total: 18, critical: 2, high: 5, resolved: 12, resolutionRate: 67 },
  osDistribution: { windows: 12 },
  siteBreakdown: [{ site: 'Main Office', count: 12 }],
  period: { start: '2026-10-10T17:06:00.000Z', end: '2026-11-09T17:06:00.000Z' },
};

const posture: PostureSummary = {
  org: { id: 'o1', name: 'Example Client' },
  deviceCount: 8,
  postureScore: 64,
  controls: {
    edrCoveragePct: 63, anyAvCoveragePct: 100, avDefinitionsCurrentPct: 100, encryptionPct: 100,
    firewallPct: 100, patchCurrentPct: 100, passwordComplexityPct: 0, localAdminExposurePct: 83,
    cisIncluded: false, identityProviderConnected: false, backupRequired: false, backupConfigured: false, dnsFilteringActive: false,
  },
};
const postureRow = (hostname: string) => ({
  hostname, site: 'Main Office', os: 'windows', protection: 'Windows Defender (RTP on)', protectionManaged: false,
  realTimeProtection: true, avDefinitionsAgeDays: 1, encryption: 'encrypted', firewall: true, localAdmins: 3,
  patchAssessed: true, pendingPatches: 2, criticalPatches: 0, openVulnCritical: 19, openVulnHigh: 5, cisPassRate: null, posture: null,
});

const threat: ThreatDetectionSummary = {
  orgId: 'o1',
  orgName: 'Example Client',
  generatedAt: '2026-11-09T17:06:00.000Z',
  coverage: {
    periodStart: '2026-10-10', periodEnd: '2026-11-09',
    coveredFrom: '2026-01-01T00:00:00.000Z', coveredTo: '2026-11-09T11:00:00.000Z',
    generatedAt: '2026-11-09T17:06:00.000Z', sourceStatus: 'ok',
    lastSyncAt: '2026-11-09T11:00:00.000Z', lastSyncStatus: 'ok',
    unattributableExcluded: 0, withheld: 0, note: '',
  },
  agentCoverage: {
    huntressAgents: 8, breezeDevices: 12, agentsOffline: 0, devicesWithoutAgent: 4,
    devicesWithDetectionAgent: 8, devicesWithoutDetectionAgent: 4, unmatchedAgents: 0,
  },
  incidents: {
    opened: 1, resolved: 1, bySeverity: { low: 1 }, byStatus: { resolved: 1 },
    meanResolveHours: 3, medianResolveHours: 3, carriedIn: 0,
  },
  rows: [{
    id: 'i1', reportedAt: '2026-10-20T14:00:00.000Z', hostname: 'WS-04', severity: 'low', category: 'identity',
    title: 'Suspicious sign-in', status: 'resolved', resolvedAt: '2026-10-20T17:00:00.000Z', recommendation: null,
  }],
  dataGaps: [],
};

const vuln: VulnerabilityManagementSummary = {
  orgId: 'o1',
  orgName: 'Example Client',
  generatedAt: '2026-11-09T17:06:00.000Z',
  period: { start: '2026-10-10', end: '2026-11-09', nextEnd: '2026-12-09' },
  feeds: [{ name: 'nvd', lastSyncAt: '2026-11-09T08:00:00.000Z', lastStatus: 'success', stale: false }],
  feedNote: '',
  open: { critical: 2, high: 5, medium: 9, low: 1, knownExploited: 1, highEpss: 2, epssThreshold: 0.5 },
  topRemediable: [{ cveId: 'CVE-2026-1111', severity: 'critical', knownExploited: true, epssScore: 0.94, riskScore: 92, patchAvailable: true, affectedDevices: 4, title: 'Remote code execution in Widget' }],
  withheld: 0,
  exceptions: [{ cveId: 'CVE-2026-2222', status: 'accepted', acceptedBy: 'Jo', acceptedUntil: '2026-11-20', expiringNextPeriod: true, affectedDevices: 2 }],
  closedThisPeriod: { count: 6, bySeverity: { critical: 1, high: 5 } },
  rows: [{ cveId: 'CVE-2026-1111', severity: 'critical', knownExploited: true, epssScore: 0.94, riskScore: 92, patchAvailable: true, affectedDevices: 4 }],
  dataGaps: [],
};


// ---------------------------------------------------------------------------
// Harness: record every drawn string with its anchor x and width.
// ---------------------------------------------------------------------------
type Drawn = { str: string; left: number; right: number; page: number };
const TOL = 0.5; // mm of float slack only; never widen to hide overflow

function renderRecorded(rows: unknown[], opts: BuildOpts): { doc: ReturnType<typeof buildReportPdf>; drawn: Drawn[] } {
  const drawn: Drawn[] = [];
  // jsPDF binds `text` per instance in its constructor, so wrap it from the
  // 'initialized' plugin event (autoTable also draws through doc.text).
  const events = (jsPDF.API as unknown as { events: Array<[string, (this: jsPDF) => void]> }).events;
  const hook: [string, (this: jsPDF) => void] = ['initialized', function (this: jsPDF) {
    const doc = this as unknown as { text: (...a: unknown[]) => unknown };
    const orig = doc.text;
    doc.text = function (this: jsPDF, ...args: unknown[]) {
      const [textArg, x, , options] = args as [string | string[], number, number, { align?: string; angle?: number } | undefined];
      const lines = (Array.isArray(textArg) ? textArg : [String(textArg)]).map(String);
      if (typeof x === 'number' && !options?.angle) {
        const page = this.getCurrentPageInfo().pageNumber;
        for (const str of lines) {
          const w = this.getTextWidth(str);
          const align = options?.align ?? 'left';
          const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
          drawn.push({ str, left, right: left + w, page });
        }
      }
      return orig.apply(this, args);
    };
  }];
  events.push(hook);
  try {
    return { doc: buildReportPdf(rows, opts), drawn };
  } finally {
    events.splice(events.indexOf(hook), 1);
  }
}

/** Lengthen name-like fields so a realistic MSP client name does not slip past. */
const LONG = ' Consolidated Holdings and Partners International LLC';
function stretch<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stretch) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) =>
      [k, typeof v === 'string' && /(name|hostname|title|site|principal|email)$/i.test(k) && v.length > 2 ? v + LONG : stretch(v)])) as T;
  }
  return value;
}

const usPartner: ReportBranding = {
  name: 'Example MSP', logoDataUrl: null, logoAspect: null,
  pageSize: 'letter', dateFormat: 'MM/DD/YYYY', timeFormat: '12h',
};
const GENERATED = new Date('2026-11-09T17:06:00.000Z');

const wideRows = Array.from({ length: 30 }, (_, i) => ({
  hostname: `workstation-${i}.corp.example-client.com`, owner: 'Alexandria Montgomery-Featherstonehaugh',
  site: 'Main Office - Building 4 West Wing', model: 'Dell Precision 7960 Tower Workstation', os: 'Windows 11 Pro 23H2 (22631.4460)',
  serialNumber: 'SVC-TAG-ABCDEFGHIJ-0123456789', lastSeen: '2026-11-09T12:00:00Z', ipAddress: '192.168.100.200', status: 'online', department: 'Accounts Receivable and Payroll',
}));

const postureWithMeta: PostureSummary = { ...posture, generatedAt: '2026-11-09T17:06:00.000Z', excludedBySiteFilterCount: 2, deviceCount: 8, privilegedAccess: { windowDays: 30, activePamRules: 3, elevationsInWindow: 14, mfaStepUpEnforced: true } };
const postureRows = Array.from({ length: 8 }, (_, i) => postureRow(`DESKTOP-ACCOUNTING-${i + 1}.corp.example`));

const CASES: Array<{ name: string; rows: unknown[]; opts: Pick<BuildOpts, 'reportType' | 'summary'> }> = [
  { name: 'identity_access_review', rows: [], opts: { reportType: 'identity_access_review', summary: identity } },
  { name: 'endpoint_management_review', rows: [], opts: { reportType: 'endpoint_management_review', summary: endpoint } },
  { name: 'hardware_lifecycle', rows: [], opts: { reportType: 'hardware_lifecycle', summary: hardware } },
  { name: 'backup_status', rows: [], opts: { reportType: 'backup_status', summary: backup } },
  { name: 'ar_aging', rows: [], opts: { reportType: 'ar_aging', summary: arAging } },
  { name: 'client_profitability', rows: [], opts: { reportType: 'client_profitability', summary: profit } },
  { name: 'mrr_renewals', rows: [], opts: { reportType: 'mrr_renewals', summary: mrr } },
  { name: 'quote_win_rate', rows: [], opts: { reportType: 'quote_win_rate', summary: quote } },
  { name: 'technician_time_billability', rows: [], opts: { reportType: 'technician_time_billability', summary: tech } },
  { name: 'ai_usage_by_client', rows: [], opts: { reportType: 'ai_usage_by_client', summary: aiUsage } },
  { name: 'ai_org_narrative', rows: [], opts: { reportType: 'ai_org_narrative', summary: narrative } },
  { name: 'ai_fleet_design', rows: [], opts: { reportType: 'ai_fleet_design', summary: { fleetDesign: { outcome: fleet, orgName: 'Harlow Pierce Consolidated Holdings and Partners', agentName: 'Designer' } } } },
  { name: 'ticket_sla_attainment', rows: [], opts: { reportType: 'ticket_sla_attainment', summary: sla } },
  { name: 'ticket_sla_performance', rows: [], opts: { reportType: 'ticket_sla_performance', summary: slaPerf } },
  { name: 'security_compliance_posture', rows: postureRows, opts: { reportType: 'security_compliance_posture', summary: postureWithMeta } },
  { name: 'executive_summary', rows: [], opts: { reportType: 'executive_summary', summary: exec } },
  { name: 'threat_detection_review', rows: [], opts: { reportType: 'threat_detection_review', summary: threat } },
  { name: 'vulnerability_management', rows: [], opts: { reportType: 'vulnerability_management', summary: vuln } },
  { name: 'generic table (10 columns)', rows: wideRows, opts: { reportType: 'asset_inventory' } },
];

describe.each(CASES.flatMap((c) => [
  { ...c, variant: 'fixture', stress: false },
  { ...c, variant: 'long names', stress: true },
]))('$name at US Letter ($variant) (#12048)', ({ rows, opts, stress }) => {
  it('draws every string inside the page, on a 279.4 x 215.9 mm page', () => {
    const o: BuildOpts = { ...opts, summary: stress ? stretch(opts.summary) : opts.summary, generatedAt: GENERATED, timezone: 'America/New_York', branding: usPartner };
    const { doc, drawn } = renderRecorded(stress ? stretch(rows) as unknown[] : rows, o);
    const n = doc.getNumberOfPages();
    expect(n).toBeGreaterThan(0);
    for (let i = 1; i <= n; i += 1) {
      doc.setPage(i);
      expect(doc.internal.pageSize.getWidth()).toBeCloseTo(279.4, 0);
      expect(doc.internal.pageSize.getHeight()).toBeCloseTo(215.9, 0);
    }
    const pageW = doc.internal.pageSize.getWidth();
    expect(drawn.length).toBeGreaterThan(20);
    const over = drawn.filter((d) => d.right > pageW - TOL || d.left < -TOL);
    expect(over.map((d) => `p${d.page} [${d.left.toFixed(1)}..${d.right.toFixed(1)}] ${d.str.slice(0, 60)}`)).toEqual([]);
  });
});
