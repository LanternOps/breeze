import { describe, it, expect, vi } from 'vitest';
import { createUnifiClient, UnifiApiError } from './unifiClient';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('unifiClient', () => {
  it('sends X-API-KEY and parses the {data} envelope for listHosts', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ data: [{ id: 'h1', name: 'Console 1' }] })
    );
    const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
    const hosts = await client.listHosts();
    expect(hosts).toEqual([{ id: 'h1', name: 'Console 1' }]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.ui.com/v1/hosts');
    expect((init.headers as Record<string, string>)['X-API-KEY']).toBe('k');
  });

  it('throws UnifiApiError on a non-ok HTTP status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: 'unauthorized' }, 401));
    const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'bad', fetchImpl });
    await expect(client.listHosts()).rejects.toBeInstanceOf(UnifiApiError);
    await expect(client.listHosts()).rejects.toMatchObject({ status: 401 });
  });

  it('maps a raw device payload to UnifiDeviceDto and preserves raw', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [{
      id: 'd1', mac: 'aa:bb', name: 'AP-1', model: 'U6-Pro', type: 'uap',
      ipAddress: '10.0.0.5', firmwareVersion: '6.6.0', firmwareUpdatable: true,
      state: 'CONNECTED', uptime: 1234,
    }] }));
    const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
    const [dev] = await client.listDevices('h1');
    expect(dev.unifiDeviceId).toBe('d1');
    expect(dev.mac).toBe('aa:bb');
    expect(dev.deviceType).toBe('uap');
    expect(dev.uptimeSeconds).toBe(1234);
    expect(dev.raw).toMatchObject({ id: 'd1', model: 'U6-Pro' });
  });

  it('throws UnifiApiError on a meta.rc=error envelope (HTTP 200)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ meta: { rc: 'error', msg: 'not found' } }, 200)
    );
    const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
    // Single call: a Response body can only be read once, so assert both facets at once.
    await expect(client.listHosts()).rejects.toMatchObject({ name: 'UnifiApiError', status: 200 });
  });

  it('returns null from getIspMetrics on an explicit data:null envelope', async () => {
    // Regression: `data ?? body` would have returned the whole envelope here.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: null }));
    const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
    await expect(client.getIspMetrics('s1')).resolves.toBeNull();
  });
});
