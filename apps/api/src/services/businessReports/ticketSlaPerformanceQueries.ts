import { sql, type SQL } from 'drizzle-orm';
import { sqlTimestamp } from '../../db/sqlValues';
import { effectiveDueSql, isoInstantSql, slaTicketEligibilitySql, type SlaDueKind } from './ticketSlaSql';

/**
 * The statements behind `ticket_sla_performance` (#11018). Each carries the
 * explicit org predicate; RLS is the backstop, not the fence.
 */

type Window = { start: Date; end: Date };

const COMPLETED_COLUMN: Record<SlaDueKind, SQL> = {
  response: sql.raw('t.first_response_at'),
  resolution: sql.raw('t.resolved_at'),
};

const TARGET_COLUMN: Record<SlaDueKind, SQL> = {
  response: sql.raw('t.response_sla_minutes'),
  resolution: sql.raw('t.resolution_sla_minutes'),
};

/**
 * Selects the subject only when the definition opted in, so a report without
 * `includeSubjects` never reads it, rather than reading it and nulling it later:
 * a delivered run is visible to every portal user of the org (D5).
 */
function decidedArm(kind: SlaDueKind, orgId: string, includeSubjects: boolean): SQL {
  const completed = COMPLETED_COLUMN[kind];
  const target = TARGET_COLUMN[kind];
  const due = effectiveDueSql(kind, 't');
  const subject = includeSubjects ? sql`t.subject AS subject` : sql`NULL::text AS subject`;
  return sql`
      SELECT
        t.id, t.ticket_number, ${subject}, t.priority,
        ${sql.raw(`'${kind}'::text`)} AS target,
        ${target} AS target_minutes,
        t.created_at,
        ${due} AS due_at,
        ${completed} AS completed_at,
        LEAST(${completed}, ${due}) AS decided_at,
        ${completed} IS NOT NULL AND ${completed} <= ${due} AS met,
        t.sla_calendar_revision_id AS calendar_revision_id
      FROM tickets t
      WHERE ${slaTicketEligibilitySql('t')}
        AND ${target} IS NOT NULL
        AND t.org_id = ${orgId}`;
}

/**
 * One row per (ticket, target) whose outcome was DECIDED in `[start, end)` (D2):
 * `decided_at = LEAST(completed, due)`, and LEAST ignores NULL, so an unanswered
 * target is decided at its due time. Consecutive periods therefore partition
 * every decided outcome exactly once.
 */
export function decidedTargetsQuery(orgId: string, window: Window, includeSubjects: boolean): SQL {
  return sql`
    SELECT
      d.id::text AS ticket_id, d.ticket_number, d.subject,
      d.priority::text AS priority, d.target, d.target_minutes,
      ${isoInstantSql(sql`d.created_at`)} AS created_at,
      ${isoInstantSql(sql`d.due_at`)} AS due_at,
      ${isoInstantSql(sql`d.completed_at`)} AS completed_at,
      d.met,
      d.calendar_revision_id::text AS calendar_revision_id
    FROM (${decidedArm('response', orgId, includeSubjects)}
      UNION ALL${decidedArm('resolution', orgId, includeSubjects)}
    ) d
    WHERE d.decided_at >= ${sqlTimestamp(window.start)} AND d.decided_at < ${sqlTimestamp(window.end)}
    ORDER BY d.due_at, d.id, d.target`;
}

/** Tickets created in the period, per priority: a volume figure, never a denominator. */
export function openedCountsQuery(orgId: string, period: Window): SQL {
  return sql`
    SELECT
      t.priority::text AS priority,
      COUNT(*)::int AS opened,
      COUNT(*) FILTER (WHERE t.response_sla_minutes IS NULL AND t.resolution_sla_minutes IS NULL)::int AS without_target
    FROM tickets t
    WHERE ${slaTicketEligibilitySql('t')}
      AND t.org_id = ${orgId}
      AND t.created_at >= ${sqlTimestamp(period.start)} AND t.created_at < ${sqlTimestamp(period.end)}
    GROUP BY t.priority`;
}

export function orgNameQuery(orgId: string): SQL {
  return sql`SELECT name FROM organizations WHERE id = ${orgId}`;
}
