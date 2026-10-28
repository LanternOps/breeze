import { afterEach, describe, it, expect, vi } from 'vitest';

const { safeFetchMock } = vi.hoisted(() => ({
  safeFetchMock: vi.fn(),
}));

vi.mock('../urlSafety', () => ({
  safeFetch: safeFetchMock,
}));

import { createUnifiClient, UnifiApiError } from './unifiClient';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('unifiClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    safeFetchMock.mockReset();
  });

  it('uses the SSRF-safe transport with timeout and response-size limits by default', async () => {
    safeFetchMock.mockResolvedValue(
      jsonResponse({ data: [{ id: 'h1', reportedState: { name: 'Console 1' } }] })
    );
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('global fetch must not be used'));

    const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k' });
    await expect(client.listHosts()).resolves.toEqual([
      { id: 'h1', name: 'Console 1', type: null, model: null },
    ]);

    expect(globalFetch).not.toHaveBeenCalled();
    expect(safeFetchMock).toHaveBeenCalledWith(
      'https://api.ui.com/v1/hosts?pageSize=100',
      expect.objectContaining({
        method: 'GET',
        timeoutMs: expect.any(Number),
        maxBytes: expect.any(Number),
      }),
    );
  });

  it('does not follow redirects returned by the SSRF-safe transport', async () => {
    safeFetchMock.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } })
    );

    const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k' });

    await expect(client.listHosts()).rejects.toMatchObject({ name: 'UnifiApiError', status: 302 });
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends X-API-KEY and hits /v1/hosts for listHosts', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ data: [{ id: 'h1', reportedState: { name: 'Console 1' } }] })
    );
    const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
    const hosts = await client.listHosts();
    expect(hosts).toEqual([{ id: 'h1', name: 'Console 1', type: null, model: null }]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.ui.com/v1/hosts?pageSize=100');
    expect((init.headers as Record<string, string>)['X-API-KEY']).toBe('k');
  });

  it('reads the console name from reportedState, not a non-existent top-level name', async () => {
    // Real Site Manager /v1/hosts puts the user-facing name under reportedState;
    // falling back to the host id here is what produced the "cryptic host IDs" report.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [
      { id: 'h1', reportedState: { name: 'Front Office UDM' } },
      { id: 'h2', reportedState: { hostname: 'udm-pro' } },
      { id: 'h3', reportedState: { hardware: { name: 'UDM Pro Max' } } },
      { id: 'h4' },
    ] }));
    const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
    const hosts = await client.listHosts();
    expect(hosts.map((h) => ({ id: h.id, name: h.name }))).toEqual([
      { id: 'h1', name: 'Front Office UDM' },
      { id: 'h2', name: 'udm-pro' },
      { id: 'h3', name: 'UDM Pro Max' },
      { id: 'h4', name: 'h4' },
    ]);
  });

  it('surfaces host type and hardware model for the mapping UI', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [
      { id: 'h1', type: 'console', reportedState: { name: 'UDM', hardware: { name: 'UDM Pro Max', shortname: 'UDMPROMAX' } } },
      { id: 'h2', type: 'network-server', reportedState: { name: 'Cloud Key' } },
    ] }));
    const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
    const hosts = await client.listHosts();
    expect(hosts).toEqual([
      { id: 'h1', name: 'UDM', type: 'console', model: 'UDM Pro Max' },
      { id: 'h2', name: 'Cloud Key', type: 'network-server', model: null },
    ]);
  });

  it('throws UnifiApiError on a non-ok HTTP status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: 'unauthorized' }, 401));
    const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'bad', fetchImpl });
    await expect(client.listHosts()).rejects.toBeInstanceOf(UnifiApiError);
    await expect(client.listHosts()).rejects.toMatchObject({ status: 401 });
  });

  it('retries on 429 then succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'rate limited' }, 429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'h1', reportedState: { name: 'Console 1' } }] }));
    const sleepImpl = vi.fn(async () => undefined);
    const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl, sleepImpl });
    await expect(client.listHosts()).resolves.toEqual([{ id: 'h1', name: 'Console 1', type: null, model: null }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).toHaveBeenCalledWith(2000);
  });

  it('gives up after bounded retries on persistent 429', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ message: 'rate limited' }, 429)));
    const sleepImpl = vi.fn(async () => undefined);
    const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl, sleepImpl });
    await expect(client.listHosts()).rejects.toMatchObject({ name: 'UnifiApiError', status: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleepImpl).toHaveBeenCalledTimes(2);
  });

  it('falls back to default delay when Retry-After is absent', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'rate limited' }, 429))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'h1', reportedState: { name: 'Console 1' } }] }));
    const sleepImpl = vi.fn(async () => undefined);
    const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl, sleepImpl });
    await expect(client.listHosts()).resolves.toEqual([{ id: 'h1', name: 'Console 1', type: null, model: null }]);
    expect(sleepImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).toHaveBeenCalledWith(1000);
  });

  it('listSites pages through nextToken with an explicit pageSize', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ siteId: 's1', hostId: 'h1', meta: { name: 'One' } }], nextToken: 'tok:2' }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ siteId: 's2', hostId: 'h2', meta: { name: 'Two' } }] }));
    const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
    expect(await client.listSites()).toEqual([
      { id: 's1', hostId: 'h1', name: 'One' },
      { id: 's2', hostId: 'h2', name: 'Two' },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.ui.com/v1/sites?pageSize=100');
    const next = new URL(fetchImpl.mock.calls[1]![0]);
    expect(next.pathname).toBe('/v1/sites');
    expect(next.searchParams.get('pageSize')).toBe('100');
    expect(next.searchParams.get('nextToken')).toBe('tok:2');
  });

  it('listHosts pages through nextToken', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'h1', name: 'One' }], nextToken: 'tok:2' }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'h2', name: 'Two' }] }));
    const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
    expect(await client.listHosts()).toEqual([
      { id: 'h1', name: 'One', type: null, model: null },
      { id: 'h2', name: 'Two', type: null, model: null },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.ui.com/v1/hosts?pageSize=100');
    const next = new URL(fetchImpl.mock.calls[1]![0]);
    expect(next.pathname).toBe('/v1/hosts');
    expect(next.searchParams.get('pageSize')).toBe('100');
    expect(next.searchParams.get('nextToken')).toBe('tok:2');
  });

  it('refuses to return a partial list when the page cap is exceeded', async () => {
    let page = 0;
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ id: 'h1' }], nextToken: `tok-${++page}` }));
    const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
    await expect(client.listHosts()).rejects.toMatchObject({ name: 'UnifiApiError' });
    expect(fetchImpl).toHaveBeenCalledTimes(50);
  });

  it('fails on a repeated nextToken instead of looping', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ id: 'h1' }], nextToken: 'same' }));
    const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
    await expect(client.listHosts()).rejects.toBeInstanceOf(UnifiApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a page 2 HTTP 500 instead of returning a partial site list', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ siteId: 's1', hostId: 'h1' }], nextToken: 'page-2' }))
      .mockResolvedValueOnce(jsonResponse({ message: 'upstream failed' }, 500));
    const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
    await expect(client.listSites()).rejects.toMatchObject({ name: 'UnifiApiError', status: 500 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects an unreadable page 2 instead of returning a partial site list', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ siteId: 's1', hostId: 'h1' }], nextToken: 'page-2' }))
      .mockResolvedValueOnce(new Response('not JSON', { status: 200 }));
    const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
    await expect(client.listSites()).rejects.toMatchObject({ name: 'UnifiApiError', status: 502 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a numeric nextToken instead of treating it as the last page', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [{ siteId: 's1', hostId: 'h1' }], nextToken: 42 }));
    const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
    await expect(client.listSites()).rejects.toMatchObject({ name: 'UnifiApiError', status: 502 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('treats an empty nextToken as the end of the list', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [{ siteId: 's1', hostId: 'h1' }], nextToken: '' }));
    const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
    await expect(client.listSites()).resolves.toEqual([{ id: 's1', hostId: 'h1', name: 's1' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  describe('listSites', () => {
    it('reports dropped rows and missing host ids for sync without changing listSites', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ data: [
        { siteId: 's1', hostId: 'h1', meta: { name: 'Main' } },
        { hostId: 'h1', meta: { name: 'Missing site id' } },
        { siteId: 's2', meta: { name: 'Missing host' } },
        { meta: { name: 'Missing both' } },
      ] }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      const sites = [
        { id: 's1', hostId: 'h1', name: 'Main' },
        { id: 's2', hostId: '', name: 'Missing host' },
      ];
      await expect(client.listSitesForSync()).resolves.toEqual({
        sites, hostsWithDroppedRows: new Set(['h1']), rowsWithoutHostId: 2,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await expect(client.listSites()).resolves.toEqual(sites);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('parses siteId + meta.name from the real /v1/sites shape (the "undefined" blocker)', async () => {
      // Site Manager /v1/sites has NO top-level id/name — only siteId, hostId, and
      // meta.name. The old String(s.id) parse produced unifi_site_id="undefined".
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [
        { siteId: 'site-abc', hostId: 'h1', meta: { name: 'Default', desc: 'Main' }, statistics: {} },
      ] }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      const sites = await client.listSites();
      expect(sites).toEqual([{ id: 'site-abc', hostId: 'h1', name: 'Default' }]);
      expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.ui.com/v1/sites?pageSize=100');
    });

    it('never emits an "undefined"/empty site id, dropping malformed rows', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [
        { siteId: 'good', hostId: 'h1', meta: { name: 'Good' } },
        { hostId: 'h1', meta: { name: 'Missing siteId' } }, // no siteId → must be dropped
      ] }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      const sites = await client.listSites();
      expect(sites).toEqual([{ id: 'good', hostId: 'h1', name: 'Good' }]);
      expect(sites.every((s) => s.id && s.id !== 'undefined')).toBe(true);
    });

    it('falls back to the siteId for the display name when meta.name is absent', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [
        { siteId: 'site-xyz', hostId: 'h1', meta: {} },
      ] }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      const sites = await client.listSites();
      expect(sites).toEqual([{ id: 'site-xyz', hostId: 'h1', name: 'site-xyz' }]);
    });
  });

  describe('listDevicesByHost', () => {
    it.each([
      { devices: [{ id: 'd1' }] },
      { hostId: '', devices: [{ id: 'd1' }] },
      { devices: null },
      {},
    ])('rejects a device group without a host id: %j', async (group) => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [group] }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      await expect(client.listDevicesByHost()).rejects.toMatchObject({
        name: 'UnifiApiError', status: 502,
        message: 'UniFi /v1/devices returned a device group with no host id; refusing to sync a partial device list',
      });
    });

    it('ignores an empty device group without a host id', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [
        { devices: [] }, { hostId: '', devices: [] }, { hostId: 'h1', devices: [] },
      ] }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      await expect(client.listDevicesByHost()).resolves.toEqual(new Map([['h1', []]]));
    });

    it('merges groups for the same host across pages', async () => {
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(jsonResponse({ data: [{ hostId: 'h1', devices: [{ id: 'd1' }] }], nextToken: 'next' }))
        .mockResolvedValueOnce(jsonResponse({ data: [{ hostId: 'h1', devices: [{ id: 'd2' }] }, { hostId: 'h2', devices: [] }] }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      const devices = await client.listDevicesByHost();
      expect(devices.get('h1')!.map((d) => d.unifiDeviceId)).toEqual(['d1', 'd2']);
      expect(devices.get('h2')).toEqual([]);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('omits a host when a later page has no device list while retaining other hosts', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(jsonResponse({ data: [{ hostId: 'h1', devices: [{ id: 'd1' }] }], nextToken: 'page-2' }))
        .mockResolvedValueOnce(jsonResponse({ data: [{ hostId: 'h1' }, { hostId: 'h2', devices: [{ id: 'd2' }] }] }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      const devices = await client.listDevicesByHost();
      expect(devices.has('h1')).toBe(false);
      expect(devices.get('h2')!.map((d) => d.unifiDeviceId)).toEqual(['d2']);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledExactlyOnceWith('[unifi] listDevicesByHost: 1 host group(s) had no device list — /v1/devices shape may have changed');
    });

    it.each([null, {}, 'invalid'])('keeps a host invalid after malformed devices %j even if a later group is valid', async (malformed) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [
        { hostId: 'h1', devices: malformed },
        { hostId: 'h1', devices: [{ id: 'd1' }] },
        { hostId: 'h2', devices: [] },
      ] }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      const devices = await client.listDevicesByHost();
      expect(devices.has('h1')).toBe(false);
      expect(devices.get('h2')).toEqual([]);
      expect(warn).toHaveBeenCalledExactlyOnceWith('[unifi] listDevicesByHost: 1 host group(s) had no device list — /v1/devices shape may have changed');
    });

    it('fetches /v1/devices and returns devices grouped by host', async () => {
      // The cloud API has no /v1/hosts/{id}/devices endpoint — that 404'd ("non-JSON").
      // /v1/devices returns every host's devices grouped.
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [
        { hostId: 'h1', hostName: 'Console 1', devices: [
          { id: 'aa:bb:cc:dd:ee:01', mac: 'aa:bb:cc:dd:ee:01', name: 'AP-1', model: 'U6-Pro', status: 'online', version: '6.6.0', firmwareStatus: 'upToDate', productLine: 'network' },
        ] },
        { hostId: 'h2', hostName: 'Console 2', devices: [
          { id: 'aa:bb:cc:dd:ee:99', mac: 'aa:bb:cc:dd:ee:99', name: 'Other', model: 'USW' },
        ] },
      ] }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      const devices = (await client.listDevicesByHost()).get('h1')!;
      expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.ui.com/v1/devices?pageSize=100');
      expect(devices).toHaveLength(1);
      const dev = devices[0]!;
      expect(dev.unifiDeviceId).toBe('aa:bb:cc:dd:ee:01');
      expect(dev.mac).toBe('aa:bb:cc:dd:ee:01');
      expect(dev.name).toBe('AP-1');
      expect(dev.model).toBe('U6-Pro');
      expect(dev.firmwareVersion).toBe('6.6.0');
      expect(dev.firmwareUpdatable).toBe(false);
      expect(dev.adoptionState).toBe('online');
      expect(dev.raw).toMatchObject({ id: 'aa:bb:cc:dd:ee:01', model: 'U6-Pro' });
    });

    it('derives firmwareUpdatable from an "upgradable" firmwareStatus', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [
        { hostId: 'h1', devices: [{ id: 'd1', mac: 'd1', firmwareStatus: 'upgradable' }] },
      ] }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      const dev = ((await client.listDevicesByHost()).get('h1')!)[0]!;
      expect(dev.firmwareUpdatable).toBe(true);
    });

    it('omits an absent host from the map (not an empty host)', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [
        { hostId: 'other', devices: [{ id: 'd1', mac: 'd1' }] },
      ] }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      expect((await client.listDevicesByHost()).has('h1')).toBe(false);
    });

    it('returns [] when the host is present but has zero devices', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [
        { hostId: 'h1', devices: [] },
      ] }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      const devices = await client.listDevicesByHost();
      expect(devices.has('h1')).toBe(true);
      expect(devices.get('h1')).toEqual([]);
      expect(devices.has('missing')).toBe(false);
    });

    it('drops a device with neither id nor mac instead of writing an "undefined" id', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [
        { hostId: 'h1', devices: [{ id: 'good', mac: 'good' }, { name: 'no-identity' }] },
      ] }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      const devices = (await client.listDevicesByHost()).get('h1')!;
      expect(devices.map((d) => d.unifiDeviceId)).toEqual(['good']);
    });

    it('returns null firmwareUpdatable for an unknown firmwareStatus', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [
        { hostId: 'h1', devices: [{ id: 'd1', mac: 'd1', firmwareStatus: 'checking' }] },
      ] }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      const dev = ((await client.listDevicesByHost()).get('h1')!)[0]!;
      expect(dev.firmwareUpdatable).toBeNull();
    });
  });

  describe('listIspMetricsBySite', () => {
    it('keys ISP samples by host and site when different hosts use the same site id', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [
        { hostId: 'h1', siteId: 's1', periods: [{ data: { wan: { avgLatency: 12 } } }] },
        { hostId: 'h2', siteId: 's1', periods: [{ data: { wan: { avgLatency: 50 } } }] },
      ] }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      const metrics = await client.listIspMetricsBySite();
      expect([...metrics.keys()]).toEqual(['h1::s1', 'h2::s1']);
      expect(metrics.get('h1::s1')!.latencyMs).toBe(12);
      expect(metrics.get('h2::s1')!.latencyMs).toBe(50);
      expect(metrics.get('h1::s1')!.raw).toMatchObject({ hostId: 'h1', siteId: 's1' });
      expect(metrics.get('h2::s1')!.raw).toMatchObject({ hostId: 'h2', siteId: 's1' });
    });

    it('hits /v1/isp-metrics/{type} without paging params and groups entries by site', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [
        { siteId: 'other', periods: [] },
        { siteId: 'site-abc', periods: [
          { data: { wan: { avgLatency: 99 } } },
          { metricTime: '2026-06-30T00:00:00Z', data: { wan: { avgLatency: 12, packetLoss: 0.5, uptime: 99.9, ispName: 'Comcast' } } },
        ] },
      ] }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      const metrics = (await client.listIspMetricsBySite()).get('site-abc');
      expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.ui.com/v1/isp-metrics/5m');
      expect(metrics).toMatchObject({ latencyMs: 12, packetLoss: 0.5, uptimePercent: 99.9, isp: 'Comcast' });
      expect(metrics!.raw).toMatchObject({ siteId: 'site-abc' });
    });

    it('keeps the first ISP entry when a site appears twice', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [
        { siteId: 'site-abc', periods: [{ data: { wan: { avgLatency: 12 } } }] },
        { siteId: 'site-abc', periods: [{ data: { wan: { avgLatency: 50 } } }] },
      ] }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      const metrics = await client.listIspMetricsBySite();
      expect(metrics.size).toBe(1);
      expect(metrics.get('site-abc')!.latencyMs).toBe(12);
    });

    it('returns an all-null sample (not null) when the matched site has zero periods', async () => {
      // We found the site but it has no WAN samples yet — distinct from "site not found".
      // raw is still the entry so wan_metrics records the (empty) sample.
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [{ siteId: 'site-abc', periods: [] }] }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      const metrics = (await client.listIspMetricsBySite()).get('site-abc');
      expect(metrics).toMatchObject({ latencyMs: null, packetLoss: null, uptimePercent: null, isp: null });
      expect(metrics!.raw).toMatchObject({ siteId: 'site-abc' });
    });

    it('omits a site with no metrics entry', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [{ siteId: 'other', periods: [] }] }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      expect((await client.listIspMetricsBySite()).has('site-abc')).toBe(false);
    });

    it('returns an empty map on an explicit data:null envelope', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: null }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      await expect(client.listIspMetricsBySite()).resolves.toEqual(new Map());
    });
  });

  it('throws UnifiApiError on a meta.rc=error envelope (HTTP 200)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ meta: { rc: 'error', msg: 'not found' } }, 200)
    );
    const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
    // Single call: a Response body can only be read once, so assert both facets at once.
    await expect(client.listHosts()).rejects.toMatchObject({ name: 'UnifiApiError', status: 200 });
  });
});
