/**
 * W06 (#3900) — pure rules for auto-suggested time entries. No DB, no I/O:
 * everything here is unit-tested against fixed instants. The service
 * (timeSuggestionService.ts) feeds it rows and applies its verdicts.
 */
export type SignalPrecision = 'recorded' | 'derived' | 'unreliable';

export const UNRELIABLE_AFTER_MS = 8 * 60 * 60_000;
export const RANGE_TOLERANCE_MS = 15 * 60_000;
export const TICKET_WINDOW_BEFORE_MS = 2 * 60 * 60_000;
export const TICKET_WINDOW_AFTER_MS = 4 * 60 * 60_000;
export const MAX_OTHER_TICKETS = 3;
/** staleCommandReaper writes 'Session timed out: …' on both zombie paths [verified jobs/staleCommandReaper.ts:837,853]. */
export const REAPER_MESSAGE_PREFIX = 'Session timed out';

const OPEN_TICKET_STATUSES = new Set(['new', 'open', 'pending', 'on_hold']);
const CLOSED_LIKE = new Set(['resolved', 'closed']);

// ── day window ───────────────────────────────────────────────────────────────
function tzOffsetMinutes(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const get = (t: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((wall - at.getTime()) / 60_000);
}

function localMidnightUtc(date: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  // Two passes: the offset at the naive guess, then the offset in force at the
  // candidate instant — that is what makes DST transition days come out right.
  const first = guess - tzOffsetMinutes(new Date(guess), tz) * 60_000;
  return new Date(guess - tzOffsetMinutes(new Date(first), tz) * 60_000);
}

/** Local midnight → next local midnight of `date` (YYYY-MM-DD) in `tz`, as UTC instants. */
export function dayWindowUtc(date: string, tz: string): { start: Date; end: Date } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { start: localMidnightUtc(date, tz), end: localMidnightUtc(next, tz) };
}

// ── precision ────────────────────────────────────────────────────────────────
export function classifySignal(row: {
  startedAt: Date; endedAt: Date; durationSeconds: number | null; errorMessage: string | null;
}): { precision: SignalPrecision; durationSeconds: number | null } {
  // The stale-session reaper stamps ended_at up to 24h after the fact (F7), so
  // its rows can never be trusted for a billable duration — even in the
  // defensive case where some other writer left a duration behind.
  if (row.errorMessage?.startsWith(REAPER_MESSAGE_PREFIX)) return { precision: 'unreliable', durationSeconds: null };
  if (row.durationSeconds != null) return { precision: 'recorded', durationSeconds: row.durationSeconds };
  const derivedMs = row.endedAt.getTime() - row.startedAt.getTime();
  if (derivedMs > UNRELIABLE_AFTER_MS || derivedMs < 0) return { precision: 'unreliable', durationSeconds: null };
  return { precision: 'derived', durationSeconds: Math.round(derivedMs / 1000) };
}

// ── merge ────────────────────────────────────────────────────────────────────
export interface SignalRow {
  id: string;
  type: 'terminal' | 'desktop' | 'file_transfer';
  deviceId: string;
  startedAt: Date;
  endedAt: Date;
  durationSeconds: number | null;
  errorMessage: string | null;
}

/** Consecutive same-device sessions whose gap is <= mergeGapMinutes become one group. Input order is irrelevant. */
export function mergeSignals<T extends SignalRow>(rows: T[], mergeGapMinutes: number): T[][] {
  const sorted = [...rows].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const gapMs = mergeGapMinutes * 60_000;
  const groups: T[][] = [];
  // The gap is measured against the group's running MAX ended_at, never the
  // last row appended. Concurrent sessions on one device (terminal + desktop)
  // mean a short row can follow a long one; comparing against that short row
  // would walk the comparison point backwards and let a session NESTED inside
  // the group's own envelope open a second group — two overlapping suggestions,
  // both confirmable from one loaded list, i.e. double-billed minutes.
  let groupDeviceId: string | null = null;
  let groupEnd = -Infinity;
  for (const row of sorted) {
    const last = groups[groups.length - 1];
    if (last && groupDeviceId === row.deviceId && row.startedAt.getTime() - groupEnd <= gapMs) {
      last.push(row);
      groupEnd = Math.max(groupEnd, row.endedAt.getTime());
    } else {
      groups.push([row]);
      groupDeviceId = row.deviceId;
      groupEnd = row.endedAt.getTime();
    }
  }
  return groups;
}

export function suggestionKey(ids: string[]): string {
  return [...ids].sort().join('+');
}

export function envelopeOf(
  group: Array<SignalRow & { precision: SignalPrecision }>,
): { startedAt: Date; endedAt: Date | null; durationMinutes: number | null } {
  const startedAt = new Date(Math.min(...group.map((s) => s.startedAt.getTime())));
  if (group.some((s) => s.precision === 'unreliable')) return { startedAt, endedAt: null, durationMinutes: null };
  const endedAt = new Date(Math.max(...group.map((s) => s.endedAt.getTime())));
  return { startedAt, endedAt, durationMinutes: Math.floor((endedAt.getTime() - startedAt.getTime()) / 60_000) };
}

// ── ticket pairing ───────────────────────────────────────────────────────────
export interface TicketCandidateRow {
  id: string;
  ticketNumber: string;
  subject: string;
  status: string;
  orgId: string;
  assignedTo: string | null;
  closedBy: string | null;
  closedAt: Date | null;
  actorStatusChangeAt: Date | null;
  actorStatusChangeTo: string | null;
}

export type TicketCandidateReason = 'closed_by_you' | 'assigned_to_you';

export function rankTicketCandidates<T extends TicketCandidateRow>(
  rows: T[],
  actorId: string,
  envelope: { startedAt: Date; endedAt: Date | null },
): { candidate: (T & { reason: TicketCandidateReason }) | null; otherTickets: T[] } {
  const endMs = (envelope.endedAt ?? new Date(envelope.startedAt.getTime() + UNRELIABLE_AFTER_MS)).getTime();
  const lo = envelope.startedAt.getTime() - TICKET_WINDOW_BEFORE_MS;
  const hi = endMs + TICKET_WINDOW_AFTER_MS;
  const inWindow = (at: Date | null) => at != null && at.getTime() >= lo && at.getTime() <= hi;

  const closedByYou = rows.filter((t) =>
    (t.closedBy === actorId && inWindow(t.closedAt))
    || (t.actorStatusChangeTo != null && CLOSED_LIKE.has(t.actorStatusChangeTo) && inWindow(t.actorStatusChangeAt)));
  const assignedToYou = rows.filter((t) => t.assignedTo === actorId && OPEN_TICKET_STATUSES.has(t.status));

  // Exactly one top candidate is preselected. Two rank-(a) ties preselect
  // NOTHING (F14) — a wrong ticket changes the org and therefore the currency,
  // so ambiguity is surfaced, never guessed.
  let candidate: (T & { reason: TicketCandidateReason }) | null = null;
  if (closedByYou.length === 1) candidate = { ...closedByYou[0]!, reason: 'closed_by_you' };
  else if (closedByYou.length === 0 && assignedToYou.length === 1) candidate = { ...assignedToYou[0]!, reason: 'assigned_to_you' };

  const byRecency = (a: TicketCandidateRow, b: TicketCandidateRow) =>
    (b.closedAt?.getTime() ?? b.actorStatusChangeAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? a.actorStatusChangeAt?.getTime() ?? 0);
  const otherTickets = rows
    .filter((t) => t.id !== candidate?.id)
    .sort(byRecency)
    .slice(0, MAX_OTHER_TICKETS);
  return { candidate, otherTickets };
}

// ── confirm range ────────────────────────────────────────────────────────────
export function validateConfirmRange(
  envelope: { startedAt: Date; endedAt: Date | null },
  input: { startedAt: Date; endedAt?: Date },
): 'ENDED_AT_REQUIRED' | 'RANGE_OUTSIDE_SIGNAL' | null {
  const s0 = envelope.startedAt.getTime();
  if (Math.abs(input.startedAt.getTime() - s0) > RANGE_TOLERANCE_MS) return 'RANGE_OUTSIDE_SIGNAL';
  if (envelope.endedAt == null) {
    if (!input.endedAt) return 'ENDED_AT_REQUIRED';
    if (input.endedAt.getTime() > s0 + UNRELIABLE_AFTER_MS) return 'RANGE_OUTSIDE_SIGNAL';
    return null;
  }
  if (input.endedAt && Math.abs(input.endedAt.getTime() - envelope.endedAt.getTime()) > RANGE_TOLERANCE_MS) return 'RANGE_OUTSIDE_SIGNAL';
  return null;
}

// ── F19: the technician may have logged this work already ────────────────────
// The decisions ledger only records suggestions someone acted on. A hand-typed
// entry, or one produced by /start + /stop, writes NO ledger row — so without
// this second exclusion the same work is offered again and a duplicate billable
// row is one tap away. Drop at >= 80% covered; below that, report the residual
// so a partial overlap is visible in the confirm sheet instead of doubled.
export const ALREADY_LOGGED_DROP_RATIO = 0.8;

export interface LoggedRange { startedAt: Date; endedAt: Date }

/** Sort + union. Entries that overlap EACH OTHER must not be counted twice. */
export function mergeRanges(ranges: LoggedRange[]): LoggedRange[] {
  const sorted = [...ranges]
    .filter((r) => r.endedAt.getTime() > r.startedAt.getTime())
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const out: LoggedRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.startedAt.getTime() <= last.endedAt.getTime()) {
      // `out` holds copies, never the caller's objects — widening the tail here
      // must not mutate the input.
      if (r.endedAt.getTime() > last.endedAt.getTime()) last.endedAt = r.endedAt;
    } else {
      out.push({ startedAt: r.startedAt, endedAt: r.endedAt });
    }
  }
  return out;
}

export function overlapMs(window: { startedAt: Date; endedAt: Date | null }, ranges: LoggedRange[]): number {
  // An unreliable window has no measurable duration; never drop on a guess (F7).
  if (!window.endedAt) return 0;
  const s = window.startedAt.getTime();
  const e = window.endedAt.getTime();
  return mergeRanges(ranges).reduce(
    (sum, r) => sum + Math.max(0, Math.min(e, r.endedAt.getTime()) - Math.max(s, r.startedAt.getTime())),
    0,
  );
}

export function alreadyLoggedVerdict(
  window: { startedAt: Date; endedAt: Date | null },
  ranges: LoggedRange[],
): { overlapMinutes: number; drop: boolean } {
  const ms = overlapMs(window, ranges);
  const windowMs = window.endedAt ? window.endedAt.getTime() - window.startedAt.getTime() : 0;
  return {
    overlapMinutes: Math.round(ms / 60_000),
    // Threshold on milliseconds, round only what is displayed.
    drop: windowMs > 0 && ms / windowMs >= ALREADY_LOGGED_DROP_RATIO,
  };
}
