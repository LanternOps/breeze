/**
 * The staff list/detail payload field slaBusinessMinutesRemaining (#8973 W4,
 * spec §4.3 readers 5–6).
 */
import type { Database } from '../../db';
import { loadTicketCalendars, slaBusinessMinutesRemaining, type TicketCalendar } from '../ticketSlaDeadlines';

type RemainingSource = {
  slaCalendarRevisionId?: string | null;
  firstResponseAt: Date | string | null;
  resolvedAt?: Date | string | null;
  slaBreachReason: string | null;
  responseDueAt: Date | string | null;
  resolutionDueAt: Date | string | null;
};

const asDate = (v: Date | string | null | undefined): Date | null => (v == null ? null : v instanceof Date ? v : new Date(v));

/**
 * The staff list/detail payload field: each row gains
 * `slaBusinessMinutesRemaining`, non-null only when the row carries a
 * calendar revision. The page's calendars load in ONE query per distinct
 * revision set (loadTicketCalendars) — no per-row read. A revision the
 * reader cannot load reads null (display only; never a wall-clock guess).
 */
export async function withBusinessMinutesRemaining<T extends RemainingSource>(
  db: Pick<Database, 'execute'>,
  rows: readonly T[],
  now: Date = new Date(),
): Promise<Array<T & { slaBusinessMinutesRemaining: ReturnType<typeof slaBusinessMinutesRemaining> }>> {
  const revisionIds = rows.map((r) => r.slaCalendarRevisionId ?? null);
  const calendars = revisionIds.some(Boolean) ? await loadTicketCalendars(db, revisionIds) : new Map<string, NonNullable<TicketCalendar>>();
  return rows.map((row) => {
    const calendar = row.slaCalendarRevisionId ? calendars.get(row.slaCalendarRevisionId) ?? null : null;
    return {
      ...row,
      slaBusinessMinutesRemaining: slaBusinessMinutesRemaining(
        { firstResponseAt: asDate(row.firstResponseAt), resolvedAt: asDate(row.resolvedAt ?? null), slaBreachReason: row.slaBreachReason },
        { responseDueAt: asDate(row.responseDueAt), resolutionDueAt: asDate(row.resolutionDueAt) },
        calendar,
        now,
      ),
    };
  });
}
