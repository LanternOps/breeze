/**
 * Whether a logged time entry is long enough to carry the "long entry" flag
 * on the week list.
 *
 * Pure module so the rule is unit-testable without the app's component test
 * runtime (see timerBarLogic.ts for the same pattern). Shares its threshold
 * with the running-timer warning (#5115) — a timer that trips that warning
 * while running should still read as flagged once it lands as a logged
 * entry here.
 */
import { LONG_RUNNING_TIMER_WARNING_SECONDS } from '../../components/timerBarLogic';

export const LONG_ENTRY_WARNING_MINUTES = LONG_RUNNING_TIMER_WARNING_SECONDS / 60;

export function isLongEntry(durationMinutes: number | null | undefined): boolean {
  return typeof durationMinutes === 'number' && durationMinutes >= LONG_ENTRY_WARNING_MINUTES;
}
