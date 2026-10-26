import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tool Catalog W05 (#5220), plan Task B4 / Decision 12 — the anonymous
 * `http_request` built-in. `safeFetch` is mocked by default; the DNS / SSRF
 * cases switch the mock to the REAL `safeFetch` with `__setLookupForTests`, so
 * the egress guard itself (resolve, check every answer, pin) is exercised —
 * those all refuse before any socket opens. Fixture origins: api.example.com,
 * 198.51.100.0/24.
 */
const { fetchState } = vi.hoisted(() => ({ fetchState: { useReal: false } }));
vi.mock('../../urlSafety', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../urlSafety')>();
  const mock = vi.fn((url: string, init?: unknown) =>
    (fetchState.useReal ? actual.safeFetch(url, init as never) : Promise.reject(new Error('safeFetch not primed'))));
  return { ...actual, safeFetch: mock };
});

import type { FlowRunRow, FlowVersionRow } from '../../../db/schema/flowRuns';
import { __setLookupForTests, safeFetch } from '../../urlSafety';
import { executeHttpRequestStep, type HttpRequestInput } from './httpRequest';
import type { BuiltinContext } from './types';

const ORIGIN = 'https://api.example.com';
const RUN = '99999999-9999-4999-8999-999999999999';

function ctx(over: Partial<BuiltinContext & { literalOrigin: string }> = {}): BuiltinContext & { literalOrigin: string } {
  return {
    run: { id: RUN, orgId: 'o1', flowId: 'f1' } as FlowRunRow,
    version: {} as FlowVersionRow,
    step: { id: 'call', tool: 'http_request', input: {}, approval: 'default', onFailure: 'stop', timeoutSec: 300 } as never,
    owner: { orgId: 'o1', partnerId: 'p1' },
    auth: {} as never,
    stepRowId: 'row-1',
    deadline: Date.now() + 300_000,
    counters: { notify: 0, http: 1 },
    leaseToken: 'lease',
    literalOrigin: ORIGIN,
    ...over,
  };
}
const get = (url = `${ORIGIN}/v1/items`, over: Partial<HttpRequestInput> = {}): HttpRequestInput => ({ method: 'GET', url, ...over });

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
const fetchMock = () => vi.mocked(safeFetch);
const calledUrl = () => fetchMock().mock.calls[0]![0] as string;
const calledInit = () => fetchMock().mock.calls[0]![1] as Record<string, unknown> & { headers: Record<string, string>; signal: AbortSignal };

beforeEach(() => {
  fetchState.useReal = false;
  fetchMock().mockClear();
  vi.stubEnv('PUBLIC_API_URL', 'https://breeze.example.test');
  vi.stubEnv('TOOL_SOURCES_ALLOW_PRIVATE_EGRESS', 'false');
});
afterEach(() => {
  __setLookupForTests(null);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('executeHttpRequestStep — the call', () => {
  it('GET returns status headers and parsed json', async () => {
    fetchMock().mockResolvedValueOnce(json({ items: [1, 2] }, 200, { etag: '"v1"', 'set-cookie': 'sid=1', 'x-internal': 'z' }));
    const out = await executeHttpRequestStep(get(), ctx());
    expect(out).toEqual({
      kind: 'completed',
      output: { status: 200, headers: { 'content-type': 'application/json', etag: '"v1"' }, body: { items: [1, 2] } },
      truncated: false,
    });
    expect(calledUrl()).toBe(`${ORIGIN}/v1/items`);
    expect(calledInit()).toMatchObject({ method: 'GET', maxBytes: 1_048_576, allowPrivateNetwork: false, requirePrivateForCleartext: true });
    expect(calledInit().body).toBeUndefined();
  });

  it('query is appended with URLSearchParams and a JSON body is sent with its content type', async () => {
    fetchMock().mockResolvedValueOnce(json({ ok: true }, 201));
    const out = await executeHttpRequestStep({ method: 'POST', url: `${ORIGIN}/tickets?src=flow`, query: { q: 'a b&c', page: 2, open: true }, body: { title: 'Disk' } }, ctx());
    expect(out).toMatchObject({ kind: 'completed', output: { status: 201 } });
    const u = new URL(calledUrl());
    expect(u.searchParams.getAll('q')).toEqual(['a b&c']);
    expect(u.searchParams.get('page')).toBe('2');
    expect(u.searchParams.get('src')).toBe('flow');
    expect(calledInit()).toMatchObject({ method: 'POST', body: '{"title":"Disk"}' });
    expect(calledInit().headers['content-type']).toBe('application/json');
  });

  it('a non-JSON body is kept as text', async () => {
    fetchMock().mockResolvedValueOnce(new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }));
    expect(await executeHttpRequestStep(get(), ctx())).toMatchObject({ kind: 'completed', output: { body: 'hello' } });
  });

  it('HEAD has no body in the output', async () => {
    fetchMock().mockResolvedValueOnce(new Response(null, { status: 204, headers: { 'last-modified': 'x' } }));
    expect(await executeHttpRequestStep({ method: 'HEAD', url: `${ORIGIN}/x` }, ctx()))
      .toEqual({ kind: 'completed', output: { status: 204, headers: { 'last-modified': 'x' }, body: null }, truncated: false });
  });

  it('a 4xx/5xx answer is http_status (onFailure applies)', async () => {
    fetchMock().mockResolvedValueOnce(json({ error: 'nope' }, 503));
    expect(await executeHttpRequestStep(get(), ctx())).toMatchObject({ kind: 'failed', code: 'http_status', policy: false, message: expect.stringContaining('503') });
  });

  it('redirect is http_status and never followed', async () => {
    fetchMock().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } }));
    expect(await executeHttpRequestStep(get(), ctx())).toMatchObject({ kind: 'failed', code: 'http_status', message: expect.stringContaining('302') });
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    expect(calledInit().redirect).toBe('manual');
  });

  it('denied header in any case is stripped at run time; allowed ones are sent', async () => {
    fetchMock().mockResolvedValueOnce(json({}));
    await executeHttpRequestStep(get(`${ORIGIN}/x`, {
      headers: { 'X-Forwarded-For': '10.0.0.1', HOST: 'evil.example', Cookie: 'a=b', 'x-breeze-signature': 's', 'Proxy-Authorization': 'p', Accept: 'application/json', 'X-Request-Id': 'r1' },
    }), ctx());
    expect(calledInit().headers).toEqual({ accept: 'application/json', 'x-request-id': 'r1' });
  });

  it('1 MB response is truncated not failed', async () => {
    const big = 'a'.repeat(1_200_000);
    fetchMock().mockResolvedValueOnce(new Response(big, { status: 200, headers: { 'content-type': 'text/plain' } }));
    const out = await executeHttpRequestStep(get(), ctx());
    expect(out).toMatchObject({ kind: 'completed', truncated: true });
    expect(JSON.stringify((out as { output: unknown }).output).length).toBeLessThan(20_000);
  });

  it('secret-looking response value is redacted before truncation', async () => {
    const secret = 'AKIAABCDEFGHIJKLMNOP';
    const body = `token for you: Bearer abc.def.ghi and ${secret}` + ' pad'.repeat(80_000);
    fetchMock().mockResolvedValueOnce(new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } }));
    const out = await executeHttpRequestStep(get(), ctx());
    const stored = JSON.stringify((out as { output: unknown }).output);
    expect(out).toMatchObject({ kind: 'completed', truncated: true });
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain('abc.def.ghi');
    expect(stored).toContain('REDACTED');
  });

  it('a secret in a small JSON response is redacted too', async () => {
    fetchMock().mockResolvedValueOnce(json({ note: 'Bearer abc.def.ghi' }));
    const out = await executeHttpRequestStep(get(), ctx());
    expect(JSON.stringify(out)).not.toContain('abc.def.ghi');
  });
});

describe('executeHttpRequestStep — egress policy', () => {
  it('templated path cannot change the host', async () => {
    for (const path of ['@evil.example/x', '/evil.example', '%2F%2Fevil.example', '\\evil.example', '..%2F..%2F']) {
      fetchMock().mockClear().mockResolvedValueOnce(json({}));
      const out = await executeHttpRequestStep(get(`${ORIGIN}/${path}`), ctx());
      if (out.kind === 'completed') expect(new URL(calledUrl()).host).toBe('api.example.com');
      else expect(out).toMatchObject({ kind: 'failed', code: 'egress_blocked', policy: true });
    }
  });

  it('a rendered URL on another origin is egress_blocked and never sent', async () => {
    for (const url of ['https://evil.example/x', 'https://api.example.com:8443/x', 'http://api.example.com/x', 'https://user:pw@api.example.com/x']) {
      expect(await executeHttpRequestStep(get(url), ctx())).toMatchObject({ kind: 'failed', code: 'egress_blocked', policy: true });
    }
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it('own API origin is egress_blocked', async () => {
    const own = 'https://breeze.example.test';
    expect(await executeHttpRequestStep({ method: 'POST', url: `${own}/api/v1/webhooks/flows/x` }, ctx({ literalOrigin: own })))
      .toMatchObject({ kind: 'failed', code: 'egress_blocked', policy: true });
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it('http scheme refused without the flag', async () => {
    const httpOrigin = 'http://198.51.100.7';
    expect(await executeHttpRequestStep(get(`${httpOrigin}/x`), ctx({ literalOrigin: httpOrigin })))
      .toMatchObject({ kind: 'failed', code: 'egress_blocked', policy: true });
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it('DNS rebinding to metadata is egress_blocked', async () => {
    fetchState.useReal = true;
    __setLookupForTests(async () => [{ address: '169.254.169.254', family: 4 }]);
    expect(await executeHttpRequestStep(get(), ctx())).toMatchObject({ kind: 'failed', code: 'egress_blocked', policy: true });
    __setLookupForTests(async () => [{ address: '127.0.0.1', family: 4 }]);
    expect(await executeHttpRequestStep(get(), ctx())).toMatchObject({ kind: 'failed', code: 'egress_blocked', policy: true });
  });

  it('private address refused unless the private-egress flag is set', async () => {
    fetchState.useReal = true;
    __setLookupForTests(async () => [{ address: '10.0.0.5', family: 4 }]);
    expect(await executeHttpRequestStep(get(), ctx())).toMatchObject({ kind: 'failed', code: 'egress_blocked', policy: true });
    // With the self-hosted flag the guard lets RFC1918 through (asserted on the options, no socket opened).
    fetchState.useReal = false;
    vi.stubEnv('TOOL_SOURCES_ALLOW_PRIVATE_EGRESS', 'true');
    fetchMock().mockClear().mockResolvedValueOnce(json({}));
    await executeHttpRequestStep(get(), ctx());
    expect(calledInit()).toMatchObject({ allowPrivateNetwork: true, requirePrivateForCleartext: true });
  });
});

describe('executeHttpRequestStep — caps and deadlines', () => {
  it('101st request in a run fails policy', async () => {
    expect(await executeHttpRequestStep(get(), ctx({ counters: { notify: 0, http: 101 } })))
      .toMatchObject({ kind: 'failed', policy: true, message: expect.stringContaining('100') });
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it('request body over 256 KB fails policy', async () => {
    expect(await executeHttpRequestStep({ method: 'POST', url: `${ORIGIN}/x`, body: { blob: 'x'.repeat(262_200) } }, ctx()))
      .toMatchObject({ kind: 'failed', code: 'input_invalid', policy: true });
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it('a GET or HEAD with a body is input_invalid', async () => {
    expect(await executeHttpRequestStep(get(`${ORIGIN}/x`, { body: { a: 1 } }), ctx())).toMatchObject({ kind: 'failed', code: 'input_invalid', policy: true });
  });

  it('POST timeout is unknown_outcome', async () => {
    fetchMock().mockRejectedValueOnce(Object.assign(new Error('request timed out after 10000ms'), { name: 'AbortError' }));
    expect(await executeHttpRequestStep({ method: 'POST', url: `${ORIGIN}/x`, body: {} }, ctx())).toMatchObject({ kind: 'unknown_outcome' });
  });

  it('a connection refused before anything was sent is a plain failure, not unknown', async () => {
    fetchMock().mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED 198.51.100.7:443'), { code: 'ECONNREFUSED' }));
    expect(await executeHttpRequestStep({ method: 'POST', url: `${ORIGIN}/x`, body: {} }, ctx())).toMatchObject({ kind: 'failed', code: 'step_failed', policy: false });
  });

  it('the absolute deadline is min(step timeout, 30 s) and is passed as an abort signal plus headers timeout', async () => {
    fetchMock().mockResolvedValueOnce(json({}));
    await executeHttpRequestStep(get(), ctx({ step: { id: 'call', tool: 'http_request', input: {}, timeoutSec: 600 } as never }));
    expect(calledInit().signal).toBeInstanceOf(AbortSignal);
    expect(calledInit().headersTimeoutMs).toBeLessThanOrEqual(30_000);
    expect(calledInit().timeoutMs).toBeLessThanOrEqual(30_000);
  });

  it('slow body past the absolute deadline aborts (fake timers; inactivity never trips)', async () => {
    vi.useFakeTimers();
    // Headers arrive at once; the body trickles one byte every 5 s forever —
    // never idle long enough for an inactivity timeout to fire.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const tick = () => { controller.enqueue(new TextEncoder().encode('x')); timer = setTimeout(tick, 5_000); };
        tick();
      },
      cancel() { clearTimeout(timer); },
    });
    fetchMock().mockResolvedValueOnce(new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } }));
    const pending = executeHttpRequestStep(get(), ctx({ step: { id: 'call', tool: 'http_request', input: {}, timeoutSec: 20 } as never }));
    await vi.advanceTimersByTimeAsync(21_000);
    expect(await pending).toMatchObject({ kind: 'unknown_outcome' });
  });

  it('a step deadline already past sends nothing', async () => {
    expect(await executeHttpRequestStep(get(), ctx({ deadline: Date.now() - 1 }))).toMatchObject({ kind: 'failed', code: 'step_timeout' });
    expect(fetchMock()).not.toHaveBeenCalled();
  });
});
