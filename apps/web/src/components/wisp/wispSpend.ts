// Wisp W06 (web) Task 15: pure rules behind the spend meter (w00 A32) and the
// pause / resume controls (w00 A29). The server stays the authority — these
// only decide what the header shows and which button is live.
import type { WispGrantStatus } from '@/stores/aiStore';

export type SpendMeterState = 'ok' | 'warn' | 'exhausted';

/** Amber from 80 % of the day's budget, exhausted at 100 %. A zero budget admits nothing, so it reads exhausted. */
export function spendMeterState(spentCents: number, budgetCents: number): SpendMeterState {
  if (budgetCents <= 0 || spentCents >= budgetCents) return 'exhausted';
  return spentCents >= budgetCents * 0.8 ? 'warn' : 'ok';
}

/** Whole hours (rounded up) until `iso`; 0 once it has passed; null when unparseable. */
export function hoursUntil(iso: string, now: Date = new Date()): number | null {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now.getTime()) / 3_600_000));
}

/** Pausing never widens anything, so any active grant may be paused by its grantor. */
export function canPause(status: WispGrantStatus): boolean {
  return status === 'active';
}

/**
 * Only a user pause is the user's to lift: system reasons (entitlement,
 * grantor access, …) resume through their own reconcilers, and the server
 * refuses the rest with 409 `NOT_USER_PAUSED`.
 */
export function canResume(status: WispGrantStatus, pausedReason: string | null | undefined): boolean {
  return status === 'paused' && pausedReason === 'user_paused';
}
