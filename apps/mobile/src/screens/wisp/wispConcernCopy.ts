// Inline English copy + small pure helpers for Wisp concerns (mobile has no i18n).
import type { WispConcern, WispConcernSeverity, WispConcernStatus } from '../../services/wisp';

const SEVERITY_LABELS: Record<WispConcernSeverity, string> = {
  info: 'Info',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

const STATUS_LABELS: Record<WispConcernStatus, string> = {
  open: 'Open',
  snoozed: 'Snoozed',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};

export function severityLabel(s: WispConcernSeverity): string {
  return SEVERITY_LABELS[s];
}

export function statusLabel(s: WispConcernStatus): string {
  return STATUS_LABELS[s];
}

function localNineAm(base: Date, addDays: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + addDays, 9, 0, 0, 0);
}

export function snoozeOptions(now: Date): Array<{ label: string; until: string }> {
  const oneHour = new Date(now.getTime() + 60 * 60 * 1000);
  const tomorrow = localNineAm(now, 1);
  // Days until the next Monday strictly after today (Mon -> 7).
  const daysToMonday = ((8 - now.getDay()) % 7) || 7;
  let monday = localNineAm(now, daysToMonday);
  if (monday.getTime() <= tomorrow.getTime()) monday = localNineAm(now, daysToMonday + 7);
  return [
    { label: '1 hour', until: oneHour.toISOString() },
    { label: 'Tomorrow 9:00', until: tomorrow.toISOString() },
    { label: 'Next Monday 9:00', until: monday.toISOString() },
  ];
}

export function concernActionFailureCopy(status: number | undefined): string {
  return status === 404 || status === 409 ? 'Already handled elsewhere.' : 'Could not update this concern.';
}

export type ConcernFeedbackState = { show: boolean; chosen: 'useful' | 'not_useful' | null; canChange: boolean };

export function concernFeedbackState(c: Pick<WispConcern, 'recipient'>): ConcernFeedbackState {
  const r = c.recipient;
  const chosen = r?.feedback ?? null;
  return { show: r != null && r.nudgeCount > 0, chosen, canChange: chosen === null };
}

export function feedbackFailureCopy(status: number | undefined): string {
  if (status === 409) return 'Feedback already recorded.';
  if (status === 404) return 'Already handled elsewhere.';
  return 'Could not send feedback.';
}
