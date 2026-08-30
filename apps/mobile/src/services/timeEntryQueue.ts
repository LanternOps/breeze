import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Sentry from '@sentry/react-native';

export const QUEUE_KEY = 'breeze.timeEntryQueue.v1';
/** Where an unparseable blob is parked so the next write cannot overwrite it. */
export const QUEUE_CORRUPT_KEY = 'breeze.timeEntryQueue.v1.corrupt';
/**
 * Ids a drain already resolved (transmitted or dropped) but could not remove
 * from QUEUE_KEY, because storage failed while reconciling. Applied on every
 * read until a successful persist clears it. Without it a storage hiccup at the
 * end of a drain re-sends everything the drain just sent — a duplicate billable
 * entry on the customer's invoice.
 */
export const QUEUE_TOMBSTONE_KEY = 'breeze.timeEntryQueue.v1.tombstone';

export interface QueuedWrite {
  id: string;
  kind: 'start' | 'stop' | 'create';
  payload: Record<string, unknown>;
  queuedAt: string;
  attempts: number;
  /**
   * Ids of the queued starts this write can close, oldest first.
   *
   * A stop takes no entry id on the wire — the server closes whichever entry
   * the user has running — so it is only safe to send while at least one start
   * it could be closing has landed. `startTimer` auto-stops the previous timer,
   * so every queued start ahead of the stop (back to the previous stop) is a
   * candidate: if the newest is rejected the stop still legitimately closes the
   * one before it. The link is dropped from this list as each candidate is
   * dropped; when the list empties the write is an orphan and is discarded.
   *
   * Absent means "not linked to any queued start" — a timer that was started
   * while online — and such a stop is always sent.
   */
  dependsOn?: string[];
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

function asDependsOn(value: unknown): string[] | undefined {
  // A single string is the shape written by the first build of this queue; a
  // row persisted by that build must keep its link across the app upgrade.
  const ids = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  const valid = ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
  return valid.length > 0 ? valid : undefined;
}

function asQueuedWrite(value: unknown): QueuedWrite | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<QueuedWrite>;
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return null;
  if (typeof candidate.kind !== 'string') return null;
  if (!WRITE_KINDS.has(candidate.kind as QueuedWrite['kind'])) return null;
  if (typeof candidate.payload !== 'object' || candidate.payload === null) return null;
  const dependsOn = asDependsOn(candidate.dependsOn);
  return {
    id: candidate.id,
    kind: candidate.kind as QueuedWrite['kind'],
    payload: candidate.payload as Record<string, unknown>,
    queuedAt: typeof candidate.queuedAt === 'string' ? candidate.queuedAt : new Date(0).toISOString(),
    attempts: typeof candidate.attempts === 'number' ? candidate.attempts : 0,
    ...(dependsOn === undefined ? {} : { dependsOn }),
  };
}

/**
 * Removes every write whose only remaining reason to exist has been dropped.
 *
 * `dropped` grows as the pass runs (a discarded dependant can itself have
 * dependants), so this iterates to a fixpoint rather than filtering once.
 * Surviving writes have the dead ids stripped from their `dependsOn`, which is
 * what makes the decision durable: once the result is persisted, a later drain
 * with no memory of this pass still sees the correct candidate list.
 */
function resolveDependants(
  writes: QueuedWrite[],
  dropped: ReadonlySet<string>
): { kept: QueuedWrite[]; orphaned: QueuedWrite[] } {
  const gone = new Set(dropped);
  const orphaned: QueuedWrite[] = [];
  let kept = writes;
  let changed = true;

  while (changed) {
    changed = false;
    const next: QueuedWrite[] = [];
    for (const write of kept) {
      if (gone.has(write.id)) continue;
      if (write.dependsOn !== undefined) {
        const live = write.dependsOn.filter((id) => !gone.has(id));
        if (live.length === 0) {
          orphaned.push(write);
          gone.add(write.id);
          changed = true;
          continue;
        }
        if (live.length !== write.dependsOn.length) write.dependsOn = live;
      }
      next.push(write);
    }
    kept = next;
  }

  return { kept, orphaned };
}

interface Tombstone {
  /** Already transmitted; must not be sent again. */
  sent: string[];
  /** Permanently rejected; also kills anything that depends on them. */
  dropped: string[];
}

const EMPTY_TOMBSTONE: Tombstone = { sent: [], dropped: [] };

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

async function readTombstone(): Promise<Tombstone> {
  let stored: string | null;
  try {
    stored = await AsyncStorage.getItem(QUEUE_TOMBSTONE_KEY);
  } catch (error) {
    // Ignoring an unreadable tombstone would re-send everything it records, so
    // this fails the read the same way an unreadable queue does.
    Sentry.captureException(error instanceof Error ? error : new QueueStorageError(error), {
      tags: { area: 'time-entry-queue' },
      extra: { reason: 'tombstone-read-failed' },
    });
    throw new QueueStorageError(error);
  }
  if (stored === null) return EMPTY_TOMBSTONE;
  try {
    const parsed = JSON.parse(stored) as { sent?: unknown; dropped?: unknown };
    return { sent: asStringArray(parsed?.sent), dropped: asStringArray(parsed?.dropped) };
  } catch {
    // A tombstone we cannot read is worse than none only in theory: the rows it
    // named are still in the queue and will simply be replayed.
    return EMPTY_TOMBSTONE;
  }
}

/**
 * Persists the queue and retires the tombstone in the same step.
 *
 * Every queue we persist is derived from `readQueue`, which has already applied
 * the tombstone, so the rows it named are gone from the blob we just wrote and
 * the record is spent.
 */
async function persistQueue(queue: QueuedWrite[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  await AsyncStorage.removeItem(QUEUE_TOMBSTONE_KEY);
}

/** Copies the corrupt bytes aside. Returns false if the copy did not happen. */
async function quarantine(stored: string, reason: string, cause?: unknown): Promise<boolean> {
  // Move the bytes aside BEFORE returning []: the next enqueue/drain rewrites
  // QUEUE_KEY, so without this copy the rows are destroyed within one tap and
  // "recoverable by hand" stops being true.
  let parked = true;
  let parkError: string | undefined;
  try {
    await AsyncStorage.setItem(QUEUE_CORRUPT_KEY, stored);
  } catch (error) {
    parked = false;
    parkError = error instanceof Error ? error.message : String(error);
  }
  // Queue corruption is otherwise invisible on a production RN build; these are
  // billable writes, so it must be observable. Sentry is initialized in App.tsx.
  // `parked` is reported because an event that claims a quarantine which never
  // happened is worse than no event: it retires an investigation that should
  // have gone looking for the bytes.
  Sentry.captureException(cause instanceof Error ? cause : new Error(reason), {
    tags: { area: 'time-entry-queue' },
    extra: { reason, storedLength: stored.length, parked, ...(parkError === undefined ? {} : { parkError }) },
  });
  return parked;
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
    if (!(await quarantine(stored, 'unparseable-queue', error))) throw new QueueStorageError(error);
    return [];
  }
  if (!Array.isArray(parsed)) {
    if (!(await quarantine(stored, 'queue-not-an-array'))) {
      throw new QueueStorageError(new Error('queue-not-an-array'));
    }
    return [];
  }

  const writes = parsed.map(asQueuedWrite).filter((write): write is QueuedWrite => write !== null);
  if (writes.length !== parsed.length) {
    // A malformed element would otherwise throw out of the drain forever, since
    // nothing rewrites the blob on that path. If the park failed, refusing the
    // read is what stops the next write from destroying the valid rows too.
    if (!(await quarantine(stored, 'malformed-queue-elements'))) {
      throw new QueueStorageError(new Error('malformed-queue-elements'));
    }
  }

  const tombstone = await readTombstone();
  if (tombstone.sent.length === 0 && tombstone.dropped.length === 0) return writes;
  const consumed = new Set([...tombstone.sent, ...tombstone.dropped]);
  // Orphans found here were already reported to the caller by the drain that
  // dropped their start; this is that decision being replayed, not a new one.
  return resolveDependants(
    writes.filter((write) => !consumed.has(write.id)),
    new Set(tombstone.dropped)
  ).kept;
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
      // Link the stop to every queued start it could be closing, back to the
      // previous stop. A stop for a timer started while online finds none and
      // stays unlinked, which is what keeps it sendable.
      const candidates: string[] = [];
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        const candidate = queue[i];
        if (candidate.kind === 'stop') break;
        if (candidate.kind === 'start') candidates.unshift(candidate.id);
      }
      if (candidates.length > 0) item.dependsOn = candidates;
    }
    queue.push(item);
    await persistQueue(queue);
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

async function drainQueue(send: (write: QueuedWrite) => Promise<void>): Promise<DrainResult> {
  const priorTombstone = await readTombstone();
  const queue = await readQueue();
  const snapshotIds = new Set(queue.map((write) => write.id));
  const dropped: QueuedWrite[] = [];
  const droppedIds = new Set<string>();
  const sentIds = new Set<string>();
  let sent = 0;
  let nextIndex = 0;

  const drop = (write: QueuedWrite): void => {
    dropped.push(write);
    droppedIds.add(write.id);
  };

  while (nextIndex < queue.length) {
    const write = queue[nextIndex];

    if (write.dependsOn !== undefined) {
      const live = write.dependsOn.filter((id) => !droppedIds.has(id));
      if (live.length === 0) {
        // Every start it could close was rejected. The server's stop takes no
        // entry id — it is a CAS on "whatever entry this user has running" — so
        // sending this would end an unrelated timer (e.g. one started from the
        // web dashboard) and stamp it with the replay time.
        drop(write);
        nextIndex += 1;
        continue;
      }
      // Rewritten in place so the surviving candidates are what gets persisted.
      write.dependsOn = live;
    }

    try {
      await send(write);
      sentIds.add(write.id);
      sent += 1;
      nextIndex += 1;
    } catch (error) {
      if (isPermanentRejection(error)) {
        drop(write);
        nextIndex += 1;
        continue;
      }

      write.attempts += 1;
      break;
    }
  }

  let remainingQueue: QueuedWrite[];
  try {
    remainingQueue = await withStorageLock(async () => {
      const currentQueue = await readQueue();
      const appendedWrites = currentQueue.filter((write) => !snapshotIds.has(write.id));
      // Writes appended mid-drain are resolved here too: a stop the technician
      // queued while the replay was running can be linked to a start this pass
      // has just dropped, and nothing later would know that.
      const { kept, orphaned } = resolveDependants(
        [...queue.slice(nextIndex), ...appendedWrites],
        droppedIds
      );
      for (const orphan of orphaned) drop(orphan);
      await persistQueue(kept);
      return kept;
    });
  } catch (error) {
    // Storage failed while reconciling. The sends really happened, so the queue
    // as stored is now wrong in the dangerous direction; record the outcome as
    // a tombstone that the next read applies. Merging with any prior tombstone
    // matters: its ids are still in the blob and would otherwise be replayed.
    const { kept, orphaned } = resolveDependants(queue.slice(nextIndex), droppedIds);
    for (const orphan of orphaned) drop(orphan);
    remainingQueue = kept;
    // Under the lock: an enqueue that lands between the failure and this write
    // would otherwise clear the tombstone it never saw, and the sent writes
    // would be replayed after all.
    await withStorageLock(() => recordTombstone(priorTombstone, sentIds, droppedIds, error));
  }

  return {
    sent,
    dropped,
    remaining: remainingQueue.length,
    headAttempts: remainingQueue[0]?.attempts ?? 0,
  };
}

async function recordTombstone(
  prior: Tombstone,
  sentIds: ReadonlySet<string>,
  droppedIds: ReadonlySet<string>,
  cause: unknown
): Promise<void> {
  const tombstone: Tombstone = {
    sent: [...new Set([...prior.sent, ...sentIds])],
    dropped: [...new Set([...prior.dropped, ...droppedIds])],
  };
  let recorded = true;
  try {
    await AsyncStorage.setItem(QUEUE_TOMBSTONE_KEY, JSON.stringify(tombstone));
  } catch {
    recorded = false;
  }
  Sentry.captureException(cause instanceof Error ? cause : new QueueStorageError(cause), {
    tags: { area: 'time-entry-queue' },
    extra: {
      reason: 'drain-reconcile-failed',
      recorded,
      sentCount: tombstone.sent.length,
      droppedCount: tombstone.dropped.length,
    },
  });
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
 * Dropping a write also drops the writes left with nothing to depend on, so a
 * stop is never replayed against a running entry its start never created. That
 * decision is written back to storage — as a rewritten `dependsOn` on the rows
 * that survive, or as a tombstone when storage fails mid-reconcile — so a later
 * drain, which has no memory of this pass, reaches the same conclusion.
 *
 * Calls are serialised: a flapping connection fires several false->true
 * transitions, and a concurrently replayed start would 409 ENTRY_RUNNING and
 * then be discarded as a verdict, losing billable work.
 *
 * Rejects with QueueStorageError if storage cannot be read before any write is
 * sent; the queue is left untouched in that case rather than truncated.
 */
export function drain(send: (write: QueuedWrite) => Promise<void>): Promise<DrainResult> {
  // Ownership of the next replay is claimed before yielding, so a second
  // caller waits here rather than snapshotting the same queue.
  const result = drainChain.then(() => drainQueue(send));
  drainChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}
