import { z } from 'zod';

/**
 * Watchdog install health (#8620, part of #8618 / #7583).
 *
 * The agent reports a bounded `watchdogInstall` object in its heartbeat when
 * the watchdog could not be (or is not being) registered. Pure core, same
 * shape as services/logShippingHealth: strict parse, transition-only
 * persistence plan, read-time banner view. No DB, no clock (`now` injected).
 *
 * Invariants:
 *  - Observational only. Never gates dispatch, auth, or any security call.
 *  - Closed vocabularies only. The agent never sends error text; this module
 *    never stores or returns any.
 *  - Absence = healthy/unreported -> stored state cleared.
 *  - A malformed object is `invalid`: it neither clears nor sets anything and
 *    is never coerced into a healthy zero.
 *  - `since` is set only on a state change (server clock), never per beat.
 */

/** Mirrors agent/internal/heartbeat/watchdog_ensure.go (WatchdogInstallReport.State). */
export const WATCHDOG_INSTALL_STATES = [
  'retrying',
  'gave_up',
  'opted_out',
  'unsupported',
  'disabled_by_policy',
] as const;

/** Mirrors agent/internal/watchdoginstall/classify.go (ErrorClass). */
export const WATCHDOG_INSTALL_ERROR_CLASSES = [
  'network',
  'server',
  'policy',
  'signature',
  'checksum',
  'dev_build',
  'unsupported_os',
  'install_cmd',
  'locked',
  'unknown',
] as const;

/**
 * States the Info-tab banner surfaces: terminal failures only. `retrying` is
 * in progress; `opted_out` / `disabled_by_policy` are deliberate, not failures.
 */
export const WATCHDOG_INSTALL_BANNER_STATES = ['gave_up', 'unsupported'] as const;

export type WatchdogInstallState = (typeof WATCHDOG_INSTALL_STATES)[number];
export type WatchdogInstallErrorClass = (typeof WATCHDOG_INSTALL_ERROR_CLASSES)[number];

const reportSchema = z.object({
  state: z.enum(WATCHDOG_INSTALL_STATES),
  // The agent saturates at 1000; validated for sanity, never stored.
  attempts: z.number().int().min(0).max(1000).optional(),
  // Display-only on the agent side; unused here, so a bad value is tolerated.
  lastAttemptAt: z.string().optional().catch(undefined),
  // A future/unknown class must not discard a valid state.
  lastErrorClass: z.enum(WATCHDOG_INSTALL_ERROR_CLASSES).optional().catch('unknown'),
});

export type ParsedWatchdogInstall =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'ok'; state: WatchdogInstallState; errorClass: WatchdogInstallErrorClass | null };

/** `undefined` -> absent. Anything else is strict-parsed; a failure is `invalid`. */
export function parseWatchdogInstall(raw: unknown): ParsedWatchdogInstall {
  if (raw === undefined) return { kind: 'absent' };
  const parsed = reportSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'invalid' };
  return { kind: 'ok', state: parsed.data.state, errorClass: parsed.data.lastErrorClass ?? null };
}

export interface WatchdogInstallDeviceFields {
  watchdogInstallState: string | null;
  watchdogInstallErrorClass: string | null;
  watchdogInstallSince: Date | null;
}

export type WatchdogInstallWrite = Partial<WatchdogInstallDeviceFields>;

/**
 * Transition-only plan against the device row the beat already loaded. `{}`
 * whenever nothing changes, so steady-state beats add zero keys to the beat's
 * single `UPDATE devices`.
 */
export function planWatchdogInstallWrite(
  device: WatchdogInstallDeviceFields,
  parsed: ParsedWatchdogInstall,
  now: Date,
): WatchdogInstallWrite {
  if (parsed.kind === 'invalid') return {};

  if (parsed.kind === 'absent') {
    if (
      device.watchdogInstallState === null &&
      device.watchdogInstallErrorClass === null &&
      device.watchdogInstallSince === null
    ) {
      return {};
    }
    return { watchdogInstallState: null, watchdogInstallErrorClass: null, watchdogInstallSince: null };
  }

  const write: WatchdogInstallWrite = {};
  if (device.watchdogInstallState !== parsed.state) {
    write.watchdogInstallState = parsed.state;
    write.watchdogInstallSince = now;
  }
  if (device.watchdogInstallErrorClass !== parsed.errorClass) {
    write.watchdogInstallErrorClass = parsed.errorClass;
  }
  return write;
}

export interface WatchdogInstallBanner {
  state: (typeof WATCHDOG_INSTALL_BANNER_STATES)[number];
  errorClass: WatchdogInstallErrorClass;
  since: string | null;
}

const BANNER_STATES: readonly string[] = WATCHDOG_INSTALL_BANNER_STATES;
const CLASSES: readonly string[] = WATCHDOG_INSTALL_ERROR_CLASSES;

/** Read-time view for the device detail response. null = show nothing. */
export function deriveWatchdogInstallBanner(row: WatchdogInstallDeviceFields): WatchdogInstallBanner | null {
  const state = row.watchdogInstallState;
  if (state === null || !BANNER_STATES.includes(state)) return null;
  const cls = row.watchdogInstallErrorClass;
  return {
    state: state as WatchdogInstallBanner['state'],
    errorClass: (cls !== null && CLASSES.includes(cls) ? cls : 'unknown') as WatchdogInstallErrorClass,
    since: row.watchdogInstallSince ? row.watchdogInstallSince.toISOString() : null,
  };
}
