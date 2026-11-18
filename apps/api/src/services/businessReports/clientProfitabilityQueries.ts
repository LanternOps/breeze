import { sql, type SQL } from 'drizzle-orm';
import { CLIENT_PROFITABILITY_REVENUE_CATEGORIES, type ClientProfitabilityRevenueCategory } from '@breeze/shared';
import { sqlTimestamp, sqlUuidArray } from '../../db/sqlValues';
import { minorUnitScaleSql } from '../currencySql';
import type { ReportScope } from '../reportScope';
import { blockOverageLineIdsCte } from './blockOverageSql';
import { effectiveCoverageSql } from './common';
import type { ResolvedReportPeriod } from './period';

/**
 * Client profitability (`client_profitability`, #9828 W3; spec §3.1) — the
 * data access layer: the invoice-line fold, the org-scope invoice detail, and
 * hours. Pure statement builders; the generator (clientProfitabilityReport.ts)
 * runs them inside its one `runInReportScope` block.
 *
 * The fold contract (spec §3.1, traps T1/T2/T7/T10) — the same rules as the
 * invoice margin panel (`computeInvoiceProfit`), proven equal by
 * clientProfitability.parity.test.ts and the integration test:
 *  - issued invoices only (`sent`, `partially_paid`, `overdue`, `paid`; never
 *    `draft` or `void` — a replaced invoice is voided, so its reissue counts
 *    once), `issue_date` in the period's LOCAL dates (a `date` column);
 *  - top-level customer-visible lines only: a bundle parent carries the whole
 *    bundle cost, so folding its children too would count it twice (T1);
 *  - known cost ⇔ `cost_basis IS NOT NULL` and no child line of it has a NULL
 *    cost. A NULL cost is unknown, never zero (T2). A bundle whose parent has
 *    a cost but a component does not is unknown too, and tallied (T10) — the
 *    one place R4 deliberately differs from the panel;
 *  - cost = Σ ROUND(quantity × cost_basis) per line at the invoice currency's
 *    minor unit, so a JPY line rounds to whole yen before summing;
 *  - money comes back as exact `numeric::text`; the generator rounds.
 *
 * Tenancy: every statement carries the explicit predicate built by
 * `invoiceScopePredicate` / `entryScopePredicate` — the org allowlist and the
 * partner axis. RLS is the backstop, not the fence. The invoice set handed to
 * `blockOverageLineIdsCte` is the same predicated sub-SELECT.
 */

export type RevenueCategory = ClientProfitabilityRevenueCategory;

/** Per (org, currency, category). Money is exact numeric ::text; rounding happens in TS. */
export type LineFoldRow = {
  org_id: string; currency_code: string; category: RevenueCategory;
  revenue: string; cost_bearing_revenue: string; cost: string; unknown_cost_revenue: string;
  lines_missing_cost: number; partial_cost_bundles: number; invoice_count: number;
};

/** Per invoice (org scope detail). Same money columns as the fold, plus the mix. */
export type InvoiceDetailRow = {
  invoice_id: string; invoice_number: string | null; issue_date: string; currency_code: string;
  revenue: string; cost_bearing_revenue: string; cost: string; unknown_cost_revenue: string;
  lines_missing_cost: number; partial_cost_bundles: number;
  recurring_revenue: string; labor_revenue: string; product_revenue: string; ai_revenue: string; other_revenue: string;
  /** Number of invoice rows before the LIMIT. */
  available: number;
};

/** Completed minutes by effective coverage, per (org, currency). `org_id` NULL = internal time (partner scope only). */
export type HoursRow = {
  org_id: string | null; currency_code: string | null;
  billable_minutes: number; included_minutes: number; non_billable_minutes: number;
};

type PeriodDates = { periodStartDate: string; periodEndDate: string };

/** Issued invoice statuses: what was billed. Never `draft`, never `void`. */
const ISSUED = sql`i.status IN ('sent', 'partially_paid', 'overdue', 'paid')`;

/**
 * The ONE place the invoice tenancy predicate is built.
 * - Partner: the live org allowlist AND the partner axis (`invoices.partner_id`).
 * - Org: the org AND the org's own partner, resolved in the same statement
 *   (defense in depth; never a bound partner id the caller could skew).
 */
function invoiceScopePredicate(scope: ReportScope): SQL {
  return scope.kind === 'partner'
    ? sql`i.org_id = ANY(${sqlUuidArray(scope.orgIds)}) AND i.partner_id = ${scope.partnerId}`
    : sql`i.org_id = ${scope.orgId} AND i.partner_id = (SELECT o.partner_id FROM organizations o WHERE o.id = ${scope.orgId})`;
}

/** Child lines of `il` whose cost is unknown (the T10 test). */
const CHILD_MISSING_COST = sql`(SELECT 1 FROM invoice_lines c WHERE c.parent_line_id = il.id AND c.invoice_id = il.invoice_id AND c.org_id = il.org_id AND c.cost_basis IS NULL)`;

/**
 * Revenue category, first match wins. A contract line that is hour-block
 * overage (W1's consume-once rule) is usage, so labor — before the generic
 * contract → recurring arm. A quote-accepted one-time line is `manual` with
 * the catalog item carried over, so it is product, not other.
 */
const CATEGORY = sql`CASE
      WHEN il.source_type = 'contract' AND il.id IN (SELECT line_id FROM block_overage_lines) THEN 'labor'
      WHEN il.source_type = 'contract' THEN 'recurring'
      WHEN il.source_type = 'time_entry' THEN 'labor'
      WHEN il.source_type IN ('part', 'catalog', 'bundle') OR (il.source_type = 'manual' AND il.catalog_item_id IS NOT NULL) THEN 'product'
      WHEN il.source_type = 'ai_usage' THEN 'ai'
      ELSE 'other' END`;

/** `WITH RECURSIVE <block overage CTEs>, lines AS (…)` — the scoped, classified line set. */
function linesCte(scope: ReportScope, period: PeriodDates): SQL {
  const invoicePredicate = sql`${invoiceScopePredicate(scope)}
        AND ${ISSUED}
        AND i.issue_date >= ${period.periodStartDate}::date AND i.issue_date < ${period.periodEndDate}::date`;
  return sql`WITH RECURSIVE ${blockOverageLineIdsCte({ invoiceIds: sql`SELECT i.id FROM invoices i WHERE ${invoicePredicate}` })},
    lines AS (
      SELECT i.org_id, i.id AS invoice_id, i.invoice_number, i.issue_date, i.currency_code,
        il.line_total, il.quantity, il.cost_basis,
        (il.cost_basis IS NOT NULL AND NOT EXISTS ${CHILD_MISSING_COST}) AS known_cost,
        (il.cost_basis IS NOT NULL AND EXISTS ${CHILD_MISSING_COST}) AS partial_bundle,
        ${CATEGORY} AS category
      FROM invoice_lines il
      JOIN invoices i ON i.id = il.invoice_id AND i.org_id = il.org_id
      WHERE ${invoicePredicate}
        AND il.parent_line_id IS NULL
        AND il.customer_visible
    )`;
}

const KNOWN_REVENUE = sql`COALESCE(SUM(l.line_total) FILTER (WHERE l.known_cost), 0)`;

/** Exact sums; the per-line ROUND is the margin panel's per-line rounding, at the invoice currency's minor unit. */
const MONEY = sql`SUM(l.line_total)::text AS revenue,
      ${KNOWN_REVENUE}::text AS cost_bearing_revenue,
      COALESCE(SUM(ROUND(l.quantity * l.cost_basis, ${minorUnitScaleSql(sql`l.currency_code`)})) FILTER (WHERE l.known_cost), 0)::text AS cost,
      (SUM(l.line_total) - ${KNOWN_REVENUE})::text AS unknown_cost_revenue,
      COUNT(*) FILTER (WHERE NOT l.known_cost)::int AS lines_missing_cost,
      COUNT(*) FILTER (WHERE l.partial_bundle)::int AS partial_cost_bundles`;

export function invoiceLineFoldQuery(args: { scope: ReportScope } & PeriodDates): SQL {
  return sql`/* profitability:fold */ ${linesCte(args.scope, args)}
    SELECT l.org_id::text AS org_id, l.currency_code::text AS currency_code, l.category,
      ${MONEY},
      COUNT(DISTINCT l.invoice_id)::int AS invoice_count
    FROM lines l
    GROUP BY l.org_id, l.currency_code, l.category
    ORDER BY 1, 2, 3`;
}

/** Org scope: one row per issued invoice in the period, capped at `limit` (pass cap + 1). */
export function invoiceDetailQuery(args: { orgId: string; limit: number } & PeriodDates): SQL {
  const mix = sql.join(
    CLIENT_PROFITABILITY_REVENUE_CATEGORIES.map(
      (c) => sql`COALESCE(SUM(l.line_total) FILTER (WHERE l.category = ${sql.raw(`'${c}'`)}), 0)::text AS ${sql.raw(`${c}_revenue`)}`,
    ),
    sql`,
      `,
  );
  return sql`/* profitability:invoice_detail */ ${linesCte({ kind: 'organization', orgId: args.orgId }, args)}
    SELECT l.invoice_id::text AS invoice_id, l.invoice_number, l.issue_date::text AS issue_date, l.currency_code::text AS currency_code,
      ${MONEY},
      ${mix},
      COUNT(*) OVER ()::int AS available
    FROM lines l
    GROUP BY l.invoice_id, l.invoice_number, l.issue_date, l.currency_code
    ORDER BY l.issue_date, l.invoice_number NULLS LAST, l.invoice_id
    LIMIT ${args.limit}`;
}

/**
 * The ONE place the time_entries tenancy predicate is built here (the same
 * shape as technician time's `entryScopePredicate`).
 * - Partner: the partner axis ALWAYS, plus the live org allowlist; org-less
 *   (internal) entries are admitted and come back as the `org_id IS NULL` row.
 * - Org: the org AND the org's own partner; never org-less time.
 */
function entryScopePredicate(scope: ReportScope): SQL {
  return scope.kind === 'partner'
    ? sql`te.partner_id = ${scope.partnerId} AND (te.org_id IS NULL OR te.org_id = ANY(${sqlUuidArray(scope.orgIds)}))`
    : sql`te.org_id = ${scope.orgId} AND te.partner_id = (SELECT o.partner_id FROM organizations o WHERE o.id = ${scope.orgId})`;
}

/**
 * Hours worked: completed entries (a running timer has no duration) with
 * `started_at` in the period's INSTANTS, minutes = `duration_minutes` (R2's
 * totals), split by effective coverage. Grouped by (org, currency) so the
 * generator can test single-currency attribution.
 */
export function hoursQuery(args: { scope: ReportScope; periodStart: Date; periodEnd: Date }): SQL {
  const coverage = effectiveCoverageSql(sql`te`);
  return sql`/* profitability:hours */
    SELECT te.org_id::text AS org_id, te.currency_code::text AS currency_code,
      COALESCE(SUM(te.duration_minutes) FILTER (WHERE ${coverage} = 'billable'), 0)::int AS billable_minutes,
      COALESCE(SUM(te.duration_minutes) FILTER (WHERE ${coverage} = 'included'), 0)::int AS included_minutes,
      COALESCE(SUM(te.duration_minutes) FILTER (WHERE ${coverage} = 'non_billable'), 0)::int AS non_billable_minutes
    FROM time_entries te
    WHERE ${entryScopePredicate(args.scope)}
      AND te.ended_at IS NOT NULL
      AND te.started_at >= ${sqlTimestamp(args.periodStart)} AND te.started_at < ${sqlTimestamp(args.periodEnd)}
    GROUP BY te.org_id, te.currency_code
    ORDER BY 1 NULLS LAST, 2 NULLS LAST`;
}

function localDate(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * The owner-timezone LOCAL dates of `[period.start, period.end)`, for the
 * `issue_date` (a `date`) comparison (T7). Both bounds are local midnights, so
 * the end date stays exclusive: August in New York is `2026-08-01` →
 * `2026-09-01`, never the UTC date of the instant.
 */
export function localPeriodDates(period: ResolvedReportPeriod): { startDate: string; endDate: string } {
  return { startDate: localDate(period.start, period.timeZone), endDate: localDate(period.end, period.timeZone) };
}
