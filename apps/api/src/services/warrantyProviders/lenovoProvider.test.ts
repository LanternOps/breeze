import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { lenovoAcquire } = vi.hoisted(() => ({
  lenovoAcquire: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./throttle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./throttle')>();
  return { ...actual, lenovoRateLimiter: { acquire: lenovoAcquire } };
});

import { lenovoProvider, resetLenovoProviderState } from './lenovoProvider';

const OFFICIAL_URL = 'https://supportapi.lenovo.com/v2.5/warranty';
const PCSUPPORT_URL = 'https://pcsupport.lenovo.com/us/en/api/v4/upsell/redport/getIbaseInfo';

// Synthetic identifiers — never commit a real device serial to a public repo.
const SERIAL = 'PF0TEST1';
const PRODUCT = '12XX000TUS';

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

const htmlResponse = (html: string, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError(`Unexpected token '<', "${html.slice(0, 10)}"... is not valid JSON`);
    },
    text: async () => html,
  }) as unknown as Response;

// Shape of a live pcsupport response (2026-09-09), identifiers replaced.
const pcsupportFound = {
  code: 0,
  msg: { desc: 'Success', value: null },
  data: {
    machineInfo: { product: PRODUCT, productName: 'Test Desktop (ThinkCentre) - Type 12XX', serial: SERIAL, shipDate: '2025-11-29' },
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
  Serial: SERIAL,
  Product: PRODUCT,
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
  resetLenovoProviderState();
  vi.stubGlobal('fetch', vi.fn());
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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

  it.each(['true', '1', 'TRUE', 'yes', 'on', ' true '])('is on with LENOVO_WARRANTY_ENABLED=%j and no key (canonical envFlag parse)', (v) => {
    vi.stubEnv('LENOVO_API_KEY', '');
    vi.stubEnv('LENOVO_WARRANTY_ENABLED', v);
    expect(lenovoProvider.isConfigured()).toBe(true);
  });

  it.each(['false', '0', 'off', 'enabled'])('treats LENOVO_WARRANTY_ENABLED=%j as off', (v) => {
    vi.stubEnv('LENOVO_API_KEY', '');
    vi.stubEnv('LENOVO_WARRANTY_ENABLED', v);
    expect(lenovoProvider.isConfigured()).toBe(false);
  });
});

describe('lenovoProvider.lookup — pcsupport (no key, LENOVO_WARRANTY_ENABLED)', () => {
  beforeEach(() => {
    vi.stubEnv('LENOVO_API_KEY', '');
    vi.stubEnv('LENOVO_WARRANTY_ENABLED', 'true');
  });

  it('POSTs a JSON body keyed serialNumber, with a User-Agent, a timeout, and no ClientID', async () => {
    fetchMock().mockResolvedValue(jsonResponse(pcsupportFound));
    await lenovoProvider.lookup([SERIAL]);

    expect(fetch).toHaveBeenCalledTimes(1);
    const { url, init } = requestOf(fetchMock().mock.calls[0]);
    expect(url).toBe(PCSUPPORT_URL);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ serialNumber: SERIAL });
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['User-Agent']).toBeTruthy();
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('clientid');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps base + upgrade + contract warranties and takes min start / max end', async () => {
    fetchMock().mockResolvedValue(jsonResponse(pcsupportFound));
    const result = (await lenovoProvider.lookup([SERIAL])).get(SERIAL)!;

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

  it('a 200 HTML bot-challenge page is reported as non-JSON, not a raw SyntaxError', async () => {
    fetchMock().mockResolvedValue(htmlResponse('<html><body>Access Denied</body></html>'));
    const result = (await lenovoProvider.lookup(['X'])).get('X')!;
    expect(result.found).toBe(false);
    expect(result.error).toBe('Lenovo pcsupport returned non-JSON (bot challenge?)');
  });

  it('a 200 JSON null body is an error, not a crash', async () => {
    fetchMock().mockResolvedValue(jsonResponse(null));
    const result = (await lenovoProvider.lookup(['X'])).get('X')!;
    expect(result.found).toBe(false);
    expect(result.error).toBe('Lenovo pcsupport returned an empty response');
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

  it('GETs /v2.5/warranty?Serial= with the ClientID header and a timeout', async () => {
    fetchMock().mockResolvedValue(jsonResponse(officialFound));
    await lenovoProvider.lookup([SERIAL]);

    expect(fetch).toHaveBeenCalledTimes(1);
    const { url, init } = requestOf(fetchMock().mock.calls[0]);
    expect(url).toBe(`${OFFICIAL_URL}?Serial=${SERIAL}`);
    expect(init.method ?? 'GET').toBe('GET');
    expect((init.headers as Record<string, string>).ClientID).toBe('client-id');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps Warranty[] and active Contract[] entries, normalising timestamps to dates', async () => {
    fetchMock().mockResolvedValue(jsonResponse(officialFound));
    const result = (await lenovoProvider.lookup([SERIAL])).get(SERIAL)!;

    expect(result.found).toBe(true);
    expect(result.warrantyStartDate).toBe('2025-12-23');
    expect(result.warrantyEndDate).toBe('2029-12-22');
    expect(result.entitlements).toEqual([
      { provider: 'lenovo', serviceLevelDescription: '3Y On-site, 9X5', entitlementType: 'BASE', startDate: '2025-12-23', endDate: '2028-12-22' },
      { provider: 'lenovo', serviceLevelDescription: 'Premier', entitlementType: 'CONTRACT', startDate: '2025-12-23', endDate: '2029-12-22' },
    ]);
  });

  it('ignores contracts whose Status is not active, so a cancelled contract cannot extend coverage', async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({
        ...officialFound,
        Warranty: [{ Type: 'BASE', Name: 'Base', Start: '2023-01-15T00:00:00', End: '2026-01-15T00:00:00' }],
        Contract: [{ SLA: 'Premier', Status: 'Cancelled', Start: '2023-01-15T00:00:00', End: '2029-12-22T00:00:00' }],
      })
    );
    const result = (await lenovoProvider.lookup([SERIAL])).get(SERIAL)!;
    expect(result.warrantyEndDate).toBe('2026-01-15');
    expect(result.entitlements).toHaveLength(1);
  });

  it('drops unparseable dates instead of passing them to Postgres, and parses non-ISO ones', async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({
        ...officialFound,
        Warranty: [{ Type: 'BASE', Name: 'Base', Start: 'not a date', End: 'Dec 22, 2028' }],
        Contract: [],
      })
    );
    const result = (await lenovoProvider.lookup([SERIAL])).get(SERIAL)!;
    expect(result.found).toBe(true);
    expect(result.warrantyStartDate).toBeNull();
    expect(result.warrantyEndDate).toBe('2028-12-22');
    expect(result.entitlements[0]?.startDate).toBe('');
  });

  it('accepts the list form and picks the record whose Serial matches, not the first one', async () => {
    const decoy = { ...officialFound, Serial: 'OTHER', Warranty: [{ Type: 'BASE', Name: 'Decoy', Start: '2020-01-01', End: '2031-06-30' }], Contract: [] };
    fetchMock().mockResolvedValue(jsonResponse([decoy, officialFound]));
    const result = (await lenovoProvider.lookup([SERIAL])).get(SERIAL)!;
    expect(result.found).toBe(true);
    expect(result.warrantyEndDate).toBe('2029-12-22');
    expect(result.entitlements.map((e) => e.serviceLevelDescription)).not.toContain('Decoy');
  });

  it("a list without the requested serial is an error (and falls back), never another machine's coverage", async () => {
    vi.stubEnv('LENOVO_WARRANTY_ENABLED', 'true');
    fetchMock()
      .mockResolvedValueOnce(jsonResponse([{ ...officialFound, Serial: 'OTHER' }]))
      .mockResolvedValueOnce(jsonResponse(pcsupportNotFound));
    const result = (await lenovoProvider.lookup([SERIAL])).get(SERIAL)!;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.found).toBe(false);
  });

  it('a single record echoing a different Serial is an error, not adopted', async () => {
    fetchMock().mockResolvedValue(jsonResponse({ ...officialFound, Serial: 'OTHER' }));
    const result = (await lenovoProvider.lookup([SERIAL])).get(SERIAL)!;
    expect(result.found).toBe(false);
    expect(result.error).toMatch(/returned serial OTHER/);
  });

  it('an empty Warranty list is not-found, and does NOT fall back to pcsupport', async () => {
    vi.stubEnv('LENOVO_WARRANTY_ENABLED', 'true');
    fetchMock().mockResolvedValue(jsonResponse({ ...officialFound, InWarranty: false, Warranty: [], Contract: [] }));
    const result = (await lenovoProvider.lookup([SERIAL])).get(SERIAL)!;
    expect(result.found).toBe(false);
    expect(result.error).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a 200 error envelope with code 100 is a definite not-found (no fallback)', async () => {
    vi.stubEnv('LENOVO_WARRANTY_ENABLED', 'true');
    fetchMock().mockResolvedValue(jsonResponse({ Error: { Code: 100, Message: 'Warranty data is not found' } }));
    const result = (await lenovoProvider.lookup([SERIAL])).get(SERIAL)!;
    expect(result.found).toBe(false);
    expect(result.error).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a 200 error envelope with any other code is an error and falls back to pcsupport', async () => {
    vi.stubEnv('LENOVO_WARRANTY_ENABLED', 'true');
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ Error: { Code: 101, Message: 'There are multiple records found. Please specify SN.MT instead of SN' } }))
      .mockResolvedValueOnce(jsonResponse(pcsupportFound));
    const result = (await lenovoProvider.lookup([SERIAL])).get(SERIAL)!;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.found).toBe(true);
    expect(result.warrantyEndDate).toBe('2029-12-22');
  });

  it('a 200 body that is not a warranty record ({}) is an error, never a silent not-found', async () => {
    fetchMock().mockResolvedValue(jsonResponse({}));
    const result = (await lenovoProvider.lookup([SERIAL])).get(SERIAL)!;
    expect(result.found).toBe(false);
    expect(result.error).toBe('Lenovo API returned an unrecognised response');
  });

  it('a non-2xx official response is an error when pcsupport is not enabled', async () => {
    fetchMock().mockResolvedValue(jsonResponse({ Message: 'Authorization has been denied for this request.' }, 401));
    const result = (await lenovoProvider.lookup(['X'])).get('X')!;
    expect(result.found).toBe(false);
    expect(result.error).toBe('Lenovo API 401');
  });

  it('falls back to pcsupport when the official call fails and pcsupport is enabled, and logs the dead key', async () => {
    vi.stubEnv('LENOVO_WARRANTY_ENABLED', 'true');
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ Message: 'denied' }, 401))
      .mockResolvedValueOnce(jsonResponse(pcsupportFound));
    const result = (await lenovoProvider.lookup([SERIAL])).get(SERIAL)!;

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(requestOf(fetchMock().mock.calls[0]).url).toContain(OFFICIAL_URL);
    expect(requestOf(fetchMock().mock.calls[1]).url).toBe(PCSUPPORT_URL);
    expect(lenovoAcquire).toHaveBeenCalledTimes(2);
    expect(result.found).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.warrantyEndDate).toBe('2029-12-22');
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/rejected LENOVO_API_KEY.*401.*pcsupport fallback/));
  });

  it('after a 401/403 the official path is paused for an hour: later serials go straight to pcsupport', async () => {
    vi.stubEnv('LENOVO_WARRANTY_ENABLED', 'true');
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ Message: 'denied' }, 403))
      .mockResolvedValue(jsonResponse(pcsupportFound));
    await lenovoProvider.lookup(['A']);
    await lenovoProvider.lookup(['B', 'C']);

    // 1 official (403) + 3 pcsupport; no further official attempts.
    expect(fetch).toHaveBeenCalledTimes(4);
    const urls = fetchMock().mock.calls.map((c) => requestOf(c).url);
    expect(urls.filter((u) => u.startsWith(OFFICIAL_URL))).toHaveLength(1);
    expect(lenovoAcquire).toHaveBeenCalledTimes(4);
  });

  it('while paused with no pcsupport, serials are reported as paused rather than silently not-found', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({ Message: 'denied' }, 401));
    await lenovoProvider.lookup(['A']);
    const result = (await lenovoProvider.lookup(['B'])).get('B')!;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.found).toBe(false);
    expect(result.error).toMatch(/credentials rejected/);
  });

  it('a 5xx does not pause the official path (transient), and pcsupport still covers the serial', async () => {
    vi.stubEnv('LENOVO_WARRANTY_ENABLED', 'true');
    fetchMock()
      .mockResolvedValueOnce(jsonResponse('upstream', 503))
      .mockResolvedValueOnce(jsonResponse(pcsupportFound))
      .mockResolvedValueOnce(jsonResponse(officialFound));
    await lenovoProvider.lookup(['A']);
    const second = (await lenovoProvider.lookup([SERIAL])).get(SERIAL)!;
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(second.found).toBe(true);
    expect(second.entitlements[1]?.entitlementType).toBe('CONTRACT');
  });

  it('reports both errors when both paths fail', async () => {
    vi.stubEnv('LENOVO_WARRANTY_ENABLED', 'true');
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ Message: 'denied' }, 401))
      .mockResolvedValueOnce(jsonResponse('blocked', 403));
    const result = (await lenovoProvider.lookup(['X'])).get('X')!;
    expect(result.found).toBe(false);
    expect(result.error).toBe('Lenovo pcsupport API 403 (official: Lenovo API 401)');
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
