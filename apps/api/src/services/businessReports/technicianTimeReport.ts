import { sql, type SQL } from 'drizzle-orm';
import {
  emptyTechnicianTimeSummary,
  type CurrencyAmountRow,
  type TechnicianTimeDetailRow,
  type TechnicianTimeGroupRow,
  type TechnicianTimeSummary,
} from '@breeze/shared';
import { db } from '../../db';
import { sqlTimestamp, sqlUuidArray } from '../../db/sqlValues';
import { minorUnitScaleSql } from '../currencySql';
import { technicianTimeConfigSchema, type TechnicianTimeConfig } from '../reportConfigSchemas';
import type { ReportResult } from '../reportGenerationService';
import { reportTypeDef } from '../reportRegistry';
import { reportOwnerOfScope, runInReportScope, type ReportScope } from '../reportScope';
import type { ReportGenerationAuthority } from '../siteScope';
import { PARTNER_ORG_LIST_NOTE, ratio, rowsOf, SITE_RESTRICTED_NOTE } from './common';
import {
  resolveReportOwnerTimezone,
  resolveReportPeriod,
  workingDaysBetween,
  type ResolvedReportPeriod,
} from './period';

/**
 * R2 — Technician time & billability (`technician_time_billability`, #3198
 * spec §3.3 R2 as amended 2026-09-21).
 *
 * Minutes semantics:
 * - utilization (logged ÷ capacity) and billable % use `duration_minutes` —
 *   time actually worked, not post-minimum/post-rounding billing quantity;
 * - billing conversion (billed ÷ billable) uses `billable_minutes` on BOTH
 *   sides, so it reconciles to what invoices carry;
 * - the billability split is `coverage`, falling back to `is_billable` for rows
 *   stamped before the billing-profiles cut-over (`coverage IS NULL`);
 * - money is per currency, never summed across currencies (OD-4 = A).
 *
 * Tenancy (rulings P6/P7): every statement runs inside ONE `runInReportScope`
 * and carries the predicate built by `entryScopePredicate` — the only place it
 * is built. `time_entries` RLS is partner-axis only, so under an org-token
 * context the org-scope report is empty; that is disclosed, never escalated
 * (escalating would hand a customer token MSP-internal rates).
 */

const DETAIL_ROW_CAP = reportTypeDef('technician_time_billability').detailRowCap;
const DEFAULT_WEEKLY_CAPACITY_HOURS = 40;

export type { TechnicianTimeConfig };
type GroupBy = TechnicianTimeSummary['groupBy'];

const BILLING_CONVERSION_NOTE =
  'Billing conversion is approved-and-billed minutes over billable minutes. It is not financial realization — no fee-schedule baseline exists to compute one.';
const COVERAGE_NOTE =
  'Billable, included and non-billable minutes follow each entry\'s coverage; entries recorded before billing profiles fall back to their billable flag. Running timers are not counted.';
const PARTNER_ROSTER_NOTE =
  'Technicians are the partner\'s active staff whose role can read time entries, plus anyone else who logged time in the period; technicians who logged nothing appear at 0%. Users who logged time but are disabled or without time-entry access are included too, and add their capacity to the totals. Time entries with no organization (internal work) are included.';
const PARTNER_NO_ORGS_NOTE =
  'This partner has no active or trial organizations, so only time entries with no organization are included.';
/** Spec §3.3 R2: the label an org-scoped instance must carry. */
const ORG_SCOPE_NOTE =
  'Organization-scoped: ticket-linked time only. Time entries with no organization are not included, and technicians who logged none of this organization\'s time do not appear.';
/** #3198 W02 Task 13: the org-scope utilization denominator is still each
 *  technician's WHOLE capacity, so the figure is a share, not utilization. */
const ORG_SCOPE_UTILIZATION_NOTE =
  'Utilization at organization scope is the share of each technician\'s capacity spent on this organization, not their overall utilization.';

function capacityNote(weeklyCapacityHours: number, workingDays: number): string {
  return `Utilization assumes a uniform ${weeklyCapacityHours}h week prorated over ${workingDays} working days; PTO, part-time schedules and public holidays are not modelled.`;
}

/**
 * The ONE place the time_entries tenancy predicate is built (P6/P7).
 * - Partner: the partner axis ALWAYS, plus the live org allowlist — org-less
 *   (internal) entries are admitted, mirroring `orgAxisSql`.
 * - Org: the org, AND the org's own partner resolved in the same statement
 *   (defense in depth; never a bound partner id the caller could skew).
 */
function entryScopePredicate(scope: ReportScope): SQL {
  return scope.kind === 'partner'
    ? sql`te.partner_id = ${scope.partnerId}
        AND (te.org_id IS NULL OR te.org_id = ANY(${sqlUuidArray(scope.orgIds)}))`
    : sql`te.org_id = ${scope.orgId}
        AND te.partner_id = (SELECT o.partner_id FROM organizations o WHERE o.id = ${scope.orgId})`;
}

/**
 * Who counts as a technician.
 * - Partner: active users with a membership of this partner whose PARTNER role
 *   grants `time_entries:read` — the same grant shape as `roleGrantsReportAction`
 *   (services/siteScope.ts), `'*'` rows included or Partner Admin's wildcard
 *   grant is invisible.
 * - Org: there is no partner axis to enumerate from, so the users in the org's
 *   own entries.
 */
function techsCte(scope: ReportScope): SQL {
  if (scope.kind === 'organization') {
    return sql`SELECT DISTINCT e.user_id FROM entries e`;
  }
  return sql`
    SELECT DISTINCT pu.user_id
    FROM partner_users pu
    JOIN users u ON u.id = pu.user_id AND u.status = 'active'
    JOIN roles r ON r.id = pu.role_id
    JOIN role_permissions rp ON rp.role_id = r.id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE pu.partner_id = ${scope.partnerId}
      AND r.scope = 'partner'
      AND (r.is_system OR r.partner_id = ${scope.partnerId})
      AND p.resource IN ('time_entries', '*')
      AND p.action IN ('read', '*')`;
}

/**
 * The shared CTEs, repeated per statement (PG has no cross-statement CTEs).
 * `roster` = techs ∪ users with entries: a deactivated or permission-less user
 * who logged time must not vanish from the technician axis, or the axes would
 * stop reconciling to the overall total.
 */
function baseCte(scope: ReportScope, period: ResolvedReportPeriod): SQL {
  return sql`
    WITH entries AS (
      SELECT te.id, te.user_id, te.org_id, te.work_type_id, te.started_at,
        te.duration_minutes, te.billable_minutes, te.hourly_rate, te.currency_code,
        te.billing_status, te.is_approved,
        COALESCE(te.coverage, CASE WHEN te.is_billable THEN 'billable' ELSE 'non_billable' END) AS eff_coverage
      FROM time_entries te
      WHERE ${entryScopePredicate(scope)}
        -- A running timer has no duration yet.
        AND te.ended_at IS NOT NULL
        AND te.started_at >= ${sqlTimestamp(period.start)} AND te.started_at < ${sqlTimestamp(period.end)}
    ),
    techs AS (${techsCte(scope)}),
    roster AS (
      SELECT user_id FROM techs
      UNION
      SELECT user_id FROM entries
    )`;
}

/**
 * Group axes. `from` is the grouped statement's FROM clause; `entryKey` is the
 * same key computed from an `entries` row alone (the money statement).
 *
 * Only the technician axis starts from the roster: over org or work type a
 * roster LEFT JOIN would add one all-NULL row per idle technician.
 */
const GROUP_AXES: Record<GroupBy, { key: SQL; label: SQL; from: SQL; entryKey: SQL }> = {
  technician: {
    key: sql`r.user_id::text`,
    label: sql`COALESCE(u.name, 'Unknown user')`,
    from: sql`FROM roster r
      LEFT JOIN entries e ON e.user_id = r.user_id
      LEFT JOIN users u ON u.id = r.user_id`,
    entryKey: sql`e.user_id::text`,
  },
  organization: {
    key: sql`COALESCE(e.org_id::text, 'no_organization')`,
    label: sql`COALESCE(org.name, CASE WHEN e.org_id IS NULL THEN 'No organization' ELSE 'Unknown organization' END)`,
    from: sql`FROM entries e
      LEFT JOIN organizations org ON org.id = e.org_id`,
    entryKey: sql`COALESCE(e.org_id::text, 'no_organization')`,
  },
  work_type: {
    key: sql`COALESCE(e.work_type_id::text, 'unassigned')`,
    label: sql`COALESCE(wt.name, CASE WHEN e.work_type_id IS NULL THEN 'Unassigned' ELSE 'Unknown work type' END)`,
    from: sql`FROM entries e
      LEFT JOIN work_types wt ON wt.id = e.work_type_id`,
    entryKey: sql`COALESCE(e.work_type_id::text, 'unassigned')`,
  },
};

const BILLED_QUANTITY = sql`COALESCE(e.billable_minutes, e.duration_minutes)`;

/** The minute counters shared by the grouped and overall statements. */
const MINUTES = sql`
  COALESCE(SUM(e.duration_minutes), 0)::int AS logged_minutes,
  COALESCE(SUM(e.duration_minutes) FILTER (WHERE e.eff_coverage = 'billable'), 0)::int AS billable_minutes,
  COALESCE(SUM(e.duration_minutes) FILTER (WHERE e.eff_coverage = 'included'), 0)::int AS included_minutes,
  COALESCE(SUM(e.duration_minutes) FILTER (WHERE e.eff_coverage = 'non_billable'), 0)::int AS non_billable_minutes,
  COALESCE(SUM(${BILLED_QUANTITY}) FILTER (WHERE e.eff_coverage = 'billable'), 0)::int AS billable_quantity_minutes,
  COALESCE(SUM(${BILLED_QUANTITY}) FILTER (WHERE e.eff_coverage = 'billable'
    AND e.is_approved AND e.billing_status IN ('billed', 'contract')), 0)::int AS billed_minutes,
  COUNT(e.id)::int AS entry_count`;

/**
 * Per-row money, rounded exactly like `getTicketBillingSummary`
 * (timeEntryService.ts): hours to 2 dp, one ROUND per row at the currency's
 * minor unit, then SUM — so this report and the ticket billing panel cannot
 * disagree. Returned as numeric text; never a JS number.
 */
const MONEY = sql`
  COALESCE(SUM(ROUND(ROUND(${BILLED_QUANTITY}::numeric / 60, 2) * e.hourly_rate, ${minorUnitScaleSql(sql`e.currency_code`)})), 0)::numeric(14,2)::text AS billable_value,
  ROUND(AVG(e.hourly_rate), 2)::numeric(12,2)::text AS average_rate`;
const MONEY_ROWS = sql`e.eff_coverage = 'billable' AND e.hourly_rate IS NOT NULL AND e.currency_code IS NOT NULL`;

function groupedQuery(cte: SQL, groupBy: GroupBy): SQL {
  const axis = GROUP_AXES[groupBy];
  return sql`${cte}
    SELECT ${axis.key} AS group_key, ${axis.label} AS group_label,
      ${MINUTES}
    ${axis.from}
    GROUP BY 1, 2
    ORDER BY 2, 1`;
}

function groupedMoneyQuery(cte: SQL, groupBy: GroupBy): SQL {
  return sql`${cte}
    SELECT ${GROUP_AXES[groupBy].entryKey} AS group_key, e.currency_code::text AS currency_code,
      ${MONEY}
    FROM entries e
    WHERE ${MONEY_ROWS}
    GROUP BY 1, 2
    ORDER BY 1, 2`;
}

function overallQuery(cte: SQL, scope: ReportScope): SQL {
  const orgName = scope.kind === 'organization'
    ? sql`(SELECT name FROM organizations WHERE id = ${scope.orgId})`
    : sql`NULL::text`;
  return sql`${cte}
    SELECT ${MINUTES},
      (SELECT COUNT(*) FROM roster)::int AS technician_count,
      (SELECT COUNT(*) FROM techs t
        WHERE NOT EXISTS (SELECT 1 FROM entries x WHERE x.user_id = t.user_id))::int AS zero_time_technicians,
      ${orgName} AS scope_org_name
    FROM entries e`;
}

function overallMoneyQuery(cte: SQL): SQL {
  return sql`${cte}
    SELECT e.currency_code::text AS currency_code,
      ${MONEY}
    FROM entries e
    WHERE ${MONEY_ROWS}
    GROUP BY e.currency_code
    ORDER BY 1`;
}

/** Naive `timestamp` columns hold UTC; render them as ISO instants in SQL. */
const iso = (column: SQL) => sql`to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

function detailQuery(cte: SQL): SQL {
  return sql`${cte}
    SELECT
      e.id::text AS id, ${iso(sql`e.started_at`)} AS started_at,
      e.user_id::text AS user_id, u.name AS user_name,
      e.org_id::text AS org_id, org.name AS org_name, wt.name AS work_type_name,
      e.duration_minutes, e.billable_minutes, e.eff_coverage AS coverage,
      e.billing_status::text AS billing_status, e.is_approved,
      e.hourly_rate::text AS hourly_rate, e.currency_code::text AS currency_code
    FROM entries e
    LEFT JOIN users u ON u.id = e.user_id
    LEFT JOIN organizations org ON org.id = e.org_id
    LEFT JOIN work_types wt ON wt.id = e.work_type_id
    ORDER BY e.started_at DESC, e.id
    LIMIT ${DETAIL_ROW_CAP + 1}`;
}

type MinutesRow = {
  logged_minutes: number; billable_minutes: number; included_minutes: number;
  non_billable_minutes: number; billable_quantity_minutes: number; billed_minutes: number;
  entry_count: number;
};
type GroupRow = MinutesRow & { group_key: string; group_label: string };
type OverallRow = MinutesRow & {
  technician_count: number; zero_time_technicians: number; scope_org_name: string | null;
};
type MoneyRow = { currency_code: string; billable_value: string; average_rate: string | null };
type GroupMoneyRow = MoneyRow & { group_key: string };
type DetailRow = {
  id: string; started_at: string; user_id: string; user_name: string | null;
  org_id: string | null; org_name: string | null; work_type_name: string | null;
  duration_minutes: number | null; billable_minutes: number | null;
  coverage: TechnicianTimeDetailRow['coverage']; billing_status: string; is_approved: boolean;
  hourly_rate: string | null; currency_code: string | null;
};

const n = (v: unknown) => Number(v ?? 0);
const nullableInt = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function money(rows: MoneyRow[]): Pick<TechnicianTimeGroupRow, 'billableValue' | 'averageRate'> {
  const billableValue: CurrencyAmountRow[] = [];
  const averageRate: CurrencyAmountRow[] = [];
  for (const r of rows) {
    billableValue.push({ currencyCode: r.currency_code, amount: String(r.billable_value) });
    if (r.average_rate !== null) averageRate.push({ currencyCode: r.currency_code, amount: String(r.average_rate) });
  }
  return { billableValue, averageRate };
}

function figures(
  row: MinutesRow,
  capacityMinutes: number | null,
  moneyRows: MoneyRow[],
): Omit<TechnicianTimeGroupRow, 'groupKey' | 'groupLabel'> {
  const loggedMinutes = n(row.logged_minutes);
  const billableMinutes = n(row.billable_minutes);
  const billedMinutes = n(row.billed_minutes);
  return {
    loggedMinutes,
    capacityMinutes,
    utilization: capacityMinutes === null ? null : ratio(loggedMinutes, capacityMinutes),
    billableMinutes,
    includedMinutes: n(row.included_minutes),
    nonBillableMinutes: n(row.non_billable_minutes),
    billablePercent: ratio(billableMinutes, loggedMinutes),
    billedMinutes,
    billingConversion: ratio(billedMinutes, n(row.billable_quantity_minutes)),
    ...money(moneyRows),
  };
}

function toDetailRow(r: DetailRow): TechnicianTimeDetailRow {
  return {
    entryId: r.id,
    startedAt: r.started_at,
    userId: r.user_id,
    userName: r.user_name,
    orgId: r.org_id,
    orgName: r.org_name,
    workTypeName: r.work_type_name,
    durationMinutes: nullableInt(r.duration_minutes),
    billableMinutes: nullableInt(r.billable_minutes),
    coverage: r.coverage,
    billingStatus: r.billing_status,
    isApproved: Boolean(r.is_approved),
    hourlyRate: r.hourly_rate,
    currencyCode: r.currency_code,
  };
}

function toResult(summary: TechnicianTimeSummary): ReportResult {
  return {
    rows: summary.rows as unknown as Record<string, unknown>[],
    rowCount: summary.rows.length,
    generatedAt: summary.generatedAt,
    summary: summary as unknown as Record<string, unknown>,
  };
}

function scopeMeta(scope: ReportScope, orgName: string | null): TechnicianTimeSummary['scope'] {
  return scope.kind === 'partner'
    ? { kind: 'partner', partnerId: scope.partnerId, orgCount: scope.orgIds.length }
    : { kind: 'organization', orgId: scope.orgId, orgName };
}

export async function generateTechnicianTimeBillabilityReport(
  scope: ReportScope,
  rawConfig: Record<string, unknown>,
  authority: ReportGenerationAuthority,
): Promise<ReportResult> {
  // Parse BEFORE any query: a stored config the type rejects never runs.
  const config = technicianTimeConfigSchema.parse(rawConfig ?? {});
  const groupBy: GroupBy = config.groupBy ?? 'technician';
  const weeklyCapacityHours = config.weeklyCapacityHours ?? DEFAULT_WEEKLY_CAPACITY_HOURS;
  const generatedAt = new Date();

  // Time entries have no site axis; a restricted authority (any number of
  // sites) queries nothing (ruling T7a — the dispatcher guards this too).
  if (authority.scope.kind === 'restricted') {
    return toResult({
      ...emptyTechnicianTimeSummary(SITE_RESTRICTED_NOTE),
      generatedAt: generatedAt.toISOString(),
      scope: scopeMeta(scope, null),
      groupBy,
      weeklyCapacityHours,
    });
  }

  // ONE scoped block for the whole report (ruling P6).
  return runInReportScope(scope, async () => {
    const timeZone = await resolveReportOwnerTimezone(reportOwnerOfScope(scope));
    const period = resolveReportPeriod(config.period, timeZone, generatedAt);
    const workingDays = workingDaysBetween(period.start, period.end, period.timeZone);
    const capacityPerTechnician = Math.round(workingDays * (weeklyCapacityHours / 5) * 60);

    const notes = [capacityNote(weeklyCapacityHours, workingDays), BILLING_CONVERSION_NOTE, COVERAGE_NOTE];
    if (scope.kind === 'partner') {
      notes.push(PARTNER_ROSTER_NOTE, PARTNER_ORG_LIST_NOTE);
      // Not a short-circuit (unlike R1/R3): internal, org-less time is still
      // real time. sqlUuidArray renders the empty list as ARRAY[]::uuid[].
      if (scope.orgIds.length === 0) notes.unshift(PARTNER_NO_ORGS_NOTE);
    } else {
      notes.push(ORG_SCOPE_NOTE, ORG_SCOPE_UTILIZATION_NOTE);
    }

    const cte = baseCte(scope, period);
    const groupRows = rowsOf<GroupRow>(await db.execute(groupedQuery(cte, groupBy)));
    const groupMoneyRows = rowsOf<GroupMoneyRow>(await db.execute(groupedMoneyQuery(cte, groupBy)));
    const [overallRow] = rowsOf<OverallRow>(await db.execute(overallQuery(cte, scope)));
    const overallMoneyRows = rowsOf<MoneyRow>(await db.execute(overallMoneyQuery(cte)));
    const detailRows = rowsOf<DetailRow>(await db.execute(detailQuery(cte)));

    const moneyByGroup = new Map<string, MoneyRow[]>();
    for (const r of groupMoneyRows) {
      const key = String(r.group_key);
      moneyByGroup.set(key, [...(moneyByGroup.get(key) ?? []), r]);
    }

    // Capacity is a technician-axis figure only: a work type or an org has no
    // capacity, and printing one would be an invented denominator.
    const groupCapacity = groupBy === 'technician' ? capacityPerTechnician : null;
    const groups: TechnicianTimeGroupRow[] = groupRows.map((r) => ({
      groupKey: String(r.group_key),
      groupLabel: String(r.group_label),
      ...figures(r, groupCapacity, moneyByGroup.get(String(r.group_key)) ?? []),
    }));

    const overallMinutes = overallRow ?? ({} as OverallRow);
    const overall = figures(
      overallMinutes,
      capacityPerTechnician * n(overallMinutes.technician_count),
      overallMoneyRows,
    );
    const truncated = detailRows.length > DETAIL_ROW_CAP;
    const rows = detailRows.slice(0, DETAIL_ROW_CAP).map(toDetailRow);

    const summary: TechnicianTimeSummary = {
      generatedAt: generatedAt.toISOString(),
      period: {
        kind: period.kind,
        start: period.start.toISOString(),
        end: period.end.toISOString(),
        label: period.label,
        timeZone: period.timeZone,
      },
      scope: scopeMeta(scope, overallRow?.scope_org_name ?? null),
      groupBy,
      weeklyCapacityHours,
      workingDays,
      overall,
      groups,
      zeroTimeTechnicians: n(overallMinutes.zero_time_technicians),
      detail: {
        cap: DETAIL_ROW_CAP,
        stored: rows.length,
        available: truncated ? n(overallMinutes.entry_count) : rows.length,
        truncated,
      },
      notes,
      rows,
    };
    return toResult(summary);
  });
}
