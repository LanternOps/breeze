/**
 * Per-device caller-verification readiness (#6354 W02), from heartbeat
 * telemetry — no table, no migration.
 *
 * Each heartbeat from a current agent carries `helperCapabilities`
 * `{ callerVerify, usernames }`: the console logins whose Assist helper can
 * render the card right now. That list REPLACES the stored observation; a
 * missing field (old agent), `callerVerify:false` or an empty list clears it.
 * The short TTL makes a silent device fall back to unavailable.
 *
 * This is a hint for availability and suggestions, never authorization: the
 * agent re-resolves the console login and helper on every dispatch.
 * Usernames compare exactly (the detector's spelling); folding could select a
 * different Unix account.
 */
import { getRedis } from '../redis';

export const WORKSTATION_READINESS_TTL_SECONDS = 180;
const MAX_USERS = 32;

export type WorkstationCapabilityObservation = { callerVerify: boolean; usernames: string[] };

export function readinessKey(orgId: string, deviceId: string): string {
  return `caller-verify-cap:${orgId}:${deviceId}`;
}

export async function recordWorkstationCapabilities(
  orgId: string,
  deviceId: string,
  observation: WorkstationCapabilityObservation | undefined,
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const users = observation?.callerVerify ? [...new Set(observation.usernames)].slice(0, MAX_USERS) : [];
  try {
    if (users.length) await redis.set(readinessKey(orgId, deviceId), JSON.stringify(users), 'EX', WORKSTATION_READINESS_TTL_SECONDS);
    else await redis.del(readinessKey(orgId, deviceId));
  } catch (error) {
    // Telemetry only: the heartbeat must not fail. Readiness simply lapses.
    console.warn('[callerVerification] readiness cache write failed', {
      deviceId,
      error: error instanceof Error ? error.name : String(error),
    });
  }
}

/** The usernames currently ready on this device; [] on any doubt. */
export async function workstationReadyUsers(orgId: string, deviceId: string): Promise<string[]> {
  try {
    const raw = await getRedis()?.get(readinessKey(orgId, deviceId));
    if (!raw) return [];
    const users: unknown = JSON.parse(raw);
    return Array.isArray(users) ? users.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

export async function workstationUserAvailable(orgId: string, deviceId: string, username: string): Promise<boolean> {
  return (await workstationReadyUsers(orgId, deviceId)).includes(username);
}
