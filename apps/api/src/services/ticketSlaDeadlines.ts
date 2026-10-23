/**
 * Stored SLA deadlines (#8973 W3, spec §4.3).
 *
 *   due  = add(created_at, target       + sla_paused_business_minutes)
 *   warn = add(created_at, 0.8 * target + sla_paused_business_minutes)
 *
 * `add` is the shared business-time calculator; with no calendar (every
 * ticket until W4) it is plain minute addition and
 * sla_paused_business_minutes equals sla_paused_minutes, which reproduces the
 * pre-W3 wall-clock rule exactly.
 *
 * These pure functions are called at the write points listed in spec §4.3
 * (create, #6691 restamp, explicit override, pause end, first response,
 * reopen), and their output rides the SAME UPDATE statement as the write
 * itself, so a deadline is never written apart from the row change that
 * caused it. Every SLA reader (breach sweep, staff queue, report, portal,
 * web, Partner API) compares against the stored columns instead of
 * re-deriving them.
 *
 * Freeze rule: once a target has an outcome its due/warn never move.
 *   response   — first_response_at set, or 'response' in sla_breach_reason
 *   resolution — resolved_at set, or 'resolution' in sla_breach_reason
 * Reopening clears resolved_at and so unfreezes resolution.
 */
import {
  addBusinessMinutes,
  businessMinutesBetween,
  type CalendarRevision,
  type HolidaySet,
} from '@breeze/shared';
import type { Database } from '../db';
import { SLA_AT_RISK_RATIO, breachedTargets } from './ticketSla';

export type SlaClockRow = {
  createdAt: Date;
  responseSlaMinutes: number | null;
  resolutionSlaMinutes: number | null;
  slaPausedAt: Date | null;
  slaPausedBusinessMinutes: number;
  firstResponseAt: Date | null;
  resolvedAt: Date | null;
  slaBreachReason: string | null;
};

export type SlaDeadlinePatch = Partial<{
  responseDueAt: Date | null;
  responseWarnAt: Date | null;
  resolutionDueAt: Date | null;
  resolutionWarnAt: Date | null;
}>;

/** A ticket's calendar snapshot; null = 24×7 (wall clock). */
export type TicketCalendar = { revision: CalendarRevision; holidays: HolidaySet } | null;

type SlaClockSource = {
  createdAt: Date;
  responseSlaMinutes: number | null;
  resolutionSlaMinutes: number | null;
  slaPausedAt: Date | null;
  slaPausedBusinessMinutes?: number | null;
  firstResponseAt: Date | null;
  resolvedAt: Date | null;
  slaBreachReason: string | null;
};

/** The clock inputs of a `tickets` row (legacy NULL business minutes read as 0). */
export function slaClockRowOf(ticket: SlaClockSource): SlaClockRow {
  return {
    createdAt: ticket.createdAt,
    responseSlaMinutes: ticket.responseSlaMinutes ?? null,
    resolutionSlaMinutes: ticket.resolutionSlaMinutes ?? null,
    slaPausedAt: ticket.slaPausedAt ?? null,
    slaPausedBusinessMinutes: ticket.slaPausedBusinessMinutes ?? 0,
    firstResponseAt: ticket.firstResponseAt ?? null,
    resolvedAt: ticket.resolvedAt ?? null,
    slaBreachReason: ticket.slaBreachReason ?? null,
  };
}

export function isResponseFrozen(row: Pick<SlaClockRow, 'firstResponseAt' | 'slaBreachReason'>): boolean {
  return row.firstResponseAt != null || breachedTargets(row.slaBreachReason).has('response');
}

export function isResolutionFrozen(row: Pick<SlaClockRow, 'resolvedAt' | 'slaBreachReason'>): boolean {
  return row.resolvedAt != null || breachedTargets(row.slaBreachReason).has('resolution');
}

function cal(calendar: TicketCalendar): [CalendarRevision | null, HolidaySet] {
  return calendar ? [calendar.revision, calendar.holidays] : [null, []];
}

function arm(
  row: SlaClockRow,
  calendar: TicketCalendar,
  target: number | null,
  pausedBusinessMinutes: number,
): { due: Date | null; warn: Date | null } {
  if (target == null) return { due: null, warn: null };
  const [revision, holidays] = cal(calendar);
  return {
    due: addBusinessMinutes(revision, holidays, row.createdAt, target + pausedBusinessMinutes),
    warn: addBusinessMinutes(revision, holidays, row.createdAt, SLA_AT_RISK_RATIO * target + pausedBusinessMinutes),
  };
}

/** Due/warn for every UNFROZEN target; frozen arms are absent from the patch. */
export function computeSlaDeadlines(row: SlaClockRow, calendar: TicketCalendar): SlaDeadlinePatch {
  const patch: SlaDeadlinePatch = {};
  if (!isResponseFrozen(row)) {
    const { due, warn } = arm(row, calendar, row.responseSlaMinutes, row.slaPausedBusinessMinutes);
    patch.responseDueAt = due;
    patch.responseWarnAt = warn;
  }
  if (!isResolutionFrozen(row)) {
    const { due, warn } = arm(row, calendar, row.resolutionSlaMinutes, row.slaPausedBusinessMinutes);
    patch.resolutionDueAt = due;
    patch.resolutionWarnAt = warn;
  }
  return patch;
}

/** Whole business minutes of the open pause (floored, matching sla_paused_minutes). */
function openPauseBusinessMinutes(row: SlaClockRow, calendar: TicketCalendar, now: Date): number {
  if (!row.slaPausedAt) return 0;
  const [revision, holidays] = cal(calendar);
  return Math.max(0, Math.floor(businessMinutesBetween(revision, holidays, row.slaPausedAt, now)));
}

/**
 * The persisted accrual when a pause ends (any exit from pending/on_hold,
 * including to resolved/closed). Callers recompute the unfrozen targets from
 * the returned value in the same statement.
 */
export function accruePauseEnd(row: SlaClockRow, calendar: TicketCalendar, now: Date): { slaPausedBusinessMinutes: number } {
  return { slaPausedBusinessMinutes: row.slaPausedBusinessMinutes + openPauseBusinessMinutes(row, calendar, now) };
}

/**
 * The response deadline frozen at the first response. A ticket answered while
 * paused counts the open pause TRANSIENTLY: it is not persisted into
 * sla_paused_business_minutes, which accrues once, when the pause ends —
 * persisting it here would count the same span twice in resolution.
 */
export function freezeResponse(row: SlaClockRow, calendar: TicketCalendar, now: Date): SlaDeadlinePatch {
  if (isResponseFrozen(row)) return {};
  const paused = row.slaPausedBusinessMinutes + openPauseBusinessMinutes(row, calendar, now);
  const { due, warn } = arm(row, calendar, row.responseSlaMinutes, paused);
  return { responseDueAt: due, responseWarnAt: warn };
}

/**
 * The calendar snapshot a ticket's deadlines are computed on. W3 has no
 * calendars, so this is always null (24×7); W4 resolves the revision and its
 * holidays here.
 */
export async function loadTicketCalendar(_db: Database, _revisionId: string | null): Promise<TicketCalendar> {
  return null;
}
