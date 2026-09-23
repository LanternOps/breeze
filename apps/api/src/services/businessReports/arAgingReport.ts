import { sql, type SQL } from 'drizzle-orm';
import {
  canonicalizeTimezone,
  emptyArAgingSummary,
  type ArAgingBucket,
  type ArAgingDetailRow,
  type ArAgingGroupRow,
  type ArAgingSummary,
  type CurrencyAmountRow,
} from '@breeze/shared';
import { db } from '../../db';
import { sqlOpenAr } from '../../db/schema/invoices';
import { sqlTimestamp, sqlUuidArray } from '../../db/sqlValues';
import { arAgingConfigSchema, type ArAgingConfig } from '../reportConfigSchemas';
import type { ReportResult } from '../reportGenerationService';
import { reportTypeDef } from '../reportRegistry';
import { reportOwnerOfScope, runInReportScope, type ReportScope } from '../reportScope';
import type { ReportGenerationAuthority } from '../siteScope';
import { NO_ORGS_NOTE, PARTNER_ORG_LIST_NOTE, rowsOf, SITE_RESTRICTED_NOTE } from './common';
import { resolveReportOwnerTimezone, resolveReportPeriod } from './period';

/**
 * R3 — AR aging (`ar_aging`, #3198 spec §3.3 R3).
 *
 * The bucket set is `sqlOpenAr` (sent / partially_paid / OVERDUE), never
 * `sqlOpenForOverdue`: the overdue sweep flips sent/partially_paid rows INTO
 * 'overdue', so the sweep-candidate predicate would empty every past-due
 * bucket (plan "READ THIS FIRST" §1). Any `balance > 0` invoice outside that
 * set is reported on the `otherOpenBalance` reconciliation line, so
 * buckets + other open balance = total open balance, per currency.
 *
 * Days overdue is `asOf::date - due_date` — date minus date, an integer with
 * no timezone left in it. The owner's timezone only decides WHICH date
 * "today" is when `asOf` is not given.
 *
 * Tenancy (ruling P6): every statement runs inside ONE `runInReportScope` and
 * carries the explicit invoice predicate built by `invoiceScopePredicate` —
 * the only place it is built.
 */

const DETAIL_ROW_CAP = reportTypeDef('ar_aging').detailRowCap;

export type { ArAgingConfig };
type GroupBy = ArAgingSummary['groupBy'];

const BUCKETS: readonly ArAgingBucket[] = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus', 'no_due_date'];

const NO_DUE_DATE_NOTE = 'Invoices with no due date are reported in their own bucket and are never counted as current.';
const PER_CURRENCY_NOTE = 'Totals are reported per currency; no FX conversion is applied.';
const OTHER_OPEN_NOTE =
  'One or more invoices carry an open balance in a status outside the AR-open set (draft, paid or void). '
  + 'They are listed as other open balance so the buckets reconcile to total AR.';
const CURRENT_BALANCE_NOTE =
  'Balances are each invoice\'s current balance; the as-of date moves only the aging reference date and does not '
  + 'reconstruct historical balances or undo payments recorded after it.';

/**
 * The ONE place the tenancy predicate is built. Invoices are org-axis with a
 * NOT NULL partner_id: partner scope binds both the partner and the live org
 * allowlist, org scope the single org.
 */
function invoiceScopePredicate(scope: ReportScope): SQL {
  return scope.kind === 'partner'
    ? sql`i.partner_id = ${scope.partnerId} AND i.org_id = ANY(${sqlUuidArray(scope.orgIds)})`
    : sql`i.org_id = ${scope.orgId}`;
}

const AR_OPEN = sqlOpenAr({ status: sql`s.status` });

/**
 * The shared CTE, repeated in each statement (PG has no cross-statement CTEs).
 * `scoped` = every in-scope invoice with an open balance, any status;
 * `bucketed` = the AR-open subset with its bucket. The NULL-due-date arm is
 * first, so a NULL due date can never fall through to `current`.
 */
function agingCte(scopePredicate: SQL, asOfDate: string): SQL {
  return sql`
    WITH scoped AS (
      SELECT i.id, i.org_id, i.invoice_number, i.currency_code, i.status,
        i.issue_date, i.due_date, i.total, i.amount_paid, i.balance,
        CASE WHEN i.due_date IS NULL THEN NULL
          ELSE (${asOfDate}::date - i.due_date)::int END AS days_overdue
      FROM invoices i
      WHERE ${scopePredicate}
        AND i.balance > 0
    ),
    bucketed AS (
      SELECT s.*,
        CASE
          WHEN s.due_date IS NULL THEN 'no_due_date'
          WHEN s.days_overdue <= 0 THEN 'current'
          WHEN s.days_overdue BETWEEN 1 AND 30 THEN 'd1_30'
          WHEN s.days_overdue BETWEEN 31 AND 60 THEN 'd31_60'
          WHEN s.days_overdue BETWEEN 61 AND 90 THEN 'd61_90'
          ELSE 'd90_plus'
        END AS bucket
      FROM scoped s
      WHERE ${AR_OPEN}
    )`;
}

/** Per-bucket sums. `numeric(14,2)` not `(12,2)`: a partner-wide sum can
 *  exceed one invoice's domain. `::text` so the driver never hands back a
 *  float — money stays a string end to end. */
const BUCKET_SUMS = sql.join(
  [
    ...BUCKETS.map((b) => sql`COALESCE(SUM(b.balance) FILTER (WHERE b.bucket = ${sql.raw(`'${b}'`)}), 0)::numeric(14,2)::text AS ${sql.raw(b)}`),
    sql`COALESCE(SUM(b.balance), 0)::numeric(14,2)::text AS open_total`,
    sql`COUNT(*)::int AS invoice_count`,
  ],
  sql`, `,
);

const GROUP_AXES: Record<GroupBy, { key: SQL; label: SQL }> = {
  organization: { key: sql`b.org_id`, label: sql`COALESCE(org.name, 'Unknown organization')` },
  currency: { key: sql`b.currency_code`, label: sql`b.currency_code::text` },
};

function groupedQuery(cte: SQL, groupBy: GroupBy): SQL {
  const axis = GROUP_AXES[groupBy];
  return sql`/* ar:grouped */ ${cte}
    SELECT ${axis.key}::text AS group_key, ${axis.label} AS group_label,
      b.currency_code::text AS currency_code, ${BUCKET_SUMS}
    FROM bucketed b
    LEFT JOIN organizations org ON org.id = b.org_id
    GROUP BY 1, 2, 3
    ORDER BY 2, 1, 3`;
}

/** The per-currency headline, grouped in SQL rather than re-summed in TS. */
function byCurrencyQuery(cte: SQL): SQL {
  return sql`/* ar:by_currency */ ${cte}
    SELECT b.currency_code::text AS group_key, b.currency_code::text AS group_label,
      b.currency_code::text AS currency_code, ${BUCKET_SUMS}
    FROM bucketed b
    GROUP BY b.currency_code
    ORDER BY b.currency_code`;
}

/** Reconciliation line: open balance in a status outside the AR-open set. */
function otherOpenQuery(cte: SQL): SQL {
  return sql`/* ar:other_open */ ${cte}
    SELECT s.currency_code::text AS currency_code,
      COALESCE(SUM(s.balance), 0)::numeric(14,2)::text AS amount
    FROM scoped s
    WHERE NOT (${AR_OPEN})
    GROUP BY 1
    ORDER BY 1`;
}

/**
 * `invoice_payments` is org-axis RLS with its own org_id, but it is reached
 * ONLY through an invoice id that already passed `invoiceScopePredicate`, so
 * it needs no tenancy predicate of its own. `received_at` is a DATE.
 * Stripe settlements (stripeReconcile.ts) and accounting pulls also insert
 * `invoice_payments` rows, so they count toward the last payment.
 */
function detailQuery(cte: SQL): SQL {
  return sql`/* ar:detail */ ${cte}
    SELECT b.id::text AS id, b.invoice_number, b.org_id::text AS org_id, org.name AS org_name,
      b.currency_code::text AS currency_code, b.status::text AS status,
      b.issue_date::text AS issue_date, b.due_date::text AS due_date,
      b.total::text AS total, b.amount_paid::text AS amount_paid, b.balance::text AS balance,
      b.days_overdue, b.bucket, lp.last_payment_at
    FROM bucketed b
    LEFT JOIN organizations org ON org.id = b.org_id
    LEFT JOIN LATERAL (
      SELECT MAX(p.received_at)::text AS last_payment_at
      FROM invoice_payments p
      WHERE p.invoice_id = b.id
    ) lp ON true
    ORDER BY b.days_overdue DESC NULLS FIRST, b.balance DESC, b.id
    LIMIT ${DETAIL_ROW_CAP + 1}`;
}

/** Informational only (`includePaidInPeriod`): invoices that reached `paid`
 *  in [start, end). `paid_at` is a naive timestamp holding UTC. */
function paidInPeriodQuery(scopePredicate: SQL, start: Date, end: Date): SQL {
  return sql`/* ar:paid_in_period */
    SELECT i.currency_code::text AS currency_code, COUNT(*)::int AS invoice_count,
      COALESCE(SUM(i.total), 0)::numeric(14,2)::text AS amount
    FROM invoices i
    WHERE ${scopePredicate}
      AND i.status = 'paid'
      AND i.paid_at >= ${sqlTimestamp(start)} AND i.paid_at < ${sqlTimestamp(end)}
    GROUP BY 1
    ORDER BY 1`;
}

type MoneyGroupRow = {
  group_key: string; group_label: string; currency_code: string;
  current: string; d1_30: string; d31_60: string; d61_90: string; d90_plus: string; no_due_date: string;
  open_total: string; invoice_count: number;
};
type OtherOpenRow = { currency_code: string; amount: string };
type PaidRow = { currency_code: string; invoice_count: number; amount: string };
type DetailRow = {
  id: string; invoice_number: string | null; org_id: string; org_name: string | null;
  currency_code: string; status: string; issue_date: string | null; due_date: string | null;
  total: string; amount_paid: string; balance: string; days_overdue: number | null;
  bucket: ArAgingBucket; last_payment_at: string | null;
};

function toGroupRow(r: MoneyGroupRow): ArAgingGroupRow {
  const buckets = Object.fromEntries(BUCKETS.map((b) => [b, String(r[b] ?? '0.00')])) as Record<ArAgingBucket, string>;
  return {
    groupKey: String(r.group_key),
    groupLabel: String(r.group_label),
    currencyCode: String(r.currency_code),
    buckets,
    openTotal: String(r.open_total ?? '0.00'),
    invoiceCount: Number(r.invoice_count ?? 0),
  };
}

function toDetailRow(r: DetailRow): ArAgingDetailRow {
  return {
    invoiceId: r.id,
    invoiceNumber: r.invoice_number,
    orgId: r.org_id,
    orgName: r.org_name,
    currencyCode: r.currency_code,
    status: r.status,
    issueDate: r.issue_date,
    dueDate: r.due_date,
    total: String(r.total),
    amountPaid: String(r.amount_paid),
    balance: String(r.balance),
    daysOverdue: r.days_overdue === null ? null : Number(r.days_overdue),
    bucket: r.bucket,
    lastPaymentAt: r.last_payment_at,
  };
}

/** `YYYY-MM-DD` of `now` as a wall-clock date in `timeZone`. */
function dateInZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Sums the TOTALS of invoices that reached `paid` with `paid_at` in the window
 * — not cash received (a partial payment on a still-open invoice is absent),
 * hence "fully paid", never "collected".
 */
function paidInPeriodNote(label: string, rows: PaidRow[]): string {
  const head = `Invoices fully paid month-to-date (${label})`;
  if (rows.length === 0) return `${head}: none (informational; not part of the buckets).`;
  const parts = rows.map((r) => {
    const count = Number(r.invoice_count);
    return `${count} ${count === 1 ? 'invoice' : 'invoices'}, invoice totals ${r.amount} ${r.currency_code}`;
  });
  return `${head}: ${parts.join('; ')} (informational; not part of the buckets).`;
}

function toResult(summary: ArAgingSummary): ReportResult {
  return {
    rows: summary.rows as unknown as Record<string, unknown>[],
    rowCount: summary.rows.length,
    generatedAt: summary.generatedAt,
    summary: summary as unknown as Record<string, unknown>,
  };
}

function scopeMeta(scope: ReportScope, orgName: string | null): ArAgingSummary['scope'] {
  return scope.kind === 'partner'
    ? { kind: 'partner', partnerId: scope.partnerId, orgCount: scope.orgIds.length }
    : { kind: 'organization', orgId: scope.orgId, orgName };
}

export async function generateArAgingReport(
  scope: ReportScope,
  rawConfig: Record<string, unknown>,
  authority: ReportGenerationAuthority,
): Promise<ReportResult> {
  // Parse BEFORE any query: a stored config the type rejects never runs.
  const config = arAgingConfigSchema.parse(rawConfig ?? {});
  const groupBy: GroupBy = config.groupBy ?? 'organization';
  const generatedAt = new Date();

  // Invoices have no site axis; a restricted authority (any number of sites)
  // queries nothing (ruling T7a — the dispatcher guards this too).
  if (authority.scope.kind === 'restricted') {
    return toResult({
      ...emptyArAgingSummary(SITE_RESTRICTED_NOTE),
      generatedAt: generatedAt.toISOString(),
      asOf: config.asOf ?? dateInZone(generatedAt, 'UTC'),
      scope: scopeMeta(scope, null),
      groupBy,
      // The registry cap, as on the P5 branch and a real run.
      detail: { cap: DETAIL_ROW_CAP, stored: 0, available: 0, truncated: false },
    });
  }

  // ONE scoped block for the whole report (ruling P6).
  return runInReportScope(scope, async () => {
    const timeZone = canonicalizeTimezone(await resolveReportOwnerTimezone(reportOwnerOfScope(scope))) ?? 'UTC';
    const asOf = config.asOf ?? dateInZone(generatedAt, timeZone);

    const notes = [`As of ${asOf} in ${timeZone}.`, NO_DUE_DATE_NOTE, PER_CURRENCY_NOTE];
    if (config.asOf !== undefined) notes.push(CURRENT_BALANCE_NOTE);
    if (scope.kind === 'partner') notes.push(PARTNER_ORG_LIST_NOTE);

    // P5: invoices are org-axis — with no active orgs there is nothing to read.
    if (scope.kind === 'partner' && scope.orgIds.length === 0) {
      const empty = emptyArAgingSummary(NO_ORGS_NOTE);
      return toResult({
        ...empty,
        generatedAt: generatedAt.toISOString(),
        asOf,
        timeZone,
        scope: scopeMeta(scope, null),
        groupBy,
        detail: { ...empty.detail, cap: DETAIL_ROW_CAP },
        notes: [NO_ORGS_NOTE, ...notes],
      });
    }

    const predicate = invoiceScopePredicate(scope);
    const cte = agingCte(predicate, asOf);

    let orgName: string | null = null;
    if (scope.kind === 'organization') {
      const [row] = rowsOf<{ name: string }>(await db.execute(
        sql`/* ar:org_name */ SELECT name FROM organizations WHERE id = ${scope.orgId}`,
      ));
      orgName = row?.name ?? null;
    }
    const groupRows = rowsOf<MoneyGroupRow>(await db.execute(groupedQuery(cte, groupBy)));
    const currencyRows = rowsOf<MoneyGroupRow>(await db.execute(byCurrencyQuery(cte)));
    const otherRows = rowsOf<OtherOpenRow>(await db.execute(otherOpenQuery(cte)));
    const detailRows = rowsOf<DetailRow>(await db.execute(detailQuery(cte)));

    const otherOpenBalance: CurrencyAmountRow[] = otherRows.map((r) => ({
      currencyCode: String(r.currency_code),
      amount: String(r.amount),
    }));
    if (otherOpenBalance.length > 0) notes.push(OTHER_OPEN_NOTE);

    if (config.includePaidInPeriod === true) {
      // Month-to-date of the as-of date, in the owner's timezone: [1st, asOf].
      const period = resolveReportPeriod(
        { kind: 'custom', start: `${asOf.slice(0, 8)}01`, end: asOf },
        timeZone,
        generatedAt,
      );
      const paidRows = rowsOf<PaidRow>(await db.execute(paidInPeriodQuery(predicate, period.start, period.end)));
      notes.push(paidInPeriodNote(period.label, paidRows));
    }

    const byCurrency = currencyRows.map(toGroupRow);
    const truncated = detailRows.length > DETAIL_ROW_CAP;
    const rows = detailRows.slice(0, DETAIL_ROW_CAP).map(toDetailRow);
    // Detail rows are exactly the bucketed invoices, whose full count is the
    // per-currency invoice_count sum.
    const available = truncated ? byCurrency.reduce((n, r) => n + r.invoiceCount, 0) : rows.length;

    const summary: ArAgingSummary = {
      generatedAt: generatedAt.toISOString(),
      asOf,
      timeZone,
      scope: scopeMeta(scope, orgName),
      groupBy,
      byCurrency,
      groups: groupRows.map(toGroupRow),
      otherOpenBalance,
      detail: { cap: DETAIL_ROW_CAP, stored: rows.length, available, truncated },
      notes,
      rows,
    };
    return toResult(summary);
  });
}
