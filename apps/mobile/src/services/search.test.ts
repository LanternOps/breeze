import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { searchAll } from './search';

vi.mock('./serverConfig', () => ({
  getServerUrl: vi.fn().mockResolvedValue('https://api.test'),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn().mockResolvedValue('test-token'),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  // Vitest's `globalThis.fetch` swap is the canonical way to inject a
  // fake fetch in node-environment tests.
  (globalThis as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, init: { status?: number } = {}) {
  return {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    json: async () => body,
  };
}

describe('searchAll', () => {
  it('returns empty results for whitespace-only query without hitting the network', async () => {
    const res = await searchAll('   ', 20);
    expect(res.results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes the query, limit, and bearer token through to the mobile search endpoint', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [] }));

    await searchAll('macbook', 20);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.test/api/v1/mobile/search?q=macbook&limit=20');
    expect(opts.headers.Authorization).toBe('Bearer test-token');
  });

  it('forwards the AbortSignal so a new query can cancel an in-flight call', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let abortFromFetch = false;
    fetchMock.mockImplementation((_url: string, opts: RequestInit) => {
      receivedSignal = opts.signal as AbortSignal;
      // Resolve only once aborted, simulating a slow server we want to cut off.
      return new Promise((resolve, reject) => {
        const signal = opts.signal;
        if (signal?.aborted) {
          abortFromFetch = true;
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
          return;
        }
        signal?.addEventListener('abort', () => {
          abortFromFetch = true;
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const promise = searchAll('macbook', 20, controller.signal);
    // The await chain inside searchAll (getServerUrl + getToken) has to
    // resolve before fetch is invoked — yield two microtasks so the
    // listener is wired up before we abort.
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(receivedSignal).toBe(controller.signal);
    expect(abortFromFetch).toBe(true);
  });

  it('throws a descriptive Error when the server returns a non-2xx response', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Rate limit exceeded' }, { status: 429 }));
    await expect(searchAll('macbook', 20)).rejects.toThrow('Rate limit exceeded');
  });

  it('returns the unified discriminated union from a multi-kind API response', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        results: [
          {
            kind: 'alert',
            id: 'a1',
            title: 'Disk full',
            subtitle: 'critical · macbook',
            meta: {
              orgId: 'o1',
              severity: 'critical',
              status: 'active',
              deviceId: 'd1',
              deviceName: 'macbook',
              message: '99%',
              triggeredAt: '2026-05-01T00:00:00Z',
            },
          },
          {
            kind: 'device',
            id: 'd1',
            title: 'macbook',
            subtitle: 'macos · HQ',
            meta: {
              orgId: 'o1',
              siteId: 's1',
              hostname: 'macbook',
              displayName: null,
              osType: 'macos',
              status: 'online',
              lastSeenAt: null,
              siteName: 'HQ',
            },
          },
          {
            kind: 'session',
            id: 'sess1',
            title: 'macbook check',
            subtitle: '4 turns',
            meta: {
              orgId: 'o1',
              status: 'active',
              turnCount: 4,
              lastActivityAt: null,
              createdAt: null,
            },
          },
        ],
      }),
    );

    const res = await searchAll('macbook', 20);
    expect(res.results).toHaveLength(3);
    const kinds = res.results.map((r) => r.kind).sort();
    expect(kinds).toEqual(['alert', 'device', 'session']);
    // Discriminator narrows: meta.severity is only typed on 'alert'.
    const first = res.results[0];
    if (first.kind === 'alert') {
      expect(first.meta.severity).toBe('critical');
    } else {
      throw new Error('expected alert as first result');
    }
  });
});
