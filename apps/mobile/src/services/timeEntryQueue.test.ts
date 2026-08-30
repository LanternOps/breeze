import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: async (k: string) => {
      store.delete(k);
    },
  },
}));

import { enqueue, readQueue, drain, QUEUE_KEY } from './timeEntryQueue';
import type { QueuedWrite } from './timeEntryQueue';

beforeEach(() => {
  store.clear();
});

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

  it('returns an empty queue when storage holds garbage instead of bricking', async () => {
    store.set(QUEUE_KEY, '{not json');
    await expect(readQueue()).resolves.toEqual([]);
    store.set(QUEUE_KEY, JSON.stringify({ nope: true }));
    await expect(readQueue()).resolves.toEqual([]);
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

  it('exports the QueuedWrite shape', () => {
    const w: QueuedWrite = {
      id: 'x',
      kind: 'create',
      payload: {},
      queuedAt: '2026-08-29T00:00:00.000Z',
      attempts: 0,
    };
    expect(w.kind).toBe('create');
  });
});
