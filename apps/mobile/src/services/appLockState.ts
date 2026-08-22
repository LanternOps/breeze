/**
 * Cold-launch half of the app lock (see navigation/AppLockGate.tsx).
 *
 * `AppLockGate` only ever saw background → foreground transitions *within one
 * process*. A cold launch — the technician swiping the app out of the switcher,
 * or iOS reaping it under memory pressure — restored the session straight from
 * the keychain with no challenge, because `services/auth.ts storeToken`
 * persisted the token without `requireAuthentication` and nothing gated the
 * restore in `navigation/RootNavigator.tsx checkAuth`.
 *
 * That made the same user gesture ("close the app, open it again") lock or not
 * lock depending on whether iOS happened to keep the process alive, which reads
 * as a flaky regression rather than the design gap it was.
 *
 * This module is the pure half: the record's shape, its parser, and the
 * cold-launch decision. `appLockStore.ts` performs the keychain I/O and
 * `appLockMachine.ts` owns the rest of the decisions. It deliberately imports
 * nothing — not expo-secure-store, not Sentry — so the security-critical logic
 * stays reachable from the node-only vitest runtime.
 *
 * Everything here is **fail-secure** — an absent, malformed, or
 * unreadable record locks. The only cost of a false lock is one Face ID prompt;
 * the cost of a false unlock is an unauthenticated stranger holding a console
 * for someone else's fleet.
 */
export const APP_LOCK_STATE_KEY = 'breeze.applock.state.v1';

/**
 * How long the app may sit outside the foreground before it locks. Short enough
 * that a phone left on a desk locks, long enough that hopping to the
 * authenticator app or a password manager and straight back does not demand
 * Face ID.
 *
 * Lives here rather than in `AppLockGate.tsx` so the decision logic can be
 * unit-tested without pulling React Native into the node-only vitest runtime.
 */
export const LOCK_GRACE_MS = 60_000;

export interface AppLockState {
  /**
   * `Date.now()` at the last lifecycle transition or authentication event —
   * the most recent moment the session was provably live. Note this is NOT
   * specifically the departure from `active`: `appLockMachine` also re-stamps
   * on resume, on unlock, and on interactive sign-in.
   */
  stampedAt: number;
  /**
   * Whether the app was locked at that moment. Exists solely so that
   * force-quitting *at* the lock screen and relaunching is not an unlock.
   */
  locked: boolean;
}

/**
 * Parse a persisted record, returning null for anything we did not write.
 *
 * Deliberately strict about the fields it knows: a truncated write or a
 * hand-forged value collapses to null, which {@link shouldLockOnLaunch} treats
 * as "lock". Being lenient here would let a tampered keychain item unlock the
 * app. Unknown extra keys are ignored — schema changes are handled by bumping
 * {@link APP_LOCK_STATE_KEY}, not here, and a v2 reader simply finds nothing
 * under its own key and locks.
 */
export function parseAppLockState(raw: string | null): AppLockState | null {
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const { stampedAt, locked } = parsed as Record<string, unknown>;

  if (typeof stampedAt !== 'number' || !Number.isFinite(stampedAt)) return null;
  if (typeof locked !== 'boolean') return null;

  return { stampedAt, locked };
}

/**
 * Decide whether a cold launch that restores a session must show the lock.
 *
 * Pure so the whole truth table is testable. Returns true when:
 *  - there is no record at all (first launch after this shipped, a failed
 *    write, a wiped keychain) — we cannot prove the app was recently in use;
 *  - the app was already locked when the record was written, so force-quitting
 *    at the lock screen and relaunching must not be an unlock;
 *  - more than `graceMs` has elapsed, matching the in-process rule;
 *  - the elapsed time is not a finite number;
 *  - the clock moved backwards since the record was written, which is both a
 *    tampering signal and a case where the elapsed-time test is meaningless.
 *
 * `graceMs` is defaulted so the production call site passes two arguments of
 * incompatible meaning and cannot silently transpose them.
 */
export function shouldLockOnLaunch(
  record: AppLockState | null,
  nowMs: number,
  graceMs: number = LOCK_GRACE_MS
): boolean {
  if (record === null) return true;
  if (record.locked) return true;

  const elapsed = nowMs - record.stampedAt;
  if (!Number.isFinite(elapsed) || elapsed < 0) return true;

  return elapsed >= graceMs;
}
