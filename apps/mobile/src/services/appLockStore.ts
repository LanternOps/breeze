import * as SecureStore from 'expo-secure-store';
import * as Sentry from '@sentry/react-native';

import { APP_LOCK_STATE_KEY, type AppLockState, parseAppLockState } from './appLockState';

/**
 * Keychain I/O for the app-lock record.
 *
 * Split from `appLockState.ts` so that the record's shape, its parser, and the
 * cold-launch decision stay importable without expo-secure-store or Sentry —
 * `vitest.config.ts` runs on node with no React Native runtime, so any module
 * that reaches a native import takes its whole dependency tree out of test
 * range. Only this file is untestable-by-mock; the logic is not.
 */

/**
 * Read the persisted record. Both failure modes report null, which locks — see
 * the fail-secure note in `appLockState.ts`.
 *
 * The two are reported to Sentry separately because they mean very different
 * things: an unreadable keychain is an environment problem, while a *malformed*
 * record should be impossible and may indicate tampering. `console.*` is not
 * enough on its own — on a production TestFlight build it goes nowhere a
 * developer can see, which is the same reasoning `clearAuthData` records.
 */
export async function readAppLockState(): Promise<AppLockState | null> {
  let raw: string | null;
  try {
    raw = await SecureStore.getItemAsync(APP_LOCK_STATE_KEY);
  } catch (error) {
    console.error('Error reading app lock state:', error);
    reportOnce('read', error);
    return null;
  }

  const record = parseAppLockState(raw);
  if (record === null && raw !== null) {
    console.error('Discarding malformed app lock state');
    reportOnce('malformed', new Error('Malformed app lock state record'));
  }
  return record;
}

/**
 * Persist the record. Failures are swallowed rather than surfaced: no caller
 * has a sensible place to report into — most are lifecycle handlers on the way
 * to the background — and a missed write degrades to a lock on the next launch,
 * never to an unlock.
 */
export async function writeAppLockState(state: AppLockState): Promise<void> {
  try {
    await SecureStore.setItemAsync(APP_LOCK_STATE_KEY, JSON.stringify(state), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } catch (error) {
    console.error('Error writing app lock state:', error);
    reportOnce('write', error);
  }
}

/**
 * Record that the user just authenticated interactively.
 *
 * Called from the login / MFA thunks rather than from `storeToken`, because
 * `storeToken` only means "a token exists", not "a human just authenticated" —
 * it is also the token-refresh path (today only `services/aiChat.ts`), and a
 * refresh firing while the lock screen is up would otherwise stamp the app
 * unlocked, letting a force-quit at that screen relaunch straight in.
 *
 * Without this, the first sign-in of a process would be met by the cold-launch
 * lock a moment later: the gate cannot otherwise tell a token restored from the
 * keychain from one the user just earned with a password. A silently failed
 * write here therefore costs one spurious Face ID prompt — fail-secure, but the
 * reason the write path reports to Sentry.
 */
export async function markAppLockUnlocked(): Promise<void> {
  await writeAppLockState({ stampedAt: Date.now(), locked: false });
}

/**
 * Report each failure kind at most once per process.
 *
 * Writes fire on every lifecycle transition, so an unreadable keychain would
 * otherwise flood Sentry with one event per app switch. One event per kind is
 * enough to tell "the keychain is broken on this device" from "the grace window
 * is miscalculated", which is the distinction you cannot make from the field
 * otherwise — all three failure modes present identically as "the app keeps
 * asking for Face ID".
 */
type FailureKind = 'read' | 'write' | 'malformed';
const reported = new Set<FailureKind>();

function reportOnce(kind: FailureKind, error: unknown): void {
  if (reported.has(kind)) return;
  reported.add(kind);
  Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
    tags: { area: `app-lock-state-${kind}` },
    ...(error instanceof Error ? {} : { extra: { raw: error } }),
  });
}

/** Test seam — the once-per-process guard would otherwise leak between cases. */
export function resetAppLockReportingForTests(): void {
  reported.clear();
}
