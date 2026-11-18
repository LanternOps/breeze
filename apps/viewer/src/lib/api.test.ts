import { describe, it, expect, vi, afterEach } from 'vitest';
import { apiFetch, endDesktopSession, exchangeDesktopConnectCode } from './api';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('api', () => {
  it('apiFetch joins base URL and path and sets auth headers', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('https://example.com/base/', '/api/v1/remote/sessions', 'tok', { method: 'GET' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe('https://example.com/base/api/v1/remote/sessions');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('exchangeDesktopConnectCode uses a normalized URL join', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(JSON.stringify({ accessToken: 't', expiresInSeconds: 60 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const resp = await exchangeDesktopConnectCode('https://example.com/base/', 's', 'c');

    expect(resp).toEqual({ accessToken: 't', expiresInSeconds: 60 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.com/base/api/v1/desktop-ws/connect/exchange');
  });
});


// #11931: the viewer's hang-up records operator_ended through the viewer-token
// End route. It must never throw and never hold the hang-up for long.
describe('endDesktopSession', () => {
  const SESSION = '11111111-1111-4111-8111-111111111111';

  function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
    const fetchMock = vi.fn(impl);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('POSTs the viewer-token End route with the viewer token', async () => {
    const fetchMock = stubFetch(async () => new Response('{}', { status: 200 }));

    await expect(endDesktopSession('https://example.com/base/', 'viewer-tok', SESSION)).resolves.toBe('ended');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://example.com/base/api/v1/desktop-ws/${SESSION}/viewer/end`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer viewer-tok');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('treats 400 (already ended) as done', async () => {
    stubFetch(async () => new Response('{"error":"Session is already ended"}', { status: 400 }));
    await expect(endDesktopSession('https://example.com', 't', SESSION)).resolves.toBe('already_ended');
  });

  it('reports other statuses as failed without throwing', async () => {
    stubFetch(async () => new Response('{}', { status: 401 }));
    await expect(endDesktopSession('https://example.com', 't', SESSION)).resolves.toBe('failed');
  });

  it('reports a network error as failed without throwing', async () => {
    stubFetch(async () => { throw new TypeError('Failed to fetch'); });
    await expect(endDesktopSession('https://example.com', 't', SESSION)).resolves.toBe('failed');
  });

  it('gives up after the timeout so a slow API never holds the hang-up', async () => {
    vi.useFakeTimers();
    stubFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));

    const result = endDesktopSession('https://example.com', 't', SESSION, 1500);
    await vi.advanceTimersByTimeAsync(1500);

    await expect(result).resolves.toBe('failed');
  });
});
