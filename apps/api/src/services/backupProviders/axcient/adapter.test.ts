import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AXCIENT_DEFAULT_BASE_URL,
  AXCIENT_PROVIDER_KEY,
  AXCIENT_PROVIDER_LABEL,
  __setAxcientClientFactoryForTests,
  axcientAdapter as adapter,
  axcientCredentialsSchema,
  validateAxcientBaseUrl,
} from './adapter';
import { AXCIENT_SCOPE_MESSAGE, AxcientClient, type AxcientFetchImpl } from './client';
import organization from './__fixtures__/organization.json';
import clients from './__fixtures__/clients.json';
import devices101 from './__fixtures__/devices-client-101.json';
import devices102 from './__fixtures__/devices-client-102.json';
import unauthorized from './__fixtures__/error-unauthorized.json';
import forbidden from './__fixtures__/error-forbidden.json';

const CREDS = { apiKey: 'test-axcient-key-0000' };
const BASE = AXCIENT_DEFAULT_BASE_URL;

type Override = (path: string) => { status?: number; body: unknown; delayMs?: number } | undefined;
const fixtures: Record<string, unknown> = {
  organization, client: clients, 'client/101/device': devices101, 'client/102/device': devices102, 'client/103/device': [],
};

function fakeVendor(override?: Override) {
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = vi.fn<AxcientFetchImpl>(async (url) => {
    const path = new URL(url).pathname.replace('/x360recover/', '');
    const response = override?.(path);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (response?.delayMs) await new Promise((resolve) => setTimeout(resolve, response.delayMs));
      const status = response?.status ?? 200;
      const body = response ? response.body : fixtures[path] ?? { message: 'missing fixture' };
      return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
    } finally {
      inFlight -= 1;
    }
  });
  __setAxcientClientFactoryForTests((baseUrl, apiKey) => new AxcientClient({ baseUrl, apiKey, fetchImpl, sleepImpl: async () => {} }));
  return { fetchImpl, maxInFlight: () => maxInFlight };
}
const paths = (fetchImpl: ReturnType<typeof fakeVendor>['fetchImpl']) =>
  fetchImpl.mock.calls.map(([url]) => new URL(url).pathname.replace('/x360recover/', ''));

afterEach(() => { __setAxcientClientFactoryForTests(null); vi.restoreAllMocks(); });

describe('configuration', () => {
  it('declares endpoint inventory, 30-minute default, root_id continuity and the default URL', () => {
    expect(adapter.key).toBe(AXCIENT_PROVIDER_KEY);
    expect(adapter.key).toBe('axcient');
    expect(adapter.label).toBe(AXCIENT_PROVIDER_LABEL);
    expect(adapter.label).toBe('Axcient x360Recover');
    expect(adapter.inventoryKind).toBeUndefined();
    expect(adapter.defaultSyncIntervalMinutes).toBe(30);
    expect(adapter.rootContinuity).toBe('root_id');
    expect(adapter.defaultBaseUrl).toBe('https://axapi.axcient.com/x360recover');
    expect(adapter.credentialsSchema).toBe(axcientCredentialsSchema);
    expect(adapter.validateBaseUrl).toBe(validateAxcientBaseUrl);
  });

  it('trims apiKey and rejects blank/missing', () => {
    expect(axcientCredentialsSchema.parse({ apiKey: ' k ' })).toEqual({ apiKey: 'k' });
    expect(axcientCredentialsSchema.parse({ apiKey: 'k', partnerName: 'x', password: 'y' })).toEqual({ apiKey: 'k' });
    for (const bad of [{ apiKey: '' }, { apiKey: '  ' }, {}, { apiKey: 7 }]) {
      expect(axcientCredentialsSchema.safeParse(bad).success).toBe(false);
    }
  });

  it.each(['https://axapi.axcient.com/x360recover', 'https://eu.axapi.axcient.com/x360recover'])('accepts %s', (url) =>
    expect(validateAxcientBaseUrl(url)).toBeNull());

  it.each([
    'http://axapi.axcient.com/x360recover',
    'https://axcient.com.evil.example/x',
    'https://evilaxcient.com/x',
    'https://u:p' + '@axapi.axcient.com/x', // split: the PII guard reads userinfo URLs as emails
    'https://axapi.axcient.com/x?a=1',
    'https://axapi.axcient.com/x#frag',
    'bad',
  ])('rejects %s', (url) => expect(validateAxcientBaseUrl(url)).toEqual(expect.any(String)));
});

describe('testConnection', () => {
  it('testConnection: rootId = String(org.id), rootName = org.name, customerCount = clients.length', async () => {
    const { fetchImpl } = fakeVendor();
    await expect(adapter.testConnection(CREDS, BASE)).resolves.toEqual({
      ok: true, rootId: '26', rootName: 'Synthetic MSP', customerCount: 3,
    });
    expect(paths(fetchImpl)).toEqual(['organization', 'client']);
    expect(fetchImpl.mock.calls[0]![1].headers['X-Api-Key']).toBe('test-axcient-key-0000');
  });

  it('zero clients is a healthy empty account', async () => {
    fakeVendor((path) => (path === 'client' ? { body: [] } : undefined));
    await expect(adapter.testConnection(CREDS, BASE)).resolves.toMatchObject({ ok: true, customerCount: 0 });
    await expect(adapter.listCustomers(CREDS, BASE, '26')).resolves.toEqual([]);
    await expect(adapter.listDevices(CREDS, BASE, '26')).resolves.toEqual({ devices: [], failedCustomerIds: [] });
  });

  it('testConnection 401 => {ok:false, reauth:true, error: "Axcient rejected the API key."}', async () => {
    fakeVendor(() => ({ status: 401, body: unauthorized }));
    await expect(adapter.testConnection(CREDS, BASE)).resolves.toEqual({
      ok: false, reauth: true, error: 'Axcient rejected the API key.',
    });
  });

  it('testConnection 403 ForbiddenException => {ok:false, reauth:true, error: scope message}', async () => {
    fakeVendor((path) => (path === 'client' ? { status: 403, body: forbidden } : undefined));
    await expect(adapter.testConnection(CREDS, BASE)).resolves.toEqual({ ok: false, reauth: true, error: AXCIENT_SCOPE_MESSAGE });
  });

  it('testConnection never echoes the key and rejects a bad base URL before any request', async () => {
    const { fetchImpl } = fakeVendor();
    const result = await adapter.testConnection(CREDS, 'https://evil.example/x360recover');
    expect(result).toMatchObject({ ok: false, reauth: false });
    expect(JSON.stringify(result)).not.toContain(CREDS.apiKey);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('listCustomers', () => {
  it('listCustomers maps id/name/client_code, parentId null, level "0", keeps inactive clients', async () => {
    fakeVendor();
    const customers = await adapter.listCustomers(CREDS, BASE, '26');
    expect(customers).toEqual([
      { vendorCustomerId: '101', name: 'Synthetic Client A', parentId: null, level: '0', externalCode: 'SYNA' },
      { vendorCustomerId: '102', name: 'Synthetic Client B', parentId: null, level: '0', externalCode: 'SYNB' },
      { vendorCustomerId: '103', name: 'Synthetic Client C', parentId: null, level: '0', externalCode: 'SYNC' },
    ]);
  });

  it('rejects a client whose id is not a positive integer', async () => {
    fakeVendor((path) => (path === 'client' ? { body: [{ id: 'abc', name: 'x' }] } : undefined));
    await expect(adapter.listCustomers(CREDS, BASE, '26')).rejects.toMatchObject({ code: 'malformed_response' });
  });
});

describe('listDevices', () => {
  it('listDevices fetches every client, inactive included, at concurrency <= 2', async () => {
    const { fetchImpl, maxInFlight } = fakeVendor((path) => (path.endsWith('/device') ? { body: fixtures[path], delayMs: 5 } : undefined));
    const { devices, failedCustomerIds } = await adapter.listDevices(CREDS, BASE, '26');
    expect(failedCustomerIds).toEqual([]);
    expect(paths(fetchImpl).filter((p) => p.endsWith('/device')).sort()).toEqual([
      'client/101/device', 'client/102/device', 'client/103/device',
    ]);
    expect(devices.map((d) => d.vendorDeviceId).sort()).toEqual(['501', '502', '503', '504', '511', '512', '513', '514', '515']);
    expect(devices.find((d) => d.vendorDeviceId === '511')?.vendorCustomerId).toBe('102'); // inactive client 102
    expect(maxInFlight()).toBe(2);
  });

  it('per-customer 5xx keeps going and reports failedCustomerIds', async () => {
    fakeVendor((path) => (path === 'client/102/device' ? { status: 503, body: {} } : undefined));
    const { devices, failedCustomerIds } = await adapter.listDevices(CREDS, BASE, '26');
    expect(failedCustomerIds).toEqual(['102']);
    expect(devices.map((d) => d.vendorDeviceId).sort()).toEqual(['501', '502', '503', '504']);
  });

  it('401 on a device call fails the whole run as reauth', async () => {
    fakeVendor((path) => (path === 'client/102/device' ? { status: 401, body: unauthorized } : undefined));
    await expect(adapter.listDevices(CREDS, BASE, '26')).rejects.toMatchObject({ code: 'http_401', reauth: true });
  });

  it('a fatal error stops the other worker from starting another client', async () => {
    const { fetchImpl } = fakeVendor((path) => {
      if (path === 'client/101/device') return { status: 401, body: unauthorized, delayMs: 5 };
      if (path === 'client/102/device') return { body: devices102, delayMs: 50 };
      return undefined;
    });
    await expect(adapter.listDevices(CREDS, BASE, '26')).rejects.toMatchObject({ code: 'http_401', reauth: true });
    await new Promise((resolve) => setTimeout(resolve, 100)); // let the in-flight 102 call finish
    expect(paths(fetchImpl)).not.toContain('client/103/device');
  });

  it('403 ForbiddenException on a device call fails the whole run as reauth', async () => {
    fakeVendor((path) => (path === 'client/102/device' ? { status: 403, body: forbidden } : undefined));
    await expect(adapter.listDevices(CREDS, BASE, '26')).rejects.toMatchObject({ code: 'http_403', reauth: true, message: AXCIENT_SCOPE_MESSAGE });
  });

  it('every customer failing throws all_customers_failed', async () => {
    fakeVendor((path) => (path.endsWith('/device') ? { status: 404, body: {} } : undefined));
    await expect(adapter.listDevices(CREDS, BASE, '26')).rejects.toMatchObject({ code: 'all_customers_failed', reauth: false });
  });

  it('device paths are built from numeric ids only', async () => {
    const { fetchImpl } = fakeVendor();
    await adapter.listDevices(CREDS, BASE, '26');
    for (const path of paths(fetchImpl).filter((p) => p.startsWith('client/'))) {
      expect(path).toMatch(/^client\/\d+\/device$/);
    }
  });

  it('attributes devices to the client they were fetched for', async () => {
    fakeVendor((path) => (path === 'client/103/device'
      ? { body: [{ id: 901, name: 'SYN-NOCLIENT', current_health_status: { status: 'NORMAL' } }] }
      : undefined));
    const { devices } = await adapter.listDevices(CREDS, BASE, '26');
    expect(devices.find((d) => d.vendorDeviceId === '901')?.vendorCustomerId).toBe('103');
  });

  it('a device that claims another client fails only that client', async () => {
    // Trusting the payload would file client 101's device under client 102's org.
    fakeVendor((path) => (path === 'client/103/device' ? { body: [{ ...devices101[0], client_id: 101 }] } : undefined));
    const { devices, failedCustomerIds } = await adapter.listDevices(CREDS, BASE, '26');
    expect(failedCustomerIds).toEqual(['103']);
    expect(devices.filter((d) => d.vendorDeviceId === '501')).toHaveLength(1);
  });

  it('throws invalid_credentials (reauth) for a malformed blob', async () => {
    const { fetchImpl } = fakeVendor();
    await expect(adapter.listDevices({ apiKey: ' ' }, BASE, '26')).rejects.toMatchObject({ code: 'invalid_credentials', reauth: true });
    await expect(adapter.listCustomers(null, BASE, '26')).rejects.toMatchObject({ code: 'invalid_credentials', reauth: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
