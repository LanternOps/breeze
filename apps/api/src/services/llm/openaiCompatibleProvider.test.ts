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

const { safeFetchMock, selfHostAllowsPrivateNetworkMock } = vi.hoisted(() => ({
  safeFetchMock: vi.fn(async (_url: string, _init?: unknown) => new Response('', { status: 200 })),
  selfHostAllowsPrivateNetworkMock: vi.fn(() => false),
}));

vi.mock('../urlSafety', async () => {
  const actual = await vi.importActual<typeof import('../urlSafety')>('../urlSafety');
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
