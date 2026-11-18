import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ fetchWithAuth: vi.fn() }));

import { fetchWithAuth } from './auth';
import {
  ATTACH_MAX_ATTEMPTS, abortAllAttaches, attachAiSession, attachBackoffMs, shouldReattach, trackAttach,
  type AttachOutcome,
} from './aiSessionAttach';

const fetchMock = vi.mocked(fetchWithAuth);
const enc = new TextEncoder();

const frame = (data: unknown, event?: string, id?: number) =>
  `${event ? `event: ${event}\n` : ''}${id !== undefined ? `id: ${id}\n` : ''}data: ${JSON.stringify(data)}\n\n`;

const attachState = (over: Record<string, unknown> = {}) => ({
  type: 'attach_state', turn: 'running', turnId: 't1', lastSeq: 2, turnUserMessageId: null,
  partial: false, replay: [], pendingCards: [], ...over,
});

/** Response whose body emits the given chunks, then closes. cancel() is recorded. */
function sseResponse(chunks: string[], opts: { hold?: boolean } = {}) {
  const cancel = vi.fn();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) { controller.enqueue(enc.encode(chunks[i++]!)); return; }
      if (opts.hold) return new Promise<void>(() => undefined); // never ends
      controller.close();
    },
    cancel,
  });
  return { res: { ok: true, status: 200, body } as unknown as Response, cancel };
}
const status = (s: number) => ({ ok: false, status: s, body: null }) as unknown as Response;

function attach(opts: Partial<Parameters<typeof attachAiSession>[1]> = {}) {
  const events: Array<Record<string, unknown>> = [];
  const order: string[] = [];
  const controller = new AbortController();
  const handle = attachAiSession('s1', {
    signal: controller.signal,
    onEvent: (e) => { events.push(e as unknown as Record<string, unknown>); order.push(`event:${(e as { type: string }).type}:${(e as { seq?: number }).seq ?? ''}`); },
    ...opts,
  });
  void handle.ready.then(() => order.push('ready'));
  return { ...handle, events, order, controller };
}

describe('attachAiSession', () => {
  beforeEach(() => { vi.clearAllMocks(); abortAllAttaches(); });

  it('delivers attach_state then live events (seq stripped); ready settles before seq3; finished = done', async () => {
    const { res } = sseResponse([
      frame({}, 'ping'),
      frame(attachState({ lastSeq: 2 })),
      frame({ type: 'content_delta', delta: 'a', seq: 2 }),
      frame({ type: 'content_delta', delta: 'b', seq: 3 }),
      frame({ type: 'done', seq: 4 }),
    ]);
    fetchMock.mockResolvedValue(res);
    const a = attach();
    await expect(a.ready).resolves.toMatchObject({ kind: 'ready', turn: 'running', state: { lastSeq: 2 } });
    await expect(a.finished).resolves.toEqual({ kind: 'done' });
    expect(fetchMock.mock.calls[0]![0]).toBe('/ai/sessions/s1/stream');
    expect(a.events.map((e) => e.type)).toEqual(['attach_state', 'content_delta', 'done']);
    expect(a.events[1]).toEqual({ type: 'content_delta', delta: 'b' }); // seq stripped, seq2 dropped
    expect(a.events[2]).toEqual({ type: 'done' });
    expect(a.order.indexOf('ready')).toBeLessThan(a.order.indexOf('event:content_delta:'));
    // ready is recorded after attach_state was handed to onEvent
    expect(a.order.indexOf('event:attach_state:')).toBeLessThan(a.order.indexOf('ready'));
  });

  it('handles frames split across chunk boundaries and ignores data without a type', async () => {
    const full = frame(attachState({ lastSeq: 0 })) + frame({ nothing: true }) + frame({ type: 'done', seq: 1 });
    const mid = Math.floor(full.length / 2);
    const { res } = sseResponse([full.slice(0, 7), full.slice(7, mid), full.slice(mid)]);
    fetchMock.mockResolvedValue(res);
    const a = attach();
    await expect(a.finished).resolves.toEqual({ kind: 'done' });
    expect(a.events.map((e) => e.type)).toEqual(['attach_state', 'done']);
  });

  it('idle -> outcome idle', async () => {
    const { res } = sseResponse([frame(attachState({ turn: 'idle', turnId: 't1', lastSeq: 0 }))]);
    fetchMock.mockResolvedValue(res);
    const a = attach();
    await expect(a.ready).resolves.toMatchObject({ kind: 'ready', turn: 'idle' });
    await expect(a.finished).resolves.toEqual({ kind: 'idle' });
  });

  it('unavailable -> outcome unavailable', async () => {
    const { res } = sseResponse([frame(attachState({ turn: 'unavailable', turnId: null, lastSeq: 0 }))]);
    fetchMock.mockResolvedValue(res);
    const a = attach();
    await expect(a.ready).resolves.toMatchObject({ kind: 'ready', turn: 'unavailable' });
    await expect(a.finished).resolves.toEqual({ kind: 'unavailable' });
  });

  it('a seq jump -> gap, reader cancelled, later events not delivered', async () => {
    const { res, cancel } = sseResponse([
      frame(attachState({ lastSeq: 2 })),
      frame({ type: 'content_delta', delta: 'x', seq: 3 }),
      frame({ type: 'content_delta', delta: 'y', seq: 5 }),
      frame({ type: 'done', seq: 6 }),
    ], { hold: true });
    fetchMock.mockResolvedValue(res);
    const a = attach();
    await expect(a.finished).resolves.toEqual({ kind: 'gap' });
    expect(a.events.map((e) => e.type)).toEqual(['attach_state', 'content_delta']);
    expect(cancel).toHaveBeenCalled();
  });

  it('body ends without done while running -> closed', async () => {
    const { res } = sseResponse([frame(attachState({ lastSeq: 0 })), frame({ type: 'content_delta', delta: 'x', seq: 1 })]);
    fetchMock.mockResolvedValue(res);
    const a = attach();
    await expect(a.finished).resolves.toEqual({ kind: 'closed' });
  });

  it('a first typed frame that is not a valid attach_state -> error (version skew), not a silent wait', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { res, cancel } = sseResponse([
      frame({}, 'ping'),
      frame(attachState({ turn: 'paused' })),
      frame({ type: 'done', seq: 3 }),
    ], { hold: true });
    fetchMock.mockResolvedValue(res);
    const a = attach();
    await expect(a.ready).resolves.toMatchObject({ kind: 'error' });
    await expect(a.finished).resolves.toMatchObject({ kind: 'error' });
    expect(a.events).toEqual([]);
    expect(cancel).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('stream ends before attach_state -> ready and finished agree (closed)', async () => {
    const { res } = sseResponse([frame({}, 'ping')]);
    fetchMock.mockResolvedValue(res);
    const a = attach();
    await expect(a.ready).resolves.toEqual({ kind: 'closed' });
    await expect(a.finished).resolves.toEqual({ kind: 'closed' });
    expect(a.events).toEqual([]);
  });

  it('404 -> not_found, 429 -> busy, 500 -> error (ready mirrors finished)', async () => {
    fetchMock.mockResolvedValueOnce(status(404));
    const a = attach();
    await expect(a.finished).resolves.toEqual({ kind: 'not_found' });
    await expect(a.ready).resolves.toEqual({ kind: 'not_found' });

    fetchMock.mockResolvedValueOnce(status(429));
    await expect(attach().finished).resolves.toEqual({ kind: 'busy' });

    fetchMock.mockResolvedValueOnce(status(500));
    const e = await attach().finished;
    expect(e.kind).toBe('error');
  });

  it('a network throw -> error with message', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(attach().finished).resolves.toEqual({ kind: 'error', message: 'offline' });
  });

  it('aborting the signal -> aborted and the reader is cancelled', async () => {
    const { res, cancel } = sseResponse([frame(attachState({ lastSeq: 0 }))], { hold: true });
    fetchMock.mockResolvedValue(res);
    const a = attach();
    await a.ready;
    a.controller.abort();
    await expect(a.finished).resolves.toEqual({ kind: 'aborted' });
    expect(cancel).toHaveBeenCalled();
  });

  it('passes the signal to fetchWithAuth', async () => {
    const { res } = sseResponse([frame(attachState({ turn: 'idle', lastSeq: 0 }))]);
    fetchMock.mockResolvedValue(res);
    const a = attach();
    await a.finished;
    expect((fetchMock.mock.calls[0]![1] as RequestInit).signal).toBe(a.controller.signal);
  });

  it('filter applies to replay, pendingCards and live events; dropped events still advance seq', async () => {
    const allow = (e: { type: string }) => e.type !== 'content_delta';
    const { res } = sseResponse([
      frame(attachState({
        lastSeq: 1,
        replay: [{ type: 'content_delta', delta: 'r' }, { type: 'status', message: 'ok' }],
        pendingCards: [{ type: 'content_delta', delta: 'p' }, { type: 'approval_required', executionId: 'e1' }],
      })),
      frame({ type: 'content_delta', delta: 'live', seq: 2 }), // filtered but advances seq
      frame({ type: 'status', message: 'next', seq: 3 }), // no gap
      frame({ type: 'done', seq: 4 }),
    ]);
    fetchMock.mockResolvedValue(res);
    const a = attach({ filter: allow as never });
    await expect(a.finished).resolves.toEqual({ kind: 'done' });
    const state = a.events[0] as { replay: Array<{ type: string }>; pendingCards: Array<{ type: string }> };
    expect(state.replay.map((e) => e.type)).toEqual(['status']);
    expect(state.pendingCards.map((e) => e.type)).toEqual(['approval_required']);
    expect(a.events.slice(1).map((e) => e.type)).toEqual(['status', 'done']);
  });
});

describe('shouldReattach', () => {
  const cycle = (attempt: number, afterClosedOr409 = false) => ({ attempt, afterClosedOr409 });
  const k = (kind: string) => ({ kind }) as AttachOutcome;

  it('closed, gap, busy re-attach', () => {
    for (const kind of ['closed', 'gap', 'busy']) expect(shouldReattach(k(kind), cycle(0))).toBe(true);
  });
  it('unavailable only inside a closed/409 cycle', () => {
    expect(shouldReattach(k('unavailable'), cycle(0, false))).toBe(false);
    expect(shouldReattach(k('unavailable'), cycle(0, true))).toBe(true);
  });
  it('terminal outcomes never re-attach', () => {
    for (const kind of ['done', 'idle', 'not_found', 'aborted', 'error']) expect(shouldReattach(k(kind), cycle(0, true))).toBe(false);
  });
  it('never past ATTACH_MAX_ATTEMPTS', () => {
    expect(ATTACH_MAX_ATTEMPTS).toBe(4);
    expect(shouldReattach(k('closed'), cycle(3))).toBe(true);
    expect(shouldReattach(k('closed'), cycle(4))).toBe(false);
    expect(shouldReattach(k('unavailable'), cycle(4, true))).toBe(false);
  });
});

describe('attachBackoffMs', () => {
  it('full jitter of min(8000, 500*2^n)', () => {
    expect([0, 1, 2, 3, 4, 5].map((n) => attachBackoffMs(n, () => 1))).toEqual([500, 1000, 2000, 4000, 8000, 8000]);
    expect(attachBackoffMs(3, () => 0)).toBe(0);
    expect(attachBackoffMs(2, () => 0.5)).toBe(1000);
  });
});

describe('trackAttach / abortAllAttaches', () => {
  it('aborts every tracked controller; untrack removes one', () => {
    const a = new AbortController();
    const b = new AbortController();
    const c = new AbortController();
    trackAttach(a);
    const untrackB = trackAttach(b);
    trackAttach(c);
    untrackB();
    abortAllAttaches();
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    expect(c.signal.aborted).toBe(true);
    // registry cleared: a second call is a no-op
    const d = new AbortController();
    abortAllAttaches();
    expect(d.signal.aborted).toBe(false);
  });
});
