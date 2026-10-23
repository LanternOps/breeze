import { sql } from 'drizzle-orm';
import {
  emptyQuoteWinRateSummary,
  roundToCurrency,
  type QuoteOutcome,
  type QuoteWinRateCounts,
  type QuoteWinRateDetailRow,
  type QuoteWinRateGroupBy,
  type QuoteWinRateGroupRow,
  type QuoteWinRateMoneyRow,
  type QuoteWinRateRates,
  type QuoteWinRateSummary,
} from '@breeze/shared';
import { db } from '../../db';
import { quoteWinRateConfigSchema, type QuoteWinRateConfig } from '../reportConfigSchemas';
import type { ReportResult } from '../reportGenerationService';
import { reportTypeDef } from '../reportRegistry';
import { reportOwnerOfScope, runInReportScope, type ReportScope } from '../reportScope';
import type { ReportGenerationAuthority } from '../siteScope';
import { NO_ORGS_NOTE, PARTNER_ORG_LIST_NOTE, ratio, rowsOf, SITE_RESTRICTED_NOTE } from './common';
import { resolveReportOwnerTimezone, resolveReportPeriod, type ResolvedReportPeriod } from './period';
import {
  lineageByCurrencyQuery,
  lineageCountQuery,
  lineageCte,
  lineageDetailQuery,
  lineageDiagnosticsQuery,
  lineageGroupedMoneyQuery,
  lineageGroupedQuery,
  lineageOverallQuery,
} from './quoteWinRateQueries';

/**
 * Quote win rate (`quote_win_rate`, #9828 W2, spec §3.3).
 *
 * The unit is a LINEAGE (one opportunity = a root quote plus its revisions),
 * not a quote row; see `quoteWinRateQueries.ts` for the walk, the cohort rule
 * (first `sent_at` in the period), the terminal-version outcome rule and the
 * read-time expiry rule.
 *
 * Headline (OD5-A): `winRate = won / (won + lost + expired)` — decided lineages
 * only, with the still-open count printed beside it. With nothing decided it is
 * `null`, never 0. Anomalies (a terminal `superseded` version) are counted and
 * listed but excluded from every rate and money total. Money is per currency,
 * never summed across currencies, pre-tax, and summed exactly in SQL then
 * rounded ONCE here. There is no conversion tracking (OD8-A).
 *
 * Tenancy: every statement embeds the lineage CTE, whose anchor binds the org
 * allowlist (and `partner_id` at partner scope) and whose recursive step
 * repeats the org predicate. RLS is the backstop, not the fence.
 */

const DETAIL_ROW_CAP = reportTypeDef('quote_win_rate').detailRowCap;

export type { QuoteWinRateConfig };

export const DECIDED_DENOMINATOR_NOTE =
  'Win rate counts decided opportunities only: won divided by won, lost and expired. '
  + 'Opportunities still open are shown beside it and are not in the denominator.';
export const MATURITY_NOTE =
  'Some opportunities in this period are still open, so the win rate can still move as they are decided. '
  + 'Recent periods look worse than they will end up.';
export const PRE_TAX_VALUES_NOTE =
  'Quoted and won values are pre-tax, taken from the latest sent version of each opportunity. '
  + 'One-time and monthly recurring values are reported separately; annual recurring is converted to a monthly figure.';
export const PER_CURRENCY_NOTE =
  'Values are reported per quote currency; no FX conversion is applied.';
export const EXPIRY_NOTE =
  'A quote still marked sent or viewed past its expiry date counts as expired, evaluated at run time on the UTC calendar day.';
export const NO_CONVERSION_TRACKING_NOTE =
  'Accepted quotes create draft contracts, and this report does not follow them further. '
  + 'See the MRR & renewals report (pending activation) for contracts waiting to go live.';

export const anomalyNote = (count: number) =>
  `${count} ${count === 1 ? 'opportunity ends' : 'opportunities end'} on a superseded quote, which should not happen. `
  + 'They are listed in the detail but excluded from every rate and value.';
export const unreachableNote = (count: number) =>
  `${count} ${count === 1 ? 'quote sent in this period could' : 'quotes sent in this period could'} not be reached from an original quote `
  + '(a broken or circular revision chain). They are not counted in any rate.';
export const depthCappedNote = (count: number) =>
  `${count} ${count === 1 ? 'opportunity has' : 'opportunities have'} a revision chain longer than the 50 versions followed. `
  + 'Versions beyond that are not counted.';

type CountsRow = {
  lineages: number | string; won: number | string; lost: number | string; expired: number | string;
  open: number | string; anomalies: number | string; viewed: number | string;
  median_days_to_win: number | string | null; median_days_to_loss: number | string | null;
};
type GroupRow = CountsRow & { group_key: string; group_label: string };
type MoneyRow = {
  group_key?: string | null; currency_code: string;
  quoted_one_time: string; won_one_time: string; decided_one_time: string;
  quoted_mrv: string; won_mrv: string; decided_mrv: string;
};
type DetailRow = {
  root_quote_id: string; terminal_quote_id: string; quote_number: string | null;
  org_id: string; org_name: string | null; author_name: string; versions: number | string;
  first_sent_at: string; outcome: QuoteOutcome; outcome_at: string | null;
  currency_code: string; one_time_total: string; monthly_recurring_value: string; decline_reason: string | null;
};

const n = (v: unknown): number => Number(v ?? 0);
const oneDp = (v: number | string | null | undefined): number | null =>
  v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10;

function countsOf(r: Partial<CountsRow>): QuoteWinRateCounts {
  return {
    lineages: n(r.lineages), won: n(r.won), lost: n(r.lost), expired: n(r.expired),
    open: n(r.open), anomalies: n(r.anomalies), viewed: n(r.viewed),
  };
}

function ratesOf(c: QuoteWinRateCounts, r: Partial<CountsRow>): QuoteWinRateRates {
  return {
    winRate: ratio(c.won, c.won + c.lost + c.expired),
    closeRate: ratio(c.won, c.lineages),
    viewedRate: ratio(c.viewed, c.lineages),
    medianDaysToWin: oneDp(r.median_days_to_win),
    medianDaysToLoss: oneDp(r.median_days_to_loss),
  };
}

/** The ONE rounding site for money: exact sums in, minor-unit strings out. */
function moneyRowOf(r: MoneyRow): QuoteWinRateMoneyRow {
  const currencyCode = String(r.currency_code);
  return {
    currencyCode,
    quotedOneTime: roundToCurrency(String(r.quoted_one_time), currencyCode),
    wonOneTime: roundToCurrency(String(r.won_one_time), currencyCode),
    quotedMonthlyRecurring: roundToCurrency(String(r.quoted_mrv), currencyCode),
    wonMonthlyRecurring: roundToCurrency(String(r.won_mrv), currencyCode),
    valueWinRate: ratio(
      Number(r.won_one_time) + Number(r.won_mrv),
      Number(r.decided_one_time) + Number(r.decided_mrv),
    ),
  };
}

function toDetailRow(r: DetailRow): QuoteWinRateDetailRow {
  const currencyCode = String(r.currency_code);
  return {
    rootQuoteId: r.root_quote_id,
    terminalQuoteId: r.terminal_quote_id,
    quoteNumber: r.quote_number,
    orgId: r.org_id,
    orgName: r.org_name,
    authorName: r.author_name,
    versions: n(r.versions),
    firstSentAt: r.first_sent_at,
    outcome: r.outcome,
    outcomeAt: r.outcome_at,
    currencyCode,
    oneTimeTotal: roundToCurrency(String(r.one_time_total), currencyCode),
    monthlyRecurringValue: roundToCurrency(String(r.monthly_recurring_value), currencyCode),
    declineReason: r.decline_reason,
  };
}

function toResult(summary: QuoteWinRateSummary): ReportResult {
  return {
    rows: summary.rows as unknown as Record<string, unknown>[],
    rowCount: summary.rows.length,
    generatedAt: summary.generatedAt,
    summary: summary as unknown as Record<string, unknown>,
  };
}

function scopeMeta(scope: ReportScope, orgName: string | null): QuoteWinRateSummary['scope'] {
  return scope.kind === 'partner'
    ? { kind: 'partner', partnerId: scope.partnerId, orgCount: scope.orgIds.length }
    : { kind: 'organization', orgId: scope.orgId, orgName };
}

function periodMeta(period: ResolvedReportPeriod): QuoteWinRateSummary['period'] {
  return {
    kind: period.kind,
    start: period.start.toISOString(),
    end: period.end.toISOString(),
    label: period.label,
    timeZone: period.timeZone,
  };
}

const EMPTY_DETAIL = { cap: DETAIL_ROW_CAP, stored: 0, available: 0, truncated: false };

export async function generateQuoteWinRateReport(
  scope: ReportScope,
  rawConfig: Record<string, unknown>,
  authority: ReportGenerationAuthority,
): Promise<ReportResult> {
  // Parse BEFORE any query: a stored config the type rejects never runs.
  const config = quoteWinRateConfigSchema.parse(rawConfig ?? {});
  // Scope-dependent default (Gate B 10): the config stores nothing for "scope default".
  const groupBy: QuoteWinRateGroupBy = config.groupBy ?? (scope.kind === 'partner' ? 'organization' : 'author');
  const generatedAt = new Date();

  // Quotes are not filtered by site here; a restricted authority queries
  // nothing rather than reporting a figure it cannot scope.
  if (authority.scope.kind === 'restricted') {
    return toResult({
      ...emptyQuoteWinRateSummary(SITE_RESTRICTED_NOTE),
      generatedAt: generatedAt.toISOString(),
      scope: scopeMeta(scope, null),
      groupBy,
      detail: { ...EMPTY_DETAIL },
    });
  }

  return runInReportScope(scope, async () => {
    const timeZone = await resolveReportOwnerTimezone(reportOwnerOfScope(scope));
    const period = resolveReportPeriod(config.period, timeZone, generatedAt);

    const notes = [DECIDED_DENOMINATOR_NOTE, PRE_TAX_VALUES_NOTE, PER_CURRENCY_NOTE, EXPIRY_NOTE, NO_CONVERSION_TRACKING_NOTE];
    if (period.timeZoneNote) notes.push(period.timeZoneNote);
    if (scope.kind === 'partner') notes.push(PARTNER_ORG_LIST_NOTE);

    if (scope.kind === 'partner' && scope.orgIds.length === 0) {
      return toResult({
        ...emptyQuoteWinRateSummary(NO_ORGS_NOTE),
        generatedAt: generatedAt.toISOString(),
        period: periodMeta(period),
        scope: scopeMeta(scope, null),
        groupBy,
        detail: { ...EMPTY_DETAIL },
        notes: [NO_ORGS_NOTE, ...notes],
      });
    }

    const orgIds = scope.kind === 'partner' ? scope.orgIds : [scope.orgId];
    const partnerId = scope.kind === 'partner' ? scope.partnerId : null;
    const scopeArgs = { partnerId, orgIds, periodStart: period.start, periodEnd: period.end };
    // The UTC calendar day: the same bound the reaper and `isQuoteExpired` use.
    const cte = lineageCte({ ...scopeArgs, asOfUtcDate: generatedAt.toISOString().slice(0, 10) });

    let orgName: string | null = null;
    if (scope.kind === 'organization') {
      const [row] = rowsOf<{ name: string }>(await db.execute(
        sql`/* qwr:org_name */ SELECT name FROM organizations WHERE id = ${scope.orgId}`,
      ));
      orgName = row?.name ?? null;
    }

    const [diag] = rowsOf<{ unreachable: number | string; depth_capped: number | string }>(
      await db.execute(lineageDiagnosticsQuery(scopeArgs)),
    );
    const [overallRow] = rowsOf<CountsRow>(await db.execute(lineageOverallQuery(cte)));
    const groupRows = rowsOf<GroupRow>(await db.execute(lineageGroupedQuery(cte, groupBy)));
    const groupMoneyRows = rowsOf<MoneyRow>(await db.execute(lineageGroupedMoneyQuery(cte, groupBy)));
    const currencyRows = rowsOf<MoneyRow>(await db.execute(lineageByCurrencyQuery(cte)));
    const detailRows = rowsOf<DetailRow>(await db.execute(lineageDetailQuery(cte, DETAIL_ROW_CAP + 1)));

    const moneyByGroup = new Map<string, QuoteWinRateMoneyRow[]>();
    for (const r of groupMoneyRows) {
      const key = String(r.group_key);
      moneyByGroup.set(key, [...(moneyByGroup.get(key) ?? []), moneyRowOf(r)]);
    }
    const groups: QuoteWinRateGroupRow[] = groupRows.map((r) => {
      const counts = countsOf(r);
      return {
        groupKey: String(r.group_key),
        groupLabel: String(r.group_label),
        ...counts,
        ...ratesOf(counts, r),
        money: moneyByGroup.get(String(r.group_key)) ?? [],
      };
    });
    const overallCounts = countsOf(overallRow ?? {});
    const overall = {
      ...overallCounts,
      ...ratesOf(overallCounts, overallRow ?? {}),
      money: currencyRows.map(moneyRowOf),
    };
    const diagnostics = { unreachable: n(diag?.unreachable), depthCapped: n(diag?.depth_capped) };

    if (overall.open > 0) notes.push(MATURITY_NOTE);
    if (overall.anomalies > 0) notes.push(anomalyNote(overall.anomalies));
    if (diagnostics.unreachable > 0) notes.push(unreachableNote(diagnostics.unreachable));
    if (diagnostics.depthCapped > 0) notes.push(depthCappedNote(diagnostics.depthCapped));

    const truncated = detailRows.length > DETAIL_ROW_CAP;
    const rows = detailRows.slice(0, DETAIL_ROW_CAP).map(toDetailRow);
    let available = rows.length;
    if (truncated) {
      const [countRow] = rowsOf<{ n: number }>(await db.execute(lineageCountQuery(cte)));
      available = n(countRow?.n);
    }

    return toResult({
      generatedAt: generatedAt.toISOString(),
      period: periodMeta(period),
      scope: scopeMeta(scope, orgName),
      groupBy,
      overall,
      groups,
      diagnostics,
      detail: { cap: DETAIL_ROW_CAP, stored: rows.length, available, truncated },
      notes,
      rows,
    });
  });
}
