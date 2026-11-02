import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResponseTooLargeError, SsrfBlockedError, type SafeFetchInit } from '../urlSafety';
import {
  buildSourceUrl,
  clockSkewFromDateHeader,
  createSourceClient,
  normalizeSourceBaseUrl,
  retryAfterMs,
  SourceAuthError,
  SourceHttpError,
  SourceResponseTooLargeError,
  SourceUnavailableError,
} from './sourceFetch';

type Call = { url: string; init: SafeFetchInit };

function fakeFetch(responses: Array<Response | Error | (() => Promise<Response>)>) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string, init: SafeFetchInit = {}) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next();
    return next;
  });
  return { impl, calls };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

function client(responses: Parameters<typeof fakeFetch>[0], extra: Partial<Parameters<typeof createSourceClient>[1]> = {}) {
  const fetch = fakeFetch(responses);
  const sleeps: number[] = [];
  const c = createSourceClient('https://helpdesk.example.com/zammad/', {
    timeoutMs: 1234,
    concurrency: 2,
    fetchImpl: fetch.impl as never,
    sleep: async (ms) => { sleeps.push(ms); },
    ...extra,
  });
  return { c, ...fetch, sleeps };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('normalizeSourceBaseUrl', () => {
  it('keeps an https base URL without its trailing slash', () => {
    expect(normalizeSourceBaseUrl('https://helpdesk.example.com/zammad/')).toEqual({ ok: true, url: 'https://helpdesk.example.com/zammad' });
    expect(normalizeSourceBaseUrl(' https://Helpdesk.Example.com ')).toEqual({ ok: true, url: 'https://helpdesk.example.com' });
  });

  it('refuses http, credentials, a query or a fragment when hosted (strict-https)', () => {
    vi.stubEnv('IS_HOSTED', 'true');
    expect(normalizeSourceBaseUrl('http://helpdesk.example.com').ok).toBe(false);
    expect(normalizeSourceBaseUrl('https://user:pw@helpdesk.example.com').ok).toBe(false);
    expect(normalizeSourceBaseUrl('https://helpdesk.example.com/?a=1').ok).toBe(false);
    expect(normalizeSourceBaseUrl('https://helpdesk.example.com/#x').ok).toBe(false);
    expect(normalizeSourceBaseUrl('https://10.0.0.5').ok).toBe(false);
  });

  it('allows on-prem http and a private address only on an affirmatively self-hosted deployment', () => {
    vi.stubEnv('IS_HOSTED', 'false');
    expect(normalizeSourceBaseUrl('http://10.0.0.5:8080')).toEqual({ ok: true, url: 'http://10.0.0.5:8080' });
    vi.stubEnv('IS_HOSTED', '');
    expect(normalizeSourceBaseUrl('http://10.0.0.5:8080').ok).toBe(false);
  });

  it.each(['http://127.0.0.1', 'http://169.254.169.254', 'http://100.64.0.1', 'https://localhost'])(
    'keeps %s blocked in both modes', (url) => {
      vi.stubEnv('IS_HOSTED', 'false');
      expect(normalizeSourceBaseUrl(url).ok).toBe(false);
      vi.stubEnv('IS_HOSTED', 'true');
      expect(normalizeSourceBaseUrl(url).ok).toBe(false);
    });
});

describe('buildSourceUrl: no URL is ever taken from a response', () => {
  const base = 'https://helpdesk.example.com/zammad';

  it('appends encoded segments and a query under the base path', () => {
    expect(buildSourceUrl(base, { path: ['api', 'v1', 'tickets', 42], query: { page: 3, per_page: 100, skip: undefined } }))
      .toBe('https://helpdesk.example.com/zammad/api/v1/tickets/42?page=3&per_page=100');
  });

  it('encodes a segment that tries to climb or leave the base', () => {
    const url = buildSourceUrl(base, { path: ['api', '../../admin', 'https://evil.example/x'] });
    expect(new URL(url).origin).toBe('https://helpdesk.example.com');
    expect(new URL(url).pathname.startsWith('/zammad/api/')).toBe(true);
    expect(url).not.toContain('/../');
  });

  it.each([['.'], ['..'], ['']])('refuses the segment %j', (segment) => {
    expect(() => buildSourceUrl(base, { path: ['api', segment] })).toThrow(/Invalid source path segment/);
  });
});

describe('createSourceClient', () => {
  it('refuses an unsafe base URL up front', () => {
    expect(() => createSourceClient('http://169.254.169.254', { timeoutMs: 1, concurrency: 1 })).toThrow(SsrfBlockedError);
  });

  it('GETs JSON with the timeout, the JSON byte cap and no private networking when hosted', async () => {
    vi.stubEnv('IS_HOSTED', 'true');
    const { c, calls } = client([json({ ok: true }, { headers: { date: new Date().toUTCString() } })]);
    const res = await c.json<{ ok: boolean }>({ path: ['api', 'v1', 'users', 'me'], headers: { authorization: 'Token token=t' } });
    expect(res.body).toEqual({ ok: true });
    expect(calls[0]!.url).toBe('https://helpdesk.example.com/zammad/api/v1/users/me');
    expect(calls[0]!.init).toMatchObject({
      method: 'GET',
      timeoutMs: 1234,
      headersTimeoutMs: 1234,
      maxBytes: 16 * 1024 * 1024,
      allowPrivateNetwork: false,
      requirePrivateForCleartext: true,
    });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Token token=t');
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('does not follow a redirect: a 3xx is an answer, not a new URL', async () => {
    const { c, calls } = client([new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })]);
    await expect(c.json({ path: ['api'] })).rejects.toMatchObject({ name: 'SourceHttpError', status: 302 });
    expect(calls).toHaveLength(1);
  });

  it('retries a 5xx with backoff, then succeeds', async () => {
    const { c, calls, sleeps } = client([new Response('', { status: 503 }), new Response('', { status: 504 }), json([1])]);
    await expect(c.json({ path: ['api'] })).resolves.toMatchObject({ body: [1] });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 3000]);
  });

  it('honours a short Retry-After inline and hands a long one to the worker', async () => {
    const short = client([new Response('', { status: 429, headers: { 'retry-after': '2' } }), json({})]);
    await short.c.json({ path: ['api'] });
    expect(short.sleeps).toEqual([2000]);

    const long = client([new Response('', { status: 429, headers: { 'retry-after': '120' } })]);
    const err = await long.c.json({ path: ['api'] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceUnavailableError);
    expect((err as SourceUnavailableError).retryAfterMs).toBe(120_000);
    expect(long.calls).toHaveLength(1);
  });

  it('gives up after the retries with a transient error', async () => {
    const { c, calls } = client([new Error('ECONNRESET'), new Error('ETIMEDOUT'), new Response('', { status: 500 })]);
    await expect(c.json({ path: ['api'] })).rejects.toBeInstanceOf(SourceUnavailableError);
    expect(calls).toHaveLength(3);
  });

  it('does not retry a 4xx; a 401 is an auth error', async () => {
    const notFound = client([new Response('', { status: 404 })]);
    await expect(notFound.c.json({ path: ['api'] })).rejects.toMatchObject({ status: 404 });
    expect(notFound.calls).toHaveLength(1);
    const forbidden = client([new Response('', { status: 403 })]);
    await expect(forbidden.c.json({ path: ['api'] })).rejects.toBeInstanceOf(SourceHttpError);
    const unauthorized = client([new Response('', { status: 401 })]);
    await expect(unauthorized.c.json({ path: ['api'] })).rejects.toBeInstanceOf(SourceAuthError);
  });

  it('never retries an SSRF refusal', async () => {
    const { c, calls } = client([new SsrfBlockedError('blocked')]);
    await expect(c.json({ path: ['api'] })).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(calls).toHaveLength(1);
  });

  it('maps an over-cap body to a permanent error and a non-JSON body to a transient one', async () => {
    const big = client([new ResponseTooLargeError(10)]);
    await expect(big.c.bytes({ path: ['file', 7], maxBytes: 10 })).rejects.toBeInstanceOf(SourceResponseTooLargeError);
    expect(big.calls[0]!.init.maxBytes).toBe(10);
    const html = client([new Response('<html>proxy error</html>', { status: 200 })]);
    await expect(html.c.json({ path: ['api'] })).rejects.toBeInstanceOf(SourceUnavailableError);
  });

  it('reads bytes with the 10 MiB file cap by default', async () => {
    const { c, calls } = client([new Response(new Uint8Array([1, 2, 3]), { status: 200 })]);
    expect(Array.from(await c.bytes({ path: ['file', 1] }))).toEqual([1, 2, 3]);
    expect(calls[0]!.init.maxBytes).toBe(10 * 1024 * 1024);
  });

  it('abandons a request that outlives its whole-exchange deadline, then gives up as transient', async () => {
    // A source that trickles bytes never trips safeFetch's inactivity timer;
    // only the deadline's signal ends the request.
    const impl = vi.fn((_url: string, init: SafeFetchInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const stalled = createSourceClient('https://helpdesk.example.com/zammad/', {
      timeoutMs: 10, requestDeadlineMs: 30, concurrency: 1, retries: 2, fetchImpl: impl as never, sleep: async () => {},
    });
    const started = Date.now();
    await expect(stalled.json({ path: ['api'] })).rejects.toBeInstanceOf(SourceUnavailableError);
    expect(impl).toHaveBeenCalledTimes(3);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('does not charge time spent waiting for the semaphore to the deadline', async () => {
    const after = (ms: number) => () => new Promise<Response>((r) => setTimeout(() => r(json({ ok: true })), ms));
    // Concurrency 1: the second request queues ~25 ms behind the first, then
    // answers in ~25 ms. Each fits the 40 ms deadline only if queueing is free.
    const { c } = client([after(25), after(25)], { concurrency: 1, timeoutMs: 10, requestDeadlineMs: 40 });
    const results = await Promise.all([c.json({ path: ['a'] }), c.json({ path: ['b'] })]);
    expect(results.map((r) => r.body)).toEqual([{ ok: true }, { ok: true }]);
  });

  it('keeps at most `concurrency` requests in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = () => async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return json({});
    };
    const { c } = client([slow(), slow(), slow(), slow(), slow()]);
    await Promise.all(Array.from({ length: 5 }, () => c.json({ path: ['api'] })));
    expect(peak).toBe(2);
  });
});

describe('header helpers', () => {
  it('reads Retry-After as seconds or a date', () => {
    expect(retryAfterMs('3')).toBe(3000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(retryAfterMs('soon')).toBeNull();
    expect(retryAfterMs(null)).toBeNull();
  });

  it('measures the clock skew from the Date header', () => {
    const headers = new Headers({ date: new Date(60_000).toUTCString() });
    expect(clockSkewFromDateHeader(headers, 0)).toBe(60_000);
    expect(clockSkewFromDateHeader(new Headers(), 0)).toBeNull();
  });
});
