import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { lenovoAcquire } = vi.hoisted(() => ({
  lenovoAcquire: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./throttle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./throttle')>();
  return { ...actual, lenovoRateLimiter: { acquire: lenovoAcquire } };
});

import { lenovoProvider } from './lenovoProvider';

const OFFICIAL_URL = 'https://supportapi.lenovo.com/v2.5/warranty';
const PCSUPPORT_URL = 'https://pcsupport.lenovo.com/us/en/api/v4/upsell/redport/getIbaseInfo';

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

// Verbatim shape of a live pcsupport response (2026-09-09, ThinkCentre M75q Gen 5).
const pcsupportFound = {
  code: 0,
  msg: { desc: 'Success', value: null },
  data: {
    machineInfo: { product: '12RQ000KUS', productName: 'M75q Gen 5 Desktop (ThinkCentre) - Type 12RQ', serial: 'MZ02YRNV', shipDate: '2025-11-29' },
    baseWarranties: [
      { type: 'BASE', category: 'MACHINE', name: '3Y On-site, 9X5', description: 'Three year limited warranty...', startDate: '2025-12-23', endDate: '2028-12-22', remainingDays: 835 },
    ],
    upgradeWarranties: [
      { type: 'UPGRADE', category: 'MACHINE', name: 'Premier Support', description: '...', startDate: '2025-12-23', endDate: '2029-12-22', remainingDays: 1200 },
    ],
    contractWarranties: [],
    warrantyStatus: 'In warranty',
    oow: false,
  },
};

const pcsupportNotFound = {
  code: 100,
  msg: { desc: 'Call sde api: No information was found.', value: null },
  data: null,
};

// Shape per https://supportapi.lenovo.com/Documentation/Warranty.html (v2.5).
const officialFound = {
  Serial: 'MZ02YRNV',
  Product: '12RQ000KUS',
  InWarranty: true,
  Shipped: '2025-11-29T00:00:00',
  Country: 'US',
  Warranty: [
    { ID: '3YOS', Name: '3Y On-site, 9X5', Description: 'Three year...', Type: 'BASE', Start: '2025-12-23T00:00:00', End: '2028-12-22T00:00:00' },
  ],
  Contract: [
    { Contract: 'C123', SLA: 'Premier', EntitlementCode: 'PS', Status: 'Active', Start: '2025-12-23T00:00:00', End: '2029-12-22T00:00:00' },
  ],
};

function fetchMock() {
  return vi.mocked(fetch as unknown as ReturnType<typeof vi.fn>);
}

function requestOf(call: unknown[] | undefined): { url: string; init: RequestInit } {
  if (!call) throw new Error('fetch was not called');
  return { url: String(call[0]), init: (call[1] ?? {}) as RequestInit };
}

beforeEach(() => {
  lenovoAcquire.mockClear();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('lenovoProvider.isConfigured', () => {
  it('is off with neither the official key nor the pcsupport opt-in', () => {
    vi.stubEnv('LENOVO_API_KEY', '');
    vi.stubEnv('LENOVO_WARRANTY_ENABLED', '');
    expect(lenovoProvider.isConfigured()).toBe(false);
  });

  it('is on with an official ClientID', () => {
    vi.stubEnv('LENOVO_API_KEY', 'client-id');
    vi.stubEnv('LENOVO_WARRANTY_ENABLED', '');
    expect(lenovoProvider.isConfigured()).toBe(true);
  });

  it.each(['true', '1'])('is on with LENOVO_WARRANTY_ENABLED=%s and no key', (v) => {
    vi.stubEnv('LENOVO_API_KEY', '');
    vi.stubEnv('LENOVO_WARRANTY_ENABLED', v);
    expect(lenovoProvider.isConfigured()).toBe(true);
  });

  it('treats other LENOVO_WARRANTY_ENABLED values as off', () => {
    vi.stubEnv('LENOVO_API_KEY', '');
    vi.stubEnv('LENOVO_WARRANTY_ENABLED', 'false');
    expect(lenovoProvider.isConfigured()).toBe(false);
  });
});

describe('lenovoProvider.lookup — pcsupport (no key, LENOVO_WARRANTY_ENABLED)', () => {
  beforeEach(() => {
    vi.stubEnv('LENOVO_API_KEY', '');
    vi.stubEnv('LENOVO_WARRANTY_ENABLED', 'true');
  });

  it('POSTs a JSON body keyed serialNumber, with a User-Agent and no ClientID', async () => {
    fetchMock().mockResolvedValue(jsonResponse(pcsupportFound));
    await lenovoProvider.lookup(['MZ02YRNV']);

    expect(fetch).toHaveBeenCalledTimes(1);
    const { url, init } = requestOf(fetchMock().mock.calls[0]);
    expect(url).toBe(PCSUPPORT_URL);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ serialNumber: 'MZ02YRNV' });
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['User-Agent']).toBeTruthy();
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('clientid');
  });

  it('maps base + upgrade + contract warranties and takes min start / max end', async () => {
    fetchMock().mockResolvedValue(jsonResponse(pcsupportFound));
    const result = (await lenovoProvider.lookup(['MZ02YRNV'])).get('MZ02YRNV')!;

    expect(result.found).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.warrantyStartDate).toBe('2025-12-23');
    expect(result.warrantyEndDate).toBe('2029-12-22');
    expect(result.entitlements).toEqual([
      { provider: 'lenovo', serviceLevelDescription: '3Y On-site, 9X5', entitlementType: 'BASE', startDate: '2025-12-23', endDate: '2028-12-22' },
      { provider: 'lenovo', serviceLevelDescription: 'Premier Support', entitlementType: 'UPGRADE', startDate: '2025-12-23', endDate: '2029-12-22' },
    ]);
  });

  it('code 100 (no information) is not-found without an error', async () => {
    fetchMock().mockResolvedValue(jsonResponse(pcsupportNotFound));
    const result = (await lenovoProvider.lookup(['NOPE'])).get('NOPE')!;
    expect(result).toEqual({ found: false, entitlements: [], warrantyStartDate: null, warrantyEndDate: null });
  });

  it('any other non-zero code surfaces the vendor message as an error', async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({ code: 101, msg: { desc: "Request method 'GET' is not supported", value: null }, data: null })
    );
    const result = (await lenovoProvider.lookup(['X'])).get('X')!;
    expect(result.found).toBe(false);
    expect(result.error).toMatch(/101/);
    expect(result.error).toMatch(/GET/);
  });

  it('non-2xx HTTP is an error, not a silent not-found', async () => {
    fetchMock().mockResolvedValue(jsonResponse('<html>Access Denied</html>', 403));
    const result = (await lenovoProvider.lookup(['X'])).get('X')!;
    expect(result.found).toBe(false);
    expect(result.error).toBe('Lenovo pcsupport API 403');
  });

  it('a network failure is captured per serial', async () => {
    fetchMock().mockRejectedValue(new Error('ECONNRESET'));
    const result = (await lenovoProvider.lookup(['X'])).get('X')!;
    expect(result.found).toBe(false);
    expect(result.error).toBe('ECONNRESET');
  });

  it('acquires the limiter once per vendor request', async () => {
    fetchMock().mockResolvedValue(jsonResponse(pcsupportNotFound));
    await lenovoProvider.lookup(['A', 'B']);
    expect(lenovoAcquire).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('lenovoProvider.lookup — official supportapi (LENOVO_API_KEY)', () => {
  beforeEach(() => {
    vi.stubEnv('LENOVO_API_KEY', 'client-id');
    vi.stubEnv('LENOVO_WARRANTY_ENABLED', '');
  });

  it('GETs /v2.5/warranty?Serial= with the ClientID header', async () => {
    fetchMock().mockResolvedValue(jsonResponse(officialFound));
    await lenovoProvider.lookup(['MZ02YRNV']);

    expect(fetch).toHaveBeenCalledTimes(1);
    const { url, init } = requestOf(fetchMock().mock.calls[0]);
    expect(url).toBe(`${OFFICIAL_URL}?Serial=MZ02YRNV`);
    expect(init.method ?? 'GET').toBe('GET');
    expect((init.headers as Record<string, string>).ClientID).toBe('client-id');
  });

  it('maps Warranty[] and Contract[] entries, normalising timestamps to dates', async () => {
    fetchMock().mockResolvedValue(jsonResponse(officialFound));
    const result = (await lenovoProvider.lookup(['MZ02YRNV'])).get('MZ02YRNV')!;

    expect(result.found).toBe(true);
    expect(result.warrantyStartDate).toBe('2025-12-23');
    expect(result.warrantyEndDate).toBe('2029-12-22');
    expect(result.entitlements).toEqual([
      { provider: 'lenovo', serviceLevelDescription: '3Y On-site, 9X5', entitlementType: 'BASE', startDate: '2025-12-23', endDate: '2028-12-22' },
      { provider: 'lenovo', serviceLevelDescription: 'Premier', entitlementType: 'CONTRACT', startDate: '2025-12-23', endDate: '2029-12-22' },
    ]);
  });

  it('accepts the list form and picks the matching Serial', async () => {
    fetchMock().mockResolvedValue(jsonResponse([{ ...officialFound, Serial: 'OTHER', Warranty: [] }, officialFound]));
    const result = (await lenovoProvider.lookup(['MZ02YRNV'])).get('MZ02YRNV')!;
    expect(result.found).toBe(true);
    expect(result.warrantyEndDate).toBe('2029-12-22');
  });

  it('an empty Warranty list is not-found, and does NOT fall back to pcsupport', async () => {
    vi.stubEnv('LENOVO_WARRANTY_ENABLED', 'true');
    fetchMock().mockResolvedValue(jsonResponse({ ...officialFound, InWarranty: false, Warranty: [], Contract: [] }));
    const result = (await lenovoProvider.lookup(['MZ02YRNV'])).get('MZ02YRNV')!;
    expect(result.found).toBe(false);
    expect(result.error).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a non-2xx official response is an error when pcsupport is not enabled', async () => {
    fetchMock().mockResolvedValue(jsonResponse({ Message: 'Authorization has been denied for this request.' }, 401));
    const result = (await lenovoProvider.lookup(['X'])).get('X')!;
    expect(result.found).toBe(false);
    expect(result.error).toBe('Lenovo API 401');
  });

  it('falls back to pcsupport when the official call fails and pcsupport is enabled', async () => {
    vi.stubEnv('LENOVO_WARRANTY_ENABLED', 'true');
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ Message: 'denied' }, 401))
      .mockResolvedValueOnce(jsonResponse(pcsupportFound));
    const result = (await lenovoProvider.lookup(['MZ02YRNV'])).get('MZ02YRNV')!;

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(requestOf(fetchMock().mock.calls[0]).url).toContain(OFFICIAL_URL);
    expect(requestOf(fetchMock().mock.calls[1]).url).toBe(PCSUPPORT_URL);
    expect(lenovoAcquire).toHaveBeenCalledTimes(2);
    expect(result.found).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.warrantyEndDate).toBe('2029-12-22');
  });

  it('reports the pcsupport error when both paths fail', async () => {
    vi.stubEnv('LENOVO_WARRANTY_ENABLED', 'true');
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ Message: 'denied' }, 401))
      .mockResolvedValueOnce(jsonResponse('blocked', 403));
    const result = (await lenovoProvider.lookup(['X'])).get('X')!;
    expect(result.found).toBe(false);
    expect(result.error).toBe('Lenovo pcsupport API 403');
  });
});

describe('lenovoProvider.lookup — not configured', () => {
  it('makes no vendor calls, acquires nothing, and says so per serial', async () => {
    vi.stubEnv('LENOVO_API_KEY', '');
    vi.stubEnv('LENOVO_WARRANTY_ENABLED', '');
    const results = await lenovoProvider.lookup(['A', 'B']);
    expect(fetch).not.toHaveBeenCalled();
    expect(lenovoAcquire).not.toHaveBeenCalled();
    expect(results.get('A')?.error).toBe('Lenovo warranty lookup not configured');
    expect(results.get('B')?.found).toBe(false);
  });
});
