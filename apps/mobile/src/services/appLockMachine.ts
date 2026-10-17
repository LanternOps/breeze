import { type AppLockState, shouldLockOnLaunch } from './appLockState';

/**
 * The app lock as a pure state machine.
 *
 * This logic used to live inline in `navigation/AppLockGate.tsx`. It moved here
 * because the mobile app has no React Native test runtime — `vitest.config.ts`
 * deliberately includes only `.ts`, never `.tsx`, so component code cannot be
 * reached by a test at all. That left the half of the lock that can fail *open*
 * as the only untested half, and it hid a real bypass: a process launched into
 * the background (push wake, iOS prewarm) had no `backgroundedAt`, so its first
 * foregrounding could never lock however long it had been sitting there.
 *
 * Everything that decides whether the lock appears now lives in `reduceLock`,
 * and `AppLockGate` is a thin adapter that forwards events and performs the
 * writes this returns. Keep it that way: logic added back to the component is
 * logic no test can see.
 *
 * The one rule that governs every branch below: **`unlocked` is the only phase
 * a user can be given, and only a proven authentication or a proven-recent
 * record grants it.** Anything unknown, in-flight, or failed stays locked.
 */

/**
 * Mirrors React Native's `AppStateStatus` union, restated so this module pulls
 * no React Native import into the node-only test runtime.
 */
export type AppLifecycle = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';

/**
 * `booting` is distinct from `locked` on purpose: it means the cold-launch
 * decision has not been made yet, so nothing may be *shown* — but for the
 * purpose of what gets written to disk it is treated exactly like `locked`,
 * which is what stops a background-during-boot from stamping the app unlocked.
 */
export type LockPhase = 'booting' | 'locked' | 'unlocked';

export interface LockMachineState {
  phase: LockPhase;
  /** Whether the app-switcher privacy cover should be up. */
  obscured: boolean;
  /**
   * When the app was last provably outside the foreground, or null when it is
   * in the foreground. Seeded at boot from the persisted record so that a
   * process which launched in the background still measures its idle time.
   */
  backgroundedAt: number | null;
  /** Whether the cold-launch check has run. It runs at most once per process. */
  bootDecided: boolean;
  /** The last unlock attempt was rejected — drives the retry copy. */
  unlockFailed: boolean;
  /** The device-security check itself failed, as opposed to reporting none. */
  authUnavailable: boolean;
  /** A sign-out is in flight; the lock stays up until the session is gone. */
  signingOut: boolean;
  /**
   * A system biometric sheet that this app raised (unlock, approve, approval
   * signature) is on screen. See {@link coverFor} for what it changes.
   */
  biometricPrompt: boolean;
}

export type LockEvent =
  /** The persisted record came back from the keychain. */
  | { type: 'bootResolved'; record: AppLockState | null; lifecycle: AppLifecycle; now: number }
  | { type: 'lifecycle'; prev: AppLifecycle; next: AppLifecycle; now: number }
  | { type: 'unlockSucceeded'; now: number }
  | { type: 'unlockRejected' }
  /** The device has no biometrics and no passcode. */
  | { type: 'noAuthenticator' }
  /** The device-security check could not be completed. */
  | { type: 'authenticatorUnavailable' }
  | { type: 'signOutRequested'; now: number }
  /** The session is gone — the login screen is showing. */
  | { type: 'signedOut' }
  /** One of our own biometric prompts went up (`services/biometricPromptState`). */
  | { type: 'biometricPromptStarted' }
  /**
   * Our last biometric prompt settled. `lifecycle` is the app state at that
   * moment, read fresh from React Native.
   */
  | { type: 'biometricPromptEnded'; lifecycle: AppLifecycle };

export interface LockReduction {
  state: LockMachineState;
  /** The record to persist, or null to leave the keychain untouched. */
  persist: AppLockState | null;
}

export const initialLockState: LockMachineState = {
  phase: 'booting',
  obscured: false,
  backgroundedAt: null,
  bootDecided: false,
  unlockFailed: false,
  authUnavailable: false,
  signingOut: false,
  biometricPrompt: false,
};

/**
 * Whether the privacy cover should be up after moving to non-`active`
 * `lifecycle`.
 *
 * Normally any non-`active` state covers: iOS snapshots the UI on the way out
 * to `inactive` to build the app-switcher card and writes that image to disk.
 * The one exception is `inactive` while one of OUR biometric prompts is up —
 * iOS reports `inactive` for the Face ID sheet itself, and covering then
 * flashed the full-screen wordmark on every Approve and Unlock. In that case
 * the cover keeps whatever it already was (an existing cover is never lowered).
 *
 * Accepted trade-off (Todd, 2026-10): if the user swipes to the app switcher
 * while our Face ID sheet is up, iOS may take that one snapshot before the
 * `background` transition lands, and it is uncovered. A real `background`
 * still covers and arms the lock clock as usual — it is a genuine switch-away,
 * prompt or not.
 */
function coverFor(state: LockMachineState, lifecycle: AppLifecycle): boolean {
  if (lifecycle === 'active') return false;
  if (lifecycle === 'inactive' && state.biometricPrompt) return state.obscured;
  return true;
}

/**
 * What to write for a given phase. `booting` persists as locked — see
 * {@link LockPhase} — so the only way a `locked: false` record reaches the
 * keychain is from a phase the user was actually given.
 */
function stamp(phase: LockPhase, now: number): AppLockState {
  return { stampedAt: now, locked: phase !== 'unlocked' };
}

/** The older of two optional timestamps; null only when both are null. */
function earlier(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

export function reduceLock(
  state: LockMachineState,
  event: LockEvent,
  graceMs: number
): LockReduction {
  switch (event.type) {
    case 'bootResolved': {
      // At most once per process. A second session in the same process (sign
      // out, sign back in) is an interactive authentication, not a cold launch.
      if (state.bootDecided) return { state, persist: null };

      const { record, lifecycle, now } = event;
      // A lock already decided by a lifecycle event that landed while the read
      // was in flight must not be undone by the read's own verdict.
      const lock = shouldLockOnLaunch(record, now, graceMs) || state.phase === 'locked';

      // The bypass this seeding closes: a process launched straight into the
      // background never observes an `active` -> `background` transition, so
      // without a seed its `backgroundedAt` stays null and the first tap on the
      // icon finds nothing to measure — opening the fleet however many hours
      // later. Seed from the record so the elapsed test still applies, and take
      // the *older* of the two candidates so a transition already seen in this
      // process cannot shorten the window.
      const seed = lifecycle === 'active' ? null : (record?.stampedAt ?? now);

      return {
        state: {
          ...state,
          bootDecided: true,
          phase: lock ? 'locked' : 'unlocked',
          unlockFailed: false,
          obscured: coverFor(state, lifecycle),
          backgroundedAt: lock ? null : earlier(state.backgroundedAt, seed),
        },
        // Make the lock durable immediately rather than waiting for the next
        // lifecycle event, which a force-quit may never deliver.
        persist: lock ? stamp('locked', now) : null,
      };
    }

    case 'lifecycle': {
      const { prev, next, now } = event;

      if (next === 'active') {
        const since = state.backgroundedAt;
        const lockNow = since !== null && now - since >= graceMs;
        // Never downgrade an existing lock, and never resolve `booting` here —
        // that is `bootResolved`'s job, and until it runs this still persists
        // as locked.
        const phase: LockPhase =
          state.phase === 'locked' || lockNow ? 'locked' : state.phase;

        return {
          state: {
            ...state,
            phase,
            obscured: false,
            backgroundedAt: null,
            unlockFailed: phase === 'locked' && state.phase !== 'locked' ? false : state.unlockFailed,
          },
          // Re-stamp on the way in so a kill later in this session is measured
          // from now rather than from whenever the app last backgrounded.
          persist: stamp(phase, now),
        };
      }

      // Only a real background starts the lock clock. `inactive` is transient
      // (Face ID sheet, Control Centre, call banner) and must not — in
      // particular the unlock prompt itself flips us to `inactive`, so treating
      // that as a lock trigger would make unlocking re-arm the lock.
      const backgroundedAt =
        next === 'background' && prev !== 'background' ? now : state.backgroundedAt;

      return {
        // Cover on `inactive`, not just `background`: iOS snapshots the UI on
        // the way out to build the app-switcher card and writes that image to
        // disk. Except for our own biometric sheet — see `coverFor`.
        state: { ...state, obscured: coverFor(state, next), backgroundedAt },
        // Stamp here too. A force-quit from the app switcher may only ever
        // deliver `inactive`, and this write is fire-and-forget — if iOS
        // suspends us before it lands, the record is simply stale or absent,
        // both of which lock.
        persist: stamp(state.phase, now),
      };
    }

    case 'unlockSucceeded':
      return {
        state: {
          ...state,
          phase: 'unlocked',
          unlockFailed: false,
          authUnavailable: false,
          signingOut: false,
        },
        persist: stamp('unlocked', event.now),
      };

    case 'unlockRejected':
      return { state: { ...state, unlockFailed: true }, persist: null };

    case 'noAuthenticator':
      // A device with neither biometrics nor a passcode cannot satisfy the
      // prompt, and locking against an authenticator that does not exist would
      // strand the user with no way back in. The device itself is unprotected
      // in that case, so an app lock adds nothing anyway.
      //
      // Deliberately persists NOTHING. No authentication happened here, so
      // writing an unlocked record would make this concession outlive the
      // process — and it costs nothing to omit, because a device with no
      // passcode reaches this same branch again on the next launch.
      return {
        state: { ...state, phase: 'unlocked', unlockFailed: false, authUnavailable: false },
        persist: null,
      };

    case 'authenticatorUnavailable':
      // Distinct from `noAuthenticator`: the check did not answer, so we do not
      // know whether an authenticator exists. Treating that as "none" would
      // turn a transient native failure into an unlock — fail closed instead
      // and leave the user the Sign out escape.
      return { state: { ...state, phase: 'locked', authUnavailable: true }, persist: null };

    case 'signOutRequested':
      // The lock must NOT lift here. Clearing it optimistically revealed the
      // fleet and every pending approval for as long as the logout request took
      // to settle — up to the 15s fetch timeout on a stalled link — while the
      // token was still live. Stay locked until the session is actually gone.
      return {
        state: { ...state, phase: 'locked', signingOut: true, unlockFailed: false },
        persist: stamp('locked', event.now),
      };

    case 'signedOut':
      // No session, nothing to protect — and covering the login screen would
      // just make sign-in flicker. `bootDecided` deliberately survives: the
      // cold launch already happened.
      return {
        state: {
          ...state,
          phase: 'unlocked',
          obscured: false,
          backgroundedAt: null,
          unlockFailed: false,
          authUnavailable: false,
          signingOut: false,
        },
        persist: null,
      };

    case 'biometricPromptStarted':
      // Changes only what `inactive` covers. Never the lock clock: that is
      // armed by `background` alone, prompt or not.
      return { state: { ...state, biometricPrompt: true }, persist: null };

    case 'biometricPromptEnded':
      // Never lowers a cover — only an `active` transition does that. And it
      // does not raise one for `inactive` either: the prompt promise can settle
      // a beat before iOS reports `active`, and covering in that gap would
      // bring the flash straight back. If the app is really leaving, the
      // `background` transition that follows covers it. A non-`inactive`,
      // non-`active` state here (a `background` whose event we missed) covers.
      return {
        state: {
          ...state,
          biometricPrompt: false,
          obscured: state.obscured || coverFor({ ...state, biometricPrompt: true }, event.lifecycle),
        },
        persist: null,
      };
  }
}
