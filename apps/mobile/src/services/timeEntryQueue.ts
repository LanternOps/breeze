import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Sentry from '@sentry/react-native';

/**
 * v2 is a NARROWING, and there is deliberately no migration from v1.
 *
 * v1 could hold `start` and `stop`. Both are SERVER-STAMPED verbs:
 * `POST /time-entries/start` sets `startedAt = new Date()` and
 * `POST /time-entries/stop` sets `endedAt = new Date()`, neither accepting a
 * client timestamp. Queueing one defers its stamping to reconnect time, so a
 * 40-minute basement job replayed at 18:00 is billed as a 0-minute entry, and a
 * stop queued at 15:00 bills to 18:00. v2 therefore holds only writes that
 * carry their own explicit bounds — `create` and `closeEntry` — which makes
 * mobile-originated over-billing unrepresentable rather than defended against.
 *
 * No migration is required: this feature is unreleased (both waves are
 * unmerged PRs), so no field install holds a v1 queue. A v1 row that somehow
 * survives is rejected by `asQueuedWrite` on its `kind`.
 */
export const QUEUE_KEY = 'breeze.timeEntryQueue.v2';
/** Where an unparseable blob is parked so the next write cannot overwrite it. */
export const QUEUE_CORRUPT_KEY = 'breeze.timeEntryQueue.v2.corrupt';
/**
 * Ids a drain already resolved (transmitted or parked) but could not remove
 * from QUEUE_KEY, because storage failed while reconciling. Applied on every
 * read until a successful persist clears it. Without it a storage hiccup at the
 * end of a drain re-sends everything the drain just sent — a duplicate billable
 * entry on the customer's invoice.
 */
export const QUEUE_TOMBSTONE_KEY = 'breeze.timeEntryQueue.v2.tombstone';
/**
 * Writes the server refused for good (see PERMANENT_STATUSES). They are moved
 * here rather than deleted: a rejected write is still a record of real work,
 * and issue #4251 makes one of these statuses ordinary rather than exotic — a
 * default Partner Technician genuinely lacks `time_entries:write`.
 */
export const QUEUE_NEEDS_ATTENTION_KEY = 'breeze.timeEntryQueue.v2.needsAttention';

/**
 * Exported as a runtime value, not just a type, so a test can assert the union
 * itself rather than one code path through it. `start`/`stop` never coming back
 * is the invariant this whole module exists to hold.
 */
export const QUEUED_KINDS = ['create', 'closeEntry'] as const;

export type QueuedWriteKind = (typeof QUEUED_KINDS)[number];

export interface QueuedWrite {
  id: string;
  kind: QueuedWriteKind;
  payload: Record<string, unknown>;
  queuedAt: string;
  attempts: number;
  /**
   * When the last send attempt was made. The replay sender may translate a
   * future-dated span back into the past against the server clock and rewrite
   * `payload.startedAt`/`endedAt` in place; persisting the attempt time next to
   * the rewritten bounds is what lets a retry compare like with like instead of
   * shifting an already-shifted span a second time.
   */
  sentAt?: string;
}

/** A write the server refused permanently, kept for the technician to re-enter. */
export interface NeedsAttentionRow {
  write: QueuedWrite;
  status: number;
  code?: string;
  message: string;
  failedAt: string;
}

export interface DrainResult {
  sent: number;
  /**
   * Writes moved to QUEUE_NEEDS_ATTENTION_KEY by this pass. They are PARKED,
   * not lost: `readNeedsAttention()` returns them and the UI surfaces them as a
   * standing row until the technician deals with them.
   */
  needsAttention: QueuedWrite[];
  /** Total parked rows in storage, including ones from earlier passes. */
  needsAttentionTotal: number;
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

const WRITE_KINDS = new Set<string>(QUEUED_KINDS);

function asQueuedWrite(value: unknown): QueuedWrite | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<QueuedWrite>;
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return null;
  if (typeof candidate.kind !== 'string') return null;
  if (!WRITE_KINDS.has(candidate.kind)) return null;
  if (typeof candidate.payload !== 'object' || candidate.payload === null) return null;
  return {
    id: candidate.id,
    kind: candidate.kind as QueuedWriteKind,
    payload: candidate.payload as Record<string, unknown>,
    queuedAt: typeof candidate.queuedAt === 'string' ? candidate.queuedAt : new Date(0).toISOString(),
    attempts: typeof candidate.attempts === 'number' ? candidate.attempts : 0,
    ...(typeof candidate.sentAt === 'string' ? { sentAt: candidate.sentAt } : {}),
  };
}

interface Tombstone {
  /** Already transmitted; must not be sent again. */
  sent: string[];
  /** Already parked in needs-attention; must not be sent again either. */
  parked: string[];
}

const EMPTY_TOMBSTONE: Tombstone = { sent: [], parked: [] };

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
    const parsed = JSON.parse(stored) as { sent?: unknown; parked?: unknown };
    return { sent: asStringArray(parsed?.sent), parked: asStringArray(parsed?.parked) };
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
    // next enqueue persist [oneWrite] over a full offline shift, so this
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
  if (tombstone.sent.length === 0 && tombstone.parked.length === 0) return writes;
  const consumed = new Set([...tombstone.sent, ...tombstone.parked]);
  return writes.filter((write) => !consumed.has(write.id));
}

export async function enqueue(
  write: Omit<QueuedWrite, 'id' | 'queuedAt' | 'attempts'>
): Promise<QueuedWrite> {
  const item: QueuedWrite = {
    ...write,
    id: `${Date.now()}-${Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(36)}`,
    queuedAt: new Date().toISOString(),
    attempts: 0,
  };
  return withStorageLock(async () => {
    // Throws QueueStorageError on a storage read failure, which aborts before
    // the setItem below — the backlog is never overwritten with a stale view.
    const queue = await readQueue();
    queue.push(item);
    await persistQueue(queue);
    return item;
  });
}

// --- Needs attention ---------------------------------------------------------

function asNeedsAttentionRow(value: unknown): NeedsAttentionRow | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<NeedsAttentionRow>;
  const write = asQueuedWrite(candidate.write);
  if (write === null) return null;
  return {
    write,
    status: typeof candidate.status === 'number' ? candidate.status : 0,
    ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
    message: typeof candidate.message === 'string' ? candidate.message : '',
    failedAt: typeof candidate.failedAt === 'string' ? candidate.failedAt : new Date(0).toISOString(),
  };
}

/** Reads without the lock; a torn read here degrades to an empty list, never a throw. */
async function readNeedsAttentionUnlocked(): Promise<NeedsAttentionRow[]> {
  let stored: string | null;
  try {
    stored = await AsyncStorage.getItem(QUEUE_NEEDS_ATTENTION_KEY);
  } catch {
    return [];
  }
  if (stored === null) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(asNeedsAttentionRow).filter((row): row is NeedsAttentionRow => row !== null);
  } catch {
    return [];
  }
}

export async function readNeedsAttention(): Promise<NeedsAttentionRow[]> {
  return withStorageLock(readNeedsAttentionUnlocked);
}

/** Removes parked rows by WRITE id, once the technician has dealt with them. */
export async function clearNeedsAttention(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const gone = new Set(ids);
  await withStorageLock(async () => {
    const rows = await readNeedsAttentionUnlocked();
    const kept = rows.filter((row) => !gone.has(row.write.id));
    await AsyncStorage.setItem(QUEUE_NEEDS_ATTENTION_KEY, JSON.stringify(kept));
  });
}

/**
 * Appends one permanently-rejected write. Returns false if the append did not
 * land, which is the caller's signal to LEAVE the write queued: a park that did
 * not happen must never be reported as one, because the drain's next step is to
 * remove the row from the queue.
 *
 * Exported because the drain is not the only source of unsendable work: a stop
 * whose device clock moved backwards mid-span produces a span that cannot be
 * invoiced, and that record has to reach the same place a rejected write does
 * rather than being dropped on the floor at the tap.
 */
export async function parkNeedsAttention(row: NeedsAttentionRow): Promise<boolean> {
  return withStorageLock(async () => {
    try {
      const rows = await readNeedsAttentionUnlocked();
      rows.push(row);
      await AsyncStorage.setItem(QUEUE_NEEDS_ATTENTION_KEY, JSON.stringify(rows));
      return true;
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new QueueStorageError(error), {
        tags: { area: 'time-entry-queue' },
        extra: { reason: 'needs-attention-park-failed', writeId: row.write.id, status: row.status },
      });
      return false;
    }
  });
}

// --- Draining ----------------------------------------------------------------

function getStatus(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  const statusError = error as { status?: unknown; statusCode?: unknown };
  return statusError.status ?? statusError.statusCode;
}

function getStringField(error: unknown, field: string): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Statuses that are a verdict on the payload itself and will never succeed on
 * replay: 400 validation, 404 entry/ticket gone, 409 conflict, 422.
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
  const parked: QueuedWrite[] = [];
  const parkedIds = new Set<string>();
  const sentIds = new Set<string>();
  let sent = 0;
  let nextIndex = 0;

  while (nextIndex < queue.length) {
    const write = queue[nextIndex];
    // Recorded before the attempt so a rewritten payload and the moment it was
    // rewritten are persisted together on a transient failure.
    write.sentAt = new Date().toISOString();

    try {
      await send(write);
      sentIds.add(write.id);
      sent += 1;
      nextIndex += 1;
    } catch (error) {
      if (isPermanentRejection(error)) {
        const landed = await parkNeedsAttention({
          write,
          status: getStatus(error) as number,
          ...(getStringField(error, 'code') === undefined
            ? {}
            : { code: getStringField(error, 'code') as string }),
          message: getStringField(error, 'message') ?? 'The server rejected this time entry.',
          failedAt: new Date().toISOString(),
        });
        if (landed) {
          parked.push(write);
          parkedIds.add(write.id);
          nextIndex += 1;
          continue;
        }
        // The park did not happen. Removing the row now would delete the only
        // copy of real work; a visibly wedged queue is the lesser failure and
        // `headAttempts` is how the UI reports it.
        write.attempts += 1;
        break;
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
      const kept = [...queue.slice(nextIndex), ...appendedWrites];
      await persistQueue(kept);
      return kept;
    });
  } catch (error) {
    // Storage failed while reconciling. The sends really happened, so the queue
    // as stored is now wrong in the dangerous direction; record the outcome as
    // a tombstone that the next read applies. Merging with any prior tombstone
    // matters: its ids are still in the blob and would otherwise be replayed.
    remainingQueue = queue.slice(nextIndex);
    // Under the lock: an enqueue that lands between the failure and this write
    // would otherwise clear the tombstone it never saw, and the sent writes
    // would be replayed after all.
    await withStorageLock(() => recordTombstone(priorTombstone, sentIds, parkedIds, error));
  }

  return {
    sent,
    needsAttention: parked,
    needsAttentionTotal: (await readNeedsAttentionUnlocked()).length,
    remaining: remainingQueue.length,
    headAttempts: remainingQueue[0]?.attempts ?? 0,
  };
}

async function recordTombstone(
  prior: Tombstone,
  sentIds: ReadonlySet<string>,
  parkedIds: ReadonlySet<string>,
  cause: unknown
): Promise<void> {
  const tombstone: Tombstone = {
    sent: [...new Set([...prior.sent, ...sentIds])],
    parked: [...new Set([...prior.parked, ...parkedIds])],
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
      parkedCount: tombstone.parked.length,
    },
  });
}

/**
 * Replays queued writes oldest-first.
 *
 * Every queued write carries its own explicit timestamps (see QUEUE_KEY), so a
 * replay can never rewrite when the work happened. Transient failures still
 * stop the drain to preserve ordering, so a `closeEntry` cannot reach the
 * server before the `create` it corrects.
 *
 * Only a verdict on the payload itself (see PERMANENT_STATUSES) leaves the
 * queue, and it is PARKED in needs-attention rather than deleted — retrying one
 * forever would wedge every later entry behind it, and deleting it would
 * silently destroy a record of real work. An auth, permission or throttle
 * failure is retried instead, and `headAttempts` is how a caller notices a
 * wedge.
 *
 * Calls are serialised: a flapping connection fires several false->true
 * transitions, and a concurrently replayed create would land twice.
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
