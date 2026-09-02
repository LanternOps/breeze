import type { TimeSuggestion } from '../../services/timeSuggestions';

/**
 * W06 (#3900). Every testable decision in the suggestions UI lives here.
 *
 * `apps/mobile/vitest.config.ts` includes `src/**\/*.test.ts` and deliberately
 * excludes `.tsx`, so logic left in a component is logic that is never tested.
 * The screens below are therefore thin: they call these functions and render.
 */

/** The zone is a parameter, never `process.env.TZ`: a vitest worker does not re-read TZ. */
function hhmm(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone,
  }).format(new Date(iso));
}

/**
 * What the window was spent on. A merged window covering several sessions is
 * labelled by its count — naming one of two types would misdescribe the other.
 */
function activityLabel(suggestion: TimeSuggestion): string | null {
  if (suggestion.signals.length > 1) return `${suggestion.signals.length} sessions`;
  return suggestion.signals[0]?.type ?? null;
}

/**
 * Where the work happened. F12: a Quick Support device row is purged after the
 * session, so `device` can be null on a perfectly valid suggestion — falling
 * through to the attribution label (and then the org) is what keeps the row
 * from rendering a blank segment the technician cannot identify.
 */
function whereLabel(suggestion: TimeSuggestion): string | null {
  return (
    suggestion.device?.hostname ??
    suggestion.quickSupport?.attributionLabel ??
    suggestion.quickSupport?.attributedOrgName ??
    suggestion.org?.name ??
    null
  );
}

export function rowSummary(suggestion: TimeSuggestion, timeZone: string): string {
  const parts: string[] = [];

  // An unreliable session has no trustworthy end, so it claims no duration —
  // showing one would invite the technician to bill a number nobody measured.
  if (suggestion.durationMinutes !== null) parts.push(`${suggestion.durationMinutes} min`);

  const activity = activityLabel(suggestion);
  if (activity !== null) parts.push(activity);

  const where = whereLabel(suggestion);
  if (where !== null) parts.push(where);

  const start = hhmm(suggestion.startedAt, timeZone);
  parts.push(
    suggestion.endedAt === null ? `from ${start}` : `${start}–${hhmm(suggestion.endedAt, timeZone)}`
  );

  return parts.join(' · ');
}

const PRECISION_LABELS: Record<string, string> = {
  exact: 'Recorded',
  approximate: 'Approximate',
  unreliable: 'Needs a time',
};

/** Null for an unrecognised precision — better no chip than a raw schema token. */
export function precisionChip(precision: string): string | null {
  return PRECISION_LABELS[precision] ?? null;
}

const TICKET_REASONS: Record<string, string> = {
  closed_by_you: 'closed by you',
  assigned_to_you: 'assigned to you',
};

/**
 * The reason is part of the label on purpose: the technician has to be able to
 * see WHY this ticket was guessed before accepting it, because a wrong pick
 * moves the entry to another organization — and another currency.
 */
export function ticketChipLabel(suggestion: TimeSuggestion): string {
  const candidate = suggestion.candidateTicket;
  if (candidate === null) return 'Add a ticket';
  const reason = TICKET_REASONS[candidate.reason];
  return reason === undefined ? candidate.ticketNumber : `${candidate.ticketNumber} · ${reason}`;
}

/** F19: only a non-zero residual is worth a note; 0 is the normal case. */
export function alreadyLoggedNote(minutes: number): string | null {
  if (minutes <= 0) return null;
  return `${minutes} min of this window is already on your timesheet`;
}

export function entryPointVisible(input: { enabled: boolean; count: number }): boolean {
  return input.enabled && input.count > 0;
}

export function bannerLabel(count: number): string {
  return `${count} unlogged session${count === 1 ? '' : 's'} today`;
}

export function confirmToast(suggestion: TimeSuggestion): string {
  const minutes = suggestion.durationMinutes;
  const ticket = suggestion.candidateTicket?.ticketNumber ?? null;
  if (minutes === null) return 'Logged this session';
  return ticket === null ? `Logged ${minutes} min` : `Logged ${minutes} min to ${ticket}`;
}
