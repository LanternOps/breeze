import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Sentry from '@sentry/react-native';

export const QUEUE_KEY = 'breeze.timeEntryQueue.v1';
/** Where an unparseable blob is parked so the next write cannot overwrite it. */
export const QUEUE_CORRUPT_KEY = 'breeze.timeEntryQueue.v1.corrupt';

export interface QueuedWrite {
  id: string;
  kind: 'start' | 'stop' | 'create';
  payload: Record<string, unknown>;
  queuedAt: string;
  attempts: number;
  /**
   * Id of the queued write this one closes. A stop is linked to the queued
   * start it ends, so a start that is permanently rejected takes its stop with
   * it instead of leaving the stop to land on an unrelated running entry.
   */
  dependsOn?: string;
}

export interface DrainResult {
  sent: number;
  dropped: QueuedWrite[];
  remaining: number;
  /**
   * Attempts already spent on the write now at the head of the queue. Lets a
   * caller tell "the phone is offline" (headAttempts 1) from "the head write
   * keeps failing and nothing behind it can move" (headAttempts large) — for
   * example a technician whose role is missing time_entries:write.
   */
  headAttempts: number;
}

/**
 * Storage itself failed. Distinct from an empty queue: callers must NOT treat
 * this as "nothing queued" and persist over the backlog.
 */
export class QueueStorageError extends Error {
  constructor(cause: unknown) {
    super('time-entry queue storage is unreadable');
    this.name = 'QueueStorageError';
    this.cause = cause;
  }
}

let storageChain: Promise<void> = Promise.resolve();
let drainChain: Promise<void> = Promise.resolve();

function withStorageLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = storageChain.then(operation, operation);
  storageChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

const WRITE_KINDS = new Set<QueuedWrite['kind']>(['start', 'stop', 'create']);

function asQueuedWrite(value: unknown): QueuedWrite | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<QueuedWrite>;
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return null;
  if (typeof candidate.kind !== 'string') return null;
  if (!WRITE_KINDS.has(candidate.kind as QueuedWrite['kind'])) return null;
  if (typeof candidate.payload !== 'object' || candidate.payload === null) return null;
  return {
    id: candidate.id,
    kind: candidate.kind as QueuedWrite['kind'],
    payload: candidate.payload as Record<string, unknown>,
    queuedAt: typeof candidate.queuedAt === 'string' ? candidate.queuedAt : new Date(0).toISOString(),
    attempts: typeof candidate.attempts === 'number' ? candidate.attempts : 0,
    ...(typeof candidate.dependsOn === 'string' ? { dependsOn: candidate.dependsOn } : {}),
  };
}

async function quarantine(stored: string, reason: string, cause?: unknown): Promise<void> {
  // Move the bytes aside BEFORE returning []: the next enqueue/drain rewrites
  // QUEUE_KEY, so without this copy the rows are destroyed within one tap and
  // "recoverable by hand" stops being true.
  try {
    await AsyncStorage.setItem(QUEUE_CORRUPT_KEY, stored);
  } catch {
    // Nothing further to do — the Sentry event below is the only record left.
  }
  // Queue corruption is otherwise invisible on a production RN build; these are
  // billable writes, so it must be observable. Sentry is initialized in App.tsx.
  Sentry.captureException(cause instanceof Error ? cause : new Error(reason), {
    tags: { area: 'time-entry-queue' },
    extra: { reason, storedLength: stored.length },
  });
}

export async function readQueue(): Promise<QueuedWrite[]> {
  let stored: string | null;
  try {
    stored = await AsyncStorage.getItem(QUEUE_KEY);
  } catch (error) {
    // A read failure is NOT an empty queue. Returning [] here would let the very
    // next enqueue persist [stopWrite] over a full offline shift, so this
    // propagates and the callers below refuse to write.
    Sentry.captureException(error instanceof Error ? error : new QueueStorageError(error), {
      tags: { area: 'time-entry-queue' },
      extra: { reason: 'read-failed' },
    });
    throw new QueueStorageError(error);
  }
  if (stored === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch (error) {
    await quarantine(stored, 'unparseable-queue', error);
    return [];
  }
  if (!Array.isArray(parsed)) {
    await quarantine(stored, 'queue-not-an-array');
    return [];
  }

  const writes = parsed.map(asQueuedWrite).filter((write): write is QueuedWrite => write !== null);
  if (writes.length !== parsed.length) {
    // A malformed element would otherwise throw out of the drain forever, since
    // nothing rewrites the blob on that path.
    await quarantine(stored, 'malformed-queue-elements');
  }
  return writes;
}

export async function enqueue(
  write: Omit<QueuedWrite, 'id' | 'queuedAt' | 'attempts'>
): Promise<QueuedWrite> {
  const base: QueuedWrite = {
    ...write,
    id: `${Date.now()}-${Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(36)}`,
    queuedAt: new Date().toISOString(),
    attempts: 0,
  };
  return withStorageLock(async () => {
    // Throws QueueStorageError on a storage read failure, which aborts before
    // the setItem below — the backlog is never overwritten with a stale view.
    const queue = await readQueue();
    const item: QueuedWrite = { ...base };
    if (item.kind === 'stop' && item.dependsOn === undefined) {
      // Pair the stop with the queued start it closes (the most recent start
      // not already closed by a queued stop). A stop for a timer started while
      // online has no queued start and stays unlinked.
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        const candidate = queue[i];
        if (candidate.kind === 'stop') break;
        if (candidate.kind === 'start') {
          item.dependsOn = candidate.id;
          break;
        }
      }
    }
    queue.push(item);
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    return item;
  });
}

function getStatus(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  const statusError = error as { status?: unknown; statusCode?: unknown };
  return statusError.status ?? statusError.statusCode;
}

/**
 * Statuses that are a verdict on the payload itself and will never succeed on
 * replay: 400 validation, 404 ticket/timer gone, 409 conflict, 422.
 *
 * The rest of the 4xx range is deliberately NOT here. 401 (coreRequest has no
 * refresh-and-retry, so a phone offline past the token TTL gets one on the
 * first replay), 403 (the default 'Partner Technician' role lacks
 * time_entries:write until an admin grants it), 408 and 429 (the global rate
 * limit, which an unpaced reconnect backlog can trip) all succeed on a later
 * attempt — dropping them destroys recoverable billable work.
 */
const PERMANENT_STATUSES = new Set([400, 404, 409, 422]);

function isPermanentRejection(error: unknown): boolean {
  const status = getStatus(error);
  return typeof status === 'number' && PERMANENT_STATUSES.has(status);
}

async function drainQueue(
  send: (write: QueuedWrite) => Promise<void>
): Promise<DrainResult> {
  const queue = await readQueue();
  const snapshotIds = new Set(queue.map((write) => write.id));
  const dropped: QueuedWrite[] = [];
  const droppedIds = new Set<string>();
  let sent = 0;
  let nextIndex = 0;

  while (nextIndex < queue.length) {
    const write = queue[nextIndex];

    if (write.dependsOn !== undefined && droppedIds.has(write.dependsOn)) {
      // Its start never landed. The server's stop takes no entry id — it is a
      // CAS on "whatever entry this user has running" — so sending this would
      // end an unrelated timer (e.g. one started from the web dashboard) and
      // stamp it with the replay time.
      dropped.push(write);
      droppedIds.add(write.id);
      nextIndex += 1;
      continue;
    }

    try {
      await send(write);
      sent += 1;
      nextIndex += 1;
    } catch (error) {
      if (isPermanentRejection(error)) {
        dropped.push(write);
        droppedIds.add(write.id);
        nextIndex += 1;
        continue;
      }

      write.attempts += 1;
      break;
    }
  }

  const remainingQueue = await withStorageLock(async () => {
    const currentQueue = await readQueue();
    const appendedWrites = currentQueue.filter((write) => !snapshotIds.has(write.id));
    const remaining = [...queue.slice(nextIndex), ...appendedWrites];
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));
    return remaining;
  });
  return {
    sent,
    dropped,
    remaining: remainingQueue.length,
    headAttempts: remainingQueue[0]?.attempts ?? 0,
  };
}

/**
 * Replays queued writes oldest-first.
 *
 * Transient failures stop the drain to preserve ordering, so a stop can never
 * reach the server before its start. Only a verdict on the payload itself
 * (see PERMANENT_STATUSES) is dropped, because retrying one forever would wedge
 * every later entry behind it — an auth, permission or throttle failure is
 * retried instead, and `headAttempts` is how a caller notices a wedge.
 *
 * Dropping a write also drops the writes that depend on it, so a stop is never
 * replayed against a running entry its start never created.
 *
 * Calls are serialised: a flapping connection fires several false->true
 * transitions, and a concurrently replayed start would 409 ENTRY_RUNNING and
 * then be discarded as a verdict, losing billable work.
 *
 * Rejects with QueueStorageError if storage cannot be read; the queue is left
 * untouched in that case rather than truncated.
 */
export function drain(
  send: (write: QueuedWrite) => Promise<void>
): Promise<DrainResult> {
  // Ownership of the next replay is claimed before yielding, so a second
  // caller waits here rather than snapshotting the same queue.
  const result = drainChain.then(() => drainQueue(send));
  drainChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}
