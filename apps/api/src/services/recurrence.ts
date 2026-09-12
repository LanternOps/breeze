import { addMonthsClamped, addDaysISO } from './contractMath';

export type Cadence = 'monthly' | 'quarterly' | 'semiannual' | 'annual' | 'one_time';

const MONTHS: Record<Exclude<Cadence, 'one_time'>, number> = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };

export function cadenceMonths(cadence: Cadence): number | null {
  return cadence === 'one_time' ? null : MONTHS[cadence];
}

export function nthDueDate(anchorDueDate: string, cadence: Cadence, n: number): string | null {
  if (n < 0) throw new RangeError('n must be >= 0');
  const months = cadenceMonths(cadence);
  if (months === null) return n === 0 ? anchorDueDate : null;
  // Always step from the anchor (not from the previous clamped date) so a 31st anchor
  // returns to the 31st in long months instead of drifting to the 28th forever.
  return addMonthsClamped(anchorDueDate, months * n);
}

function isLastDayOfMonth(iso: string): boolean {
  return addDaysISO(iso, 1).slice(0, 7) !== iso.slice(0, 7);
}

function endOfMonth(iso: string): string {
  return addDaysISO(addMonthsClamped(`${iso.slice(0, 7)}-01`, 1), -1);
}

/**
 * The covered period ends on the due date and starts the day after the previous due date.
 * A month-end due date steps back to the previous cadence's month end (not a clamped day
 * number), so quarterly 06-30 covers 04-01..06-30 and monthly 03-31 covers 03-01..03-31,
 * and successive periods of a clamped 31st anchor stay contiguous.
 */
export function coveredPeriod(dueAt: string, cadence: Cadence): { periodStart: string; periodEnd: string } {
  const months = cadenceMonths(cadence);
  if (months === null) return { periodStart: dueAt, periodEnd: dueAt };
  const stepped = addMonthsClamped(dueAt, -months);
  const previousDue = isLastDayOfMonth(dueAt) ? endOfMonth(stepped) : stepped;
  return { periodStart: addDaysISO(previousDue, 1), periodEnd: dueAt };
}

export function isInLeadWindow(dueAt: string, leadDays: number, today: string): boolean {
  return addDaysISO(dueAt, -leadDays) <= today;
}

export function isPastGrace(dueAt: string, graceDays: number, today: string): boolean {
  return addDaysISO(dueAt, graceDays) < today;
}

export interface PlanInput {
  anchorDueDate: string; cadence: Cadence; effectiveFrom: string; effectiveUntil: string | null;
  leadDays: number; graceDays: number; today: string; existingDueDates: readonly string[]; cap?: number;
}
export interface PlannedOccurrence { periodStart: string; periodEnd: string; dueAt: string; initialStatus: 'scheduled' | 'missed' }

/** Every due date d with effectiveFrom ≤ d ≤ effectiveUntil, d − leadDays ≤ today, not yet materialized; oldest first; capped. */
export function planOccurrences(input: PlanInput): PlannedOccurrence[] {
  const cap = input.cap ?? 12;
  const existing = new Set(input.existingDueDates);
  const out: PlannedOccurrence[] = [];
  for (let n = 0; out.length < cap; n++) {
    const due = nthDueDate(input.anchorDueDate, input.cadence, n);
    if (due === null) break;
    if (!isInLeadWindow(due, input.leadDays, input.today)) break;
    if (input.effectiveUntil !== null && due > input.effectiveUntil) break;
    if (due < input.effectiveFrom || existing.has(due)) continue;
    out.push({ ...coveredPeriod(due, input.cadence), dueAt: due, initialStatus: isPastGrace(due, input.graceDays, input.today) ? 'missed' : 'scheduled' });
  }
  return out;
}

/**
 * The `anchor_due_date` a deliverable gets when a template item is applied from
 * `effectiveFrom` (spec §4.6: "end of the first full period after
 * effective_from").
 *
 * anchor = effectiveFrom + cadence months − 1 day, so coveredPeriod(anchor)
 * begins exactly on effectiveFrom. `one_time` has no period, so its single
 * obligation is due on the day the schedule starts.
 *
 * Month-end caveat (deliberate): addMonthsClamped is not invertible around
 * short months, so an effectiveFrom of 2026-02-01 yields 2026-02-28 whose
 * coveredPeriod starts 2026-01-29 — three days early. Advancing a whole cadence
 * step to avoid that would skip February and delay the first deliverable by a
 * month, which is the worse error. The anchor names the period END, which is
 * what the sweep and the customer key on.
 */
export function firstAnchorAfter(effectiveFrom: string, cadence: Cadence): string {
  const months = cadenceMonths(cadence);
  if (months === null) return effectiveFrom;
  return addDaysISO(addMonthsClamped(effectiveFrom, months), -1);
}
