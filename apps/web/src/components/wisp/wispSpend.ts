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

/**
 * The system pause reasons the header can name (API `SYSTEM_PAUSE_REASONS`,
 * less `partner_disabled`, which has its own line). Anything else the server
 * sends reads as `unknown` — "Paused by Breeze" — rather than nothing (#10106).
 */
const SYSTEM_PAUSE_KINDS = {
  budget_exhausted: 'budget_exhausted',
  grantor_access_lost: 'grantor_access_lost',
  grantor_suspended: 'grantor_suspended',
  factor_expired: 'factor_expired',
  entitlement_lost: 'entitlement_lost',
} as const;

export type SystemPauseKind = (typeof SYSTEM_PAUSE_KINDS)[keyof typeof SYSTEM_PAUSE_KINDS] | 'unknown';

/**
 * Which reason line a system-paused grant shows. Null when there is no system
 * reason to name: not paused, a user pause, a partner switch (own line), or a
 * reason still being looked up (`undefined`).
 */
export function systemPauseKind(status: WispGrantStatus, pausedReason: string | null | undefined): SystemPauseKind | null {
  if (status !== 'paused' || pausedReason === undefined) return null;
  if (pausedReason === 'user_paused' || pausedReason === 'partner_disabled') return null;
  return pausedReason !== null && Object.hasOwn(SYSTEM_PAUSE_KINDS, pausedReason)
    ? SYSTEM_PAUSE_KINDS[pausedReason as keyof typeof SYSTEM_PAUSE_KINDS]
    : 'unknown';
}

/** The day's budget already sits at the plan's ceiling, so raising it cannot help. Unknown ceiling → false. */
export function atBudgetCeiling(budgetCents: number, budgetMax: number | null | undefined): boolean {
  return typeof budgetMax === 'number' && budgetCents >= budgetMax;
}
