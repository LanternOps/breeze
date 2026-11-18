/**
 * Wisp nudge preferences: option lists and copy. Every decision the
 * `.tsx` rows make lives here so it is testable in the node environment.
 */

type CadenceMinutes = 60 | 240 | 1440;
type QuietOverride = 'never' | 'urgent_only';
type BriefOption = 'off' | '07:00' | '08:00' | '09:00';
type Proactivity = 'quiet' | 'normal' | 'chatty';

export const WISP_OFFLINE_HINT = 'Offline — reconnect to change';

export const DIGEST_CADENCE_OPTIONS: ReadonlyArray<{ value: CadenceMinutes; label: string }> = [
  { value: 60, label: 'Hourly' },
  { value: 240, label: 'Every 4 hours' },
  { value: 1440, label: 'Daily' },
];

/** Nearest option by absolute difference; ties go to the larger; non-finite -> 4 hours. */
export function cadenceValueFor(minutes: number): CadenceMinutes {
  if (!Number.isFinite(minutes)) return 240;
  let best = DIGEST_CADENCE_OPTIONS[0].value;
  let bestDiff = Math.abs(minutes - best);
  for (const { value } of DIGEST_CADENCE_OPTIONS) {
    const diff = Math.abs(minutes - value);
    if (diff <= bestDiff) {
      best = value;
      bestDiff = diff;
    }
  }
  return best;
}

export const QUIET_OVERRIDE_OPTIONS: ReadonlyArray<{ value: QuietOverride; label: string }> = [
  { value: 'never', label: 'Respect' },
  { value: 'urgent_only', label: 'Urgent only' },
];

export function quietOverrideDescription(v: QuietOverride): string {
  return v === 'urgent_only'
    ? 'Only concerns your partner marked urgent break through quiet hours.'
    : 'Quiet hours always win; nothing breaks through.';
}

export const BRIEF_TIME_OPTIONS: ReadonlyArray<{ value: BriefOption; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: '07:00', label: '7:00' },
  { value: '08:00', label: '8:00' },
  { value: '09:00', label: '9:00' },
];

/** null -> 'off'; exact option -> itself; any other HH:MM (set elsewhere) -> null (custom). */
export function briefOptionFor(briefTimeLocal: string | null): BriefOption | null {
  if (briefTimeLocal === null) return 'off';
  const match = BRIEF_TIME_OPTIONS.find((o) => o.value !== 'off' && o.value === briefTimeLocal);
  return match ? match.value : null;
}

export function briefTimeFromOption(v: BriefOption): string | null {
  return v === 'off' ? null : v;
}

export const PROACTIVITY_OPTIONS: ReadonlyArray<{ value: Proactivity; label: string }> = [
  { value: 'quiet', label: 'Quiet' },
  { value: 'normal', label: 'Normal' },
  { value: 'chatty', label: 'Chatty' },
];

export function proactivityDescription(v: Proactivity): string {
  switch (v) {
    case 'quiet':
      return 'Push only high-severity concerns. Approval cards and the morning brief always push.';
    case 'normal':
      return 'Push medium-severity concerns and above. Approval cards and the morning brief always push.';
    case 'chatty':
      return 'Push every concern. Approval cards and the morning brief always push.';
  }
}
