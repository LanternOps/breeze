import { sql, type SQL } from 'drizzle-orm';
import {
  emptyAiUsageByClientSummary,
  roundToCurrency,
  type AiUsageByClientChargeRow,
  type AiUsageByClientDetailRow,
  type AiUsageByClientGroupRow,
  type AiUsageByClientSummary,
  type AiUsageByClientTotals,
} from '@breeze/shared';
import { db } from '../../db';
import { sqlTimestamp, sqlUuidArray } from '../../db/sqlValues';
import { aiUsageByClientConfigSchema, type AiUsageByClientConfig } from '../reportConfigSchemas';
import type { ReportResult } from '../reportGenerationService';
import { reportTypeDef } from '../reportRegistry';
import { reportOwnerOfScope, runInReportScope, type ReportScope } from '../reportScope';
import type { ReportGenerationAuthority } from '../siteScope';
import { NO_ORGS_NOTE, PARTNER_ORG_LIST_NOTE, rowsOf, SITE_RESTRICTED_NOTE } from './common';
import { resolveReportOwnerTimezone, resolveReportPeriod, type ResolvedReportPeriod } from './period';

/**
 * AI usage by client (`ai_usage_by_client`, #7608 W10).
 *
 * Source: `ai_invocations` rows with `ledger_mode = 'authoritative'` (shadow
 * rows are the model-registry rollout's comparison data and never count) in
 * `[period.start, period.end)`, the period resolved in the report owner's
 * timezone like every business report.
 *
 * Money:
 *  - `charge_amount` (numeric(20,6), card-currency major units, stamped at
 *    ledger write by W03) is summed EXACTLY in SQL and returned `::text`; this
 *    file rounds each reported figure ONCE with `roundToCurrency`, the same
 *    function that rounds the monthly `ai_usage_charges.amount`. Per currency,
 *    never summed across currencies.
 *  - Breeze cost is `SUM(cost_cents) / 100` as numeric(14,2), USD, and is never
 *    combined with a chargeable amount.
 *  - Chargeable = `chargeable AND charge_coverage = 'billable' AND charge_amount
 *    IS NOT NULL`. 'included' usage is reported as included cost; a billable
 *    request with no rate on the card (charge_basis 'unpriced') is COUNTED, never
 *    treated as free.
 *  - Billed vs unbilled: the claim (`ai_usage_charge_claims.invocation_id ->
 *    charge_id`) joins to `ai_usage_charges.billing_status`. Billed =
 *    'billed'; everything else, including usage not yet aggregated into a
 *    charge, is unbilled.
 *
 * Tenancy: every statement runs inside ONE `runInReportScope` and carries the
 * predicate built by `invocationScopePredicate` (explicit org allowlist /
 * single org) — RLS is the backstop, never the only fence.
 */

const DETAIL_ROW_CAP = reportTypeDef('ai_usage_by_client').detailRowCap;

export type { AiUsageByClientConfig };
type GroupBy = AiUsageByClientSummary['groupBy'];

const BASIS_NOTE =
  'Usage is the authoritative AI ledger only; shadow-mode rows from the model registry rollout are excluded.';
const COST_NOTE =
  'Breeze cost is what the platform paid for the usage, in USD. It is not the amount charged to the client.';
const PER_CURRENCY_NOTE =
  'Chargeable amounts are reported per billing-profile currency; no FX conversion is applied, and Breeze cost (USD) is never combined with them.';
const ROUNDING_NOTE =
  'Each chargeable amount is summed exactly and rounded once to its currency\'s minor unit, so a row can differ from the sum of its parts by one minor unit.';
const BILLED_NOTE =
  'Billed means the usage sits in a monthly charge on an issued invoice. Unbilled covers charges not yet invoiced and usage not yet aggregated into a charge.';

const utcMonthNote = (timeZone: string) =>
  `Charges bill by UTC calendar month of the ledger write; this report's period is in ${timeZone} so month-edge rows can differ from the invoice.`;

const unpricedNote = (n: number) =>
  `${n} ${n === 1 ? 'request' : 'requests'} on a billable billing profile had no rate for the model; `
  + 'they are counted as unpriced and carry no chargeable amount. They are never treated as free.';

/**
 * The ONE place the tenancy predicate is built. `ai_invocations` is org-axis
 * (org_id NOT NULL, no partner column): partner scope binds the live org
 * allowlist, org scope the single org.
 */
function invocationScopePredicate(scope: ReportScope): SQL {
  return scope.kind === 'partner'
    ? sql`i.org_id = ANY(${sqlUuidArray(scope.orgIds)})`
    : sql`i.org_id = ${scope.orgId}`;
}

/**
 * The shared CTE, repeated per statement (PG has no cross-statement CTEs).
 * The claim -> charge join lives here and only here. A claim has a primary key
 * on invocation_id, so the LEFT JOINs never fan a row out; the `ch.org_id =
 * i.org_id` guard keeps a charge from ever attaching across tenants.
 */
function baseCte(scope: ReportScope, period: ResolvedReportPeriod): SQL {
  return sql`
    WITH base AS (
      SELECT i.org_id, i.served_model, i.input_tokens, i.output_tokens,
        i.cache_read_tokens, i.cache_write_tokens, i.cost_cents,
        i.chargeable, i.charge_coverage, i.charge_basis, i.charge_currency, i.charge_amount,
        ch.billing_status
      FROM ai_invocations i
      LEFT JOIN ai_usage_charge_claims cl ON cl.invocation_id = i.id
      LEFT JOIN ai_usage_charges ch ON ch.id = cl.charge_id AND ch.org_id = i.org_id
      WHERE ${invocationScopePredicate(scope)}
        AND i.ledger_mode = 'authoritative'
        AND i.created_at >= ${sqlTimestamp(period.start)} AND i.created_at < ${sqlTimestamp(period.end)}
    )`;
}

/** Sums of `bigint` come back as `numeric`; `::text` keeps the driver from handing back a float. */
const TOTALS_SELECT = sql.join(
  [
    sql`COUNT(*)::int AS requests`,
    sql`COALESCE(SUM(b.input_tokens), 0)::text AS input_tokens`,
    sql`COALESCE(SUM(b.output_tokens), 0)::text AS output_tokens`,
    sql`COALESCE(SUM(b.cache_read_tokens), 0)::text AS cache_read_tokens`,
    sql`COALESCE(SUM(b.cache_write_tokens), 0)::text AS cache_write_tokens`,
    sql`(COALESCE(SUM(b.cost_cents), 0) / 100)::numeric(14,2)::text AS cost_usd`,
    sql`(COALESCE(SUM(b.cost_cents) FILTER (WHERE b.charge_coverage = 'included'), 0) / 100)::numeric(14,2)::text AS included_cost_usd`,
    sql`COUNT(*) FILTER (WHERE b.chargeable AND b.charge_basis = 'unpriced')::int AS unpriced_requests`,
  ],
  sql`, `,
);

/** A row that carries a chargeable, priced amount in a known currency. */
const BILLABLE = sql`b.chargeable AND b.charge_coverage = 'billable' AND b.charge_amount IS NOT NULL AND b.charge_currency IS NOT NULL`;

/** Exact sums as text. COALESCE'd: only ever selected over rows that match BILLABLE. */
const MONEY_SELECT = sql.join(
  [
    sql`COALESCE(SUM(b.charge_amount), 0)::text AS amount`,
    sql`COALESCE(SUM(b.charge_amount) FILTER (WHERE b.billing_status = 'billed'), 0)::text AS billed`,
    sql`COALESCE(SUM(b.charge_amount) FILTER (WHERE b.billing_status IS DISTINCT FROM 'billed'), 0)::text AS unbilled`,
  ],
  sql`, `,
);

const GROUP_AXES: Record<GroupBy, { key: SQL; label: SQL }> = {
  organization: { key: sql`b.org_id::text`, label: sql`COALESCE(org.name, 'Unknown organization')` },
  model: { key: sql`b.served_model`, label: sql`b.served_model` },
};

const overallQuery = (cte: SQL): SQL => sql`/* ai:overall */ ${cte}
    SELECT ${TOTALS_SELECT}
    FROM base b`;

function groupedQuery(cte: SQL, groupBy: GroupBy): SQL {
  const axis = GROUP_AXES[groupBy];
  return sql`/* ai:grouped */ ${cte}
    SELECT ${axis.key} AS group_key, ${axis.label} AS group_label, ${TOTALS_SELECT}
    FROM base b
    LEFT JOIN organizations org ON org.id = b.org_id
    GROUP BY 1, 2
    ORDER BY SUM(b.cost_cents) DESC NULLS LAST, 2, 1`;
}

function groupedMoneyQuery(cte: SQL, groupBy: GroupBy): SQL {
  return sql`/* ai:grouped_money */ ${cte}
    SELECT ${GROUP_AXES[groupBy].key} AS group_key, b.charge_currency::text AS currency_code, ${MONEY_SELECT}
    FROM base b
    WHERE ${BILLABLE}
    GROUP BY 1, 2
    ORDER BY 1, 2`;
}

const byCurrencyQuery = (cte: SQL): SQL => sql`/* ai:by_currency */ ${cte}
    SELECT b.charge_currency::text AS currency_code, ${MONEY_SELECT}
    FROM base b
    WHERE ${BILLABLE}
    GROUP BY b.charge_currency
    ORDER BY b.charge_currency`;

/**
 * Detail grain: organization x served model x charge currency. A NULL
 * currency row is usage that carries no charge (included, non-billable, not
 * eligible, unpriced-before-stamp). Money columns are NULL when the group has
 * no billable amount, so a missing figure is never printed as 0.00.
 */
function detailQuery(cte: SQL): SQL {
  return sql`/* ai:detail */ ${cte}
    SELECT b.org_id::text AS org_id, org.name AS org_name, b.served_model AS model,
      b.charge_currency::text AS currency_code, ${TOTALS_SELECT},
      (SUM(b.charge_amount) FILTER (WHERE ${BILLABLE}))::text AS amount,
      (SUM(b.charge_amount) FILTER (WHERE ${BILLABLE} AND b.billing_status = 'billed'))::text AS billed,
      (SUM(b.charge_amount) FILTER (WHERE ${BILLABLE} AND b.billing_status IS DISTINCT FROM 'billed'))::text AS unbilled
    FROM base b
    LEFT JOIN organizations org ON org.id = b.org_id
    GROUP BY b.org_id, org.name, b.served_model, b.charge_currency
    ORDER BY SUM(b.cost_cents) DESC NULLS LAST, org.name NULLS LAST, b.served_model, b.charge_currency NULLS LAST
    LIMIT ${DETAIL_ROW_CAP + 1}`;
}

/** Only run when the detail set was truncated: the true number of detail rows. */
const detailCountQuery = (cte: SQL): SQL => sql`/* ai:detail_count */ ${cte}
    SELECT COUNT(*)::int AS n
    FROM (SELECT 1 FROM base b GROUP BY b.org_id, b.served_model, b.charge_currency) g`;

type TotalsRow = {
  requests: number | string; input_tokens: string; output_tokens: string; cache_read_tokens: string;
  cache_write_tokens: string; cost_usd: string; included_cost_usd: string; unpriced_requests: number | string;
};
type GroupRow = TotalsRow & { group_key: string; group_label: string };
type MoneyRow = { group_key?: string | null; currency_code: string; amount: string; billed: string; unbilled: string };
type DetailRow = TotalsRow & {
  org_id: string; org_name: string | null; model: string; currency_code: string | null;
  amount: string | null; billed: string | null; unbilled: string | null;
};

const n = (v: unknown): number => Number(v ?? 0);

function totalsOf(r: Partial<TotalsRow>): AiUsageByClientTotals {
  return {
    requests: n(r.requests),
    inputTokens: n(r.input_tokens),
    outputTokens: n(r.output_tokens),
    cacheReadTokens: n(r.cache_read_tokens),
    cacheWriteTokens: n(r.cache_write_tokens),
    costUsd: String(r.cost_usd ?? '0.00'),
    includedCostUsd: String(r.included_cost_usd ?? '0.00'),
    unpricedRequests: n(r.unpriced_requests),
  };
}

/** The ONE rounding site for chargeable money: exact sum in, minor-unit string out. */
function chargeRow(r: MoneyRow): AiUsageByClientChargeRow {
  const currencyCode = String(r.currency_code);
  return {
    currencyCode,
    amount: roundToCurrency(String(r.amount), currencyCode),
    billed: roundToCurrency(String(r.billed), currencyCode),
    unbilled: roundToCurrency(String(r.unbilled), currencyCode),
  };
}

function toDetailRow(r: DetailRow): AiUsageByClientDetailRow {
  const currency = r.currency_code;
  const priced = currency !== null && r.amount !== null;
  return {
    orgId: r.org_id,
    orgName: r.org_name,
    model: r.model,
    currencyCode: currency,
    ...totalsOf(r),
    amount: priced ? roundToCurrency(String(r.amount), currency) : null,
    billed: priced ? roundToCurrency(String(r.billed ?? '0'), currency) : null,
    unbilled: priced ? roundToCurrency(String(r.unbilled ?? '0'), currency) : null,
  };
}

function toResult(summary: AiUsageByClientSummary): ReportResult {
  return {
    rows: summary.rows as unknown as Record<string, unknown>[],
    rowCount: summary.rows.length,
    generatedAt: summary.generatedAt,
    summary: summary as unknown as Record<string, unknown>,
  };
}

function scopeMeta(scope: ReportScope, orgName: string | null): AiUsageByClientSummary['scope'] {
  return scope.kind === 'partner'
    ? { kind: 'partner', partnerId: scope.partnerId, orgCount: scope.orgIds.length }
    : { kind: 'organization', orgId: scope.orgId, orgName };
}

function periodMeta(period: ResolvedReportPeriod): AiUsageByClientSummary['period'] {
  return {
    kind: period.kind,
    start: period.start.toISOString(),
    end: period.end.toISOString(),
    label: period.label,
    timeZone: period.timeZone,
  };
}

export async function generateAiUsageByClientReport(
  scope: ReportScope,
  rawConfig: Record<string, unknown>,
  authority: ReportGenerationAuthority,
): Promise<ReportResult> {
  // Parse BEFORE any query: a stored config the type rejects never runs.
  const config = aiUsageByClientConfigSchema.parse(rawConfig ?? {});
  const groupBy: GroupBy = config.groupBy ?? (scope.kind === 'partner' ? 'organization' : 'model');
  const generatedAt = new Date();

  // The ledger has no site axis; a restricted authority (any number of sites)
  // queries nothing (ruling T7a — the dispatcher guards this too).
  if (authority.scope.kind === 'restricted') {
    return toResult({
      ...emptyAiUsageByClientSummary(SITE_RESTRICTED_NOTE),
      generatedAt: generatedAt.toISOString(),
      scope: scopeMeta(scope, null),
      groupBy,
      detail: { cap: DETAIL_ROW_CAP, stored: 0, available: 0, truncated: false },
    });
  }

  // ONE scoped block for the whole report (ruling P6).
  return runInReportScope(scope, async () => {
    const timeZone = await resolveReportOwnerTimezone(reportOwnerOfScope(scope));
    const period = resolveReportPeriod(config.period, timeZone, generatedAt);

    const notes = [BASIS_NOTE, COST_NOTE, PER_CURRENCY_NOTE, ROUNDING_NOTE, BILLED_NOTE, utcMonthNote(period.timeZone)];
    if (period.timeZoneNote) notes.push(period.timeZoneNote);
    if (scope.kind === 'partner') notes.push(PARTNER_ORG_LIST_NOTE);

    // Invocations are org-axis: with no active orgs there is nothing to read.
    if (scope.kind === 'partner' && scope.orgIds.length === 0) {
      return toResult({
        ...emptyAiUsageByClientSummary(NO_ORGS_NOTE),
        generatedAt: generatedAt.toISOString(),
        period: periodMeta(period),
        scope: scopeMeta(scope, null),
        groupBy,
        detail: { cap: DETAIL_ROW_CAP, stored: 0, available: 0, truncated: false },
        notes: [NO_ORGS_NOTE, ...notes],
      });
    }

    const cte = baseCte(scope, period);

    let orgName: string | null = null;
    if (scope.kind === 'organization') {
      const [row] = rowsOf<{ name: string }>(await db.execute(
        sql`/* ai:org_name */ SELECT name FROM organizations WHERE id = ${scope.orgId}`,
      ));
      orgName = row?.name ?? null;
    }

    const [overallRow] = rowsOf<TotalsRow>(await db.execute(overallQuery(cte)));
    const groupRows = rowsOf<GroupRow>(await db.execute(groupedQuery(cte, groupBy)));
    const groupMoneyRows = rowsOf<MoneyRow>(await db.execute(groupedMoneyQuery(cte, groupBy)));
    const currencyRows = rowsOf<MoneyRow>(await db.execute(byCurrencyQuery(cte)));
    const detailRows = rowsOf<DetailRow>(await db.execute(detailQuery(cte)));

    const moneyByGroup = new Map<string, AiUsageByClientChargeRow[]>();
    for (const r of groupMoneyRows) {
      const key = String(r.group_key);
      moneyByGroup.set(key, [...(moneyByGroup.get(key) ?? []), chargeRow(r)]);
    }
    const groups: AiUsageByClientGroupRow[] = groupRows.map((r) => ({
      groupKey: String(r.group_key),
      groupLabel: String(r.group_label),
      ...totalsOf(r),
      charges: moneyByGroup.get(String(r.group_key)) ?? [],
    }));
    const overall = { ...totalsOf(overallRow ?? {}), charges: currencyRows.map(chargeRow) };
    if (overall.unpricedRequests > 0) notes.push(unpricedNote(overall.unpricedRequests));

    const truncated = detailRows.length > DETAIL_ROW_CAP;
    const rows = detailRows.slice(0, DETAIL_ROW_CAP).map(toDetailRow);
    let available = rows.length;
    if (truncated) {
      const [countRow] = rowsOf<{ n: number }>(await db.execute(detailCountQuery(cte)));
      available = n(countRow?.n);
    }

    return toResult({
      generatedAt: generatedAt.toISOString(),
      period: periodMeta(period),
      scope: scopeMeta(scope, orgName),
      groupBy,
      overall,
      groups,
      detail: { cap: DETAIL_ROW_CAP, stored: rows.length, available, truncated },
      notes,
      rows,
    });
  });
}
