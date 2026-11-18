import { sql, type SQL } from 'drizzle-orm';
import {
  emptyMrrRenewalsSummary,
  fromCents,
  fromMinorUnits,
  multiplyToCurrency,
  roundToCurrency,
  toCents,
  toMinorUnits,
  type MrrBilledMonth,
  type MrrContractDetailRow,
  type MrrCurrencyTotals,
  type MrrGroupRow,
  type MrrRenewalTotals,
  type MrrRenewalsHorizonDays,
  type MrrRenewalsSummary,
} from '@breeze/shared';
import { db } from '../../db';
import { sqlUuidArray } from '../../db/sqlValues';
import { addDaysISO, todayISO } from '../contractMath';
import { resolveContractMrrRows, type ContractMrrRow } from '../contractMrr';
import { mrrRenewalsConfigSchema, type MrrRenewalsConfig } from '../reportConfigSchemas';
import type { ReportResult } from '../reportGenerationService';
import { reportTypeDef } from '../reportRegistry';
import { reportOwnerOfScope, runInReportScope, type ReportScope } from '../reportScope';
import type { ReportGenerationAuthority } from '../siteScope';
import { blockOverageLineIdsCte } from './blockOverageSql';
import { NO_ORGS_NOTE, PARTNER_ORG_LIST_NOTE, rowsOf, SITE_RESTRICTED_NOTE } from './common';
import { reportTimezone, resolveReportOwnerTimezone } from './period';

/**
 * MRR & renewals (`mrr_renewals`, #9828 W1; spec §3.2).
 *
 * Measured at run time — contracts keep no status history, so the config
 * refuses `asOf` and `period`. `asOf` is the UTC date of the run, the same
 * "today" billing uses (contracts carry no timezone); the owner timezone only
 * labels the billed-recurring months.
 *
 *  - MRR: `resolveContractMrrRows` (contractMrr.ts), the same per-contract
 *    figures behind the partner dashboard. In term = `active` and
 *    `billed_final_term` rows; paused and draft contracts are valued live and
 *    reported BESIDE MRR, never in it. Contracts that should count but could
 *    not be valued are listed (`skipped`), never silently dropped.
 *  - Renewals: in-term contracts whose end date falls in [asOf, asOf + horizon).
 *  - Billed recurring: issued contract invoice lines over the 12 owner-timezone
 *    calendar months ending with the run month, a billing period's line spread
 *    evenly over its months; hour-block overage lines (usage) are excluded.
 *
 * Tenancy: ONE `runInReportScope`; every query carries the explicit org
 * allowlist and, on partner-axis tables (`contracts`, `invoices`,
 * `organizations`), `partner_id` at partner scope. RLS is the backstop.
 */

const DETAIL_ROW_CAP = reportTypeDef('mrr_renewals').detailRowCap;
const DEFAULT_HORIZON: MrrRenewalsHorizonDays = 90;
const SERIES_MONTHS = 12;
/** How far before the series window an invoice can be issued and still spread
 *  into it: the longest contract billing interval the validator allows
 *  (`intervalMonths` max 60, packages/shared/src/validators/contracts.ts). */
const SPREAD_LOOKBACK_MONTHS = 60;

export type { MrrRenewalsConfig };
type GroupBy = MrrRenewalsSummary['groupBy'];

export const AS_OF_RUN_TIME_NOTE =
  'Figures are as of the run date (UTC, the date billing uses). Contracts keep no status history, so this report cannot be backdated.';
export const LIVE_QUANTITIES_NOTE =
  'Per-device and per-seat quantities are counted live at run time (seats are active Breeze users mapped to the organization) and priced as billing prices them, so MRR is an estimate of the next invoices, not a billed amount.';
export const FINAL_TERM_NOTE =
  'A contract in its final, already-billed term counts at the value its last invoice billed, spread over the billing interval; that value is not split into base and overage.';
export const BILLED_SERIES_NOTE =
  'Billed recurring revenue is what issued invoices billed for contracts, not MRR. A billing period\'s line is spread evenly over its months; a contract line added to an invoice by hand counts in the invoice\'s month; hour-block overage is usage and is excluded.';
export const UNKNOWN_ORG_NOTE =
  'Some contracts belong to an organization whose name could not be read; they are labelled with the start of the organization\'s id.';
export const HISTORY_STARTS_NOTE =
  'MRR has no history before this report first ran: the trend starts with the first scheduled run, and each run compares with the previous one.';
export const SUSPENDED_ORGS_MRR_NOTE =
  'Contracts of suspended or archived organizations are not counted, even if they still bill.';
export const excludedContractsNote = (n: number): string =>
  `MRR excludes ${n} ${n === 1 ? 'contract that' : 'contracts that'} could not be valued; ${n === 1 ? 'it is' : 'they are'} listed below.`;
export const deletedGroupNote = (n: number): string =>
  `${n} ${n === 1 ? 'contract bills' : 'contracts bill'} a deleted device group; that line counts as zero.`;

const IN_TERM = new Set<ContractMrrRow['basis']>(['active', 'billed_final_term']);
const isInTerm = (r: ContractMrrRow): boolean => IN_TERM.has(r.basis);

/** Exact per-currency accumulator: integer cents of already-rounded strings. */
class CentsSum {
  private cents = 0;
  count = 0;
  add(amount: string | null): void {
    if (amount === null) return;
    this.cents += toCents(amount);
    this.count += 1;
  }
  value(currencyCode: string): string {
    return roundToCurrency(fromCents(this.cents), currencyCode);
  }
}

function totalsFor(currencyCode: string, rows: readonly ContractMrrRow[]): MrrCurrencyTotals {
  const mrr = new CentsSum();
  const base = new CentsSum();
  const overage = new CentsSum();
  const finalTerm = new CentsSum();
  const paused = new CentsSum();
  const pending = new CentsSum();
  const evergreen = new CentsSum();
  for (const r of rows) {
    if (isInTerm(r)) {
      mrr.add(r.mrr);
      base.add(r.baseMonthly);
      if (r.basis === 'active') overage.add(r.overageMonthly);
      if (r.basis === 'billed_final_term') finalTerm.add(r.mrr);
      if (r.endDate === null) evergreen.add(r.mrr);
    } else if (r.basis === 'paused') {
      paused.add(r.mrr);
    } else if (r.basis === 'draft') {
      pending.add(r.mrr);
    }
  }
  const mrrValue = mrr.value(currencyCode);
  return {
    currencyCode,
    mrr: mrrValue,
    baseMrr: base.value(currencyCode),
    overageMrr: overage.value(currencyCode),
    finalTermMrr: finalTerm.value(currencyCode),
    arr: multiplyToCurrency(mrrValue, 12, currencyCode),
    contractCount: mrr.count,
    pausedMrr: paused.value(currencyCode),
    pausedCount: paused.count,
    pendingActivationMrr: pending.value(currencyCode),
    pendingActivationCount: pending.count,
    evergreenMrr: evergreen.value(currencyCode),
    evergreenCount: evergreen.count,
  };
}

function byCurrencyOf(rows: readonly ContractMrrRow[]): Map<string, ContractMrrRow[]> {
  const out = new Map<string, ContractMrrRow[]>();
  for (const r of rows) out.set(r.currencyCode, [...(out.get(r.currencyCode) ?? []), r]);
  return new Map([...out.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** `YYYY-MM-DD` of `now` as a wall-clock date in `timeZone`. */
function dateInZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Month index (year × 12 + month0) of a `YYYY-MM[-DD]` string, and back. */
const monthIndex = (iso: string): number => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;
const monthLabel = (idx: number): string =>
  `${String(Math.floor(idx / 12)).padStart(4, '0')}-${String((idx % 12) + 1).padStart(2, '0')}`;
const monthStart = (idx: number): string => `${monthLabel(idx)}-01`;

function daysBetween(fromISO: string, toISO: string): number {
  const at = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  return Math.round((at(toISO) - at(fromISO)) / 86_400_000);
}

type BilledLine = {
  line_total: string; currency_code: string; issue_date: string;
  period_start: string | null; period_end: string | null;
};

/**
 * Spread each billed line over its months (in the currency's minor unit, the
 * remainder on the last month, so the spread sums to `line_total` exactly) and
 * keep the window months. A line with a billing period spreads from the
 * period's start month over the period's length in months; a line without one
 * (an interactively added contract line) lands in its issue month. Dates are
 * compared as `date` strings — no timezone math.
 */
function billedSeries(lines: readonly BilledLine[], firstMonth: number, runMonth: number): MrrBilledMonth[] {
  const sums = new Map<string, Map<number, number>>(); // currency -> month idx -> minor units
  const add = (currency: string, month: number, minor: number) => {
    if (month < firstMonth || month > runMonth) return;
    const per = sums.get(currency) ?? new Map<number, number>();
    per.set(month, (per.get(month) ?? 0) + minor);
    sums.set(currency, per);
  };
  for (const l of lines) {
    const currency = String(l.currency_code);
    const minor = toMinorUnits(String(l.line_total), currency);
    if (l.period_start && l.period_end) {
      const start = monthIndex(l.period_start);
      const months = Math.max(1, monthIndex(l.period_end) - start);
      const each = Math.trunc(minor / months);
      for (let i = 0; i < months; i++) {
        add(currency, start + i, i === months - 1 ? minor - each * (months - 1) : each);
      }
    } else {
      add(currency, monthIndex(l.issue_date), minor);
    }
  }
  const out: MrrBilledMonth[] = [];
  for (const currency of [...sums.keys()].sort()) {
    const per = sums.get(currency)!;
    for (let m = firstMonth; m <= runMonth; m++) {
      out.push({ month: monthLabel(m), currencyCode: currency, amount: fromMinorUnits(per.get(m) ?? 0, currency), partial: m === runMonth });
    }
  }
  return out;
}

function toResult(summary: MrrRenewalsSummary): ReportResult {
  return {
    rows: summary.rows as unknown as Record<string, unknown>[],
    rowCount: summary.rows.length,
    generatedAt: summary.generatedAt,
    summary: summary as unknown as Record<string, unknown>,
  };
}

function scopeMeta(scope: ReportScope, orgName: string | null): MrrRenewalsSummary['scope'] {
  return scope.kind === 'partner'
    ? { kind: 'partner', partnerId: scope.partnerId, orgCount: scope.orgIds.length }
    : { kind: 'organization', orgId: scope.orgId, orgName };
}

export async function generateMrrRenewalsReport(
  scope: ReportScope,
  rawConfig: Record<string, unknown>,
  authority: ReportGenerationAuthority,
): Promise<ReportResult> {
  // Parse BEFORE any query: a stored config the type rejects never runs.
  const config = mrrRenewalsConfigSchema.parse(rawConfig ?? {});
  const groupBy: GroupBy = config.groupBy ?? 'organization';
  const horizon: MrrRenewalsHorizonDays = config.renewalHorizonDays ?? DEFAULT_HORIZON;
  const generatedAt = new Date();
  const asOf = todayISO(generatedAt);
  const header = { generatedAt: generatedAt.toISOString(), asOf, groupBy, renewalHorizonDays: horizon };

  // Contracts have no site column; a restricted authority (any number of
  // sites) queries nothing (ruling T7a — the dispatcher guards this too).
  if (authority.scope.kind === 'restricted') {
    return toResult({
      ...emptyMrrRenewalsSummary(SITE_RESTRICTED_NOTE),
      ...header,
      scope: scopeMeta(scope, null),
      detail: { cap: DETAIL_ROW_CAP, stored: 0, available: 0, truncated: false },
    });
  }

  // ONE scoped block for the whole report (ruling P6).
  return runInReportScope(scope, async () => {
    const { timeZone, note: timeZoneNote } = reportTimezone(
      await resolveReportOwnerTimezone(reportOwnerOfScope(scope)),
    );

    const notes = [AS_OF_RUN_TIME_NOTE, LIVE_QUANTITIES_NOTE, FINAL_TERM_NOTE, BILLED_SERIES_NOTE, HISTORY_STARTS_NOTE];
    if (timeZoneNote) notes.push(timeZoneNote);
    if (scope.kind === 'partner') notes.push(PARTNER_ORG_LIST_NOTE, SUSPENDED_ORGS_MRR_NOTE);

    if (scope.kind === 'partner' && scope.orgIds.length === 0) {
      return toResult({
        ...emptyMrrRenewalsSummary(NO_ORGS_NOTE),
        ...header,
        timeZone,
        scope: scopeMeta(scope, null),
        detail: { cap: DETAIL_ROW_CAP, stored: 0, available: 0, truncated: false },
        notes: [NO_ORGS_NOTE, ...notes],
      });
    }

    const orgIds = scope.kind === 'partner' ? scope.orgIds : [scope.orgId];
    const partnerId = scope.kind === 'partner' ? scope.partnerId : undefined;
    const orgAllowlist = sqlUuidArray(orgIds);
    const partnerBound = (column: SQL): SQL => (partnerId !== undefined ? sql` AND ${column} = ${partnerId}` : sql``);

    const nameRows = rowsOf<{ id: string; name: string }>(await db.execute(sql`/* mrr:org_names */
      SELECT o.id::text AS id, o.name FROM organizations o
      WHERE o.id = ANY(${orgAllowlist})${partnerBound(sql`o.partner_id`)}`));
    const orgNames = new Map(nameRows.map((r) => [String(r.id), String(r.name)]));
    const orgNameOf = (orgId: string): string | null => orgNames.get(orgId) ?? null;

    const resolved = await resolveContractMrrRows(orgIds, generatedAt, { include: ['paused', 'draft'], partnerId });

    // ---- renewal window --------------------------------------------------
    const windowEnd = addDaysISO(asOf, horizon);
    const inWindow = (r: ContractMrrRow): boolean =>
      isInTerm(r) && r.endDate !== null && r.endDate >= asOf && r.endDate < windowEnd;
    const windowRows = resolved.rows.filter(inWindow)
      .sort((a, b) => a.endDate!.localeCompare(b.endDate!) || a.name.localeCompare(b.name) || a.contractId.localeCompare(b.contractId));

    // The advance notice for the CURRENT term: matched on (contract, its own
    // end_date). The table has no partner_id; the ids come from the
    // partner-bound contract set and the org allowlist is bound too.
    const noticeSentAt = new Map<string, string>();
    if (windowRows.length > 0) {
      const noticeRows = rowsOf<{ contract_id: string; end_date: string; sent_at: string }>(await db.execute(sql`/* mrr:renewal_notices */
        SELECT n.contract_id::text AS contract_id, n.end_date::text AS end_date,
          to_char(n.sent_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS sent_at
        FROM contract_renewal_notices n
        WHERE n.kind = 'advance'
          AND n.contract_id = ANY(${sqlUuidArray(windowRows.map((r) => r.contractId))})
          AND n.org_id = ANY(${orgAllowlist})`));
      const endDateOf = new Map(windowRows.map((r) => [r.contractId, r.endDate]));
      for (const n of noticeRows) {
        if (endDateOf.get(String(n.contract_id)) === String(n.end_date)) noticeSentAt.set(String(n.contract_id), String(n.sent_at));
      }
    }

    const renewalTotals: MrrRenewalTotals[] = [...byCurrencyOf(windowRows)].map(([currencyCode, rows]) => {
      const auto = new CentsSum();
      const manual = new CentsSum();
      for (const r of rows) (r.autoRenew ? auto : manual).add(r.mrr);
      return {
        currencyCode,
        autoRenewMrr: auto.value(currencyCode), autoRenewCount: auto.count,
        manualMrr: manual.value(currencyCode), manualCount: manual.count,
      };
    });

    // ---- billed recurring series ------------------------------------------
    const runMonth = monthIndex(dateInZone(generatedAt, timeZone));
    const firstMonth = runMonth - (SERIES_MONTHS - 1);
    const invoicePredicate = sql`i.org_id = ANY(${orgAllowlist})${partnerBound(sql`i.partner_id`)}
        AND i.status IN ('sent', 'partially_paid', 'overdue', 'paid')
        AND i.issue_date >= ${monthStart(firstMonth - SPREAD_LOOKBACK_MONTHS)}::date
        AND i.issue_date < ${monthStart(runMonth + 1)}::date`;
    const billedLines = rowsOf<BilledLine>(await db.execute(sql`/* mrr:billed_recurring */
      WITH RECURSIVE ${blockOverageLineIdsCte({ invoiceIds: sql`SELECT i.id FROM invoices i WHERE ${invoicePredicate}` })}
      SELECT il.line_total::text AS line_total, i.currency_code::text AS currency_code, i.issue_date::text AS issue_date,
        cbp.period_start::text AS period_start, cbp.period_end::text AS period_end
      FROM invoice_lines il
      JOIN invoices i ON i.id = il.invoice_id AND i.org_id = il.org_id
      LEFT JOIN LATERAL (
        SELECT MIN(p.period_start) AS period_start, MAX(p.period_end) AS period_end
        FROM contract_billing_periods p
        -- A reissued invoice's period row still points at the voided original:
        -- take the period through the void → reissue chain (depth 1 is i itself).
        WHERE p.invoice_id IN (SELECT ancestor_id FROM block_overage_chain WHERE invoice_id = i.id)
          AND p.contract_id = il.source_contract_id AND p.org_id = i.org_id
      ) cbp ON true
      WHERE ${invoicePredicate}
        AND il.parent_line_id IS NULL
        AND il.customer_visible
        AND il.source_type = 'contract'
        AND il.id NOT IN (SELECT line_id FROM block_overage_lines)`));
    const billedRecurring = billedSeries(billedLines, firstMonth, runMonth);

    // ---- totals and groups (before the detail cap) -------------------------
    const byCurrency = [...byCurrencyOf(resolved.rows)].map(([code, rows]) => totalsFor(code, rows));

    const groupKeyOf = (r: ContractMrrRow): [string, string] => (groupBy === 'organization'
      ? [r.orgId, orgNameOf(r.orgId) ?? `Unknown organization (${r.orgId.slice(0, 8)})`]
      : [r.contractId, r.name]);
    const grouped = new Map<string, { label: string; rows: ContractMrrRow[] }>();
    for (const r of resolved.rows) {
      const [key, label] = groupKeyOf(r);
      const g = grouped.get(key) ?? { label, rows: [] };
      g.rows.push(r);
      grouped.set(key, g);
    }
    const groups: MrrGroupRow[] = [...grouped.entries()]
      .flatMap(([groupKey, g]) => [...byCurrencyOf(g.rows)].map(([code, rows]) => ({ groupKey, groupLabel: g.label, ...totalsFor(code, rows) })))
      .sort((a, b) => a.groupLabel.localeCompare(b.groupLabel) || a.currencyCode.localeCompare(b.currencyCode) || a.groupKey.localeCompare(b.groupKey));

    // ---- reconciliation lists and notes ------------------------------------
    const activeNotInTerm = resolved.activeNotInTerm.map((c) => ({
      contractId: c.contractId, contractName: c.name, orgName: orgNameOf(c.orgId),
      reason: c.reason, startDate: c.startDate, endDate: c.endDate,
    }));
    const skipped = resolved.skipped.map((c) => ({
      contractId: c.contractId, contractName: c.name, orgName: orgNameOf(c.orgId), reason: c.reason,
    }));
    if (skipped.length > 0) notes.push(excludedContractsNote(skipped.length));
    const unresolvedGroups = resolved.rows.filter((r) => r.unresolvedGroup).length;
    if (unresolvedGroups > 0) notes.push(deletedGroupNote(unresolvedGroups));
    const everyOrgId = [...resolved.rows, ...resolved.skipped, ...resolved.activeNotInTerm].map((c) => c.orgId);
    if (everyOrgId.some((id) => orgNameOf(id) === null)) notes.push(UNKNOWN_ORG_NOTE);

    // ---- detail rows -------------------------------------------------------
    const windowIds = new Set(windowRows.map((r) => r.contractId));
    const allDetail: MrrContractDetailRow[] = resolved.rows.map((r) => ({
      contractId: r.contractId,
      contractName: r.name,
      orgId: r.orgId,
      orgName: orgNameOf(r.orgId),
      status: r.status,
      basis: r.basis,
      intervalMonths: r.intervalMonths,
      currencyCode: r.currencyCode,
      baseMonthly: r.baseMonthly,
      overageMonthly: r.overageMonthly,
      mrr: r.mrr,
      startDate: r.startDate,
      endDate: r.endDate,
      daysRemaining: r.endDate === null ? null : daysBetween(asOf, r.endDate),
      autoRenew: r.autoRenew,
      renewalTermMonths: r.renewalTermMonths,
      inRenewalWindow: windowIds.has(r.contractId),
      advanceNoticeSentAt: noticeSentAt.get(r.contractId) ?? null,
    })).sort((a, b) => (a.orgName ?? '').localeCompare(b.orgName ?? '')
      || a.contractName.localeCompare(b.contractName)
      || a.contractId.localeCompare(b.contractId));
    const rows = allDetail.slice(0, DETAIL_ROW_CAP);

    return toResult({
      ...header,
      measured: true,
      timeZone,
      scope: scopeMeta(scope, scope.kind === 'organization' ? orgNameOf(scope.orgId) : null),
      byCurrency,
      groups,
      renewals: { totals: renewalTotals, contractIds: windowRows.map((r) => r.contractId) },
      activeNotInTerm,
      skipped,
      billedRecurring,
      detail: { cap: DETAIL_ROW_CAP, stored: rows.length, available: allDetail.length, truncated: allDetail.length > rows.length },
      notes,
      rows,
    });
  });
}
