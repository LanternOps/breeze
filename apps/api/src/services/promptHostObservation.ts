/**
 * The live prompt-renderer observation (#10190 W02; spec §3.8, plan P1).
 *
 * A main-agent heartbeat carries `helperCapabilities.promptHost`
 * `{ protocolVersion, kinds, rendererVersion }`: what the renderer in the
 * active console session advertised at its LIVE IPC authentication. The
 * technician's device page shows it, and it is the evidence compatibility
 * rule 8 needs before legacy branches toward old Assist builds can go ("no
 * connected Assist below the floor"). `devices.helper_version` cannot answer
 * that: it is the on-disk version and keeps its old value when reporting
 * stops. So this is telemetry only (no column, no migration) and must be
 * FRESH:
 *
 *   - every main-agent beat replaces it (SET with a 180 s TTL);
 *   - a beat that reports none (old agent, no renderer, malformed block)
 *     DELETES it, so a present observation is always the device's latest
 *     report, never a renderer that has since gone away;
 *   - the TTL covers a device that stops beating at all.
 *
 * It is a hint for people, never an input to prompt routing: the agent decides
 * per prompt from the live, authenticated renderer (spec §3.1 rule 1).
 *
 * Failure handling. The write sits on the heartbeat hot path, so it never
 * throws, skips a client that is not ready (its offline queue would hold the
 * beat for as long as the retry strategy runs), is capped at
 * PROMPT_HOST_REDIS_TIMEOUT_MS, and logs a lost write at most once a minute.
 * A read fails closed to `null` and is logged.
 *
 * Keyed by device id alone: device ids are globally unique and the only
 * reader (GET /devices/:id) reads after its tenant and site check.
 */
import { promptHostTelemetrySchema } from '@breeze/shared/promptHost';
import { z } from 'zod';
import { getRedis } from './redis';

export const PROMPT_HOST_OBSERVATION_TTL_SECONDS = 180;
/** Upper bound on one observation store call; the heartbeat must not wait longer. */
export const PROMPT_HOST_REDIS_TIMEOUT_MS = 250;
const WRITE_FAULT_LOG_INTERVAL_MS = 60_000;

export type PromptHostReport = z.infer<typeof promptHostTelemetrySchema>;
export type PromptHostObservation = PromptHostReport & {
  /** Server time of the heartbeat that carried the report. */
  observedAt: string;
};

const storedObservationSchema = promptHostTelemetrySchema.extend({
  observedAt: z.string().datetime({ offset: true }),
});

export function promptHostObservationKey(deviceId: string): string {
  return `prompt-host:${deviceId}`;
}

type RedisClient = NonNullable<ReturnType<typeof getRedis>>;
const TIMED_OUT = Symbol('timed-out');

async function withCap<T>(run: Promise<T>): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), PROMPT_HOST_REDIS_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function describeFault(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let lastWriteFaultLogAt = Number.NEGATIVE_INFINITY;
let suppressedWriteFaults = 0;

function logWriteFault(deviceId: string, reason: string): void {
  const now = Date.now();
  if (now - lastWriteFaultLogAt < WRITE_FAULT_LOG_INTERVAL_MS) {
    suppressedWriteFaults += 1;
    return;
  }
  const suppressed = suppressedWriteFaults;
  lastWriteFaultLogAt = now;
  suppressedWriteFaults = 0;
  console.error(
    `[promptHost] prompt host observation write failed (${reason}) for device ${deviceId}; `
      + 'the device page shows no live renderer until it recovers'
      + (suppressed ? ` (${suppressed} similar failures suppressed)` : ''),
  );
}

/** Test-only: re-arm the write-fault log throttle. */
export function __resetPromptHostObservationLogThrottleForTests(): void {
  lastWriteFaultLogAt = Number.NEGATIVE_INFINITY;
  suppressedWriteFaults = 0;
}

/**
 * Replace (or, when `report` is undefined, delete) the device's observation.
 * Never throws and never holds the caller longer than the cap.
 */
export async function recordPromptHostObservation(
  deviceId: string,
  report: PromptHostReport | undefined,
  now: Date = new Date(),
): Promise<void> {
  try {
    const redis = getRedis();
    if (!redis) {
      // No store configured or it is down: an absent report has nothing to clear.
      if (report) logWriteFault(deviceId, 'redis_unavailable');
      return;
    }
    if (redis.status !== 'ready') {
      if (report) logWriteFault(deviceId, `redis_${redis.status}`);
      return;
    }
    const key = promptHostObservationKey(deviceId);
    const run = report
      ? redis.set(key, JSON.stringify({ ...report, observedAt: now.toISOString() } satisfies PromptHostObservation), 'EX', PROMPT_HOST_OBSERVATION_TTL_SECONDS)
      : redis.del(key);
    if ((await withCap<unknown>(run)) === TIMED_OUT) {
      logWriteFault(deviceId, `timed out after ${PROMPT_HOST_REDIS_TIMEOUT_MS} ms`);
    }
  } catch (error) {
    // Telemetry only: the heartbeat must not fail. The observation lapses.
    logWriteFault(deviceId, describeFault(error));
  }
}

function logReadFault(deviceId: string, reason: string): null {
  console.error(
    `[promptHost] prompt host observation read failed (${reason}) for device ${deviceId}; reporting none`,
  );
  return null;
}

/** The device's fresh observation, or `null` when there is none or the store fails. */
export async function readPromptHostObservation(deviceId: string): Promise<PromptHostObservation | null> {
  let raw: unknown;
  try {
    const redis: RedisClient | null = getRedis();
    if (!redis) return logReadFault(deviceId, 'redis_unavailable');
    if (redis.status !== 'ready') return logReadFault(deviceId, `redis_${redis.status}`);
    raw = await withCap(redis.get(promptHostObservationKey(deviceId)));
    if (raw === TIMED_OUT) return logReadFault(deviceId, `timed out after ${PROMPT_HOST_REDIS_TIMEOUT_MS} ms`);
  } catch (error) {
    return logReadFault(deviceId, describeFault(error));
  }
  if (typeof raw !== 'string' || raw.length === 0) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    decoded = undefined;
  }
  const parsed = storedObservationSchema.safeParse(decoded);
  if (!parsed.success) {
    // One device's corrupt entry, not a store outage; it lapses on its TTL.
    console.warn(`[promptHost] ignoring a corrupt prompt host observation for device ${deviceId}`);
    return null;
  }
  return parsed.data;
}
