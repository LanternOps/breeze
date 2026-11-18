import { sql, type SQL } from 'drizzle-orm';
import type { QuoteOutcome } from '@breeze/shared';
import { sqlTimestamp, sqlUuidArray } from '../../db/sqlValues';

/**
 * Quote lineage queries for the win-rate report (`quote_win_rate`, #9828 W2,
 * spec §3.3 T5/T5b).
 *
 * Unit of analysis = a lineage (one opportunity): the root quote plus every
 * revision reached through `revision_of_quote_id`. The walk is a recursive CTE
 * that is fenced twice:
 *  - the ANCHOR binds `org_id = ANY($orgIds)` and, at partner scope,
 *    `partner_id = $partnerId` (`quotes.partner_id` is NOT NULL, so the
 *    predicate always applies);
 *  - the STEP repeats `c.org_id = w.org_id` (and the partner predicate), so a
 *    cross-org revision pointer can never widen the walk.
 * Bound parameters only. RLS is the backstop, never the fence.
 *
 * The walk happens BEFORE cohort filtering and capping. A lineage is in the
 * cohort when its FIRST `sent_at` falls in `[periodStart, periodEnd)`; a
 * never-sent lineage has no `first_sent_at` and drops out. The outcome is the
 * outcome of the highest-`revision_number` non-draft version (so decline →
 * revise → accept is ONE won lineage, and a draft revision leaves its sent
 * parent's outcome standing). A sent/viewed version past its `expiry_date` is
 * expired at read time (the `isQuoteExpired` rule: UTC day, `<`), because the
 * reaper may not have run yet.
 *
 * `quotes_revision_of_uq` does not prevent a cycle (A→B, B→A is unique). A
 * cycle has no root, so the root-anchored walk never reaches it; the
 * diagnostics statement counts such quotes so the report can say so instead of
 * silently under-counting. Unreachable quotes feed no rate. A depth-capped
 * lineage IS still counted, on its 50th version (the report prints a note).
 */

/** anomaly: a terminal 'superseded' version (should be impossible). */
export type { QuoteOutcome };

/** Longest revision chain walked. Bound as a parameter, never interpolated. */
export const QUOTE_LINEAGE_MAX_DEPTH = 50;

type ScopeArgs = { partnerId: string | null; orgIds: readonly string[] };
type PeriodArgs = { periodStart: Date; periodEnd: Date };

/** Anchor/step predicates for a quotes alias: org allowlist (+ partner at partner scope). */
function anchorPredicate(alias: string, args: ScopeArgs): SQL {
  const a = sql.raw(alias);
  const org = sql`${a}.org_id = ANY(${sqlUuidArray(args.orgIds)})`;
  return args.partnerId === null ? org : sql`${org} AND ${a}.partner_id = ${args.partnerId}`;
}

/** The recursive walk, shared by the cohort CTE and the diagnostics statement. */
function walkCte(args: ScopeArgs): SQL {
  const stepPartner = args.partnerId === null ? sql`` : sql` AND c.partner_id = ${args.partnerId}`;
  return sql`WITH RECURSIVE walk(root_id, id, org_id, depth) AS (
      SELECT q.id, q.id, q.org_id, 1
      FROM quotes q
      WHERE q.revision_of_quote_id IS NULL AND ${anchorPredicate('q', args)}
      UNION ALL
      SELECT w.root_id, c.id, c.org_id, w.depth + 1
      FROM walk w
      JOIN quotes c ON c.revision_of_quote_id = w.id AND c.org_id = w.org_id${stepPartner}
      WHERE w.depth < ${QUOTE_LINEAGE_MAX_DEPTH}
    )`;
}

/**
 * Sent quotes in the period that no root-anchored walk reached (a cycle or a
 * broken chain), and lineages that hit the depth guard with more versions
 * beyond it. One row `{ unreachable, depth_capped }`.
 */
export function lineageDiagnosticsQuery(
  args: ScopeArgs & PeriodArgs,
): SQL {
  const partner = args.partnerId === null ? sql`` : sql` AND x.partner_id = ${args.partnerId}`;
  return sql`/* qwr:diagnostics */ ${walkCte(args)}
    SELECT
      (SELECT COUNT(*)::int FROM quotes x
        WHERE x.org_id = ANY(${sqlUuidArray(args.orgIds)})${partner}
          AND x.sent_at >= ${sqlTimestamp(args.periodStart)} AND x.sent_at < ${sqlTimestamp(args.periodEnd)}
          AND x.id NOT IN (SELECT id FROM walk)) AS unreachable,
      (SELECT COUNT(DISTINCT w.root_id)::int FROM walk w
        WHERE w.depth = ${QUOTE_LINEAGE_MAX_DEPTH}
          AND EXISTS (SELECT 1 FROM quotes n WHERE n.revision_of_quote_id = w.id AND n.org_id = w.org_id)) AS depth_capped`;
}

/**
 * One row per lineage in the cohort, as the CTE named `lin`. The returned
 * fragment ends right after the CTE list; each statement appends its SELECT.
 */
export function lineageCte(args: ScopeArgs & PeriodArgs & { asOfUtcDate: string }): SQL {
  const asOf = sql`${args.asOfUtcDate}::date`;
  return sql`${walkCte(args)},
    per_root AS (
      SELECT w.root_id,
        MIN(q.sent_at) AS first_sent_at,
        COUNT(*)::int AS versions,
        bool_or(q.first_viewed_at IS NOT NULL) AS ever_viewed
      FROM walk w
      JOIN quotes q ON q.id = w.id
      GROUP BY w.root_id
    ),
    terminal AS (
      SELECT DISTINCT ON (w.root_id)
        w.root_id, q.id, q.org_id, q.quote_number, q.status, q.expiry_date, q.currency_code,
        q.one_time_total, q.monthly_recurring_total, q.annual_recurring_total,
        q.accepted_at, q.converted_at, q.declined_at, q.decline_reason
      FROM walk w
      JOIN quotes q ON q.id = w.id
      WHERE q.status <> 'draft'
      ORDER BY w.root_id, q.revision_number DESC
    ),
    lin AS (
      SELECT p.root_id, t.id AS terminal_id, t.org_id, org.name AS org_name, t.quote_number,
        p.first_sent_at, p.versions, p.ever_viewed,
        COALESCE(r.created_by::text, 'unknown') AS author_key,
        COALESCE(u.name, 'Unknown user') AS author_name,
        t.currency_code::text AS currency_code,
        t.one_time_total,
        (t.monthly_recurring_total + t.annual_recurring_total / 12) AS monthly_recurring_value,
        t.decline_reason,
        CASE
          WHEN t.status IN ('converted', 'accepted') THEN 'won'
          WHEN t.status = 'declined' THEN 'lost'
          WHEN t.status = 'expired' THEN 'expired'
          WHEN t.status IN ('sent', 'viewed') AND t.expiry_date < ${asOf} THEN 'expired'
          WHEN t.status IN ('sent', 'viewed') THEN 'open'
          ELSE 'anomaly'
        END AS outcome,
        CASE
          WHEN t.status IN ('converted', 'accepted') THEN COALESCE(t.accepted_at, t.converted_at)
          WHEN t.status = 'declined' THEN t.declined_at
          WHEN t.status = 'expired' OR (t.status IN ('sent', 'viewed') AND t.expiry_date < ${asOf})
            THEN t.expiry_date::timestamp
        END AS outcome_at
      FROM per_root p
      JOIN terminal t ON t.root_id = p.root_id
      JOIN quotes r ON r.id = p.root_id
      LEFT JOIN users u ON u.id = r.created_by
      LEFT JOIN organizations org ON org.id = t.org_id
      WHERE p.first_sent_at >= ${sqlTimestamp(args.periodStart)} AND p.first_sent_at < ${sqlTimestamp(args.periodEnd)}
    )`;
}

/** Count and median columns, over `lin l`. Anomalies are counted but never feed `lineages`. */
const COUNTS_SELECT = sql.join(
  [
    sql`COUNT(*) FILTER (WHERE l.outcome <> 'anomaly')::int AS lineages`,
    sql`COUNT(*) FILTER (WHERE l.outcome = 'won')::int AS won`,
    sql`COUNT(*) FILTER (WHERE l.outcome = 'lost')::int AS lost`,
    sql`COUNT(*) FILTER (WHERE l.outcome = 'expired')::int AS expired`,
    sql`COUNT(*) FILTER (WHERE l.outcome = 'open')::int AS open`,
    sql`COUNT(*) FILTER (WHERE l.outcome = 'anomaly')::int AS anomalies`,
    sql`COUNT(*) FILTER (WHERE l.ever_viewed AND l.outcome <> 'anomaly')::int AS viewed`,
    sql`(percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (l.outcome_at - l.first_sent_at)) / 86400)
      FILTER (WHERE l.outcome = 'won' AND l.outcome_at IS NOT NULL))::float8 AS median_days_to_win`,
    sql`(percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (l.outcome_at - l.first_sent_at)) / 86400)
      FILTER (WHERE l.outcome = 'lost' AND l.outcome_at IS NOT NULL))::float8 AS median_days_to_loss`,
  ],
  sql`, `,
);

/** Exact money sums as text; anomalies are excluded by the caller's WHERE. */
const MONEY_SELECT = sql.join(
  [
    sql`COALESCE(SUM(l.one_time_total), 0)::text AS quoted_one_time`,
    sql`COALESCE(SUM(l.one_time_total) FILTER (WHERE l.outcome = 'won'), 0)::text AS won_one_time`,
    sql`COALESCE(SUM(l.one_time_total) FILTER (WHERE l.outcome IN ('won', 'lost', 'expired')), 0)::text AS decided_one_time`,
    sql`COALESCE(SUM(l.monthly_recurring_value), 0)::text AS quoted_mrv`,
    sql`COALESCE(SUM(l.monthly_recurring_value) FILTER (WHERE l.outcome = 'won'), 0)::text AS won_mrv`,
    sql`COALESCE(SUM(l.monthly_recurring_value) FILTER (WHERE l.outcome IN ('won', 'lost', 'expired')), 0)::text AS decided_mrv`,
  ],
  sql`, `,
);

type GroupBy = 'organization' | 'author' | 'currency';

const GROUP_AXES: Record<GroupBy, { key: SQL; label: SQL }> = {
  organization: { key: sql`l.org_id::text`, label: sql`COALESCE(l.org_name, 'Unknown organization')` },
  author: { key: sql`l.author_key`, label: sql`l.author_name` },
  currency: { key: sql`l.currency_code`, label: sql`l.currency_code` },
};

export const lineageOverallQuery = (cte: SQL): SQL => sql`/* qwr:overall */ ${cte}
    SELECT ${COUNTS_SELECT}
    FROM lin l`;

export function lineageGroupedQuery(cte: SQL, groupBy: GroupBy): SQL {
  const axis = GROUP_AXES[groupBy];
  return sql`/* qwr:grouped */ ${cte}
    SELECT ${axis.key} AS group_key, ${axis.label} AS group_label, ${COUNTS_SELECT}
    FROM lin l
    GROUP BY 1, 2
    ORDER BY COUNT(*) DESC, 2, 1`;
}

export function lineageGroupedMoneyQuery(cte: SQL, groupBy: GroupBy): SQL {
  return sql`/* qwr:grouped_money */ ${cte}
    SELECT ${GROUP_AXES[groupBy].key} AS group_key, l.currency_code, ${MONEY_SELECT}
    FROM lin l
    WHERE l.outcome <> 'anomaly'
    GROUP BY 1, 2
    ORDER BY 1, 2`;
}

export const lineageByCurrencyQuery = (cte: SQL): SQL => sql`/* qwr:by_currency */ ${cte}
    SELECT l.currency_code, ${MONEY_SELECT}
    FROM lin l
    WHERE l.outcome <> 'anomaly'
    GROUP BY l.currency_code
    ORDER BY l.currency_code`;

const ISO_TS = (col: string) =>
  sql`to_char(${sql.raw(col)}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** Detail grain: one row per lineage, anomalies included (flagged), `limit` caps the set. */
export function lineageDetailQuery(cte: SQL, limit: number): SQL {
  return sql`/* qwr:detail */ ${cte}
    SELECT l.root_id::text AS root_quote_id, l.terminal_id::text AS terminal_quote_id, l.quote_number,
      l.org_id::text AS org_id, l.org_name, l.author_name, l.versions,
      ${ISO_TS('l.first_sent_at')} AS first_sent_at, l.outcome,
      ${ISO_TS('l.outcome_at')} AS outcome_at,
      l.currency_code, l.one_time_total::text AS one_time_total,
      l.monthly_recurring_value::text AS monthly_recurring_value, l.decline_reason
    FROM lin l
    ORDER BY l.first_sent_at, l.quote_number, l.root_id
    LIMIT ${limit}`;
}

/** Only run when the detail set was truncated: the true number of lineages. */
export const lineageCountQuery = (cte: SQL): SQL => sql`/* qwr:detail_count */ ${cte}
    SELECT COUNT(*)::int AS n FROM lin`;
