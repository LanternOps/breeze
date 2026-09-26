/**
 * Agent self-update attempt tracking (#4073).
 *
 * The agent sends a WebSocket `update_status` message immediately before every
 * self-update attempt, and a wedged update (e.g. #4072) re-attempts on every
 * heartbeat forever. The server records each attempt on the device row
 * (`devices.update_attempt_*`) and the heartbeat clears the record once the
 * reported agent version reaches the target. A device whose record has been
 * open, and still retrying, for longer than a sane install takes is stuck —
 * detectable server-side with no agent change and no dependence on log
 * shipping, which is exactly the channel that can be dead when an update
 * wedges.
 *
 * Shared so the API (which writes the record) and the web client (which
 * derives the stuck flag for display) use one definition.
 */

/**
 * An attempt after this long a silence starts a NEW episode rather than
 * continuing the old one; and a record whose last attempt is older than this
 * is no longer "stuck" — the device stopped trying (offer withdrawn, pin
 * changed, agent backing off). Wider than the agent's longest per-version
 * retry cooldown (30 min, codeSignatureRetryCooldown) so a device retrying on
 * that cadence still reads as one continuous episode.
 */
export const AGENT_UPDATE_EPISODE_GAP_MS = 2 * 60 * 60 * 1000;

/**
 * An update still unconverged this long after its first attempt is stuck. A
 * healthy update restarts on the new binary within minutes; an hour leaves
 * ample room for a slow download before flagging.
 */
export const AGENT_UPDATE_STUCK_AFTER_MS = 60 * 60 * 1000;

type Timestamp = Date | string | null | undefined;

export interface AgentUpdateAttemptRecord {
  targetVersion: string | null;
  startedAt: Date | null;
  lastAttemptAt: Date | null;
  attemptCount: number | null;
}

function toTime(value: Timestamp): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The record to persist after an `update_status` attempt for `targetVersion`.
 * A retry of the same target within the episode gap continues the episode
 * (start time kept, count incremented); anything else starts a new one.
 */
export function nextAgentUpdateAttempt(
  prev: {
    targetVersion: string | null | undefined;
    startedAt: Timestamp;
    lastAttemptAt: Timestamp;
    attemptCount: number | null | undefined;
  },
  targetVersion: string,
  now: Date,
): AgentUpdateAttemptRecord {
  const startedAt = toTime(prev.startedAt);
  const lastAttemptAt = toTime(prev.lastAttemptAt);
  const continues =
    prev.targetVersion === targetVersion &&
    startedAt !== null &&
    lastAttemptAt !== null &&
    now.getTime() - lastAttemptAt <= AGENT_UPDATE_EPISODE_GAP_MS;

  if (!continues) {
    return { targetVersion, startedAt: now, lastAttemptAt: now, attemptCount: 1 };
  }
  return {
    targetVersion,
    startedAt: new Date(startedAt),
    lastAttemptAt: now,
    attemptCount: Math.max(1, prev.attemptCount ?? 1) + 1,
  };
}

/**
 * True when the device has been attempting the same update for longer than
 * AGENT_UPDATE_STUCK_AFTER_MS and is still attempting it (last attempt within
 * the episode gap). The heartbeat clears the record on convergence, so an open
 * record is by definition unconverged.
 */
export function isAgentUpdateStuck(
  record: { targetVersion: string | null | undefined; startedAt: Timestamp; lastAttemptAt: Timestamp },
  now: Date = new Date(),
): boolean {
  if (!record.targetVersion) return false;
  const startedAt = toTime(record.startedAt);
  const lastAttemptAt = toTime(record.lastAttemptAt);
  if (startedAt === null || lastAttemptAt === null) return false;
  const nowMs = now.getTime();
  return (
    nowMs - startedAt >= AGENT_UPDATE_STUCK_AFTER_MS &&
    nowMs - lastAttemptAt <= AGENT_UPDATE_EPISODE_GAP_MS
  );
}
