/**
 * Per-agent coalescing for the agent WebSocket `update_status` frame.
 *
 * `update_status` is a one-shot "about to self-update to <version>" notice that
 * flips the device row to `status = 'updating'`. Each write is its own org-
 * scoped transaction updating the same `devices` row, so without coalescing a
 * run of repeated frames from one connection queues one row-locking
 * transaction per frame, each holding a pooled connection while it waits on
 * the previous one.
 *
 * Rules (per agent id, in-process — the WS connection lives on one replica):
 *  - while a write for the agent is in flight, further frames are absorbed
 *    (the in-flight write already sets the state they ask for);
 *  - after a successful write, a frame naming the SAME target version inside
 *    the dedupe window is absorbed; a different target version always writes;
 *  - a failed write clears the entry, so the next frame retries.
 *
 * The window is deliberately shorter than any real update cadence: the agent
 * sends one notice per update attempt, and attempts are driven by the
 * heartbeat's `upgradeTo` (one per heartbeat interval at most), so a
 * legitimate retry of the same version always lands outside the window and
 * is written exactly as before. Inside the window the row already says
 * 'updating' from the write that just succeeded.
 */

export const UPDATE_STATUS_DEDUPE_WINDOW_MS = 15_000;

/** Upper bound on tracked agents before expired entries are swept. */
const MAX_TRACKED_AGENTS = 10_000;

interface Entry {
  targetVersion: string;
  inFlight: boolean;
  writtenAt: number;
}

const entries = new Map<string, Entry>();

let absorbedCount = 0;

function sweepExpired(now: number): void {
  for (const [agentId, entry] of entries) {
    if (!entry.inFlight && now - entry.writtenAt >= UPDATE_STATUS_DEDUPE_WINDOW_MS) {
      entries.delete(agentId);
    }
  }
}

/**
 * Returns true when the caller should perform the devices write for this
 * frame (and must then call {@link finishAgentUpdateStatusWrite}); false when
 * the frame is absorbed by an in-flight or recent identical write.
 */
export function beginAgentUpdateStatusWrite(
  agentId: string,
  targetVersion: string,
  now: number = Date.now(),
): boolean {
  const existing = entries.get(agentId);
  if (existing) {
    if (existing.inFlight) {
      absorbedCount += 1;
      return false;
    }
    if (
      existing.targetVersion === targetVersion
      && now - existing.writtenAt < UPDATE_STATUS_DEDUPE_WINDOW_MS
    ) {
      absorbedCount += 1;
      return false;
    }
  } else if (entries.size >= MAX_TRACKED_AGENTS) {
    sweepExpired(now);
  }
  entries.set(agentId, { targetVersion, inFlight: true, writtenAt: 0 });
  return true;
}

export function finishAgentUpdateStatusWrite(
  agentId: string,
  targetVersion: string,
  succeeded: boolean,
  now: number = Date.now(),
): void {
  if (!succeeded) {
    entries.delete(agentId);
    return;
  }
  entries.set(agentId, { targetVersion, inFlight: false, writtenAt: now });
}

export function getAgentUpdateStatusCoalescerMetrics(): { tracked: number; absorbed: number } {
  return { tracked: entries.size, absorbed: absorbedCount };
}

export function resetAgentUpdateStatusCoalescerForTests(): void {
  entries.clear();
  absorbedCount = 0;
}
