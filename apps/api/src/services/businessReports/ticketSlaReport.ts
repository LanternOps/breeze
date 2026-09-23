import { sql, type SQL } from 'drizzle-orm';
import {
  emptyTicketSlaSummary,
  type SlaOutcome,
  type TicketSlaDetailRow,
  type TicketSlaGroupRow,
  type TicketSlaSummary,
} from '@breeze/shared';
import { db } from '../../db';
import { sqlTimestamp, sqlUuidArray } from '../../db/sqlValues';
import { ticketSlaConfigSchema, type TicketSlaConfig } from '../reportConfigSchemas';
import type { ReportResult } from '../reportGenerationService';
import { reportTypeDef } from '../reportRegistry';
import { reportOwnerOfScope, runInReportScope, type ReportScope } from '../reportScope';
import type { ReportGenerationAuthority } from '../siteScope';
import { NO_ORGS_NOTE, PARTNER_ORG_LIST_NOTE, ratio, rowsOf, SITE_RESTRICTED_NOTE } from './common';
import { resolveReportOwnerTimezone, resolveReportPeriod, type ResolvedReportPeriod } from './period';

/**
 * R1 — Ticket SLA attainment (`ticket_sla_attainment`, #3198 spec §3.3 R1).
 *
 * Attainment is RECOMPUTED from ticket timestamps and the SLA targets stored on
 * each ticket (Open Decision 2 = A), not read from `sla_breached_at`: the sweep
 * (`jobs/ticketSlaWorker.ts`) only stamps tickets that are still open and
 * unanswered when it runs, so a late-but-eventually-answered ticket is never
 * stamped. The disagreement between the two is published as a count.
 *
 * Tenancy (ruling P6): every statement runs inside ONE `runInReportScope` and
 * carries the explicit org predicate built by `ticketScopePredicate` — the only
 * place it is built.
 */

/** The registry entry's cap is the single source (spec §4). Aggregates are
 *  always computed over the full set; only stored detail rows are capped. */
const DETAIL_ROW_CAP = reportTypeDef('ticket_sla_attainment').detailRowCap;

export type { TicketSlaConfig };
type GroupBy = TicketSlaSummary['groupBy'];

const NOTES = [
  'Attainment is recomputed from ticket timestamps and the SLA targets stored on each ticket, not from the sla_breached_at stamp: the SLA sweep only marks tickets that are still open and unanswered when it runs, so a late-but-eventually-answered ticket is never stamped.',
  'sla_paused_minutes is a lifetime total, so pause time that occurred after first response slightly flatters response attainment.',
  'Tickets with no SLA target are excluded from the attainment denominators and counted separately.',
  'Planned work (work_kind other than support) carries a due date, not an SLA, and is excluded.',
  'The technician axis uses the ticket\'s CURRENT assignee; reassignment history is not tracked.',
];

const TECHNICIAN_LABEL_SUFFIX = ' (current assignee)';

/**
 * The ONE place the tenancy predicate is built; every statement interpolates
 * it. Partner scope binds the live org allowlist, org scope the single org.
 */
function ticketScopePredicate(scope: ReportScope): SQL {
  return scope.kind === 'partner'
    ? sql`t.org_id = ANY(${sqlUuidArray(scope.orgIds)})`
    : sql`t.org_id = ${scope.orgId}`;
}

/**
 * Group axis fragments. Constant SQL — `groupBy` is a zod enum, but nothing
 * here interpolates it as text either way.
 *
 * The technician label distinguishes "no assignee" from "an assignee whose
 * `users` row this context cannot read" (users RLS can hide partner staff from
 * an org-scoped caller): the latter is not unassigned.
 */
const GROUP_AXES: Record<GroupBy, { key: SQL; label: SQL; order: SQL }> = {
  organization: {
    key: sql`o.org_id`,
    label: sql`COALESCE(org.name, 'Unknown organization')`,
    order: sql`2, 1`,
  },
  priority: {
    key: sql`o.priority`,
    label: sql`o.priority::text`,
    // Enum order is low < normal < high < urgent; most urgent first.
    order: sql`o.priority DESC`,
  },
  technician: {
    key: sql`COALESCE(o.assigned_to::text, 'unassigned')`,
    label: sql`COALESCE(u.name, CASE WHEN o.assigned_to IS NULL THEN 'Unassigned' ELSE 'Unknown technician' END)`,
    order: sql`2, 1`,
  },
  category: {
    key: sql`COALESCE(o.category, 'uncategorised')`,
    label: sql`COALESCE(o.category, 'Uncategorised')`,
    order: sql`2, 1`,
  },
};

/**
 * The shared CTE, repeated in each statement (PG has no cross-statement CTEs).
 * The deadline mirrors `ticketSlaWorker.ts` exactly:
 * `created_at + (target + paused) * interval '1 minute'`.
 */
function outcomesCte(scopePredicate: SQL, period: ResolvedReportPeriod): SQL {
  return sql`
    WITH scoped AS (
      SELECT
        t.id, t.org_id, t.priority, t.category, t.assigned_to, t.subject,
        t.ticket_number, t.internal_number, t.created_at,
        t.first_response_at, t.resolved_at,
        t.response_sla_minutes, t.resolution_sla_minutes,
        COALESCE(t.sla_paused_minutes, 0) AS paused,
        t.sla_breached_at, t.sla_breach_reason
      FROM tickets t
      WHERE t.deleted_at IS NULL
        -- #5573 §4.8: the sweep excludes planned work, so the recompute must too.
        AND t.work_kind = 'support'
        AND t.created_at >= ${sqlTimestamp(period.start)} AND t.created_at < ${sqlTimestamp(period.end)}
        AND ${scopePredicate}
    ),
    outcomes AS (
      SELECT s.*,
        CASE
          WHEN s.response_sla_minutes IS NULL THEN 'no_target'
          WHEN s.first_response_at IS NOT NULL
           AND s.first_response_at <= s.created_at + (s.response_sla_minutes + s.paused) * interval '1 minute'
            THEN 'met'
          WHEN s.first_response_at IS NOT NULL THEN 'missed'
          WHEN now() > s.created_at + (s.response_sla_minutes + s.paused) * interval '1 minute' THEN 'missed'
          ELSE 'pending'
        END AS response_outcome,
        CASE
          WHEN s.resolution_sla_minutes IS NULL THEN 'no_target'
          WHEN s.resolved_at IS NOT NULL
           AND s.resolved_at <= s.created_at + (s.resolution_sla_minutes + s.paused) * interval '1 minute'
            THEN 'met'
          WHEN s.resolved_at IS NOT NULL THEN 'missed'
          WHEN now() > s.created_at + (s.resolution_sla_minutes + s.paused) * interval '1 minute' THEN 'missed'
          ELSE 'pending'
        END AS resolution_outcome
      FROM scoped s
    )`;
}

/** The counters shared by the grouped and overall statements. */
const COUNTERS = sql`
  COUNT(*)::int AS tickets_total,
  COUNT(*) FILTER (WHERE o.response_outcome = 'no_target'
                     AND o.resolution_outcome = 'no_target')::int AS no_sla_tickets,
  COUNT(*) FILTER (WHERE o.response_outcome IN ('met', 'missed'))::int AS response_eligible,
  COUNT(*) FILTER (WHERE o.response_outcome = 'met')::int AS response_met,
  COUNT(*) FILTER (WHERE o.resolution_outcome IN ('met', 'missed'))::int AS resolution_eligible,
  COUNT(*) FILTER (WHERE o.resolution_outcome = 'met')::int AS resolution_met,
  COUNT(*) FILTER (WHERE o.response_outcome = 'missed'
                      OR o.resolution_outcome = 'missed')::int AS breaches`;

function groupedQuery(cte: SQL, groupBy: GroupBy): SQL {
  const axis = GROUP_AXES[groupBy];
  return sql`${cte}
    SELECT ${axis.key}::text AS group_key, ${axis.label} AS group_label,
      ${COUNTERS}
    FROM outcomes o
    LEFT JOIN organizations org ON org.id = o.org_id
    LEFT JOIN users u ON u.id = o.assigned_to
    GROUP BY ${axis.key}, ${axis.label}
    ORDER BY ${axis.order}`;
}

function overallQuery(cte: SQL, scope: ReportScope): SQL {
  const orgName = scope.kind === 'organization'
    ? sql`(SELECT name FROM organizations WHERE id = ${scope.orgId})`
    : sql`NULL::text`;
  return sql`${cte}
    SELECT ${COUNTERS},
      COUNT(*) FILTER (WHERE (o.response_outcome = 'missed' OR o.resolution_outcome = 'missed')
                         AND o.sla_breached_at IS NULL)::int AS recomputed_breach_not_stamped,
      COUNT(*) FILTER (WHERE o.sla_breached_at IS NOT NULL
                         AND o.response_outcome <> 'missed'
                         AND o.resolution_outcome <> 'missed')::int AS stamped_not_recomputed_breach,
      ${orgName} AS scope_org_name
    FROM outcomes o`;
}

/** Naive `timestamp` columns hold UTC; render them as ISO instants in SQL so
 *  the output does not depend on the driver's timestamp parser. */
const iso = (column: SQL) => sql`to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

function detailQuery(cte: SQL, includeNoSla: boolean): SQL {
  const noSlaFilter = includeNoSla
    ? sql``
    : sql`WHERE NOT (o.response_outcome = 'no_target' AND o.resolution_outcome = 'no_target')`;
  return sql`${cte}
    SELECT
      o.id::text AS id, o.ticket_number, o.internal_number,
      o.org_id::text AS org_id, org.name AS org_name,
      o.subject, o.priority::text AS priority, o.category,
      u.name AS assigned_to_name,
      ${iso(sql`o.created_at`)} AS created_at,
      ${iso(sql`o.first_response_at`)} AS first_response_at,
      ${iso(sql`o.resolved_at`)} AS resolved_at,
      o.response_sla_minutes, o.resolution_sla_minutes, o.paused,
      o.response_outcome, o.resolution_outcome,
      ${iso(sql`o.sla_breached_at`)} AS sla_breached_at, o.sla_breach_reason
    FROM outcomes o
    LEFT JOIN organizations org ON org.id = o.org_id
    LEFT JOIN users u ON u.id = o.assigned_to
    ${noSlaFilter}
    ORDER BY o.created_at DESC, o.id
    LIMIT ${DETAIL_ROW_CAP + 1}`;
}

type CounterRow = {
  tickets_total: number; no_sla_tickets: number;
  response_eligible: number; response_met: number;
  resolution_eligible: number; resolution_met: number;
  breaches: number;
};
type GroupRow = CounterRow & { group_key: string; group_label: string };
type OverallRow = CounterRow & {
  recomputed_breach_not_stamped: number;
  stamped_not_recomputed_breach: number;
  scope_org_name: string | null;
};
type DetailRow = {
  id: string; ticket_number: string | null; internal_number: string | null;
  org_id: string; org_name: string | null; subject: string; priority: string;
  category: string | null; assigned_to_name: string | null;
  created_at: string; first_response_at: string | null; resolved_at: string | null;
  response_sla_minutes: number | null; resolution_sla_minutes: number | null; paused: number;
  response_outcome: SlaOutcome; resolution_outcome: SlaOutcome;
  sla_breached_at: string | null; sla_breach_reason: string | null;
};

function counters(row: CounterRow): TicketSlaSummary['overall'] {
  const n = (v: unknown) => Number(v ?? 0);
  const responseEligible = n(row.response_eligible);
  const responseMet = n(row.response_met);
  const resolutionEligible = n(row.resolution_eligible);
  const resolutionMet = n(row.resolution_met);
  return {
    ticketsTotal: n(row.tickets_total),
    noSlaTickets: n(row.no_sla_tickets),
    responseEligible,
    responseMet,
    responseAttainment: ratio(responseMet, responseEligible),
    resolutionEligible,
    resolutionMet,
    resolutionAttainment: ratio(resolutionMet, resolutionEligible),
    breaches: n(row.breaches),
  };
}

function toDetailRow(r: DetailRow): TicketSlaDetailRow {
  return {
    ticketId: r.id,
    ticketNumber: r.ticket_number,
    internalNumber: r.internal_number,
    orgId: r.org_id,
    orgName: r.org_name,
    subject: r.subject,
    priority: r.priority,
    category: r.category,
    assignedToName: r.assigned_to_name,
    createdAt: r.created_at,
    firstResponseAt: r.first_response_at,
    resolvedAt: r.resolved_at,
    responseSlaMinutes: r.response_sla_minutes === null ? null : Number(r.response_sla_minutes),
    resolutionSlaMinutes: r.resolution_sla_minutes === null ? null : Number(r.resolution_sla_minutes),
    slaPausedMinutes: Number(r.paused ?? 0),
    responseOutcome: r.response_outcome,
    resolutionOutcome: r.resolution_outcome,
    stampedBreachAt: r.sla_breached_at,
    stampedBreachReason: r.sla_breach_reason,
  };
}

/** Lowest response attainment among MEASURED groups; an unmeasured group
 *  (attainment null) is not "worst", it is unknown. First wins a tie. */
function worstGroup(groups: TicketSlaGroupRow[]): string | null {
  let worst: TicketSlaGroupRow | null = null;
  for (const g of groups) {
    if (g.responseAttainment === null) continue;
    if (worst === null || g.responseAttainment < (worst.responseAttainment as number)) worst = g;
  }
  return worst?.groupLabel ?? null;
}

function toResult(summary: TicketSlaSummary): ReportResult {
  return {
    rows: summary.rows as unknown as Record<string, unknown>[],
    rowCount: summary.rows.length,
    generatedAt: summary.generatedAt,
    summary: summary as unknown as Record<string, unknown>,
  };
}

export async function generateTicketSlaAttainmentReport(
  scope: ReportScope,
  rawConfig: Record<string, unknown>,
  authority: ReportGenerationAuthority,
): Promise<ReportResult> {
  // Parse BEFORE any query: a stored config the type rejects never runs.
  const config = ticketSlaConfigSchema.parse(rawConfig ?? {});
  const groupBy: GroupBy = config.groupBy ?? (scope.kind === 'partner' ? 'organization' : 'priority');
  const includeNoSla = config.includeNoSla ?? true;
  const generatedAt = new Date();

  // Tickets have no site axis. The dispatcher's zero-safe branch catches a
  // restricted authority with ZERO sites; one with some sites reaches here,
  // and there is no site filter to apply — so nothing is queried at all
  // (same answer as the zero-safe branch, like identity_access_review OD-8 = A).
  if (authority.scope.kind === 'restricted') {
    return toResult({
      ...emptyTicketSlaSummary(SITE_RESTRICTED_NOTE),
      generatedAt: generatedAt.toISOString(),
      scope: scope.kind === 'organization'
        ? { kind: 'organization', orgId: scope.orgId, orgName: null }
        : { kind: 'partner', partnerId: scope.partnerId, orgCount: scope.orgIds.length },
      groupBy,
    });
  }

  // ONE scoped block for the whole report (ruling P6): the timezone read and
  // all three statements share one context — and, when this opens a system
  // context, one pooled connection.
  return runInReportScope(scope, async () => {
    const timeZone = await resolveReportOwnerTimezone(reportOwnerOfScope(scope));
    const period = resolveReportPeriod(config.period, timeZone, generatedAt);
    const periodMeta = {
      kind: period.kind,
      start: period.start.toISOString(),
      end: period.end.toISOString(),
      label: period.label,
      timeZone: period.timeZone,
    };
    const notes = scope.kind === 'partner' ? [...NOTES, PARTNER_ORG_LIST_NOTE] : [...NOTES];

    if (scope.kind === 'partner' && scope.orgIds.length === 0) {
      const empty = emptyTicketSlaSummary(NO_ORGS_NOTE);
      return toResult({
        ...empty,
        generatedAt: generatedAt.toISOString(),
        period: periodMeta,
        scope: { kind: 'partner', partnerId: scope.partnerId, orgCount: 0 },
        groupBy,
        detail: { ...empty.detail, cap: DETAIL_ROW_CAP },
        notes: [NO_ORGS_NOTE, ...notes],
      });
    }

    const cte = outcomesCte(ticketScopePredicate(scope), period);
    const groupRows = rowsOf<GroupRow>(await db.execute(groupedQuery(cte, groupBy)));
    const [overallRow] = rowsOf<OverallRow>(await db.execute(overallQuery(cte, scope)));
    const detailRows = rowsOf<DetailRow>(await db.execute(detailQuery(cte, includeNoSla)));

    const groups: TicketSlaGroupRow[] = groupRows.map((r) => ({
      groupKey: String(r.group_key),
      groupLabel: groupBy === 'technician'
        ? `${r.group_label}${TECHNICIAN_LABEL_SUFFIX}`
        : String(r.group_label),
      ...counters(r),
    }));
    const overall = counters(overallRow ?? ({} as CounterRow));
    const truncated = detailRows.length > DETAIL_ROW_CAP;
    const rows = detailRows.slice(0, DETAIL_ROW_CAP).map(toDetailRow);
    // With includeNoSla=false the detail set is narrower than the aggregate
    // set, so the untruncated count is the stored count, not ticketsTotal.
    const available = truncated
      ? (includeNoSla ? overall.ticketsTotal : overall.ticketsTotal - overall.noSlaTickets)
      : rows.length;

    const summary: TicketSlaSummary = {
      generatedAt: generatedAt.toISOString(),
      period: periodMeta,
      scope: scope.kind === 'partner'
        ? { kind: 'partner', partnerId: scope.partnerId, orgCount: scope.orgIds.length }
        : { kind: 'organization', orgId: scope.orgId, orgName: overallRow?.scope_org_name ?? null },
      groupBy,
      overall,
      groups,
      worstGroupLabel: worstGroup(groups),
      stampDiscrepancy: {
        recomputedBreachNotStamped: Number(overallRow?.recomputed_breach_not_stamped ?? 0),
        stampedNotRecomputedBreach: Number(overallRow?.stamped_not_recomputed_breach ?? 0),
      },
      detail: { cap: DETAIL_ROW_CAP, stored: rows.length, available, truncated },
      notes,
      rows,
    };
    return toResult(summary);
  });
}
