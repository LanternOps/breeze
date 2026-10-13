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
 *
 * Reads fail closed but are never silent: a missing or failing readiness
 * store returns `null` (not "nobody ready"), is logged, and is reported to
 * Sentry at most once a minute, so an outage is not mistaken for outdated
 * helpers.
 */
import { getRedis } from '../redis';
import { captureException } from '../sentry';

export const WORKSTATION_READINESS_TTL_SECONDS = 180;
const MAX_USERS = 32;
const REPORT_INTERVAL_MS = 60_000;

export type WorkstationCapabilityObservation = { callerVerify: boolean; usernames: string[] };

let lastReportAt = 0;
function reportStoreFault(phase: 'read' | 'write', error: unknown): void {
  const name = error instanceof Error ? error.name : String(error);
  console.error(`[callerVerification] readiness store ${phase} failed; workstation readiness is unknown`, { error: name });
  const now = Date.now();
  if (now - lastReportAt < REPORT_INTERVAL_MS) return;
  lastReportAt = now;
  captureException(error instanceof Error ? error : new Error(`caller verification readiness ${phase}: ${name}`), undefined, { phase });
}

/** Test-only: re-arm the Sentry throttle. */
export function __resetReadinessReportThrottleForTests(): void {
  lastReportAt = 0;
}

export function readinessKey(orgId: string, deviceId: string): string {
  return `caller-verify-cap:${orgId}:${deviceId}`;
}

export async function recordWorkstationCapabilities(
  orgId: string,
  deviceId: string,
  observation: WorkstationCapabilityObservation | undefined,
): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    if (observation?.callerVerify) reportStoreFault('write', new Error('redis_unavailable'));
    return;
  }
  const users = observation?.callerVerify ? [...new Set(observation.usernames)].slice(0, MAX_USERS) : [];
  try {
    if (users.length) await redis.set(readinessKey(orgId, deviceId), JSON.stringify(users), 'EX', WORKSTATION_READINESS_TTL_SECONDS);
    else await redis.del(readinessKey(orgId, deviceId));
  } catch (error) {
    // Telemetry only: the heartbeat must not fail. Readiness simply lapses.
    reportStoreFault('write', error);
  }
}

function parseUsers(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const users: unknown = JSON.parse(raw);
    return Array.isArray(users) ? users.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    // A corrupt entry for one device is that device's problem, not a store outage.
    return [];
  }
}

/**
 * Ready usernames for each device in one round trip, or `null` when the
 * readiness store is unavailable (absent or failing).
 */
export async function workstationReadiness(orgId: string, deviceIds: string[]): Promise<Map<string, string[]> | null> {
  const result = new Map<string, string[]>();
  if (!deviceIds.length) return result;
  const redis = getRedis();
  if (!redis) {
    reportStoreFault('read', new Error('redis_unavailable'));
    return null;
  }
  try {
    const raw = await redis.mget(...deviceIds.map((id) => readinessKey(orgId, id)));
    deviceIds.forEach((id, i) => result.set(id, parseUsers(raw[i])));
    return result;
  } catch (error) {
    reportStoreFault('read', error);
    return null;
  }
}

/** The usernames currently ready on this device; [] when unknown. */
export async function workstationReadyUsers(orgId: string, deviceId: string): Promise<string[]> {
  return (await workstationReadiness(orgId, [deviceId]))?.get(deviceId) ?? [];
}

export async function workstationUserAvailable(orgId: string, deviceId: string, username: string): Promise<boolean> {
  return (await workstationReadyUsers(orgId, deviceId)).includes(username);
}
