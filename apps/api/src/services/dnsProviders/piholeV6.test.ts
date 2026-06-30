import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PiHoleV6Provider } from './piholeV6';
import { DnsProviderHttpError, requestJson } from './http';

// Transport is mocked — these tests exercise the v6 provider's request shaping
// (auth handshake, X-FTL-SID header, query/domain endpoints) and response
// handling, not real HTTP. requestJson returns the parsed JSON body directly.
vi.mock('./http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./http')>();
  return {
    ...actual,
    requestJson: vi.fn()
  };
});

const requestJsonMock = vi.mocked(requestJson);

const AUTH_OK = { session: { valid: true, sid: 'SID-123', validity: 300 } };

function queueResponses(responses: unknown[]): void {
  const queue = [...responses];
  requestJsonMock.mockImplementation(async () => {
    if (queue.length === 0) throw new Error('requestJson mock exhausted');
    return queue.shift() as never;
  });
}

function newProvider(): PiHoleV6Provider {
  return new PiHoleV6Provider('app-password', { apiEndpoint: 'https://pi.hole.local/' });
}

describe('PiHoleV6Provider', () => {
  beforeEach(() => {
    requestJsonMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws when apiEndpoint is missing', async () => {
    const provider = new PiHoleV6Provider('app-password', {});
    await expect(provider.syncEvents(new Date(0), new Date())).rejects.toThrow(/apiEndpoint/);
  });

  it('authenticates then sends the X-FTL-SID header on subsequent requests', async () => {
    queueResponses([AUTH_OK, { queries: [] }]);

    await newProvider().syncEvents(new Date(0), new Date());

    expect(requestJsonMock).toHaveBeenCalledTimes(2);
    const [authUrl, authInit] = requestJsonMock.mock.calls[0]! as [string, RequestInit];
    expect(authUrl).toBe('https://pi.hole.local/api/auth');
    expect(authInit.method).toBe('POST');
    expect(JSON.parse(authInit.body as string)).toEqual({ password: 'app-password' });

    const [queryUrl, queryInit] = requestJsonMock.mock.calls[1]! as [string, RequestInit];
    expect(queryUrl).toContain('https://pi.hole.local/api/queries');
    expect((queryInit.headers as Record<string, string>)['X-FTL-SID']).toBe('SID-123');
  });

  it('throws when authentication returns no valid session', async () => {
    queueResponses([{ session: { valid: false } }]);
    await expect(newProvider().addBlocklistDomain('bad.example')).rejects.toThrow(/authentication failed/i);
  });

  it('maps a 429 no_seats auth failure to a distinct, actionable error', async () => {
    requestJsonMock.mockRejectedValueOnce(
      new DnsProviderHttpError(429, 'Too Many Requests', '{"error":{"key":"no_seats"}}')
    );
    await expect(newProvider().syncEvents(new Date(0), new Date())).rejects.toThrow(/session seats are in use/i);
  });

  it('propagates a generic (non-no_seats) 429 auth failure unchanged', async () => {
    requestJsonMock.mockRejectedValueOnce(new DnsProviderHttpError(429, 'Too Many Requests', 'rate limited'));
    await expect(newProvider().syncEvents(new Date(0), new Date())).rejects.toThrow(DnsProviderHttpError);
  });

  it('maps blocked statuses to action=blocked and parses domain/time/client', async () => {
    queueResponses([
      AUTH_OK,
      {
        queries: [
          {
            id: 42,
            time: 1_700_000_100,
            type: 'A',
            domain: 'tracker.bad.example',
            status: 'GRAVITY',
            client: { ip: '10.0.0.5', name: 'workstation-3' }
          },
          {
            id: 43,
            time: 1_700_000_200,
            type: 'AAAA',
            domain: 'ok.example',
            status: 'FORWARDED',
            client: { ip: '10.0.0.6', name: null }
          }
        ]
      }
    ]);

    const events = await newProvider().syncEvents(
      new Date(1_700_000_000 * 1000),
      new Date(1_700_001_000 * 1000)
    );

    expect(events).toHaveLength(2);
    const blocked = events[0]!;
    expect(blocked.domain).toBe('tracker.bad.example');
    expect(blocked.action).toBe('blocked');
    expect(blocked.sourceIp).toBe('10.0.0.5');
    expect(blocked.sourceHostname).toBe('workstation-3');
    expect(blocked.queryType).toBe('A');
    expect(blocked.providerEventId).toBe('v6-42');
    expect(blocked.metadata?.status).toBe('GRAVITY');
    expect(events[1]!.action).toBe('allowed');
  });

  it('treats *_CNAME and EXTERNAL_BLOCKED_* statuses as blocked', async () => {
    queueResponses([
      AUTH_OK,
      {
        queries: [
          { id: 1, time: 1_700_000_100, type: 'A', domain: 'a.example', status: 'DENYLIST_CNAME', client: { ip: '10.0.0.1' } },
          { id: 2, time: 1_700_000_110, type: 'A', domain: 'b.example', status: 'EXTERNAL_BLOCKED_NULL', client: { ip: '10.0.0.1' } },
          { id: 3, time: 1_700_000_120, type: 'A', domain: 'c.example', status: 'CACHE', client: { ip: '10.0.0.1' } }
        ]
      }
    ]);

    const events = await newProvider().syncEvents(
      new Date(1_700_000_000 * 1000),
      new Date(1_700_001_000 * 1000)
    );

    expect(events.map((e) => e.action)).toEqual(['blocked', 'blocked', 'allowed']);
  });

  it('drops queries outside the [since, until] window', async () => {
    queueResponses([
      AUTH_OK,
      {
        queries: [
          { id: 1, time: 1_700_000_500, type: 'A', domain: 'in.example', status: 'FORWARDED', client: { ip: '10.0.0.1' } },
          { id: 2, time: 1_699_999_000, type: 'A', domain: 'before.example', status: 'FORWARDED', client: { ip: '10.0.0.1' } },
          { id: 3, time: 1_700_002_000, type: 'A', domain: 'after.example', status: 'FORWARDED', client: { ip: '10.0.0.1' } }
        ]
      }
    ]);

    const events = await newProvider().syncEvents(
      new Date(1_700_000_000 * 1000),
      new Date(1_700_001_000 * 1000)
    );

    expect(events.map((e) => e.domain)).toEqual(['in.example']);
  });

  it('pages back through the cursor until a short page is returned', async () => {
    // All 1000 entries sit inside the [since, until] window so none are filtered;
    // the test is exercising cursor paging, not the window guard.
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({
      id: 2000 - i,
      time: 1_700_000_500,
      type: 'A',
      domain: `d${i}.example`,
      status: 'FORWARDED',
      client: { ip: '10.0.0.1' }
    }));
    queueResponses([
      AUTH_OK,
      { queries: fullPage, cursor: 999 },
      { queries: [{ id: 999, time: 1_700_000_050, type: 'A', domain: 'last.example', status: 'FORWARDED', client: { ip: '10.0.0.1' } }] }
    ]);

    const events = await newProvider().syncEvents(
      new Date(1_700_000_000 * 1000),
      new Date(1_700_001_000 * 1000)
    );

    // 1000 from the first page + 1 from the short second page.
    expect(events).toHaveLength(1001);
    // Second query request carried the cursor from the first page.
    const secondQuery = requestJsonMock.mock.calls[2]![0] as string;
    expect(secondQuery).toContain('cursor=999');
  });

  it('re-authenticates once and retries on a 401', async () => {
    requestJsonMock
      .mockResolvedValueOnce(AUTH_OK as never) // initial auth
      .mockRejectedValueOnce(new DnsProviderHttpError(401, 'Unauthorized', '')) // expired session
      .mockResolvedValueOnce(AUTH_OK as never) // re-auth
      .mockResolvedValueOnce({} as never); // retried POST

    await newProvider().addBlocklistDomain('bad.example');

    expect(requestJsonMock).toHaveBeenCalledTimes(4);
    // Calls 1 and 3 are auth; calls 2 and 4 are the domain POST.
    expect(requestJsonMock.mock.calls[2]![0]).toBe('https://pi.hole.local/api/auth');
    expect(requestJsonMock.mock.calls[3]![0]).toBe('https://pi.hole.local/api/domains/deny/exact');
  });

  it('addBlocklistDomain POSTs to /api/domains/deny/exact', async () => {
    queueResponses([AUTH_OK, {}]);

    await newProvider().addBlocklistDomain('bad.example');

    const [url, init] = requestJsonMock.mock.calls[1]! as [string, RequestInit];
    expect(url).toBe('https://pi.hole.local/api/domains/deny/exact');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ domain: 'bad.example' });
  });

  it('addAllowlistDomain POSTs to /api/domains/allow/exact', async () => {
    queueResponses([AUTH_OK, {}]);

    await newProvider().addAllowlistDomain('safe.example');

    const [url] = requestJsonMock.mock.calls[1]! as [string, RequestInit];
    expect(url).toBe('https://pi.hole.local/api/domains/allow/exact');
  });

  it('removeBlocklistDomain DELETEs the url-encoded domain', async () => {
    queueResponses([AUTH_OK, {}]);

    await newProvider().removeBlocklistDomain('bad sub.example');

    const [url, init] = requestJsonMock.mock.calls[1]! as [string, RequestInit];
    expect(init.method).toBe('DELETE');
    expect(url).toBe('https://pi.hole.local/api/domains/deny/exact/bad%20sub.example');
  });

  it('removeBlocklistDomain treats a 404 as a no-op (already absent)', async () => {
    requestJsonMock
      .mockResolvedValueOnce(AUTH_OK as never)
      .mockRejectedValueOnce(new DnsProviderHttpError(404, 'Not Found', ''));

    await expect(newProvider().removeBlocklistDomain('gone.example')).resolves.toBeUndefined();
  });

  it('propagates non-404 errors from a removal', async () => {
    requestJsonMock
      .mockResolvedValueOnce(AUTH_OK as never)
      .mockRejectedValueOnce(new DnsProviderHttpError(500, 'Server Error', ''));

    await expect(newProvider().removeBlocklistDomain('boom.example')).rejects.toThrow(DnsProviderHttpError);
  });

  it('removeAllowlistDomain DELETEs the allow list url-encoded', async () => {
    queueResponses([AUTH_OK, {}]);

    await newProvider().removeAllowlistDomain('safe sub.example');

    const [url, init] = requestJsonMock.mock.calls[1]! as [string, RequestInit];
    expect(init.method).toBe('DELETE');
    expect(url).toBe('https://pi.hole.local/api/domains/allow/exact/safe%20sub.example');
  });

  it('returns [] and bounds the window with from/until/length on the query call', async () => {
    queueResponses([AUTH_OK, { queries: [] }]);

    const events = await newProvider().syncEvents(
      new Date(1_700_000_000 * 1000),
      new Date(1_700_001_000 * 1000)
    );

    expect(events).toEqual([]);
    const queryUrl = new URL(requestJsonMock.mock.calls[1]![0] as string);
    expect(queryUrl.searchParams.get('from')).toBe('1700000000');
    expect(queryUrl.searchParams.get('until')).toBe('1700001000');
    expect(queryUrl.searchParams.get('length')).toBe('1000');
  });

  it('synthesizes a composite providerEventId when the row has no id', async () => {
    queueResponses([
      AUTH_OK,
      {
        queries: [
          { time: 1_700_000_100, type: 'A', domain: 'noid.example', status: 'FORWARDED', client: { ip: '10.0.0.9' } },
          // No id AND no client.ip → falls back to the 'unknown' source tail.
          { time: 1_700_000_200, type: 'A', domain: 'noip.example', status: 'FORWARDED', client: {} }
        ]
      }
    ]);

    const events = await newProvider().syncEvents(
      new Date(1_700_000_000 * 1000),
      new Date(1_700_001_000 * 1000)
    );

    expect(events[0]!.providerEventId).toBe('1700000100-noid.example-10.0.0.9');
    expect(events[1]!.providerEventId).toBe('1700000200-noip.example-unknown');
  });

  it('drops malformed rows (missing domain/time) while keeping valid ones', async () => {
    queueResponses([
      AUTH_OK,
      {
        queries: [
          { id: 1, time: 1_700_000_100, type: 'A', domain: 'good.example', status: 'FORWARDED', client: { ip: '10.0.0.1' } },
          { id: 2, time: 1_700_000_110, type: 'A', status: 'FORWARDED', client: { ip: '10.0.0.1' } }, // no domain
          { id: 3, type: 'A', domain: 'notime.example', status: 'FORWARDED', client: { ip: '10.0.0.1' } } // no time
        ]
      }
    ]);

    const events = await newProvider().syncEvents(
      new Date(1_700_000_000 * 1000),
      new Date(1_700_001_000 * 1000)
    );

    expect(events.map((e) => e.domain)).toEqual(['good.example']);
  });

  it('stops paging when the server repeats the same cursor (no infinite loop)', async () => {
    const page = Array.from({ length: 1000 }, (_, i) => ({
      id: 2000 - i,
      time: 1_700_000_500,
      type: 'A',
      domain: `d${i}.example`,
      status: 'FORWARDED',
      client: { ip: '10.0.0.1' }
    }));
    // Both full pages report the SAME cursor — the guard must stop after page 2.
    queueResponses([
      AUTH_OK,
      { queries: page, cursor: 555 },
      { queries: page, cursor: 555 }
    ]);

    await newProvider().syncEvents(
      new Date(1_700_000_000 * 1000),
      new Date(1_700_001_000 * 1000)
    );

    // auth + 2 query pages, then it stops rather than re-requesting cursor=555.
    expect(requestJsonMock).toHaveBeenCalledTimes(3);
  });

  it('dispose() releases the session via DELETE /api/auth with the SID', async () => {
    queueResponses([AUTH_OK, {}, {}]);
    const provider = newProvider();

    await provider.addBlocklistDomain('bad.example'); // establishes the session
    await provider.dispose();

    const [url, init] = requestJsonMock.mock.calls[2]! as [string, RequestInit];
    expect(url).toBe('https://pi.hole.local/api/auth');
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>)['X-FTL-SID']).toBe('SID-123');
  });

  it('dispose() is a no-op when no session was established', async () => {
    await newProvider().dispose();
    expect(requestJsonMock).not.toHaveBeenCalled();
  });

  it('dispose() swallows a logout failure (best-effort)', async () => {
    requestJsonMock
      .mockResolvedValueOnce(AUTH_OK as never)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new DnsProviderHttpError(401, 'Unauthorized', ''));
    const provider = newProvider();

    await provider.addBlocklistDomain('bad.example');
    await expect(provider.dispose()).resolves.toBeUndefined();
  });
});
