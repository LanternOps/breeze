import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DnsFilterProvider, type DnsFilterProviderConfig } from './dnsfilter';
import { DnsProviderHttpError, requestJson } from './http';

// Same shape as the Umbrella/Cloudflare/AdGuard provider tests: transport is
// not exercised, only the provider's request shaping and response handling.
vi.mock('./http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./http')>();
  return {
    ...actual,
    requestJson: vi.fn()
  };
});

const requestJsonMock = vi.mocked(requestJson);

/*
 * FIXTURES ARE DOCUMENTATION-DERIVED, NOT CAPTURED FROM A LIVE ACCOUNT (#12699).
 *
 * Every response below is built from DNSFilter's published OpenAPI document
 * (https://api.dnsfilter.com/docs/api.json, version 2026-11-20):
 *
 * - GET /v1/traffic_reports/query_logs answers `{ data: TrafficReportsQueryLogs }`.
 *   Rows are `data.values[]` (schema TrafficReportsQueryLogsResult); paging is
 *   `data.page` (schema TrafficReportsPaginationResponse: size, total, first,
 *   last, self, prev, next).
 * - POST /v1/policies/{id}/add_blacklist_domain (and remove_/whitelist
 *   variants) take PolicyUpdateSingleDomainSpec `{ domain, note }`.
 * - V1 errors are `{ "error": "string" }`.
 *
 * No request in this file has been checked against the real API.
 */

const BASE = 'https://api.dnsfilter.com';
const QUERY_LOGS = `${BASE}/v1/traffic_reports/query_logs`;

/** One TrafficReportsQueryLogsResult row, documented field names only. */
function docRow(overrides: Record<string, unknown> = {}) {
  return {
    time: '2026-11-25T12:10:00.123Z',
    fqdn: 'www.malware.example',
    domain: 'malware.example',
    networkid: 42,
    network_name: 'Head office',
    request_address: '203.0.113.7',
    result: 'blocked',
    threat: true,
    categories: [12],
    categories_names: ['Malware'],
    question_type: 'A',
    agentid: '3a1e7c3e-0000-4000-8000-000000000001',
    agentname: 'FRONTDESK-01',
    agenttype: 'agent',
    local_ipv4_address: '10.0.0.15',
    local_ipv6_address: null,
    lan_device_name: null,
    policy_id: 7,
    policy_name: 'Default policy',
    ...overrides
  };
}

/** A query_logs response in page-number mode (TrafficReportsPaginationResponse). */
function docPage(values: unknown[], page: { self: number; last: number; next: number | null; size?: number; total?: number }) {
  return {
    data: {
      organization_id: 1001,
      organization_name: 'Example org',
      values,
      page: {
        size: page.size ?? 100,
        total: page.total ?? values.length,
        first: 1,
        last: page.last,
        self: page.self,
        prev: page.self > 1 ? page.self - 1 : null,
        next: page.next
      }
    }
  };
}

function urlOf(call: unknown[]): URL {
  return new URL(String(call[0]));
}
function initOf(call: unknown[]): RequestInit & { headers?: Record<string, string> } {
  return (call[1] ?? {}) as RequestInit & { headers?: Record<string, string> };
}
function bodyOf(call: unknown[]): any {
  return JSON.parse(String(initOf(call).body));
}

function makeProvider(config: DnsFilterProviderConfig = {}) {
  return new DnsFilterProvider('dnsf-key', config);
}

const SINCE = new Date('2026-11-24T12:15:00.000Z');
const UNTIL = new Date('2026-11-25T12:15:00.000Z');

beforeEach(() => {
  requestJsonMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DnsFilterProvider.syncEvents — documented query-log endpoint (#12699)', () => {
  it('calls GET /v1/traffic_reports/query_logs, not the undocumented /v1/dns-events', async () => {
    requestJsonMock.mockResolvedValueOnce(docPage([], { self: 1, last: 1, next: null }) as never);

    await makeProvider().syncEvents(SINCE, UNTIL);

    expect(requestJsonMock).toHaveBeenCalledTimes(1);
    const call = requestJsonMock.mock.calls[0]!;
    const url = urlOf(call);
    expect(`${url.origin}${url.pathname}`).toBe(QUERY_LOGS);
    expect(url.pathname).not.toContain('dns-events');
  });

  it('sends the API key itself as the Authorization header (no Bearer prefix)', async () => {
    requestJsonMock.mockResolvedValueOnce(docPage([], { self: 1, last: 1, next: null }) as never);

    await makeProvider().syncEvents(SINCE, UNTIL);

    expect(initOf(requestJsonMock.mock.calls[0]!).headers?.Authorization).toBe('dnsf-key');
  });

  it('sends from/to without milliseconds, result=blocked by default, and the nested page object', async () => {
    requestJsonMock.mockResolvedValueOnce(docPage([], { self: 1, last: 1, next: null }) as never);

    await makeProvider().syncEvents(SINCE, UNTIL);

    const params = urlOf(requestJsonMock.mock.calls[0]!).searchParams;
    expect(params.get('from')).toBe('2026-11-24T12:15:00Z');
    expect(params.get('to')).toBe('2026-11-25T12:15:00Z');
    expect(params.get('result')).toBe('blocked');
    expect(params.get('page[number]')).toBe('1');
    expect(params.get('page[size]')).toBe('100');
    // Nothing from the old guessed shape.
    for (const key of ['limit', 'page', 'cursor', 'accountId']) {
      expect(params.has(key)).toBe(false);
    }
    expect(params.has('organization_id')).toBe(false);
  });

  it('asks for all results when the integration stores allowed traffic', async () => {
    requestJsonMock.mockResolvedValueOnce(docPage([], { self: 1, last: 1, next: null }) as never);

    await makeProvider({ storeAllowedTraffic: true }).syncEvents(SINCE, UNTIL);

    expect(urlOf(requestJsonMock.mock.calls[0]!).searchParams.get('result')).toBe('all');
  });

  it('sends organization_id from config.organizationId', async () => {
    requestJsonMock.mockResolvedValueOnce(docPage([], { self: 1, last: 1, next: null }) as never);

    await makeProvider({ organizationId: '1001' }).syncEvents(SINCE, UNTIL);

    expect(urlOf(requestJsonMock.mock.calls[0]!).searchParams.get('organization_id')).toBe('1001');
  });

  it('reads a numeric legacy "Account ID" (config.accountId) as the organization id', async () => {
    requestJsonMock.mockResolvedValueOnce(docPage([], { self: 1, last: 1, next: null }) as never);

    await makeProvider({ accountId: '2002' }).syncEvents(SINCE, UNTIL);

    expect(urlOf(requestJsonMock.mock.calls[0]!).searchParams.get('organization_id')).toBe('2002');
  });

  it('refuses a non-numeric legacy Account ID with a message that says what to enter, without calling DNSFilter', async () => {
    await expect(makeProvider({ accountId: 'acct-abc' }).syncEvents(SINCE, UNTIL)).rejects.toThrow(
      /DNSFilter organization ID.*whole number.*Stored data/
    );
    expect(requestJsonMock).not.toHaveBeenCalled();
  });

  it('maps documented query-log fields onto DNS events', async () => {
    requestJsonMock.mockResolvedValueOnce(docPage([
      docRow(),
      docRow({
        time: '2026-11-25T12:11:00Z',
        fqdn: 'cdn.example.org',
        domain: 'example.org',
        result: 'allowed',
        threat: false,
        categories: [],
        categories_names: [],
        question_type: 'AAAA',
        agentname: null,
        lan_device_name: 'printer-2',
        local_ipv4_address: null
      })
    ], { self: 1, last: 1, next: null }) as never);

    const events = await makeProvider({ storeAllowedTraffic: true }).syncEvents(SINCE, UNTIL);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      timestamp: new Date('2026-11-25T12:10:00.123Z'),
      domain: 'www.malware.example',
      queryType: 'A',
      action: 'blocked',
      category: 'Malware',
      threatType: 'Malware',
      sourceIp: '10.0.0.15',
      sourceHostname: 'FRONTDESK-01',
      // Rows carry no id; the sync job derives a deterministic one.
      providerEventId: undefined
    });
    expect(events[1]).toMatchObject({
      domain: 'cdn.example.org',
      queryType: 'AAAA',
      action: 'allowed',
      category: undefined,
      threatType: undefined,
      sourceIp: '203.0.113.7',
      sourceHostname: 'printer-2'
    });
  });

  it('drops a row with an unrecognized result instead of counting it as allowed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    requestJsonMock.mockResolvedValueOnce(docPage([
      docRow({ result: 'quarantined' }),
      docRow({ time: 'not-a-time' }),
      docRow()
    ], { self: 1, last: 1, next: null }) as never);

    const events = await makeProvider().syncEvents(SINCE, UNTIL);

    expect(events).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped 2 unparseable'));
  });

  it('follows data.page.next until it is null', async () => {
    requestJsonMock
      .mockResolvedValueOnce(docPage([docRow({ fqdn: 'a.example' })], { self: 1, last: 3, next: 2, total: 3 }) as never)
      .mockResolvedValueOnce(docPage([docRow({ fqdn: 'b.example' })], { self: 2, last: 3, next: 3, total: 3 }) as never)
      .mockResolvedValueOnce(docPage([docRow({ fqdn: 'c.example' })], { self: 3, last: 3, next: null, total: 3 }) as never);

    const events = await makeProvider().syncEvents(SINCE, UNTIL);

    expect(events.map((e) => e.domain)).toEqual(['a.example', 'b.example', 'c.example']);
    expect(requestJsonMock.mock.calls.map((c) => urlOf(c).searchParams.get('page[number]'))).toEqual(['1', '2', '3']);
  });

  it('fails loudly when the response has no data.values array (shape drift is not a successful empty sync)', async () => {
    requestJsonMock.mockResolvedValueOnce({ data: [] } as never);

    await expect(makeProvider().syncEvents(SINCE, UNTIL)).rejects.toThrow(/data\.values/);
  });

  it('reports a truncated slice when the page cap is reached and DNSFilter still has more pages', async () => {
    requestJsonMock.mockImplementation(async (input) => {
      const n = Number(new URL(String(input)).searchParams.get('page[number]'));
      return docPage([docRow({ fqdn: `p${n}.example` })], { self: n, last: 999, next: n + 1, total: 999 }) as never;
    });

    const slices = [];
    for await (const slice of makeProvider().syncEventSlices(SINCE, UNTIL)) slices.push(slice);

    expect(slices).toHaveLength(1);
    expect(slices[0]!.until).toEqual(UNTIL);
    expect(slices[0]!.truncated).toEqual({ from: SINCE, to: UNTIL, reachableRecords: slices[0]!.events.length });
    expect(slices[0]!.events.length).toBeGreaterThan(0);
  });

  it('surfaces DNSFilter\'s status and error text when the call fails', async () => {
    requestJsonMock.mockRejectedValueOnce(
      new DnsProviderHttpError(401, 'Unauthorized', '{"error":"Not Authorized"}')
    );

    const failure = makeProvider().syncEvents(SINCE, UNTIL);
    await expect(failure).rejects.toBeInstanceOf(DnsProviderHttpError);
    await expect(failure).rejects.toThrow(/DNSFilter.*HTTP 401 Unauthorized.*Not Authorized/);
  });
});

describe('DnsFilterProvider block/allow edits — documented policy endpoints (#12699)', () => {
  it('adds a blocked domain with POST /v1/policies/{id}/add_blacklist_domain and a { domain, note } body', async () => {
    requestJsonMock.mockResolvedValueOnce({ data: {} } as never);

    await makeProvider({ policyId: '7' }).addBlocklistDomain('bad.example', 'phishing');

    const call = requestJsonMock.mock.calls[0]!;
    expect(String(call[0])).toBe(`${BASE}/v1/policies/7/add_blacklist_domain`);
    expect(initOf(call).method).toBe('POST');
    expect(initOf(call).headers?.Authorization).toBe('dnsf-key');
    expect(bodyOf(call)).toMatchObject({ domain: 'bad.example', note: 'phishing' });
  });

  it('uses the matching remove/whitelist endpoints, each with a note (required by the schema)', async () => {
    requestJsonMock.mockResolvedValue({ data: {} } as never);
    const provider = makeProvider({ policyId: '7' });

    await provider.removeBlocklistDomain('bad.example');
    await provider.addAllowlistDomain('good.example');
    await provider.removeAllowlistDomain('good.example');

    expect(requestJsonMock.mock.calls.map((c) => String(c[0]))).toEqual([
      `${BASE}/v1/policies/7/remove_blacklist_domain`,
      `${BASE}/v1/policies/7/add_whitelist_domain`,
      `${BASE}/v1/policies/7/remove_whitelist_domain`
    ]);
    for (const call of requestJsonMock.mock.calls) {
      expect(initOf(call).method).toBe('POST');
      expect(typeof bodyOf(call).note).toBe('string');
      expect(bodyOf(call).note.length).toBeGreaterThan(0);
    }
    expect(bodyOf(requestJsonMock.mock.calls[0]!).domain).toBe('bad.example');
  });

  it('never calls the undocumented /v1/lists routes, even with legacy list ids saved', async () => {
    await expect(
      makeProvider({ blocklistId: 'bl-1', allowlistId: 'al-1' }).addBlocklistDomain('bad.example')
    ).rejects.toThrow(/policy ID.*Stored data/);
    expect(requestJsonMock).not.toHaveBeenCalled();
  });

  it('says a policy ID is needed when none is configured', async () => {
    await expect(makeProvider().addAllowlistDomain('good.example')).rejects.toThrow(/DNSFilter policy ID/);
    expect(requestJsonMock).not.toHaveBeenCalled();
  });

  it('surfaces DNSFilter\'s 404 for an unknown policy with a hint', async () => {
    requestJsonMock.mockRejectedValueOnce(new DnsProviderHttpError(404, 'Not Found', '{"error":"Not Found"}'));

    await expect(makeProvider({ policyId: '7' }).addBlocklistDomain('bad.example')).rejects.toThrow(
      /HTTP 404 Not Found.*policy/
    );
  });
});
