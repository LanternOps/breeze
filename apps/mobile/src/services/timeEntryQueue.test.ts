import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, string>();
let getItemFailures = 0;
/**
 * Fails the NEXT read of the queue blob only. Counting getItem calls is brittle
 * (the module reads more than one key), so tests arm this from inside a `send`
 * callback to target the re-read at the end of a drain specifically.
 */
let failNextQueueRead = false;
/** Same, for the parked-rows blob, which the sign-out park reads third. */
let failNextNeedsAttentionRead = false;
/** Keys whose setItem rejects, so a failed quarantine copy can be exercised. */
const setItemFailKeys = new Set<string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => {
      // Literal, not the imported const: this factory is hoisted above imports.
      if (failNextQueueRead && k === 'breeze.timeEntryQueue.v2') {
        failNextQueueRead = false;
        throw new Error('SQLite busy');
      }
      if (failNextNeedsAttentionRead && k === 'breeze.timeEntryQueue.v2.needsAttention') {
        failNextNeedsAttentionRead = false;
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
  readNeedsAttention,
  clearNeedsAttention,
  parkNeedsAttention,
  clearQueueForSignOut,
  reconcileQueueOwner,
  readOrphanedQueues,
  QUEUE_ORPHANED_KEY,
  QUEUE_OWNER_KEY,
  QUEUE_KEY,
  QUEUE_CORRUPT_KEY,
  QUEUE_NEEDS_ATTENTION_KEY,
  QUEUE_TOMBSTONE_KEY,
  QUEUED_KINDS,
} from './timeEntryQueue';
import type { QueuedWrite } from './timeEntryQueue';

beforeEach(() => {
  store.clear();
  getItemFailures = 0;
  failNextQueueRead = false;
  failNextNeedsAttentionRead = false;
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

const SPAN = { startedAt: '2026-08-30T09:00:00.000Z', endedAt: '2026-08-30T09:40:00.000Z' };

describe('the queue can only hold self-timestamped writes', () => {
  // The whole offline-span design rests on this: `/time-entries/start` and
  // `/time-entries/stop` are SERVER-STAMPED verbs, so queueing one defers its
  // stamping to an arbitrary later moment and silently rewrites the customer's
  // bill. Making the union runtime-inspectable is what lets a test pin it.
  it('QUEUED_KINDS contains neither start nor stop', () => {
    expect([...QUEUED_KINDS].sort()).toEqual([
      'closeEntry', 'create', 'suggestion.confirm', 'suggestion.dismiss',
    ]);
    expect(QUEUED_KINDS).not.toContain('start');
    expect(QUEUED_KINDS).not.toContain('stop');
  });

  it('enqueue never produces a dependsOn key on any write', async () => {
    // `dependsOn` existed only to pair a queued start with the stop that closed
    // it. With no start to pair, a surviving field is a heuristic waiting to be
    // reintroduced — so assert on the KEY, not on a falsy value.
    const created = await enqueue({ kind: 'create', payload: { ...SPAN } });
    const closed = await enqueue({ kind: 'closeEntry', payload: { id: 'E', endedAt: SPAN.endedAt } });
    for (const write of [created, closed]) {
      expect(Object.prototype.hasOwnProperty.call(write, 'dependsOn')).toBe(false);
    }
    for (const write of await readQueue()) {
      expect(Object.prototype.hasOwnProperty.call(write, 'dependsOn')).toBe(false);
    }
    const raw = JSON.parse(store.get(QUEUE_KEY) ?? '[]') as Array<Record<string, unknown>>;
    for (const row of raw) {
      expect(Object.prototype.hasOwnProperty.call(row, 'dependsOn')).toBe(false);
    }
  });

  it('refuses a persisted row whose kind is a server-stamped verb', async () => {
    // A row written by the pre-v2 build (or a future one) must not resurrect a
    // timer verb through the untyped storage boundary.
    store.set(
      QUEUE_KEY,
      JSON.stringify([
        { id: 'a', kind: 'start', payload: {}, queuedAt: '2026-08-30T09:00:00.000Z', attempts: 0 },
        { id: 'b', kind: 'create', payload: SPAN, queuedAt: '2026-08-30T09:00:00.000Z', attempts: 0 },
      ])
    );
    const kept = await readQueue();
    expect(kept.map((w) => w.kind)).toEqual(['create']);
  });
});

describe('timeEntryQueue', () => {
  it('replays writes in the order they were made', async () => {
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'k1' } });
    await enqueue({ kind: 'closeEntry', payload: { id: 'E', endedAt: SPAN.endedAt } });
    const seen: string[] = [];
    const result = await drain(async (w) => {
      seen.push(w.kind);
    });
    expect(seen).toEqual(['create', 'closeEntry']);
    expect(result).toMatchObject({ sent: 2, remaining: 0, needsAttention: [] });
    await expect(readQueue()).resolves.toEqual([]);
  });

  it('enqueue stamps id, queuedAt and attempts=0 and is durable across a fresh readQueue', async () => {
    const item = await enqueue({ kind: 'create', payload: { ...SPAN } });
    expect(item.id).toEqual(expect.any(String));
    expect(item.id.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(item.queuedAt))).toBe(false);
    expect(item.attempts).toBe(0);

    // Durability: nothing cached in memory — a fresh read goes back to storage.
    const persisted = await readQueue();
    expect(persisted).toEqual([item]);
    expect(store.has(QUEUE_KEY)).toBe(true);

    // Two enqueues get distinct ids.
    const second = await enqueue({ kind: 'closeEntry', payload: { id: 'E', endedAt: SPAN.endedAt } });
    expect(second.id).not.toBe(item.id);
    await expect(readQueue()).resolves.toHaveLength(2);
  });

  it('stops draining on a transport failure and keeps the rest queued', async () => {
    await enqueue({ kind: 'create', payload: { ...SPAN } });
    await enqueue({ kind: 'closeEntry', payload: { id: 'E', endedAt: SPAN.endedAt } });
    const result = await drain(async (w) => {
      if (w.kind === 'create') throw Object.assign(new Error('offline'), { status: undefined });
    });
    // Order matters more than throughput: a correction must never land before
    // the entry it corrects.
    expect(result).toMatchObject({ sent: 0, remaining: 2, needsAttention: [] });
    const queue = await readQueue();
    expect(queue.map((q) => q.kind)).toEqual(['create', 'closeEntry']);
  });

  it('increments attempts on the write that failed transiently, and persists it', async () => {
    await enqueue({ kind: 'create', payload: { ...SPAN } });
    await enqueue({ kind: 'closeEntry', payload: { id: 'E', endedAt: SPAN.endedAt } });
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
    await enqueue({ kind: 'create', payload: { ...SPAN } });
    const result = await drain(async () => {
      throw Object.assign(new Error('boom'), { status: 500 });
    });
    expect(result).toMatchObject({ sent: 0, remaining: 1, needsAttention: [] });
  });

  it('parks a permanently-rejected write instead of blocking the queue forever', async () => {
    await enqueue({ kind: 'closeEntry', payload: { id: 'gone', endedAt: SPAN.endedAt } });
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'k2' } });
    const result = await drain(async (w) => {
      if (w.kind === 'closeEntry')
        throw Object.assign(new Error('no entry'), { status: 404, code: 'ENTRY_NOT_FOUND' });
    });
    // A 4xx will never succeed on retry — parking it lets the queue progress.
    expect(result.needsAttention.map((d) => d.kind)).toEqual(['closeEntry']);
    expect(result).toMatchObject({ sent: 1, remaining: 0, needsAttentionTotal: 1 });
    await expect(readQueue()).resolves.toEqual([]);
  });

  it('recognises the statusCode alias used by TimeEntryError as a permanent failure', async () => {
    await enqueue({ kind: 'closeEntry', payload: { id: 'E', endedAt: SPAN.endedAt } });
    await enqueue({ kind: 'create', payload: { ...SPAN } });
    const result = await drain(async (w) => {
      if (w.kind === 'closeEntry')
        throw Object.assign(new Error('running'), { statusCode: 409, code: 'ENTRY_RUNNING' });
    });
    expect(result.needsAttention.map((d) => d.kind)).toEqual(['closeEntry']);
    expect(result).toMatchObject({ sent: 1, remaining: 0 });
  });

  it('parks a 422 as a payload verdict', async () => {
    await enqueue({ kind: 'create', payload: { ...SPAN } });
    const result = await drain(async () => {
      throw Object.assign(new Error('unprocessable'), { status: 422 });
    });
    expect(result.needsAttention.map((d) => d.kind)).toEqual(['create']);
    expect(result).toMatchObject({ sent: 0, remaining: 0 });
  });

  // --- Retriable 4xx: these codes succeed on a later attempt, so dropping them
  // destroys billable work that was recoverable. ---

  it('retains a 401 — coreRequest does not refresh, so an expired token is not a verdict', async () => {
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'k1' } });
    const result = await drain(async () => {
      throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    });
    expect(result).toMatchObject({ sent: 0, needsAttention: [], remaining: 1 });
    const [head] = await readQueue();
    expect(head.attempts).toBe(1);
    expect(head.kind).toBe('create');
  });

  it('retains a 403 — the W02 default Partner Technician lacks time_entries:write until granted', async () => {
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'k1' } });
    await enqueue({ kind: 'closeEntry', payload: { id: 'E', endedAt: SPAN.endedAt } });
    const result = await drain(async () => {
      throw Object.assign(new Error('Permission denied'), { statusCode: 403 });
    });
    expect(result).toMatchObject({ sent: 0, needsAttention: [], remaining: 2 });
    await expect(readQueue()).resolves.toHaveLength(2);
  });

  it('retains a 429 — a reconnect backlog trips the global rate limit and must be re-sent', async () => {
    await enqueue({ kind: 'closeEntry', payload: { id: 'E', endedAt: SPAN.endedAt } });
    const result = await drain(async () => {
      throw Object.assign(new Error('Too many requests'), { status: 429 });
    });
    expect(result).toMatchObject({ sent: 0, needsAttention: [], remaining: 1 });
    const [head] = await readQueue();
    expect(head.attempts).toBe(1);
  });

  it('retains a 408 request timeout', async () => {
    await enqueue({ kind: 'closeEntry', payload: { id: 'E', endedAt: SPAN.endedAt } });
    const result = await drain(async () => {
      throw Object.assign(new Error('timeout'), { status: 408 });
    });
    expect(result).toMatchObject({ sent: 0, needsAttention: [], remaining: 1 });
  });

  it('surfaces headAttempts so a caller can tell "offline" from "wedged"', async () => {
    await enqueue({ kind: 'create', payload: { ...SPAN } });
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

  // --- Needs-attention: a permanent rejection parks the work, never deletes it.

  it('a 400-rejected write is gone from the queue but READABLE from needs-attention', async () => {
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'k9' } });
    const result = await drain(async () => {
      throw Object.assign(new Error('startedAt is too far in the future'), {
        status: 400,
        code: 'VALIDATION_ERROR',
      });
    });

    // Not merely "one was dropped" — the row itself has to come back.
    expect(result.needsAttentionTotal).toBe(1);
    await expect(readQueue()).resolves.toEqual([]);
    expect(JSON.parse(store.get(QUEUE_KEY) ?? '[]')).toEqual([]);

    const parked = await readNeedsAttention();
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'startedAt is too far in the future',
    });
    expect(parked[0].write.kind).toBe('create');
    expect(parked[0].write.payload).toMatchObject({ ticketId: 'k9', startedAt: SPAN.startedAt });
    expect(Number.isNaN(Date.parse(parked[0].failedAt))).toBe(false);
  });

  it('parks a row a caller could never enqueue, so unsendable work still surfaces', async () => {
    // A local timer whose device clock moved backwards mid-span has no valid
    // span to enqueue. That is still a record of real work and must reach the
    // same place a server-rejected write does.
    const landed = await parkNeedsAttention({
      write: {
        id: 'local-1',
        kind: 'create',
        payload: { ...SPAN, ticketId: 'k1' },
        queuedAt: '2026-08-30T09:40:00.000Z',
        attempts: 0,
      },
      status: 0,
      code: 'CLOCK_WENT_BACKWARDS',
      message: 'The device clock changed while this timer ran — enter it manually.',
      failedAt: '2026-08-30T09:40:00.000Z',
    });
    expect(landed).toBe(true);
    const parked = await readNeedsAttention();
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ code: 'CLOCK_WENT_BACKWARDS' });
    expect(parked[0].write.payload).toMatchObject({ ticketId: 'k1' });
    // The queue itself is untouched — this was never a queued write.
    await expect(readQueue()).resolves.toEqual([]);
  });

  it('needs-attention rows survive a later drain and can be cleared by id', async () => {
    const write = await enqueue({ kind: 'create', payload: { ...SPAN } });
    await drain(async () => {
      throw Object.assign(new Error('bad'), { status: 400 });
    });
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'later' } });
    await drain(async () => {});
    await expect(readNeedsAttention()).resolves.toHaveLength(1);

    await clearNeedsAttention([write.id]);
    await expect(readNeedsAttention()).resolves.toEqual([]);
    expect(store.get(QUEUE_NEEDS_ATTENTION_KEY)).toBe('[]');
  });

  it('keeps the write queued rather than losing it when the park itself fails', async () => {
    // Parking is the only thing that makes a permanent rejection non-destructive.
    // If it cannot happen, the honest outcome is a wedged queue, not a deletion.
    setItemFailKeys.add(QUEUE_NEEDS_ATTENTION_KEY);
    await enqueue({ kind: 'create', payload: { ...SPAN } });
    const result = await drain(async () => {
      throw Object.assign(new Error('bad'), { status: 400 });
    });
    expect(result).toMatchObject({ sent: 0, needsAttention: [], remaining: 1 });
    await expect(readQueue()).resolves.toHaveLength(1);
  });

  it('refuses the park rather than overwriting the store when its own read fails', async () => {
    // A failed read of the needs-attention blob is NOT an empty store. Pushing
    // onto [] persists ONE row over every previously parked one AND reports
    // success, and the drain's next step on a `true` is to drop the queued
    // original — the same silent destruction of billable work that `readQueue`
    // refuses on the queue side.
    const first = await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'first' } });
    await drain(async () => {
      throw Object.assign(new Error('bad'), { status: 400 });
    });
    await expect(readNeedsAttention()).resolves.toHaveLength(1);

    getItemFailures = 1;
    const landed = await parkNeedsAttention({
      write: { id: 'clock-backwards', kind: 'create', payload: { ...SPAN }, queuedAt: SPAN.startedAt, attempts: 0 },
      status: 0,
      code: 'CLOCK_WENT_BACKWARDS',
      message: 'the device clock moved backwards mid-span',
      failedAt: SPAN.endedAt,
    });

    expect(landed).toBe(false);
    const rows = await readNeedsAttention();
    expect(rows).toHaveLength(1);
    expect(rows[0].write.id).toBe(first.id);
  });

  it('leaves every parked row in place when the read behind a clear fails', async () => {
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'a' } });
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'b' } });
    await drain(async () => {
      throw Object.assign(new Error('bad'), { status: 400 });
    });
    const parked = await readNeedsAttention();
    expect(parked).toHaveLength(2);

    getItemFailures = 1;
    await clearNeedsAttention([parked[0].write.id]);

    // A clear that could not read the store must not write one either: the
    // rows it would persist are [] and both records would be gone.
    await expect(readNeedsAttention()).resolves.toHaveLength(2);
  });

  it('a poison entry is parked once and never re-sent; later entries drain', async () => {
    await enqueue({ kind: 'closeEntry', payload: { id: 'E', endedAt: SPAN.endedAt } });
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'a' } });
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'b' } });
    const sends: string[] = [];
    const first = await drain(async (w) => {
      sends.push(w.kind);
      if (w.kind === 'closeEntry') throw Object.assign(new Error('bad'), { status: 400 });
      if (w.payload.ticketId === 'a') throw new Error('offline');
    });
    expect(first.needsAttention.map((d) => d.kind)).toEqual(['closeEntry']);
    expect(first).toMatchObject({ sent: 0, remaining: 2 });

    const second = await drain(async (w) => {
      sends.push(w.kind);
    });
    expect(second).toMatchObject({ sent: 2, remaining: 0, needsAttention: [] });
    expect(sends).toEqual(['closeEntry', 'create', 'create', 'create']);
  });

  // --- Send-time bounds ---

  it('persists a payload the sender rewrote in place, so a retry sees the shifted bounds', async () => {
    // The replay sender translates a future-dated span back into the past using
    // the server clock. A retry must compare like with like, so the rewrite has
    // to survive to storage rather than being recomputed from the original.
    await enqueue({ kind: 'create', payload: { ...SPAN } });
    await drain(async (w) => {
      w.payload.startedAt = '2026-08-30T08:00:00.000Z';
      w.payload.endedAt = '2026-08-30T08:40:00.000Z';
      throw new Error('offline');
    });
    const [head] = await readQueue();
    expect(head.payload).toMatchObject({
      startedAt: '2026-08-30T08:00:00.000Z',
      endedAt: '2026-08-30T08:40:00.000Z',
    });
    expect(typeof head.sentAt).toBe('string');
    expect(Number.isNaN(Date.parse(head.sentAt ?? ''))).toBe(false);
  });

  // --- Storage failures ---

  it('returns an empty queue when storage holds garbage instead of bricking', async () => {
    store.set(QUEUE_KEY, '{not json');
    await expect(readQueue()).resolves.toEqual([]);
    store.set(QUEUE_KEY, JSON.stringify({ nope: true }));
    await expect(readQueue()).resolves.toEqual([]);
  });

  it('quarantines a corrupt blob instead of letting the next write overwrite it', async () => {
    store.set(QUEUE_KEY, '[{"id":"a","kind":"cre');
    await expect(readQueue()).resolves.toEqual([]);
    // The bytes survive the next enqueue, so the rows really are recoverable.
    expect(store.get(QUEUE_CORRUPT_KEY)).toBe('[{"id":"a","kind":"cre');
    expect(Sentry.captureException).toHaveBeenCalled();
    await enqueue({ kind: 'create', payload: { ...SPAN } });
    expect(store.get(QUEUE_CORRUPT_KEY)).toBe('[{"id":"a","kind":"cre');
  });

  it('discards malformed elements without throwing out of the drain', async () => {
    const good: QueuedWrite = {
      id: 'good',
      kind: 'create',
      payload: { ...SPAN, ticketId: 'k1' },
      queuedAt: '2026-08-29T00:00:00.000Z',
      attempts: 0,
    };
    store.set(QUEUE_KEY, JSON.stringify([null, good, 7]));
    await expect(readQueue()).resolves.toEqual([good]);
    const sends: string[] = [];
    const result = await drain(async (w) => {
      sends.push(w.kind);
    });
    expect(sends).toEqual(['create']);
    expect(result).toMatchObject({ sent: 1, remaining: 0 });
  });

  it('a storage READ failure is not an empty queue — enqueue must not clobber the backlog', async () => {
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'k1' } });
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'k2' } });
    const before = store.get(QUEUE_KEY);

    getItemFailures = 1;
    await expect(
      enqueue({ kind: 'closeEntry', payload: { id: 'E', endedAt: SPAN.endedAt } })
    ).rejects.toThrow(/unreadable/i);

    // The 2 queued writes are still on disk, not overwritten by [closeWrite].
    expect(store.get(QUEUE_KEY)).toBe(before);
    await expect(readQueue()).resolves.toHaveLength(2);
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('a storage READ failure aborts the drain rather than truncating the queue', async () => {
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'k1' } });
    await enqueue({ kind: 'closeEntry', payload: { id: 'E', endedAt: SPAN.endedAt } });
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
    expect(sends).toEqual(['create', 'closeEntry']);
    expect(result).toMatchObject({ sent: 2, remaining: 0 });
  });

  it('keeps a write enqueued while a drain is in flight', async () => {
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'k1' } });
    // The tech taps Stop while the reconnect replay is still in flight. That
    // write is unbillable work if the drain's final persist clobbers it.
    const result = await drain(async (w) => {
      if (w.kind === 'create')
        await enqueue({ kind: 'closeEntry', payload: { id: 'E', endedAt: SPAN.endedAt } });
    });
    expect(result).toMatchObject({ sent: 1, needsAttention: [] });
    await expect(readQueue().then((q) => q.map((w) => w.kind))).resolves.toEqual(['closeEntry']);
    expect(result.remaining).toBe(1);
  });

  it('serialises overlapping drains so a write is never sent twice', async () => {
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'a' } });
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'b' } });
    const sends: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Network flap: useNetworkConnected fires two false->true transitions, so
    // drain is called again before the first replay has finished.
    const first = drain(async (w) => {
      sends.push(String(w.payload.ticketId));
      if (w.payload.ticketId === 'a') await gate;
    });
    const second = drain(async (w) => {
      sends.push(String(w.payload.ticketId));
    });
    release();
    const [a, b] = await Promise.all([first, second]);

    // A duplicate create is a duplicate billable line on the customer invoice,
    // so each write must be sent exactly once.
    expect(sends).toEqual(['a', 'b']);
    expect(a.sent + b.sent).toBe(2);
    expect(b.remaining).toBe(0);
    await expect(readQueue()).resolves.toEqual([]);
  });

  it('persists the payload verbatim across a storage round-trip', async () => {
    const payload = {
      ...SPAN,
      description: 'basement switch swap',
      isBillable: false,
      nested: { ticketId: 'k1', tags: ['onsite', 'afterhours'] },
    };
    await enqueue({ kind: 'create', payload });
    const [persisted] = await readQueue();
    expect(persisted.kind).toBe('create');
    expect(persisted.payload).toEqual(payload);
  });

  // --- Round two: a resolved write must stay resolved across a storage hiccup.

  it('does not re-send transmitted writes when the drain final re-read fails', async () => {
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'a' } });
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'b' } });

    const firstSends: string[] = [];
    const first = await drain(async (w) => {
      firstSends.push(String(w.payload.ticketId));
      // Storage goes busy exactly when the drain goes to reconcile the queue.
      if (w.payload.ticketId === 'b') failNextQueueRead = true;
    });
    expect(firstSends).toEqual(['a', 'b']);
    expect(first.sent).toBe(2);

    // A duplicate create is a duplicate billable line on the customer invoice.
    const secondSends: string[] = [];
    const second = await drain(async (w) => {
      secondSends.push(String(w.payload.ticketId));
    });
    expect(secondSends).toEqual([]);
    expect(second).toMatchObject({ sent: 0, remaining: 0 });
  });

  it('a write enqueued during a drain whose re-read fails is still replayed', async () => {
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'a' } });
    await drain(async (w) => {
      if (w.payload.ticketId === 'a') {
        await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'b' } });
        failNextQueueRead = true;
      }
    });
    const sends: string[] = [];
    await drain(async (w) => {
      sends.push(String(w.payload.ticketId));
    });
    expect(sends).toEqual(['b']);
  });

  it('refuses to report a quarantine that did not happen, and keeps the bytes', async () => {
    setItemFailKeys.add(QUEUE_CORRUPT_KEY);
    store.set(QUEUE_KEY, '[{"id":"a","kind":"cre');

    // Returning [] here would let the very next write destroy the only copy of
    // the rows while Sentry claims they were parked.
    await expect(readQueue()).rejects.toThrow(/unreadable/i);
    expect(lastSentryExtra()).toMatchObject({ reason: 'unparseable-queue', parked: false });

    await expect(enqueue({ kind: 'create', payload: { ...SPAN } })).rejects.toThrow(/unreadable/i);
    expect(store.get(QUEUE_KEY)).toBe('[{"id":"a","kind":"cre');
  });

  it('reports parked:true when the corrupt blob really was copied aside', async () => {
    store.set(QUEUE_KEY, '[{"id":"a","kind":"cre');
    await expect(readQueue()).resolves.toEqual([]);
    expect(lastSentryExtra()).toMatchObject({ reason: 'unparseable-queue', parked: true });
    expect(store.get(QUEUE_CORRUPT_KEY)).toBe('[{"id":"a","kind":"cre');
  });

  // --- Sign-out, session loss, and the drain that outlives both ---

  it('parks and clears the queue on a deliberate sign-out', async () => {
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'k1' } });
    const outcome = await clearQueueForSignOut();

    expect(outcome).toMatchObject({ cleared: 1, parked: true });
    await expect(readQueue()).resolves.toEqual([]);
    const orphaned = await readOrphanedQueues();
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].writes[0].payload).toMatchObject({ ticketId: 'k1' });
  });

  it('APPENDS to the orphan park, so a second sign-out cannot destroy the first', async () => {
    // The park is the only remaining copy of unsent billable work. Overwriting
    // it turns "recoverable by hand" into a claim nobody can act on.
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'first' } });
    await clearQueueForSignOut();
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'second' } });
    await clearQueueForSignOut();

    const orphaned = await readOrphanedQueues();
    expect(orphaned).toHaveLength(2);
    expect(orphaned.flatMap((batch) => batch.writes.map((w) => w.payload.ticketId))).toEqual([
      'first',
      'second',
    ]);
  });

  it('refuses to delete the queue when the park did not happen', async () => {
    // Deleting anyway was the defect: the failure was swallowed while the only
    // copy of the work was destroyed. Keeping it leaves the (already narrow)
    // cross-account window to `reconcileQueueOwner`, which closes it at the
    // next sign-in without losing anything.
    setItemFailKeys.add(QUEUE_ORPHANED_KEY);
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'k1' } });

    await expect(clearQueueForSignOut()).rejects.toThrow(/could not be parked/i);
    await expect(readQueue()).resolves.toHaveLength(1);
    expect(lastSentryExtra()).toMatchObject({ reason: 'sign-out', parked: false });
  });

  it('refuses the sign-out when the parked rows cannot be read', async () => {
    // The last act of the park is `setItem(QUEUE_NEEDS_ATTENTION_KEY, '[]')`.
    // Rows that could not be read were never copied into the orphan batch, so
    // proceeding would wipe them — the same rule as a failed park: never delete
    // what you could not back up first.
    await enqueue({ kind: 'create', payload: { ...SPAN } });
    await drain(async () => {
      throw Object.assign(new Error('bad'), { status: 400 });
    });
    await expect(readNeedsAttention()).resolves.toHaveLength(1);

    failNextNeedsAttentionRead = true;
    await expect(clearQueueForSignOut()).rejects.toThrow(/could not be parked/i);

    await expect(readNeedsAttention()).resolves.toHaveLength(1);
  });

  it('parks the needs-attention rows too — they are the previous account\'s work as well', async () => {
    await enqueue({ kind: 'create', payload: { ...SPAN } });
    await drain(async () => {
      throw Object.assign(new Error('bad'), { status: 400 });
    });
    await expect(readNeedsAttention()).resolves.toHaveLength(1);

    await clearQueueForSignOut();
    await expect(readNeedsAttention()).resolves.toEqual([]);
    expect((await readOrphanedQueues())[0].needsAttention).toHaveLength(1);
  });

  it('an in-flight drain cannot write the queue back after a sign-out cleared it', async () => {
    // The drain holds a snapshot taken before the sign-out. Persisting it would
    // hand the previous technician's unsent entries straight to the next
    // account — re-opening the exact leak the sign-out wipe exists to close.
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'a' } });
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'b' } });

    const result = await drain(async (write) => {
      if (write.payload.ticketId === 'a') await clearQueueForSignOut();
      // 'b' fails transiently, so the pre-fix code would persist it back.
      if (write.payload.ticketId === 'b') throw new Error('offline');
    });

    expect(result.remaining).toBe(0);
    await expect(readQueue()).resolves.toEqual([]);
    expect(JSON.parse(store.get(QUEUE_KEY) ?? '[]')).toEqual([]);
  });

  it('an in-flight drain does not leave a tombstone behind a sign-out either', async () => {
    // Same race on the storage-failure path: the tombstone names ids from a
    // queue that no longer exists, and applying it to the NEXT account's queue
    // could silently swallow their writes if an id ever collided.
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'a' } });
    await drain(async () => {
      await clearQueueForSignOut();
      failNextQueueRead = true;
    });
    expect(store.has(QUEUE_TOMBSTONE_KEY)).toBe(false);
  });

  it('keeps the queue for an INVOLUNTARY session loss — that is a token expiry, not a sign-out', async () => {
    // A technician who worked offline all day and whose token expired must not
    // lose the backlog: `clearQueueForSignOut` is only reached on a deliberate
    // sign-out now, and ownership is what protects the next account.
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'k1' } });
    await reconcileQueueOwner('user-a');
    // The same technician signs back in after the token expiry.
    const outcome = await reconcileQueueOwner('user-a');
    expect(outcome).toBeNull();
    await expect(readQueue()).resolves.toHaveLength(1);
  });

  it('parks and clears a queue owned by a DIFFERENT account at sign-in', async () => {
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'k1' } });
    await reconcileQueueOwner('user-a');

    const outcome = await reconcileQueueOwner('user-b');
    expect(outcome).toMatchObject({ cleared: 1 });
    await expect(readQueue()).resolves.toEqual([]);
    expect((await readOrphanedQueues())[0].owner).toBe('user-a');
    expect(store.get(QUEUE_OWNER_KEY)).toBe('user-b');
  });

  it('adopts an unowned queue rather than destroying it', async () => {
    // A queue written before the owner stamp existed, or by this same account
    // before the first reconcile. Deleting it would lose real work for no gain.
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'k1' } });
    expect(await reconcileQueueOwner('user-a')).toBeNull();
    await expect(readQueue()).resolves.toHaveLength(1);
    expect(store.get(QUEUE_OWNER_KEY)).toBe('user-a');
  });

  it('a drain that started before an owner switch cannot restore the old queue', async () => {
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'a' } });
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'b' } });
    await reconcileQueueOwner('user-a');

    const result = await drain(async (write) => {
      if (write.payload.ticketId === 'a') await reconcileQueueOwner('user-b');
      if (write.payload.ticketId === 'b') throw new Error('offline');
    });
    expect(result.remaining).toBe(0);
    await expect(readQueue()).resolves.toEqual([]);
  });
});


// ── W06 (#3900): suggestion writes ─────────────────────────────────────────
describe('suggestion writes', () => {
  const SIG_A = { kind: 'remote_session', id: 'aaaa1111-0000-4000-8000-000000000001' };
  const SIG_B = { kind: 'remote_session', id: 'bbbb2222-0000-4000-8000-000000000002' };
  const confirmWrite = (dedupeKey: string) => ({
    kind: 'suggestion.confirm' as const,
    payload: { signals: [SIG_A], startedAt: '2026-08-29T10:00:00.000Z', endedAt: '2026-08-29T10:45:00.000Z' },
    dedupeKey,
  });

  it('accepts the two new kinds through a cold-start reparse', async () => {
    await enqueue(confirmWrite('suggestion.confirm:remote_session:a'));
    await enqueue({ kind: 'suggestion.dismiss', payload: { signals: [SIG_B] }, dedupeKey: 'suggestion.dismiss:remote_session:b' });
    const queue = await readQueue();
    expect(queue.map((w) => w.kind)).toEqual(['suggestion.confirm', 'suggestion.dismiss']);
  });

  it('preserves dedupeKey across a cold start, or dedupe silently stops working', async () => {
    await enqueue(confirmWrite('KEY-1'));
    // Re-read from storage: this is the path a fresh app launch takes.
    const queue = await readQueue();
    expect(queue[0]!.dedupeKey).toBe('KEY-1');
  });

  it('the same suggestion key enqueued twice collapses to one queued write', async () => {
    const first = await enqueue(confirmWrite('KEY-1'));
    const second = await enqueue(confirmWrite('KEY-1'));
    expect(await readQueue()).toHaveLength(1);
    // The caller gets the row that is actually queued, not a phantom second id.
    expect(second.id).toBe(first.id);
  });

  it('a different key still enqueues separately', async () => {
    await enqueue(confirmWrite('KEY-1'));
    await enqueue(confirmWrite('KEY-2'));
    expect(await readQueue()).toHaveLength(2);
  });

  it('writes WITHOUT a dedupeKey never collapse — two identical manual entries are two entries', async () => {
    const payload = { startedAt: '2026-08-29T10:00:00.000Z', endedAt: '2026-08-29T10:45:00.000Z' };
    await enqueue({ kind: 'create', payload });
    await enqueue({ kind: 'create', payload });
    expect(await readQueue()).toHaveLength(2);
  });

  it('a suggestion write that already drained does not block re-enqueueing the same key later', async () => {
    await enqueue(confirmWrite('KEY-1'));
    await drain(async () => {});
    expect(await readQueue()).toHaveLength(0);
    await enqueue(confirmWrite('KEY-1'));
    expect(await readQueue()).toHaveLength(1);
  });

  it('a queued confirm survives a cold start and drains on reconnect', async () => {
    await enqueue(confirmWrite('KEY-1'));
    const sent: QueuedWrite[] = [];
    const result = await drain(async (write) => { sent.push(write); });
    expect(sent.map((w) => w.kind)).toEqual(['suggestion.confirm']);
    expect(result.sent).toBe(1);
    expect(await readQueue()).toHaveLength(0);
  });
});
