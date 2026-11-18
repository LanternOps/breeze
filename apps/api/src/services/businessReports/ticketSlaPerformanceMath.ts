import {
  businessMinutesBetween,
  SLA_PRIORITIES,
  zeroTicketSlaPerformanceRow,
  type SlaPriority,
  type SlaTargetKind,
  type SlaTargetSummary,
  type TicketSlaBreachRow,
  type TicketSlaPerformanceRow,
} from '@breeze/shared';
import type { TicketCalendar } from '../ticketSlaDeadlines';
import { ratio } from './common';

/**
 * Pure folding for `ticket_sla_performance` (#11018 D3, D4). Durations run on
 * the SLA clock: the ticket's business calendar, minus paused time, the same
 * clock its target uses, so "median 3 h against a 4 h target" is comparable.
 */

/** One (ticket, target) whose outcome was decided in the report window. */
export type DecidedTarget = {
  ticketId: string;
  ticketNumber: string;
  subject: string | null;
  priority: SlaPriority;
  target: SlaTargetKind;
  targetMinutes: number;
  createdAt: Date;
  dueAt: Date;
  completedAt: Date | null;
  met: boolean;
  calendarRevisionId: string | null;
};

type OpenedCount = { priority: SlaPriority; opened: number; withoutTarget: number };

/**
 * SLA-clock time from creation to completion, measured back from the stored
 * frozen deadline: the deadline already embeds the calendar and the paused
 * time, so `target ∓ business minutes between completion and due` is exact and
 * needs no pause history. Null when not completed. May be fractional.
 */
export function slaClockElapsedMinutes(
  t: Pick<DecidedTarget, 'targetMinutes' | 'dueAt' | 'completedAt'>,
  calendar: TicketCalendar,
): number | null {
  if (t.completedAt === null) return null;
  const revision = calendar?.revision ?? null;
  const holidays = calendar?.holidays ?? [];
  const elapsed = t.completedAt.getTime() <= t.dueAt.getTime()
    ? t.targetMinutes - businessMinutesBetween(revision, holidays, t.completedAt, t.dueAt)
    : t.targetMinutes + businessMinutesBetween(revision, holidays, t.dueAt, t.completedAt);
  return Math.max(0, elapsed);
}

/** Median and mean in whole minutes; both null for an empty sample. */
export function durationStats(values: readonly number[]): { median: number | null; mean: number | null } {
  if (values.length === 0) return { median: null, mean: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const mean = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
  return { median: Math.round(median), mean: Math.round(mean) };
}

/**
 * The target to print for a group: what was most commonly agreed on its
 * tickets, the smallest on a tie. `varies` when more than one distinct target
 * was measured (a category override, or a mid-period policy change).
 */
export function targetMode(targets: readonly number[]): SlaTargetSummary {
  if (targets.length === 0) return { minutes: null, varies: false };
  const counts = new Map<number, number>();
  for (const t of targets) counts.set(t, (counts.get(t) ?? 0) + 1);
  let minutes = targets[0]!;
  for (const [value, count] of counts) {
    const best = counts.get(minutes)!;
    if (count > best || (count === best && value < minutes)) minutes = value;
  }
  return { minutes, varies: counts.size > 1 };
}

type KindTally = { targets: number[]; elapsed: number[]; met: number; missed: number; missedOpen: number };
type Tally = { response: KindTally; resolution: KindTally };

const emptyKind = (): KindTally => ({ targets: [], elapsed: [], met: 0, missed: 0, missedOpen: 0 });
const emptyTally = (): Tally => ({ response: emptyKind(), resolution: emptyKind() });

function record(tally: KindTally, t: DecidedTarget, elapsed: number | null): void {
  tally.targets.push(t.targetMinutes);
  if (t.met) tally.met += 1;
  else {
    tally.missed += 1;
    if (t.completedAt === null) tally.missedOpen += 1;
  }
  if (elapsed !== null) tally.elapsed.push(elapsed);
}

function toRow(
  priority: TicketSlaPerformanceRow['priority'],
  tally: Tally,
  opened: { opened: number; withoutTarget: number },
): TicketSlaPerformanceRow {
  const response = durationStats(tally.response.elapsed);
  const resolution = durationStats(tally.resolution.elapsed);
  const responseTarget = targetMode(tally.response.targets);
  const resolutionTarget = targetMode(tally.resolution.targets);
  const responseMeasured = tally.response.met + tally.response.missed;
  const resolutionMeasured = tally.resolution.met + tally.resolution.missed;
  return {
    ...zeroTicketSlaPerformanceRow(priority),
    ticketsOpened: opened.opened,
    ticketsWithoutTarget: opened.withoutTarget,
    responseTargetMinutes: responseTarget.minutes,
    responseTargetVaries: responseTarget.varies,
    responseMeasured,
    responseMet: tally.response.met,
    responseMissed: tally.response.missed,
    responseMissedOpen: tally.response.missedOpen,
    responseAttainment: ratio(tally.response.met, responseMeasured),
    responseMedianMinutes: response.median,
    responseMeanMinutes: response.mean,
    responseTimedSample: tally.response.elapsed.length,
    resolutionTargetMinutes: resolutionTarget.minutes,
    resolutionTargetVaries: resolutionTarget.varies,
    resolutionMeasured,
    resolutionMet: tally.resolution.met,
    resolutionMissed: tally.resolution.missed,
    resolutionMissedOpen: tally.resolution.missedOpen,
    resolutionAttainment: ratio(tally.resolution.met, resolutionMeasured),
    resolutionMedianMinutes: resolution.median,
    resolutionMeanMinutes: resolution.mean,
    resolutionTimedSample: tally.resolution.elapsed.length,
  };
}

/**
 * Folds decided targets and opened counts into the report's rows. Overall stats
 * come from the pooled sample, never from averaging the priority rows.
 *
 * A `calendarRevisionId` missing from `calendars` could not be read by the
 * generating context (an org-scope caller may not read a partner-owned
 * calendar). That target still counts for attainment, which comes from stored
 * timestamps, but it is untimed and counted in `unmeasuredDurations`. It never
 * falls back to the wall clock, which would misreport a business-hours target.
 *
 * `breaches` keeps the input order, which the query sets to `due, id, target`.
 */
export function foldPerformance(
  decided: readonly DecidedTarget[],
  opened: readonly OpenedCount[],
  calendars: ReadonlyMap<string, NonNullable<TicketCalendar>>,
): {
  overall: TicketSlaPerformanceRow;
  priorities: TicketSlaPerformanceRow[];
  unmeasuredDurations: number;
  breaches: TicketSlaBreachRow[];
} {
  const byPriority = new Map<SlaPriority, Tally>(SLA_PRIORITIES.map((p) => [p, emptyTally()]));
  const overall = emptyTally();
  const breaches: TicketSlaBreachRow[] = [];
  let unmeasuredDurations = 0;

  for (const t of decided) {
    const unreadable = t.calendarRevisionId !== null && !calendars.has(t.calendarRevisionId);
    const calendar = t.calendarRevisionId === null ? null : calendars.get(t.calendarRevisionId) ?? null;
    const elapsed = unreadable ? null : slaClockElapsedMinutes(t, calendar);
    if (unreadable && t.completedAt !== null) unmeasuredDurations += 1;

    const tally = byPriority.get(t.priority);
    if (tally) record(tally[t.target], t, elapsed);
    record(overall[t.target], t, elapsed);

    if (!t.met) {
      const whole = elapsed === null ? null : Math.round(elapsed);
      breaches.push({
        ticketId: t.ticketId,
        ticketNumber: t.ticketNumber,
        subject: t.subject,
        priority: t.priority,
        target: t.target,
        targetMinutes: t.targetMinutes,
        createdAt: t.createdAt.toISOString(),
        dueAt: t.dueAt.toISOString(),
        completedAt: t.completedAt?.toISOString() ?? null,
        elapsedSlaMinutes: whole,
        overByMinutes: whole === null ? null : whole - t.targetMinutes,
      });
    }
  }

  const openedOf = (priority: SlaPriority) =>
    opened.find((o) => o.priority === priority) ?? { opened: 0, withoutTarget: 0 };
  const totalOpened = SLA_PRIORITIES.reduce(
    (acc, p) => {
      const o = openedOf(p);
      return { opened: acc.opened + o.opened, withoutTarget: acc.withoutTarget + o.withoutTarget };
    },
    { opened: 0, withoutTarget: 0 },
  );

  return {
    overall: toRow('all', overall, totalOpened),
    priorities: SLA_PRIORITIES.map((p) => toRow(p, byPriority.get(p)!, openedOf(p))),
    unmeasuredDurations,
    breaches,
  };
}
