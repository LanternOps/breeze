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
      'https://api.ui.com/v1/hosts',
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
    expect(url).toBe('https://api.ui.com/v1/hosts');
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

  describe('listSites', () => {
    it('parses siteId + meta.name from the real /v1/sites shape (the "undefined" blocker)', async () => {
      // Site Manager /v1/sites has NO top-level id/name — only siteId, hostId, and
      // meta.name. The old String(s.id) parse produced unifi_site_id="undefined".
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [
        { siteId: 'site-abc', hostId: 'h1', meta: { name: 'Default', desc: 'Main' }, statistics: {} },
      ] }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      const sites = await client.listSites();
      expect(sites).toEqual([{ id: 'site-abc', hostId: 'h1', name: 'Default' }]);
      expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.ui.com/v1/sites');
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

  describe('listDevices', () => {
    it('fetches /v1/devices and returns only the requested host group', async () => {
      // The cloud API has no /v1/hosts/{id}/devices endpoint — that 404'd ("non-JSON").
      // /v1/devices returns every host's devices grouped; we filter to the one host.
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [
        { hostId: 'h1', hostName: 'Console 1', devices: [
          { id: 'aa:bb:cc:dd:ee:01', mac: 'aa:bb:cc:dd:ee:01', name: 'AP-1', model: 'U6-Pro', status: 'online', version: '6.6.0', firmwareStatus: 'upToDate', productLine: 'network' },
        ] },
        { hostId: 'h2', hostName: 'Console 2', devices: [
          { id: 'aa:bb:cc:dd:ee:99', mac: 'aa:bb:cc:dd:ee:99', name: 'Other', model: 'USW' },
        ] },
      ] }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      const devices = await client.listDevices('h1');
      expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.ui.com/v1/devices');
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
      const dev = (await client.listDevices('h1'))[0]!;
      expect(dev.firmwareUpdatable).toBe(true);
    });

    it('throws when the host is absent from the grouped payload (not an empty host)', async () => {
      // Absent host must error so the sync routes it to the per-mapping failure path
      // and skips the stale-sweep — returning [] would unlink still-good devices.
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [
        { hostId: 'other', devices: [{ id: 'd1', mac: 'd1' }] },
      ] }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      await expect(client.listDevices('h1')).rejects.toMatchObject({ name: 'UnifiApiError', status: 404 });
    });

    it('returns [] when the host is present but has zero devices', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [
        { hostId: 'h1', devices: [] },
      ] }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      await expect(client.listDevices('h1')).resolves.toEqual([]);
    });

    it('drops a device with neither id nor mac instead of writing an "undefined" id', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [
        { hostId: 'h1', devices: [{ id: 'good', mac: 'good' }, { name: 'no-identity' }] },
      ] }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      const devices = await client.listDevices('h1');
      expect(devices.map((d) => d.unifiDeviceId)).toEqual(['good']);
    });

    it('returns null firmwareUpdatable for an unknown firmwareStatus', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [
        { hostId: 'h1', devices: [{ id: 'd1', mac: 'd1', firmwareStatus: 'checking' }] },
      ] }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      const dev = (await client.listDevices('h1'))[0]!;
      expect(dev.firmwareUpdatable).toBeNull();
    });
  });

  describe('getIspMetrics', () => {
    it('hits /v1/isp-metrics/{type} and selects the entry for the site', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [
        { siteId: 'other', periods: [] },
        { siteId: 'site-abc', periods: [
          { metricTime: '2026-06-30T00:00:00Z', data: { wan: { avgLatency: 12, packetLoss: 0.5, uptime: 99.9, ispName: 'Comcast' } } },
        ] },
      ] }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      const metrics = await client.getIspMetrics('site-abc');
      expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.ui.com/v1/isp-metrics/5m');
      expect(metrics).toMatchObject({ latencyMs: 12, packetLoss: 0.5, uptimePercent: 99.9, isp: 'Comcast' });
      expect(metrics!.raw).toMatchObject({ siteId: 'site-abc' });
    });

    it('returns an all-null sample (not null) when the matched site has zero periods', async () => {
      // We found the site but it has no WAN samples yet — distinct from "site not found".
      // raw is still the entry so wan_metrics records the (empty) sample.
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [{ siteId: 'site-abc', periods: [] }] }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      const metrics = await client.getIspMetrics('site-abc');
      expect(metrics).toMatchObject({ latencyMs: null, packetLoss: null, uptimePercent: null, isp: null });
      expect(metrics!.raw).toMatchObject({ siteId: 'site-abc' });
    });

    it('returns null when the site has no metrics entry', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [{ siteId: 'other', periods: [] }] }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      await expect(client.getIspMetrics('site-abc')).resolves.toBeNull();
    });

    it('returns null on an explicit data:null envelope', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: null }));
      const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
      await expect(client.getIspMetrics('s1')).resolves.toBeNull();
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
