import AsyncStorage from '@react-native-async-storage/async-storage';

export const QUEUE_KEY = 'breeze.timeEntryQueue.v1';

export interface QueuedWrite {
  id: string;
  kind: 'start' | 'stop' | 'create';
  payload: Record<string, unknown>;
  queuedAt: string;
  attempts: number;
}

export interface DrainResult {
  sent: number;
  dropped: QueuedWrite[];
  remaining: number;
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

export async function readQueue(): Promise<QueuedWrite[]> {
  try {
    const stored = await AsyncStorage.getItem(QUEUE_KEY);
    if (stored === null) return [];

    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? (parsed as QueuedWrite[]) : [];
  } catch {
    return [];
  }
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
  await withStorageLock(async () => {
    const queue = await readQueue();
    queue.push(item);
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  });
  return item;
}

function getStatus(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  const statusError = error as { status?: unknown; statusCode?: unknown };
  return statusError.status ?? statusError.statusCode;
}

async function drainQueue(
  send: (write: QueuedWrite) => Promise<void>
): Promise<DrainResult> {
  const queue = await readQueue();
  const snapshotIds = new Set(queue.map((write) => write.id));
  const dropped: QueuedWrite[] = [];
  let sent = 0;
  let nextIndex = 0;

  while (nextIndex < queue.length) {
    const write = queue[nextIndex];
    try {
      await send(write);
      sent += 1;
      nextIndex += 1;
    } catch (error) {
      const status = getStatus(error);
      if (typeof status === 'number' && status >= 400 && status < 500) {
        dropped.push(write);
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
  return { sent, dropped, remaining: remainingQueue.length };
}

/**
 * Replays queued writes oldest-first.
 *
 * Transient failures stop the drain to preserve ordering, so a stop can never
 * reach the server before its start. A 4xx is dropped because retrying a
 * permanent rejection forever would wedge every later entry behind it.
 *
 * Calls are serialised: a flapping connection fires several false->true
 * transitions, and a concurrently replayed start would 409 ENTRY_RUNNING and
 * then be discarded as a 4xx, losing billable work.
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
