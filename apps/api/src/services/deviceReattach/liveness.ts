/**
 * Target liveness (#8318 spec §6.5, decision 5): at request (§8 refusals) and
 * again at confirm.
 *
 * The target is live if ANY of its credentials was used recently. The
 * signals, newest wins:
 *   - devices.last_seen_at — agent heartbeats;            (DB)
 *   - devices.watchdog_last_seen — watchdog beats;        (DB)
 *   - the agent WS presence lease (`agent-presence:<agentId>`, 90 s TTL): a
 *     lease that exists means a socket is connected NOW;  (Redis)
 *   - the credential-use marker `agent-cred-use:<deviceId>` (wave 1b-1),
 *     written by every successful agent, helper and WS authentication — it
 *     covers the REST command poll, which claims work without touching
 *     last_seen_at.                                        (Redis)
 * The target counts as silent only when the newest signal is older than
 * `min(requested_at, now − 10 min)`. When Redis cannot answer either read
 * (unavailable, error, or slower than REDIS_LIVENESS_TIMEOUT_MS), the answer
 * is `unknown` and the caller refuses with `liveness_unknown` (fail closed).
 *
 * The two kinds of signal are read at different times on purpose: the Redis
 * ones BEFORE the caller takes its advisory and row locks, outside any DB
 * context (a Redis round trip must never hold a pooled connection or a lock,
 * #1105); the DB ones from the row the caller read under its lock. A use
 * between the Redis read and the commit is the §6.5 residual the stale-caller
 * rules close: a confirm that commits first changes the target's agent_id and
 * incarnation, so the late request matches 0 rows (wave 1b-1).
 */
import { assertOutsideHeldDbContext } from '../../db';
import { readAgentCredentialUse } from '../agentCredentialUse';
import { probeAgentPresence } from '../agentPresence';
import { REATTACH_TARGET_QUIET_PERIOD_MS } from './protocol';

export type TargetLivenessSignal = 'heartbeat' | 'watchdog' | 'credential_use' | 'ws_presence';

export type TargetLiveness =
  | { state: 'silent' }
  | { state: 'alive'; signal: TargetLivenessSignal; at: Date }
  | { state: 'unknown' };

/** The Redis half, read before any lock. */
export type RedisLivenessSignals =
  | { unavailable: true }
  | { unavailable?: false; wsPresent: boolean; credentialUseAt: Date | null; readAt: Date };

/** The DB half, read from the row the caller holds locked. */
export interface DbLivenessSignals {
  lastSeenAt: Date | null;
  watchdogLastSeen: Date | null;
}

/** How long the Redis half may take before it counts as unavailable (fail closed). */
export const REDIS_LIVENESS_TIMEOUT_MS = 2_000;

/** The instant every signal must be older than for the target to count as silent. */
export function targetSilenceThreshold(requestedAt: Date, now: Date): Date {
  return new Date(Math.min(requestedAt.getTime(), now.getTime() - REATTACH_TARGET_QUIET_PERIOD_MS));
}

/**
 * Read the WS presence lease and the credential-use marker of the target's
 * install. Call with NO DB context held (asserted). Never throws.
 */
export async function readRedisLivenessSignals(
  target: { deviceId: string; agentId: string },
  options: { timeoutMs?: number } = {},
): Promise<RedisLivenessSignals> {
  assertOutsideHeldDbContext('deviceReattach liveness (Redis)');
  const timeoutMs = options.timeoutMs ?? REDIS_LIVENESS_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const reads = Promise.all([readAgentCredentialUse(target.deviceId), probeAgentPresence(target.agentId)]);
    const outcome = await Promise.race([reads, timeout]);
    if (outcome === 'timeout') return { unavailable: true };
    const [credentialUse, presence] = outcome;
    if ('unavailable' in credentialUse || 'unavailable' in presence) return { unavailable: true };
    return { wsPresent: presence.present, credentialUseAt: credentialUse.at, readAt: new Date() };
  } catch {
    return { unavailable: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The §6.5 rule over both halves. Pure. */
export function decideTargetLiveness(
  redis: RedisLivenessSignals,
  dbSignals: DbLivenessSignals,
  requestedAt: Date,
  now: Date,
): TargetLiveness {
  if (redis.unavailable) return { state: 'unknown' };
  if (redis.wsPresent) return { state: 'alive', signal: 'ws_presence', at: redis.readAt };

  const threshold = targetSilenceThreshold(requestedAt, now).getTime();
  const signals: Array<[TargetLivenessSignal, Date | null]> = [
    ['heartbeat', dbSignals.lastSeenAt],
    ['watchdog', dbSignals.watchdogLastSeen],
    ['credential_use', redis.credentialUseAt],
  ];
  let newest: { signal: TargetLivenessSignal; at: Date } | null = null;
  for (const [signal, at] of signals) {
    if (at && !Number.isNaN(at.getTime()) && (!newest || at.getTime() > newest.at.getTime())) {
      newest = { signal, at };
    }
  }
  if (newest && newest.at.getTime() >= threshold) return { state: 'alive', ...newest };
  return { state: 'silent' };
}
