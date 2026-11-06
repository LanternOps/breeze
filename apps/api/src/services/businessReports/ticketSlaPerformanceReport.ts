import {
  emptyTicketSlaPerformanceSummary,
  TICKET_SLA_BREACH_CAP,
  type SlaPriority,
  type SlaTargetKind,
  type TicketSlaPerformanceSummary,
} from '@breeze/shared';
import { db } from '../../db';
import { ticketSlaPerformanceConfigSchema } from '../reportConfigSchemas';
import type { EvidenceRunContext, ReportResult } from '../reportGenerationService';
import { reportOwnerOfScope, runInReportScope, type ReportScope } from '../reportScope';
import type { ReportGenerationAuthority } from '../siteScope';
import { loadTicketCalendars } from '../ticketSlaDeadlines';
import { rowsOf, SITE_RESTRICTED_NOTE } from './common';
import { resolveReportOwnerTimezone, resolveReportPeriod } from './period';
import { foldPerformance, type DecidedTarget } from './ticketSlaPerformanceMath';
import { decidedTargetsQuery, openedCountsQuery, orgNameQuery } from './ticketSlaPerformanceQueries';

/**
 * Customer SLA performance (`ticket_sla_performance`, #11018). The customer-safe
 * sibling of `ticket_sla_attainment`: one org and period, per priority, counted
 * in the period each outcome was DECIDED rather than by ticket creation date, and
 * timed on the SLA clock. It shares that report's eligibility and due SQL, so
 * the two cannot drift on which tickets count or when they were due.
 *
 * Tenancy: every statement carries the explicit org predicate and all of them
 * run inside ONE `runInReportScope`.
 */

const NOTES = [
  'Response and resolution are counted in the period their outcome was decided: when the ticket was answered or resolved on time, or when its deadline passed. Consecutive reports therefore count each outcome once.',
  '"Tickets opened" counts tickets created in the period; it is a volume figure and is not the denominator of any percentage.',
  "Times are measured on each ticket's SLA clock — its business hours, excluding time the SLA was paused — the same clock its target uses.",
  'The SLA target shown for a priority is the most common target agreed on its tickets; "varies" means tickets in that priority carried different targets.',
  'Tickets with no SLA target are counted but not timed or included in percentages.',
  'Planned work and tickets merged into another ticket are excluded.',
  'A report reflects ticket state when it was generated; a ticket reopened later is measured again in a later report.',
];

type DecidedRow = {
  ticket_id: string;
  ticket_number: string;
  subject: string | null;
  priority: SlaPriority;
  target: SlaTargetKind;
  target_minutes: number;
  created_at: string;
  due_at: string;
  completed_at: string | null;
  met: boolean;
  calendar_revision_id: string | null;
};
type OpenedRow = { priority: SlaPriority; opened: number; without_target: number };

function toDecidedTarget(r: DecidedRow): DecidedTarget {
  return {
    ticketId: r.ticket_id,
    ticketNumber: r.ticket_number,
    subject: r.subject ?? null,
    priority: r.priority,
    target: r.target,
    targetMinutes: Number(r.target_minutes),
    createdAt: new Date(r.created_at),
    dueAt: new Date(r.due_at),
    completedAt: r.completed_at ? new Date(r.completed_at) : null,
    met: r.met === true,
    calendarRevisionId: r.calendar_revision_id ?? null,
  };
}

/** A calendar date in the owner's timezone, so the printed day matches the period's. */
function dateInZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant);
}

export async function generateTicketSlaPerformanceReport(
  scope: ReportScope,
  rawConfig: Record<string, unknown>,
  authority: ReportGenerationAuthority,
  evidence?: EvidenceRunContext,
): Promise<ReportResult> {
  // Parse BEFORE any query: a stored config the type rejects never runs.
  const config = ticketSlaPerformanceConfigSchema.parse(rawConfig ?? {});
  if (scope.kind !== 'organization') {
    throw new Error(`ticket_sla_performance requires an organization scope, got ${scope.kind}`);
  }
  const orgId = scope.orgId;
  const includeSubjects = config.includeSubjects ?? false;
  const generatedAt = evidence ? new Date(evidence.generatedAt) : new Date();

  // Tickets have no site axis, so a restricted authority has no filter to apply:
  // nothing is queried. No rows either, because a CSV of zeros would read as "no
  // tickets"; the summary keeps its shape so the PDF can print the reason.
  if (authority.scope.kind === 'restricted') {
    return {
      rows: [],
      rowCount: 0,
      generatedAt: generatedAt.toISOString(),
      summary: {
        ...emptyTicketSlaPerformanceSummary(SITE_RESTRICTED_NOTE),
        generatedAt: generatedAt.toISOString(),
        org: { orgId, orgName: null },
      } as unknown as Record<string, unknown>,
    };
  }

  return runInReportScope(scope, async () => {
    const timeZone = await resolveReportOwnerTimezone(reportOwnerOfScope(scope));
    // The occurrence's period is the contract of an evidence run, whatever the
    // definition's config says: a re-run of a late occurrence must report the
    // same month (#5784 OD-11). Its end date is inclusive, like a custom period's.
    const period = resolveReportPeriod(
      evidence
        ? { kind: 'custom', start: evidence.periodStart, end: evidence.periodEnd }
        : config.period ?? { kind: 'last_full_month' },
      timeZone,
      generatedAt,
    );
    // Clipped so a run during its own period counts nothing it could not know;
    // whatever is decided later falls to the re-run or the next report.
    const windowEnd = new Date(Math.min(period.end.getTime(), generatedAt.getTime()));

    const openedRows = rowsOf<OpenedRow>(await db.execute(openedCountsQuery(orgId, period)));
    const decidedRows = rowsOf<DecidedRow>(
      await db.execute(decidedTargetsQuery(orgId, { start: period.start, end: windowEnd }, includeSubjects)),
    );
    const [orgRow] = rowsOf<{ name: string | null }>(await db.execute(orgNameQuery(orgId)));

    const decided = decidedRows.map(toDecidedTarget);
    const calendars = await loadTicketCalendars(
      db,
      [...new Set(decided.map((d) => d.calendarRevisionId).filter((id): id is string => id !== null))],
    );
    const fold = foldPerformance(
      decided,
      openedRows.map((r) => ({
        priority: r.priority,
        opened: Number(r.opened),
        withoutTarget: Number(r.without_target),
      })),
      calendars,
    );

    const notes = [...NOTES];
    // Generation runs on the due day, which is the period's last day. Whatever is
    // decided later that day falls outside this run and before the next period,
    // so the artifact says where it stopped. A late run reached the period's end
    // and has nothing to disclose.
    if (evidence && windowEnd.getTime() < period.end.getTime()) {
      notes.push(`This service report was generated on ${dateInZone(generatedAt, period.timeZone)} and covers outcomes decided through that time.`);
    }
    if (fold.unmeasuredDurations > 0) {
      notes.push(`${fold.unmeasuredDurations} outcome(s) are included in the percentages but not in the times because their business-hours calendar could not be read.`);
    }
    if (period.timeZoneNote) notes.push(period.timeZoneNote);

    const stored = fold.breaches.slice(0, TICKET_SLA_BREACH_CAP);
    const summary: TicketSlaPerformanceSummary = {
      generatedAt: generatedAt.toISOString(),
      period: {
        kind: period.kind,
        start: period.start.toISOString(),
        end: period.end.toISOString(),
        label: period.label,
        timeZone: period.timeZone,
        measuredThrough: windowEnd.toISOString(),
      },
      org: { orgId, orgName: orgRow?.name ?? null },
      overall: fold.overall,
      priorities: fold.priorities,
      breaches: {
        cap: TICKET_SLA_BREACH_CAP,
        stored: stored.length,
        available: fold.breaches.length,
        truncated: fold.breaches.length > stored.length,
        rows: stored,
      },
      unmeasuredDurations: fold.unmeasuredDurations,
      includeSubjects,
      notes,
      rows: fold.priorities,
    };
    return {
      rows: fold.priorities as unknown as Record<string, unknown>[],
      rowCount: fold.priorities.length,
      generatedAt: summary.generatedAt,
      summary: summary as unknown as Record<string, unknown>,
    };
  });
}
