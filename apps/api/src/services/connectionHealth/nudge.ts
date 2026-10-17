import type { Queue } from 'bullmq';
import { runOutsideDbContext } from '../../db';
import { createInstrumentedQueue } from '../bullmqQueue';
import type { ConnectionSourceKind } from './types';

// Reconcile nudges (spec §1.3, W4 plan D9/D10). A shared failure write point
// (the durable grant revocation, a sync worker's final failed attempt) asks
// the reconciler to observe that one kind soon instead of waiting for the next
// poll. The nudge carries no policy: the poll stays the source of truth, and a
// lost nudge only delays detection to it.
//
// Debounce: a delayed job with a fixed id. While it waits, every further add
// with that id is a no-op, so a burst of failures becomes one run of the kind.
// removeOnComplete/removeOnFail re-arm it once the run finishes.
//
// Hot-path contract: returns synchronously, never throws, never rejects, and
// enqueues outside the caller's DB context (no transaction is held across the
// Redis round trip, #1105). Unit tests get a global no-op mock of this module
// (src/__tests__/setup.ts), so callers' tests never open a BullMQ connection.

/** The reconciler's queue (jobs/connectionHealthReconcile.ts consumes it). */
export const CONNECTION_HEALTH_QUEUE = 'connection-health-reconcile';
export const NUDGE_JOB_NAME = 'reconcile-kind';
export const NUDGE_DELAY_MS = 60_000;

/** BullMQ 5 rejects ':' in custom job ids, hence '-' (spec §1.3 amended in W4). */
export const nudgeJobId = (kind: ConnectionSourceKind) => `reconcile-kind-${kind}`;

export type NudgeJobData = { kind: ConnectionSourceKind };

let queue: Queue | null = null;
const lastWarnAt = new Map<string, number>();

function warn(kind: string, err: unknown) {
  const at = Date.now();
  if (at - (lastWarnAt.get(kind) ?? 0) < 60_000) return;
  lastWarnAt.set(kind, at);
  console.warn(JSON.stringify({
    event: 'connection_health_nudge_failed',
    kind,
    error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
  }));
}

function getQueue(): Queue {
  if (!queue) {
    const q = createInstrumentedQueue(CONNECTION_HEALTH_QUEUE);
    // Without a listener a connection error event would be unhandled.
    q.on('error', (err) => warn('queue', err));
    queue = q;
  }
  return queue;
}

export function nudgeConnectionHealth(kind: ConnectionSourceKind): void {
  try {
    const q = getQueue();
    const data: NudgeJobData = { kind };
    const added = runOutsideDbContext(() => q.add(NUDGE_JOB_NAME, data, {
      jobId: nudgeJobId(kind),
      delay: NUDGE_DELAY_MS,
      removeOnComplete: true,
      removeOnFail: true,
    }));
    void Promise.resolve(added).catch((err: unknown) => warn(kind, err));
  } catch (err) {
    warn(kind, err);
  }
}

export function resetNudgeQueueForTests(): void {
  queue = null;
  lastWarnAt.clear();
}

export async function closeNudgeQueue(): Promise<void> {
  const q = queue;
  queue = null;
  await q?.close();
}
