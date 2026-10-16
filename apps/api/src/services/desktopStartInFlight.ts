/**
 * #8947 — "this WebRTC desktop start is still waiting for its answer".
 *
 * One viewer window posted two `/viewer/offer`s ~250 ms apart for the same
 * session. Both were accepted, each bumped the start generation and dispatched
 * its own `start_desktop`, and only the second answer was kept. The first peer
 * was orphaned and the agent ran two captures.
 *
 * `commitDesktopStartIntent` now refuses a second offer while the first start
 * is in flight. The row alone cannot say that: an unanswered `connecting` row
 * looks the same whether its viewer is still polling for the answer or gave up
 * long ago. A refusal with no time bound would lock the session out for good
 * when an agent never answers. So the bound lives here, as a Redis marker:
 *
 *   value = the start's command id,  TTL = how long its viewer waits for the
 *   answer (`viewerAnswerTimeoutMs`).
 *
 * After the TTL that viewer has given up, so a new offer is a legitimate retry.
 * The marker counts only while the row still names the same command, still has
 * no answer and is still `connecting`. That check and the marker write both run
 * under the start decision's row lock, so two concurrent offers serialize on it.
 *
 * Read and mark fail OPEN: no Redis, a client that is not ready, an error or a
 * slow reply all read as "nothing in flight", and the offer goes through as it
 * did before #8947. The guard is then off, so every degraded outcome is logged
 * (rate-limited) to make a recurrence of the double offer traceable. The calls
 * run under a held row lock and inside a transaction, so each one is capped at
 * DESKTOP_START_IN_FLIGHT_REDIS_TIMEOUT_MS. An offline client is skipped
 * outright: its offline queue would hold the lock for as long as the retry
 * strategy runs.
 *
 * Release is the exception: a release that fails leaves the marker until its
 * TTL, so a retry inside that window is refused with START_IN_FLIGHT for a
 * start the agent never received. It is bounded by the TTL and logged at error
 * level with the command id.
 */
import { getRedis } from './redis';

/** Upper bound on any one marker operation while the row lock is held. */
export const DESKTOP_START_IN_FLIGHT_REDIS_TIMEOUT_MS = 250;

export function desktopStartInFlightRedisKey(sessionId: string): string {
  return `remote:desktop-start-inflight:${sessionId}`;
}

/** Delete the marker only if it still names this start. */
const RELEASE_SCRIPT = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

const TIMED_OUT = Symbol('timed-out');
const NO_CLIENT = 'skipped: no Redis client';

/** At most one "guard is off" warning per interval, so an outage cannot flood the log. */
const DEGRADED_WARN_INTERVAL_MS = 60_000;
let lastDegradedWarnAt = Number.NEGATIVE_INFINITY;

function warnDegraded(message: string): void {
  const now = Date.now();
  if (now - lastDegradedWarnAt < DEGRADED_WARN_INTERVAL_MS) return;
  lastDegradedWarnAt = now;
  console.warn(`[desktopStartInFlight] ${message}; duplicate-offer guard (#8947) is off until Redis recovers`);
}

/** Test hook: forget the rate-limit window. */
export function resetDesktopStartInFlightWarningsForTests(): void {
  lastDegradedWarnAt = Number.NEGATIVE_INFINITY;
}

async function withReadyRedis<T>(
  operation: 'read' | 'mark' | 'release',
  sessionId: string,
  run: (redis: NonNullable<ReturnType<typeof getRedis>>) => Promise<T>,
  onFailure: (reason: string) => void = (reason) =>
    warnDegraded(`${operation} ${reason} for session ${sessionId}`),
): Promise<T | null> {
  const redis = getRedis();
  if (!redis) {
    onFailure(NO_CLIENT);
    return null;
  }
  if (redis.status !== 'ready') {
    onFailure(`skipped: Redis client is ${redis.status}`);
    return null;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      run(redis),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), DESKTOP_START_IN_FLIGHT_REDIS_TIMEOUT_MS);
      }),
    ]);
    if (result === TIMED_OUT) {
      onFailure(`timed out after ${DESKTOP_START_IN_FLIGHT_REDIS_TIMEOUT_MS} ms`);
      return null;
    }
    return result;
  } catch (err) {
    onFailure(`failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The command id of the start in flight for this session, or null. */
export async function readDesktopStartInFlight(sessionId: string): Promise<string | null> {
  const value = await withReadyRedis('read', sessionId, (redis) =>
    redis.get(desktopStartInFlightRedisKey(sessionId)),
  );
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Record `startCommandId` as the start in flight for `ttlMs`. */
export async function markDesktopStartInFlight(
  sessionId: string,
  startCommandId: string,
  ttlMs: number,
): Promise<void> {
  await withReadyRedis('mark', sessionId, (redis) =>
    redis.set(desktopStartInFlightRedisKey(sessionId), startCommandId, 'PX', ttlMs),
  );
}

/**
 * Drop the marker for a start that was committed but never dispatched (the
 * agent was unreachable, the lease could not be minted, a terminal decision
 * landed first). Without this, a retry would be refused until the TTL ran out
 * for a start that the agent never received. Compare-and-delete, so it can
 * never drop a newer start's marker.
 */
export async function releaseDesktopStartInFlight(sessionId: string, startCommandId: string): Promise<void> {
  await withReadyRedis(
    'release',
    sessionId,
    (redis) => redis.eval(RELEASE_SCRIPT, 1, desktopStartInFlightRedisKey(sessionId), startCommandId),
    // Not rate-limited: each one may strand a marker, and a retry of this
    // session is refused until it expires. With no client at all nothing was
    // ever marked, so there is nothing to report.
    (reason) => reason !== NO_CLIENT && console.error(
      `[desktopStartInFlight] release ${reason} for session ${sessionId} (start ${startCommandId}); `
        + 'a retry is refused with START_IN_FLIGHT until the marker expires',
    ),
  );
}
