import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, string>();
let getItemFailures = 0;
/**
 * Fails the NEXT read of the queue blob only. Counting getItem calls is brittle
 * (the module reads more than one key), so tests arm this from inside a `send`
 * callback to target the re-read at the end of a drain specifically.
 */
let failNextQueueRead = false;
/** Keys whose setItem rejects, so a failed quarantine copy can be exercised. */
const setItemFailKeys = new Set<string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => {
      // Literal, not the imported const: this factory is hoisted above imports.
      if (failNextQueueRead && k === 'breeze.timeEntryQueue.v1') {
        failNextQueueRead = false;
        throw new Error('SQLite busy');
      }
      if (getItemFailures > 0) {
        getItemFailures -= 1;
        throw new Error('SQLite busy');
      }
      return store.get(k) ?? null;
    },
    setItem: async (k: string, v: string) => {
      if (setItemFailKeys.has(k)) throw new Error('SQLITE_FULL');
      store.set(k, v);
    },
    removeItem: async (k: string) => {
      store.delete(k);
    },
  },
}));

// @sentry/react-native is a Flow source this .ts-only suite cannot parse.
vi.mock('@sentry/react-native', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import * as Sentry from '@sentry/react-native';
import {
  enqueue,
  readQueue,
  drain,
  QUEUE_KEY,
  QUEUE_CORRUPT_KEY,
} from './timeEntryQueue';
import type { QueuedWrite } from './timeEntryQueue';

beforeEach(() => {
  store.clear();
  getItemFailures = 0;
  failNextQueueRead = false;
  setItemFailKeys.clear();
  vi.clearAllMocks();
});

/** The `extra` bag of the most recent Sentry event, for payload assertions. */
function lastSentryExtra(): Record<string, unknown> {
  const calls = vi.mocked(Sentry.captureException).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const context = calls[calls.length - 1][1] as
    | { tags?: Record<string, unknown>; extra?: Record<string, unknown> }
    | undefined;
  expect(context?.tags).toEqual({ area: 'time-entry-queue' });
  return context?.extra ?? {};
}

describe('timeEntryQueue', () => {
  it('replays writes in the order they were made', async () => {
    await enqueue({ kind: 'start', payload: { ticketId: 'k1' } });
    await enqueue({ kind: 'stop', payload: { isBillable: true } });
    const seen: string[] = [];
    const result = await drain(async (w) => {
      seen.push(w.kind);
    });
    expect(seen).toEqual(['start', 'stop']);
    expect(result).toMatchObject({ sent: 2, remaining: 0, dropped: [] });
    await expect(readQueue()).resolves.toEqual([]);
  });

  it('enqueue stamps id, queuedAt and attempts=0 and is durable across a fresh readQueue', async () => {
    const item = await enqueue({ kind: 'create', payload: { durationMinutes: 30 } });
    expect(item.id).toEqual(expect.any(String));
    expect(item.id.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(item.queuedAt))).toBe(false);
    expect(item.attempts).toBe(0);

    // Durability: nothing cached in memory — a fresh read goes back to storage.
    const persisted = await readQueue();
    expect(persisted).toEqual([item]);
    expect(store.has(QUEUE_KEY)).toBe(true);

    // Two enqueues get distinct ids.
    const second = await enqueue({ kind: 'start', payload: {} });
    expect(second.id).not.toBe(item.id);
    await expect(readQueue()).resolves.toHaveLength(2);
  });

  it('stops draining on a transport failure and keeps the rest queued', async () => {
    await enqueue({ kind: 'start', payload: {} });
    await enqueue({ kind: 'stop', payload: {} });
    const result = await drain(async (w) => {
      if (w.kind === 'start') throw Object.assign(new Error('offline'), { status: undefined });
    });
    // Order matters more than throughput: a stop must never land before its start.
    expect(result).toMatchObject({ sent: 0, remaining: 2, dropped: [] });
    const queue = await readQueue();
    expect(queue.map((q) => q.kind)).toEqual(['start', 'stop']);
  });

  it('increments attempts on the write that failed transiently, and persists it', async () => {
    await enqueue({ kind: 'start', payload: {} });
    await enqueue({ kind: 'stop', payload: {} });
    await drain(async () => {
      throw new Error('offline');
    });
    let queue = await readQueue();
    expect(queue[0].attempts).toBe(1);
    // The untouched later write was never attempted.
    expect(queue[1].attempts).toBe(0);

    await drain(async () => {
      throw Object.assign(new Error('gateway'), { status: 503 });
    });
    queue = await readQueue();
    expect(queue[0].attempts).toBe(2);
    expect(queue[1].attempts).toBe(0);
  });

  it('treats a 5xx as transient (retained), not a verdict', async () => {
    await enqueue({ kind: 'start', payload: {} });
    const result = await drain(async () => {
      throw Object.assign(new Error('boom'), { status: 500 });
    });
    expect(result).toMatchObject({ sent: 0, remaining: 1, dropped: [] });
  });

  it('drops a permanently-rejected write instead of blocking the queue forever', async () => {
    await enqueue({ kind: 'stop', payload: {} });
    await enqueue({ kind: 'start', payload: { ticketId: 'k2' } });
    const result = await drain(async (w) => {
      if (w.kind === 'stop')
        throw Object.assign(new Error('no timer'), { status: 404, code: 'NO_RUNNING_TIMER' });
    });
    // A 4xx will never succeed on retry — dropping it lets the queue progress.
    expect(result.dropped.map((d) => d.kind)).toEqual(['stop']);
    expect(result).toMatchObject({ sent: 1, remaining: 0 });
    await expect(readQueue()).resolves.toEqual([]);
  });

  it('recognises the statusCode alias used by TimeEntryError as a permanent failure', async () => {
    await enqueue({ kind: 'stop', payload: {} });
    await enqueue({ kind: 'start', payload: {} });
    const result = await drain(async (w) => {
      if (w.kind === 'stop')
        throw Object.assign(new Error('running'), { statusCode: 409, code: 'ENTRY_RUNNING' });
    });
    expect(result.dropped.map((d) => d.kind)).toEqual(['stop']);
    expect(result).toMatchObject({ sent: 1, remaining: 0 });
  });

  it('drops a 422 as a payload verdict', async () => {
    await enqueue({ kind: 'create', payload: {} });
    const result = await drain(async () => {
      throw Object.assign(new Error('unprocessable'), { status: 422 });
    });
    expect(result.dropped.map((d) => d.kind)).toEqual(['create']);
    expect(result).toMatchObject({ sent: 0, remaining: 0 });
  });

  // --- Retriable 4xx: these codes succeed on a later attempt, so dropping them
  // destroys billable work that was recoverable. ---

  it('retains a 401 — coreRequest does not refresh, so an expired token is not a verdict', async () => {
    await enqueue({ kind: 'start', payload: { ticketId: 'k1' } });
    const result = await drain(async () => {
      throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    });
    expect(result).toMatchObject({ sent: 0, dropped: [], remaining: 1 });
    await expect(readQueue().then((q) => q.map((w) => w.kind))).resolves.toEqual(['start']);
  });

  it('retains a 403 — the W02 default Partner Technician lacks time_entries:write until granted', async () => {
    await enqueue({ kind: 'start', payload: { ticketId: 'k1' } });
    await enqueue({ kind: 'stop', payload: { isBillable: true } });
    const result = await drain(async () => {
      throw Object.assign(new Error('Permission denied'), { statusCode: 403 });
    });
    expect(result).toMatchObject({ sent: 0, dropped: [], remaining: 2 });
    await expect(readQueue()).resolves.toHaveLength(2);
  });

  it('retains a 429 — a reconnect backlog trips the global rate limit and must be re-sent', async () => {
    await enqueue({ kind: 'stop', payload: {} });
    const result = await drain(async () => {
      throw Object.assign(new Error('Too many requests'), { status: 429 });
    });
    expect(result).toMatchObject({ sent: 0, dropped: [], remaining: 1 });
  });

  it('retains a 408 request timeout', async () => {
    await enqueue({ kind: 'stop', payload: {} });
    const result = await drain(async () => {
      throw Object.assign(new Error('timeout'), { status: 408 });
    });
    expect(result).toMatchObject({ sent: 0, dropped: [], remaining: 1 });
  });

  it('surfaces headAttempts so a caller can tell "offline" from "wedged"', async () => {
    await enqueue({ kind: 'start', payload: {} });
    const first = await drain(async () => {
      throw Object.assign(new Error('denied'), { status: 403 });
    });
    expect(first.headAttempts).toBe(1);
    const second = await drain(async () => {
      throw Object.assign(new Error('denied'), { status: 403 });
    });
    expect(second.headAttempts).toBe(2);
    const drained = await drain(async () => {});
    expect(drained).toMatchObject({ sent: 1, remaining: 0, headAttempts: 0 });
  });

  // --- Dependent writes ---

  it('drops the paired stop when its start was permanently rejected', async () => {
    await enqueue({ kind: 'start', payload: { ticketId: 'gone' } });
    await enqueue({ kind: 'stop', payload: { isBillable: true } });
    const sends: string[] = [];
    const result = await drain(async (w) => {
      sends.push(w.kind);
      if (w.kind === 'start')
        throw Object.assign(new Error('denied'), { status: 404, code: 'TICKET_ORG_DENIED' });
    });
    // The server's stop is a CAS on "whatever entry this user has running" — it
    // takes no entry id — so an orphaned stop would end an unrelated timer.
    expect(sends).toEqual(['start']);
    expect(result.dropped.map((d) => d.kind)).toEqual(['start', 'stop']);
    expect(result).toMatchObject({ sent: 0, remaining: 0 });
  });

  it('still replays a stop whose start was never queued (timer started online)', async () => {
    await enqueue({ kind: 'stop', payload: { isBillable: true } });
    const sends: string[] = [];
    const result = await drain(async (w) => {
      sends.push(w.kind);
    });
    expect(sends).toEqual(['stop']);
    expect(result).toMatchObject({ sent: 1, dropped: [], remaining: 0 });
  });

  it('replays a stop whose paired start succeeded', async () => {
    await enqueue({ kind: 'start', payload: { ticketId: 'k1' } });
    await enqueue({ kind: 'stop', payload: {} });
    const sends: string[] = [];
    const result = await drain(async (w) => {
      sends.push(w.kind);
    });
    expect(sends).toEqual(['start', 'stop']);
    expect(result).toMatchObject({ sent: 2, dropped: [] });
  });

  it('a poison entry is dropped once and never re-sent; later entries drain', async () => {
    await enqueue({ kind: 'stop', payload: {} });
    await enqueue({ kind: 'create', payload: { a: 1 } });
    await enqueue({ kind: 'start', payload: {} });
    const sends: string[] = [];
    const first = await drain(async (w) => {
      sends.push(w.kind);
      if (w.kind === 'stop') throw Object.assign(new Error('bad'), { status: 400 });
      if (w.kind === 'create') throw new Error('offline');
    });
    expect(first.dropped.map((d) => d.kind)).toEqual(['stop']);
    expect(first).toMatchObject({ sent: 0, remaining: 2 });

    const second = await drain(async (w) => {
      sends.push(w.kind);
    });
    expect(second).toMatchObject({ sent: 2, remaining: 0, dropped: [] });
    expect(sends).toEqual(['stop', 'create', 'create', 'start']);
  });

  // --- Storage failures ---

  it('returns an empty queue when storage holds garbage instead of bricking', async () => {
    store.set(QUEUE_KEY, '{not json');
    await expect(readQueue()).resolves.toEqual([]);
    store.set(QUEUE_KEY, JSON.stringify({ nope: true }));
    await expect(readQueue()).resolves.toEqual([]);
  });

  it('quarantines a corrupt blob instead of letting the next write overwrite it', async () => {
    store.set(QUEUE_KEY, '[{"id":"a","kind":"sta');
    await expect(readQueue()).resolves.toEqual([]);
    // The bytes survive the next enqueue, so the rows really are recoverable.
    expect(store.get(QUEUE_CORRUPT_KEY)).toBe('[{"id":"a","kind":"sta');
    expect(Sentry.captureException).toHaveBeenCalled();
    await enqueue({ kind: 'stop', payload: {} });
    expect(store.get(QUEUE_CORRUPT_KEY)).toBe('[{"id":"a","kind":"sta');
  });

  it('discards malformed elements without throwing out of the drain', async () => {
    const good: QueuedWrite = {
      id: 'good',
      kind: 'start',
      payload: { ticketId: 'k1' },
      queuedAt: '2026-08-29T00:00:00.000Z',
      attempts: 0,
    };
    store.set(QUEUE_KEY, JSON.stringify([null, good, 7]));
    await expect(readQueue()).resolves.toEqual([good]);
    const sends: string[] = [];
    const result = await drain(async (w) => {
      sends.push(w.kind);
    });
    expect(sends).toEqual(['start']);
    expect(result).toMatchObject({ sent: 1, remaining: 0 });
  });

  it('a storage READ failure is not an empty queue — enqueue must not clobber the backlog', async () => {
    await enqueue({ kind: 'start', payload: { ticketId: 'k1' } });
    await enqueue({ kind: 'create', payload: { durationMinutes: 45 } });
    const before = store.get(QUEUE_KEY);

    getItemFailures = 1;
    await expect(enqueue({ kind: 'stop', payload: {} })).rejects.toThrow(/unreadable/i);

    // The 2 queued writes are still on disk, not overwritten by [stopWrite].
    expect(store.get(QUEUE_KEY)).toBe(before);
    await expect(readQueue()).resolves.toHaveLength(2);
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('a storage READ failure aborts the drain rather than truncating the queue', async () => {
    await enqueue({ kind: 'start', payload: { ticketId: 'k1' } });
    await enqueue({ kind: 'stop', payload: {} });
    const before = store.get(QUEUE_KEY);

    getItemFailures = 1;
    const sends: string[] = [];
    await expect(
      drain(async (w) => {
        sends.push(w.kind);
      })
    ).rejects.toThrow(/unreadable/i);
    expect(sends).toEqual([]);
    expect(store.get(QUEUE_KEY)).toBe(before);

    // The queue still drains normally once storage recovers.
    const result = await drain(async (w) => {
      sends.push(w.kind);
    });
    expect(sends).toEqual(['start', 'stop']);
    expect(result).toMatchObject({ sent: 2, remaining: 0 });
  });

  it('keeps a write enqueued while a drain is in flight', async () => {
    await enqueue({ kind: 'start', payload: { ticketId: 'k1' } });
    // The tech taps Stop while the reconnect replay is still in flight. That
    // write is unbillable work if the drain's final persist clobbers it.
    const result = await drain(async (w) => {
      if (w.kind === 'start') await enqueue({ kind: 'stop', payload: { isBillable: true } });
    });
    expect(result).toMatchObject({ sent: 1, dropped: [] });
    await expect(readQueue().then((q) => q.map((w) => w.kind))).resolves.toEqual(['stop']);
    expect(result.remaining).toBe(1);
  });

  it('serialises overlapping drains so a write is never sent twice', async () => {
    await enqueue({ kind: 'start', payload: {} });
    await enqueue({ kind: 'stop', payload: {} });
    const sends: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Network flap: useNetworkConnected fires two false->true transitions, so
    // drain is called again before the first replay has finished.
    const first = drain(async (w) => {
      sends.push(w.kind);
      if (w.kind === 'start') await gate;
    });
    const second = drain(async (w) => {
      sends.push(w.kind);
    });
    release();
    const [a, b] = await Promise.all([first, second]);

    // A replayed start would 409 ENTRY_RUNNING and then be dropped as a 4xx,
    // silently losing the entry — so each write must be sent exactly once.
    expect(sends).toEqual(['start', 'stop']);
    expect(a.sent + b.sent).toBe(2);
    expect(b.remaining).toBe(0);
    await expect(readQueue()).resolves.toEqual([]);
  });

  it('persists the payload verbatim across a storage round-trip', async () => {
    const payload = {
      durationMinutes: 30,
      description: 'basement switch swap',
      isBillable: false,
      nested: { ticketId: 'k1', tags: ['onsite', 'afterhours'] },
    };
    await enqueue({ kind: 'create', payload });
    const [persisted] = await readQueue();
    expect(persisted.kind).toBe('create');
    expect(persisted.payload).toEqual(payload);
  });
  // --- Round two: the drop decision has to outlive the pass that made it. ---

  it('never replays an orphaned stop on a LATER drain when its start was dropped', async () => {
    // The drain stops on the transient `create`, so the stop is never visited
    // in the pass that dropped its start — the in-pass skip cannot see it.
    await enqueue({ kind: 'start', payload: { ticketId: 'gone' } });
    await enqueue({ kind: 'create', payload: { durationMinutes: 30 } });
    await enqueue({ kind: 'stop', payload: { isBillable: true } });

    const first = await drain(async (w) => {
      if (w.kind === 'start') throw Object.assign(new Error('gone'), { status: 404 });
      if (w.kind === 'create') throw new Error('offline');
    });
    expect(first.dropped.map((d) => d.kind)).toEqual(['start', 'stop']);
    // Only the create is left. A stop whose start is gone must not survive the
    // pass that dropped it — the server stop is a CAS on "whatever this user
    // has running" and would end an unrelated timer.
    await expect(readQueue().then((q) => q.map((w) => w.kind))).resolves.toEqual(['create']);

    const sends: string[] = [];
    const second = await drain(async (w) => {
      sends.push(w.kind);
    });
    expect(sends).toEqual(['create']);
    expect(second).toMatchObject({ sent: 1, remaining: 0 });
  });

  it('drops a stop enqueued DURING the drain that dropped its start', async () => {
    await enqueue({ kind: 'start', payload: { ticketId: 'gone' } });
    const first = await drain(async (w) => {
      if (w.kind === 'start') {
        // The tech taps Stop while the replay is in flight.
        await enqueue({ kind: 'stop', payload: { isBillable: true } });
        throw Object.assign(new Error('gone'), { status: 404 });
      }
    });
    expect(first.dropped.map((d) => d.kind)).toEqual(['start', 'stop']);
    expect(first).toMatchObject({ sent: 0, remaining: 0 });
    await expect(readQueue()).resolves.toEqual([]);

    const sends: string[] = [];
    await drain(async (w) => {
      sends.push(w.kind);
    });
    expect(sends).toEqual([]);
  });

  it('keeps a stop whose EARLIER start landed when a later start was rejected', async () => {
    // startTimer auto-stops the previous timer, so after both starts replay the
    // running entry is B. If B is rejected, A is still running and this stop
    // legitimately closes it — discarding the stop leaves A open forever.
    await enqueue({ kind: 'start', payload: { ticketId: 'a' } });
    await enqueue({ kind: 'start', payload: { ticketId: 'b' } });
    await enqueue({ kind: 'stop', payload: { isBillable: true } });

    const sends: string[] = [];
    const result = await drain(async (w) => {
      sends.push(`${w.kind}:${String(w.payload.ticketId ?? '')}`);
      if (w.payload.ticketId === 'b') throw Object.assign(new Error('gone'), { status: 404 });
    });
    expect(sends).toEqual(['start:a', 'start:b', 'stop:']);
    expect(result.dropped.map((d) => d.payload.ticketId)).toEqual(['b']);
    expect(result).toMatchObject({ sent: 2, remaining: 0 });
  });

  it('does not re-send transmitted writes when the drain final re-read fails', async () => {
    await enqueue({ kind: 'create', payload: { durationMinutes: 30 } });
    await enqueue({ kind: 'create', payload: { durationMinutes: 45 } });

    const firstSends: number[] = [];
    const first = await drain(async (w) => {
      firstSends.push(w.payload.durationMinutes as number);
      // Storage goes busy exactly when the drain goes to reconcile the queue.
      if (w.payload.durationMinutes === 45) failNextQueueRead = true;
    });
    expect(firstSends).toEqual([30, 45]);
    expect(first.sent).toBe(2);

    // A duplicate create is a duplicate billable line on the customer invoice.
    const secondSends: number[] = [];
    const second = await drain(async (w) => {
      secondSends.push(w.payload.durationMinutes as number);
    });
    expect(secondSends).toEqual([]);
    expect(second).toMatchObject({ sent: 0, remaining: 0 });
  });

  it('a write enqueued during a drain whose re-read fails is still replayed', async () => {
    await enqueue({ kind: 'create', payload: { durationMinutes: 30 } });
    await drain(async (w) => {
      if (w.payload.durationMinutes === 30) {
        await enqueue({ kind: 'create', payload: { durationMinutes: 15 } });
        failNextQueueRead = true;
      }
    });
    const sends: number[] = [];
    await drain(async (w) => {
      sends.push(w.payload.durationMinutes as number);
    });
    expect(sends).toEqual([15]);
  });

  it('refuses to report a quarantine that did not happen, and keeps the bytes', async () => {
    setItemFailKeys.add(QUEUE_CORRUPT_KEY);
    store.set(QUEUE_KEY, '[{"id":"a","kind":"sta');

    // Returning [] here would let the very next write destroy the only copy of
    // the rows while Sentry claims they were parked.
    await expect(readQueue()).rejects.toThrow(/unreadable/i);
    expect(lastSentryExtra()).toMatchObject({ reason: 'unparseable-queue', parked: false });

    await expect(enqueue({ kind: 'stop', payload: {} })).rejects.toThrow(/unreadable/i);
    expect(store.get(QUEUE_KEY)).toBe('[{"id":"a","kind":"sta');
  });

  it('reports parked:true when the corrupt blob really was copied aside', async () => {
    store.set(QUEUE_KEY, '[{"id":"a","kind":"sta');
    await expect(readQueue()).resolves.toEqual([]);
    expect(lastSentryExtra()).toMatchObject({ reason: 'unparseable-queue', parked: true });
    expect(store.get(QUEUE_CORRUPT_KEY)).toBe('[{"id":"a","kind":"sta');
  });
  it('honours a dependsOn persisted by the first build as a bare string', async () => {
    // Rows already on a tester's phone were written before dependsOn became a
    // list; losing the link on upgrade would send those stops as orphans.
    store.set(
      QUEUE_KEY,
      JSON.stringify([
        { id: 'a', kind: 'start', payload: { ticketId: 'gone' }, queuedAt: '2026-08-29T00:00:00.000Z', attempts: 0 },
        { id: 'b', kind: 'stop', payload: {}, queuedAt: '2026-08-29T01:00:00.000Z', attempts: 0, dependsOn: 'a' },
      ])
    );
    const sends: string[] = [];
    const result = await drain(async (w) => {
      sends.push(w.id);
      if (w.id === 'a') throw Object.assign(new Error('gone'), { status: 404 });
    });
    expect(sends).toEqual(['a']);
    expect(result.dropped.map((d) => d.id)).toEqual(['a', 'b']);
  });
});
