import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdGuardHomeProvider } from './adguardHome';

interface MockResponse {
  ok: boolean;
  status?: number;
  statusText?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

function makeFetchMock(responses: MockResponse[]): ReturnType<typeof vi.fn> {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error('fetch mock exhausted');
    const headers = new Map(Object.entries(next.headers ?? {}));
    return {
      ok: next.ok,
      status: next.status ?? (next.ok ? 200 : 500),
      statusText: next.statusText ?? '',
      text: async () => JSON.stringify(next.body ?? {}),
      headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null }
    } as unknown as Response;
  });
}

describe('AdGuardHomeProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function newProvider(): AdGuardHomeProvider {
    return new AdGuardHomeProvider('admin', 'hunter2', { apiEndpoint: 'https://adguard.example/' });
  }

  it('throws when apiEndpoint is missing', async () => {
    const provider = new AdGuardHomeProvider('admin', 'hunter2', {});
    await expect(provider.syncEvents(new Date(0), new Date())).rejects.toThrow(/apiEndpoint/);
  });

  it('sends HTTP Basic auth header on requests', async () => {
    const fetchMock = makeFetchMock([{ ok: true, body: { data: [] } }]);
    vi.stubGlobal('fetch', fetchMock);

    await newProvider().syncEvents(new Date(0), new Date());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0]!;
    const [url, init] = call as [string | URL, RequestInit];
    expect(String(url)).toContain('https://adguard.example/control/querylog');
    const auth = init.headers as Record<string, string>;
    // Basic admin:hunter2 → base64(YWRtaW46aHVudGVyMg==)
    expect(auth.Authorization).toBe('Basic YWRtaW46aHVudGVyMg==');
  });

  it('maps blocked reasons to action=blocked and parses domain/timestamp', async () => {
    const fetchMock = makeFetchMock([{
      ok: true,
      body: {
        data: [{
          time: '2026-05-21T10:00:00Z',
          question: { name: 'tracker.bad.example', type: 'A' },
          reason: 'FilteredBlackList',
          client: '10.0.0.5',
          client_info: { name: 'workstation-3' },
          elapsedMs: '0.42',
          cached: false,
          upstream: 'tls://1.1.1.1'
        }]
      }
    }]);
    vi.stubGlobal('fetch', fetchMock);

    const events = await newProvider().syncEvents(
      new Date('2026-05-21T00:00:00Z'),
      new Date('2026-05-22T00:00:00Z')
    );

    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.domain).toBe('tracker.bad.example');
    expect(ev.action).toBe('blocked');
    expect(ev.sourceIp).toBe('10.0.0.5');
    expect(ev.sourceHostname).toBe('workstation-3');
    expect(ev.queryType).toBe('A');
    expect(ev.metadata?.reason).toBe('FilteredBlackList');
    expect(ev.providerEventId).toContain('tracker.bad.example');
  });

  it('maps Rewrite reasons to action=redirected and unfiltered to allowed', async () => {
    const fetchMock = makeFetchMock([{
      ok: true,
      body: {
        data: [
          {
            time: '2026-05-21T10:00:00Z',
            question: { name: 'ok.example', type: 'A' },
            reason: 'NotFilteredNotFound',
            client: '10.0.0.5'
          },
          {
            time: '2026-05-21T10:00:01Z',
            question: { name: 'internal.example', type: 'A' },
            reason: 'RewriteEtcHosts',
            client: '10.0.0.5'
          }
        ]
      }
    }]);
    vi.stubGlobal('fetch', fetchMock);

    const events = await newProvider().syncEvents(
      new Date('2026-05-21T00:00:00Z'),
      new Date('2026-05-22T00:00:00Z')
    );

    expect(events.map((e) => e.action)).toEqual(['allowed', 'redirected']);
  });

  it('stops paging once a timestamp falls before `since`', async () => {
    const fetchMock = makeFetchMock([{
      ok: true,
      body: {
        data: [
          { time: '2026-05-21T11:00:00Z', question: { name: 'a.example', type: 'A' }, reason: 'NotFilteredNotFound' },
          { time: '2026-05-21T09:00:00Z', question: { name: 'b.example', type: 'A' }, reason: 'NotFilteredNotFound' },
          { time: '2026-05-20T10:00:00Z', question: { name: 'c.example', type: 'A' }, reason: 'NotFilteredNotFound' }
        ]
      }
    }]);
    vi.stubGlobal('fetch', fetchMock);

    const events = await newProvider().syncEvents(
      new Date('2026-05-21T10:00:00Z'),
      new Date('2026-05-21T23:59:59Z')
    );

    expect(events.map((e) => e.domain)).toEqual(['a.example']);
    // Only the first page is fetched because the third entry crossed `since`.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('addBlocklistDomain appends an Adblock-style rule preserving existing rules', async () => {
    const fetchMock = makeFetchMock([
      { ok: true, body: { user_rules: ['||existing.bad^', '@@||allowed.good^'] } },
      { ok: true, body: {} }
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await newProvider().addBlocklistDomain('new.bad.example');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const init = fetchMock.mock.calls[1]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as { rules: string[] };
    expect(body.rules).toEqual(['||existing.bad^', '@@||allowed.good^', '||new.bad.example^']);
  });

  it('addBlocklistDomain is a no-op when rule already exists', async () => {
    const fetchMock = makeFetchMock([
      { ok: true, body: { user_rules: ['||already.bad^'] } }
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await newProvider().addBlocklistDomain('already.bad');

    expect(fetchMock).toHaveBeenCalledTimes(1); // only the GET, no POST
  });

  it('removeBlocklistDomain removes the matching rule and POSTs the new set', async () => {
    const fetchMock = makeFetchMock([
      { ok: true, body: { user_rules: ['||one.bad^', '||two.bad^', '@@||three.good^'] } },
      { ok: true, body: {} }
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await newProvider().removeBlocklistDomain('two.bad');

    const init = fetchMock.mock.calls[1]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as { rules: string[] };
    expect(body.rules).toEqual(['||one.bad^', '@@||three.good^']);
  });

  it('addAllowlistDomain appends @@-prefixed rule', async () => {
    const fetchMock = makeFetchMock([
      { ok: true, body: { user_rules: [] } },
      { ok: true, body: {} }
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await newProvider().addAllowlistDomain('safe.example');

    const init = fetchMock.mock.calls[1]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as { rules: string[] };
    expect(body.rules).toEqual(['@@||safe.example^']);
  });
});
