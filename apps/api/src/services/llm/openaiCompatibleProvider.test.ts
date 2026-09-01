/**
 * Regression suite for #4121: `openaiCompatibleProvider` must reach its
 * operator-configured endpoint through the SSRF-guarded `safeFetch`, not raw
 * global `fetch`.
 *
 * The interesting assertions are the two that a naive "swap fetch for
 * safeFetch" would break:
 *
 *  - global `fetch` is never called (the actual egress-bypass being closed), and
 *  - `streamResponse: true` is requested, because `safeFetch`'s DEFAULT mode
 *    buffers the whole body before resolving. Buffering would turn an
 *    incremental SSE chat stream into a single burst delivered after the turn
 *    finished, and hold a whole LLM turn in memory across the 6-minute timeout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import { EventEmitter } from 'events';

const { safeFetchMock, selfHostAllowsPrivateNetworkMock, realUrlSafety } = vi.hoisted(() => ({
  safeFetchMock: vi.fn(async (_url: string, _init?: unknown) => new Response('', { status: 200 })),
  selfHostAllowsPrivateNetworkMock: vi.fn(() => false),
  // Stashed so the seam suite below can drive the provider through the REAL
  // safeFetch (and the real module's DNS test hook) instead of a stand-in.
  realUrlSafety: { mod: null as typeof import('../urlSafety') | null },
}));

vi.mock('../urlSafety', async () => {
  const actual = await vi.importActual<typeof import('../urlSafety')>('../urlSafety');
  realUrlSafety.mod = actual;
  return { ...actual, safeFetch: safeFetchMock };
});

vi.mock('../../config/env', async () => {
  const actual = await vi.importActual<typeof import('../../config/env')>('../../config/env');
  return { ...actual, selfHostAllowsPrivateNetwork: selfHostAllowsPrivateNetworkMock };
});

import { OpenAICompatibleProvider } from './openaiCompatibleProvider';
import { SsrfBlockedError } from '../urlSafety';
import type { LLMStreamEvent } from './types';

const BASE_URL = 'https://vllm.example.com/v1';

function makeProvider(baseUrl = BASE_URL): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    baseUrl,
    apiKey: 'sk-test-key',
    priceInputPerMUsd: 0,
    priceOutputPerMUsd: 0,
  });
}

/** Build an SSE body from already-encoded event payloads. */
function sseBody(chunks: string[]): string {
  return chunks.map((c) => `data: ${c}\n\n`).join('');
}

function contentChunk(text: string): string {
  return JSON.stringify({ choices: [{ delta: { content: text } }] });
}

async function collect(stream: AsyncIterable<LLMStreamEvent>): Promise<LLMStreamEvent[]> {
  const out: LLMStreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

/** The `init` object handed to safeFetch on the most recent call. */
function lastInit(): Record<string, unknown> {
  const call = safeFetchMock.mock.calls.at(-1);
  expect(call, 'expected safeFetch to have been called').toBeDefined();
  return (call![1] ?? {}) as Record<string, unknown>;
}

describe('OpenAICompatibleProvider egress guard (#4121)', () => {
  let globalFetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    safeFetchMock.mockReset();
    safeFetchMock.mockResolvedValue(
      new Response(sseBody([contentChunk('hi'), '[DONE]']), { status: 200 }),
    );
    selfHostAllowsPrivateNetworkMock.mockReset();
    selfHostAllowsPrivateNetworkMock.mockReturnValue(false);

    // Any call to raw global fetch is the bug this issue exists to close.
    globalFetchSpy = vi.fn(async () => {
      throw new Error('raw global fetch() must not be used — route through safeFetch');
    });
    vi.stubGlobal('fetch', globalFetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('routes the chat completion through safeFetch and never touches global fetch', async () => {
    const events = await collect(
      makeProvider().chatStream([{ role: 'user', content: 'hello' }], { model: 'm' }),
    );

    expect(globalFetchSpy).not.toHaveBeenCalled();
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    expect(safeFetchMock.mock.calls[0]![0]).toBe('https://vllm.example.com/v1/chat/completions');
    expect(events).toContainEqual({ type: 'content_delta', delta: 'hi' });
  });

  it('asks safeFetch for a STREAMED response so SSE is not buffered into one burst', () => {
    return collect(makeProvider().chatStream([{ role: 'user', content: 'x' }], { model: 'm' })).then(
      () => {
        expect(lastInit().streamResponse).toBe(true);
      },
    );
  });

  it('bounds the streamed body with maxBytes', async () => {
    await collect(makeProvider().chatStream([{ role: 'user', content: 'x' }], { model: 'm' }));
    expect(typeof lastInit().maxBytes).toBe('number');
    expect(lastInit().maxBytes as number).toBeGreaterThan(0);
  });

  it('forwards the POST body, bearer auth and abort signal to safeFetch', async () => {
    const controller = new AbortController();
    await collect(
      makeProvider().chatStream([{ role: 'user', content: 'hello' }], {
        model: 'my-model',
        maxTokens: 128,
        signal: controller.signal,
      }),
    );

    const init = lastInit();
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-test-key',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'my-model', stream: true, max_tokens: 128 });
  });

  it('never follows redirects and keeps cleartext confined to the operator LAN', async () => {
    await collect(makeProvider().chatStream([{ role: 'user', content: 'x' }], { model: 'm' }));
    const init = lastInit();
    expect(init.redirect).toBe('error');
    expect(init.requirePrivateForCleartext).toBe(true);
  });

  it('passes the self-host private-network opt-in through from config', async () => {
    selfHostAllowsPrivateNetworkMock.mockReturnValue(true);
    await collect(makeProvider('http://10.0.0.5:8000/v1').chatStream([], { model: 'm' }));
    expect(lastInit().allowPrivateNetwork).toBe(true);

    selfHostAllowsPrivateNetworkMock.mockReturnValue(false);
    await collect(makeProvider().chatStream([], { model: 'm' }));
    expect(lastInit().allowPrivateNetwork).toBe(false);
  });

  it('surfaces an SSRF refusal as an error event rather than throwing out of the iterator', async () => {
    safeFetchMock.mockRejectedValueOnce(
      new SsrfBlockedError('URL points to blocked address: 169.254.169.254'),
    );

    const events = await collect(
      makeProvider('http://169.254.169.254/v1').chatStream([], { model: 'm' }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error' });
    expect((events[0] as { message: string }).message).toContain('169.254.169.254');
  });

  it('treats a 3xx as an error instead of silently following the Location', async () => {
    safeFetchMock.mockResolvedValueOnce(
      new Response('', { status: 302, headers: { location: 'http://169.254.169.254/' } }),
    );

    const events = await collect(makeProvider().chatStream([], { model: 'm' }));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error' });
    expect((events[0] as { message: string }).message).toMatch(/redirect/i);
  });

  it('still yields deltas incrementally as SSE chunks arrive', async () => {
    // A body that emits two events, then only closes once the consumer has
    // seen the first — proving the provider is not waiting for the full body.
    let releaseSecond: () => void = () => {};
    const secondSent = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(sseBody([contentChunk('first')])));
        await secondSent;
        controller.enqueue(encoder.encode(sseBody([contentChunk('second'), '[DONE]'])));
        controller.close();
      },
    });
    safeFetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));

    const seen: string[] = [];
    for await (const ev of makeProvider().chatStream([], { model: 'm' })) {
      if (ev.type === 'content_delta') {
        seen.push(ev.delta);
        // We got the first delta before the second was ever written — the only
        // way that happens is if the response body is live, not buffered.
        if (seen.length === 1) releaseSecond();
      }
    }

    expect(seen).toEqual(['first', 'second']);
  });
});

/**
 * The branches the streaming swap actually rewrote. Each of these would still
 * pass with a buffered body; what makes them discriminating is that the mocked
 * `safeFetch` returns a body that only ends when the request is aborted —
 * which is exactly what real streaming mode does via `req.destroy()`.
 */
describe('OpenAICompatibleProvider live-body error paths (#4121)', () => {
  const TURN_TIMEOUT_MS = 6 * 60 * 1000;

  beforeEach(() => {
    safeFetchMock.mockReset();
    selfHostAllowsPrivateNetworkMock.mockReset();
    selfHostAllowsPrivateNetworkMock.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A body that never ends on its own and errors only when the turn is aborted. */
  function stallingBody(signal: AbortSignal, prelude?: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        if (prelude) controller.enqueue(new TextEncoder().encode(prelude));
        signal.addEventListener('abort', () => controller.error(new Error('aborted')), {
          once: true,
        });
      },
    });
  }

  it('reports the endpoint error body on a non-2xx response', async () => {
    safeFetchMock.mockResolvedValueOnce(new Response('upstream exploded', { status: 502 }));

    const events = await collect(makeProvider().chatStream([], { model: 'm' }));

    expect(events).toHaveLength(1);
    expect((events[0] as { message: string }).message).toContain('HTTP 502');
    expect((events[0] as { message: string }).message).toContain('upstream exploded');
  });

  it('keeps the turn timeout armed while reading a non-2xx body that stalls', async () => {
    vi.useFakeTimers();
    safeFetchMock.mockImplementationOnce(async (_url, init) => {
      const { signal } = init as { signal: AbortSignal };
      return new Response(stallingBody(signal), { status: 500 });
    });

    const events: LLMStreamEvent[] = [];
    const consume = (async () => {
      for await (const ev of makeProvider().chatStream([], { model: 'm' })) events.push(ev);
    })();

    // With `clearTimeout` moved into the `finally` AFTER the body read, the
    // turn timeout still fires and unblocks `response.text()`. If it were
    // cleared before the read (the pre-#4121 order, safe only while the body
    // was pre-buffered), nothing would ever settle and this would hang.
    await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS + 1);
    await consume;

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error' });
    expect((events[0] as { message: string }).message).toContain('HTTP 500');
  });

  it('yields the turn-timeout error when the stream stalls mid-response', async () => {
    vi.useFakeTimers();
    safeFetchMock.mockImplementationOnce(async (_url, init) => {
      const { signal } = init as { signal: AbortSignal };
      return new Response(
        stallingBody(signal, 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
        { status: 200 },
      );
    });

    const events: LLMStreamEvent[] = [];
    const consume = (async () => {
      for await (const ev of makeProvider().chatStream([], { model: 'm' })) events.push(ev);
    })();

    await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS + 1);
    await consume;

    expect(events).toContainEqual({ type: 'content_delta', delta: 'partial' });
    // A stalled stream must end as a timeout error, never as a clean
    // `message_end` that would present a truncated answer as complete.
    expect(events.at(-1)).toMatchObject({ type: 'error' });
    expect((events.at(-1) as { message: string }).message).toMatch(/timed out/i);
    expect(events.some((e) => e.type === 'message_end')).toBe(false);
  });

  it('returns silently, with no error event, when the caller aborts mid-stream', async () => {
    const caller = new AbortController();
    safeFetchMock.mockImplementationOnce(async (_url, init) => {
      const { signal } = init as { signal: AbortSignal };
      return new Response(
        stallingBody(signal, 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
        { status: 200 },
      );
    });

    const events: LLMStreamEvent[] = [];
    for await (const ev of makeProvider().chatStream([], {
      model: 'm',
      signal: caller.signal,
    })) {
      events.push(ev);
      if (ev.type === 'content_delta') caller.abort();
    }

    // A user pressing Stop is not an error, and must not fabricate a message_end.
    expect(events).toEqual([{ type: 'content_delta', delta: 'partial' }]);
  });
});

/**
 * The seam. Every suite above mocks `safeFetch`, so they prove what the
 * provider *intends* to send; none prove that those exact options actually
 * produce a guarded, streaming request. This one drives the real `safeFetch`
 * with only `http.request` faked, so a mismatch between the two halves fails.
 */
describe('OpenAICompatibleProvider through the real safeFetch (#4121)', () => {
  let reqHandle: { req: any; res: any };

  beforeEach(() => {
    safeFetchMock.mockReset();
    selfHostAllowsPrivateNetworkMock.mockReset();
    selfHostAllowsPrivateNetworkMock.mockReturnValue(true);
    // Route the provider's calls into the genuine implementation.
    safeFetchMock.mockImplementation((url, init) => realUrlSafety.mod!.safeFetch(url, init as never));
  });

  afterEach(() => {
    realUrlSafety.mod!.__setLookupForTests(null);
    vi.restoreAllMocks();
  });

  function fakeTransport(): { req: any; res: any } {
    const handle: { req: any; res: any } = { req: null, res: null };
    vi.spyOn(http, 'request').mockImplementation((_options: any, callback?: any) => {
      const res: any = new EventEmitter();
      res.statusCode = 200;
      res.statusMessage = 'OK';
      res.headers = { 'content-type': 'text/event-stream' };
      res.pause = vi.fn();
      res.resume = vi.fn();
      res.destroy = vi.fn();
      res.complete = false;
      const req: any = new EventEmitter();
      req.write = vi.fn();
      req.destroy = vi.fn();
      req.setTimeout = vi.fn();
      req.end = vi.fn(() => callback?.(res));
      handle.req = req;
      handle.res = res;
      return req;
    });
    return handle;
  }

  it('streams SSE deltas over a real guarded request to an on-LAN endpoint', async () => {
    // 10.0.0.5 is RFC1918: reachable only because the provider asks for the
    // self-host private-network opt-in. If it stopped doing so, safeFetch would
    // refuse this and the test would fail with an SSRF error event.
    realUrlSafety.mod!.__setLookupForTests(async () => [{ address: '10.0.0.5', family: 4 }]);
    reqHandle = fakeTransport();

    const seen: string[] = [];
    const done = (async () => {
      for await (const ev of makeProvider('http://vllm.lan:8000/v1').chatStream([], {
        model: 'm',
      })) {
        if (ev.type === 'content_delta') seen.push(ev.delta);
      }
    })();

    // Wait for the real safeFetch to resolve DNS and dial.
    while (reqHandle.res === null) await new Promise((r) => setImmediate(r));

    reqHandle.res.emit('data', Buffer.from('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
    reqHandle.res.emit('data', Buffer.from('data: {"choices":[{"delta":{"content":"b"}}]}\n\n'));
    reqHandle.res.complete = true;
    reqHandle.res.emit('end');
    await done;

    expect(seen).toEqual(['a', 'b']);
    expect(http.request).toHaveBeenCalledTimes(1);
  });

  it('refuses a cleartext endpoint that resolves to a public address', async () => {
    // `requirePrivateForCleartext` is what stops the bearer token going over
    // the open internet in the clear. Proven here against the real guard.
    realUrlSafety.mod!.__setLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
    const requestSpy = vi.spyOn(http, 'request');

    const events = await collect(
      makeProvider('http://public.example.com/v1').chatStream([], { model: 'm' }),
    );

    expect(requestSpy).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error' });
    expect((events[0] as { message: string }).message).toMatch(/cleartext/i);
  });
});
