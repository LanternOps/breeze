import { inArray } from 'drizzle-orm';
import type { WakeOnLanInlineSettings } from '@breeze/shared/validators';
import { db, withDbTransaction } from '../db';
import { devices } from '../db/schema/devices';
import { deviceWakeStatus, type WakeReadinessState } from '../db/schema/deviceWake';
import { compareAgentVersions } from './agentEditionCompat';
import { resolveWakeOnLanSettingsForDevices } from './featureConfigResolver';
import { captureException } from './sentry';

/**
 * Whether the Wake button shows for an offline device (#10838).
 *
 * `decideWakeAvailability` is the pure rule; `resolveWakeAvailability` is the
 * read side for a page of devices. The server decides: no client re-derives it.
 */

/** First agent release carrying the wake readiness collector. */
export const MIN_WAKE_STATUS_AGENT_VERSION = '0.130.0';
/** How long a "came online" after a wake attempt keeps an `unproven` device proven. */
export const WAKE_PROOF_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
/** Consecutive timed-out wake attempts after which the device is flagged (and hidden in 'verified' mode). */
export const WAKE_BLOCK_THRESHOLD = 3;

const CHUNK = 500;

export type WakeEffectiveState =
  | WakeReadinessState
  | 'unsupported_os'
  | 'agent_update_required'
  | 'no_data'
  | 'lookup_failed';

export interface WakeAvailability {
  show: boolean;
  mode: 'none' | 'verified' | 'always' | 'unknown';
  state: WakeEffectiveState;
  /** A hidden-but-unproven device may still be woken once to prove it. */
  testWakeAllowed: boolean;
  flaggedTimeouts: boolean;
}

/** Fail closed: a failed lookup never shows the button. */
export const WAKE_LOOKUP_FAILED_AVAILABILITY: WakeAvailability = {
  show: false,
  mode: 'unknown',
  state: 'lookup_failed',
  testWakeAllowed: false,
  flaggedTimeouts: false,
};

export interface WakeStatusInput {
  readinessState: WakeReadinessState | null;
  fingerprint: string | null;
  proofFingerprint: string | null;
  lastCameOnlineAt: Date | null;
  consecutiveTimeouts: number;
}

export function decideWakeAvailability(input: {
  settings: WakeOnLanInlineSettings | null;
  status: WakeStatusInput | null;
  device: { osType: 'windows' | 'macos' | 'linux'; agentVersion: string | null };
  now: Date;
}): WakeAvailability {
  const { settings, status, device, now } = input;

  let state: WakeEffectiveState;
  if (device.osType === 'linux' || device.osType === 'macos') {
    // Mac readiness is W05.
    state = 'unsupported_os';
  } else if (!status || status.readinessState === null) {
    state = device.agentVersion === null || compareAgentVersions(device.agentVersion, MIN_WAKE_STATUS_AGENT_VERSION) < 0
      ? 'agent_update_required'
      : 'no_data';
  } else {
    state = status.readinessState;
  }

  const flaggedTimeouts = (status?.consecutiveTimeouts ?? 0) >= WAKE_BLOCK_THRESHOLD;

  if (settings === null) {
    return { show: true, mode: 'none', state, testWakeAllowed: false, flaggedTimeouts };
  }
  if (settings.buttonMode === 'always') {
    return { show: true, mode: 'always', state, testWakeAllowed: false, flaggedTimeouts };
  }

  const proven = state === 'unproven'
    && status !== null
    && status.lastCameOnlineAt !== null
    && now.getTime() - status.lastCameOnlineAt.getTime() <= WAKE_PROOF_LIFETIME_MS
    && status.proofFingerprint !== null
    && status.proofFingerprint === status.fingerprint;
  const show = (state === 'ready' || proven) && !flaggedTimeouts;
  const testWakeAllowed = !show && state === 'unproven' && !flaggedTimeouts;
  return { show, mode: 'verified', state, testWakeAllowed, flaggedTimeouts };
}

/**
 * Availability for many devices. NEVER throws: any failure maps every id to
 * {@link WAKE_LOOKUP_FAILED_AVAILABILITY}. Ids that are not visible devices are
 * absent from the map; callers use `map.get(id) ?? WAKE_LOOKUP_FAILED_AVAILABILITY`.
 *
 * Runs in the caller's DB context (RLS). All reads sit in ONE transaction with
 * the catch outside it, so a failed read cannot poison the request transaction.
 * Per chunk of 500 ids: the wake_on_lan winner lookup, one `devices` read and
 * one `device_wake_status` read. Do not call it inside a `Promise.all`.
 */
export async function resolveWakeAvailability(deviceIds: readonly string[]): Promise<Map<string, WakeAvailability>> {
  const unique = Array.from(new Set(deviceIds));
  const result = new Map<string, WakeAvailability>();
  if (unique.length === 0) return result;

  try {
    const now = new Date();
    await withDbTransaction(async () => {
      for (let i = 0; i < unique.length; i += CHUNK) {
        const chunk = unique.slice(i, i + CHUNK);
        const settingsById = await resolveWakeOnLanSettingsForDevices(chunk);
        const deviceRows = await db
          .select({ id: devices.id, osType: devices.osType, agentVersion: devices.agentVersion })
          .from(devices)
          .where(inArray(devices.id, chunk));
        const statusRows = await db
          .select({
            deviceId: deviceWakeStatus.deviceId,
            readinessState: deviceWakeStatus.readinessState,
            fingerprint: deviceWakeStatus.fingerprint,
            proofFingerprint: deviceWakeStatus.proofFingerprint,
            lastCameOnlineAt: deviceWakeStatus.lastCameOnlineAt,
            consecutiveTimeouts: deviceWakeStatus.consecutiveTimeouts,
          })
          .from(deviceWakeStatus)
          .where(inArray(deviceWakeStatus.deviceId, chunk));
        const statusById = new Map(statusRows.map((row) => [row.deviceId, row] as const));

        for (const device of deviceRows) {
          const status = statusById.get(device.id) ?? null;
          result.set(device.id, decideWakeAvailability({
            settings: settingsById.get(device.id) ?? null,
            status: status && {
              readinessState: status.readinessState,
              fingerprint: status.fingerprint,
              proofFingerprint: status.proofFingerprint,
              lastCameOnlineAt: status.lastCameOnlineAt,
              consecutiveTimeouts: status.consecutiveTimeouts,
            },
            device: { osType: device.osType, agentVersion: device.agentVersion },
            now,
          }));
        }
      }
    });
    return result;
  } catch (err) {
    console.error('[wakeAvailability] lookup failed; hiding the wake button', {
      deviceCount: unique.length,
      error: err instanceof Error ? err.message : String(err),
    });
    captureException(err);
    return new Map(unique.map((id) => [id, WAKE_LOOKUP_FAILED_AVAILABILITY] as const));
  }
}
