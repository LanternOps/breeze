import { describe, it, expect, vi, afterEach } from 'vitest';
import { apiFetch, exchangeDesktopConnectCode } from './api';

afterEach(() => {
  vi.restoreAllMocks();
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

