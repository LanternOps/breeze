import { getRedis } from './redis';

/**
 * Consume-once expectations for agent WS result integrity.
 *
 * Both the backup-completion (F6) and vault-auto-sync (F5) result paths accept a
 * completion from an authenticated agent based on identifiers the agent already
 * knows. A compromised-but-legitimately-enrolled agent can therefore forge or
 * replay a "completed" result for its own device. These helpers add a server-side
 * record of "this specific unit of work is outstanding and not-yet-consumed" so a
 * forged/replayed result can be dropped.
 *
 * Two shapes, both **fail-closed** — if Redis is unavailable or errors, the
 * consume returns `{ ok: false }` and the caller drops the result (degrades to
 * "not-completed", which is the safe direction: we under-report protection
 * rather than trust the agent):
 *
 *  - {@link recordDispatchedExpectation} / {@link consumeDispatchedExpectation}:
 *    server-dispatched work (F6 backup jobs). The dispatcher records the
 *    expectation when it sends the command; the result path consumes it exactly
 *    once. Replay, never-dispatched job UUIDs, and a result for the wrong device
 *    all fail to consume.
 *
 *  - {@link claimConsumeOnce}: derived expectation (F5 vault auto-sync). There is
 *    no server dispatch to bind to, so legitimacy is established separately (a
 *    real recently-completed backup snapshot for the device). This helper only
 *    enforces consume-once on that derived tuple so the same snapshot can't drive
 *    repeated/overwriting vault-state updates.
 */

export type AgentWorkExpectationKind = 'backup' | 'vault_sync';

// Generous TTLs: a legitimate result can arrive long after dispatch (slow backup,
// agent reconnect). Tune toward over-accepting late legitimate results rather than
// dropping them — see the rollout notes in the design doc.
const DISPATCHED_EXPECTATION_TTL_SECONDS = 24 * 60 * 60; // 24h
const CONSUME_ONCE_TTL_SECONDS = 24 * 60 * 60; // 24h

function dispatchedKey(kind: AgentWorkExpectationKind, deviceId: string, key: string): string {
  return `agent-work-expect:${kind}:${deviceId}:${key}`;
}

function consumeOnceKey(kind: AgentWorkExpectationKind, deviceId: string, key: string): string {
  return `agent-work-consumed:${kind}:${deviceId}:${key}`;
}

/**
 * Atomic GET-exists + DEL via a Redis Lua script (ioredis `eval`). This is a
 * Redis server-side script — NOT JavaScript `eval`; it executes the literal Lua
 * below against Redis with no client-controlled code. Returns 1 if the key
 * existed (and was deleted), 0 otherwise, so a concurrent double-report can only
 * succeed once.
 */
const CONSUME_IF_PRESENT_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

/**
 * Record that a unit of server-dispatched work is outstanding for a device.
 * Best-effort: a Redis outage here means {@link consumeDispatchedExpectation}
 * will later fail-closed and drop the result, which is the safe direction.
 */
export async function recordDispatchedExpectation(
  kind: AgentWorkExpectationKind,
  deviceId: string,
  key: string,
): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    console.warn(
      `[AgentWorkExpectation] Redis unavailable while recording ${kind} expectation ` +
      `(device=${deviceId}, key=${key}); the corresponding result will be dropped on arrival`,
    );
    return;
  }
  try {
    await redis.set(
      dispatchedKey(kind, deviceId, key),
      '1',
      'EX',
      DISPATCHED_EXPECTATION_TTL_SECONDS,
    );
  } catch (err) {
    console.error(
      `[AgentWorkExpectation] Failed to record ${kind} expectation (device=${deviceId}, key=${key}):`,
      err,
    );
  }
}

/**
 * Consume a previously-recorded dispatched expectation exactly once.
 * Returns `{ ok: true }` only if the expectation currently exists for this
 * (kind, device, key); the consume deletes it so replay and re-drive of an
 * already-consumed/terminal job both fail. Fail-closed on Redis errors.
 */
export async function consumeDispatchedExpectation(
  kind: AgentWorkExpectationKind,
  deviceId: string,
  key: string,
): Promise<{ ok: boolean }> {
  const redis = getRedis();
  if (!redis) {
    console.warn(
      `[AgentWorkExpectation] Redis unavailable consuming ${kind} expectation ` +
      `(device=${deviceId}, key=${key}); dropping result (fail-closed)`,
    );
    return { ok: false };
  }
  try {
    const consumed = await redis.eval(
      CONSUME_IF_PRESENT_LUA,
      1,
      dispatchedKey(kind, deviceId, key),
    );
    return { ok: consumed === 1 };
  } catch (err) {
    console.error(
      `[AgentWorkExpectation] Failed to consume ${kind} expectation (device=${deviceId}, key=${key}); ` +
      `dropping result (fail-closed):`,
      err,
    );
    return { ok: false };
  }
}

/**
 * Claim a derived (non-dispatched) unit of work consume-once. Returns
 * `{ ok: true }` only on the first claim for this (kind, device, key); replays
 * return `{ ok: false }`. Fail-closed on Redis unavailable/error. Uses
 * `SET ... NX` so the claim is atomic.
 */
export async function claimConsumeOnce(
  kind: AgentWorkExpectationKind,
  deviceId: string,
  key: string,
): Promise<{ ok: boolean }> {
  const redis = getRedis();
  if (!redis) {
    console.warn(
      `[AgentWorkExpectation] Redis unavailable claiming ${kind} consume-once ` +
      `(device=${deviceId}, key=${key}); dropping result (fail-closed)`,
    );
    return { ok: false };
  }
  try {
    const result = await redis.set(
      consumeOnceKey(kind, deviceId, key),
      '1',
      'EX',
      CONSUME_ONCE_TTL_SECONDS,
      'NX',
    );
    return { ok: result === 'OK' };
  } catch (err) {
    console.error(
      `[AgentWorkExpectation] Failed to claim ${kind} consume-once (device=${deviceId}, key=${key}); ` +
      `dropping result (fail-closed):`,
      err,
    );
    return { ok: false };
  }
}
