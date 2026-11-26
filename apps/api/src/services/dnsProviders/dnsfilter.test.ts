import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DNSFILTER_MAX_PAGES,
  DNSFILTER_MAX_REQUESTS_PER_RUN,
  DNSFILTER_PAGE_SIZE,
  DNSFILTER_SLICE_MS,
  DnsFilterProvider, type DnsFilterProviderConfig } from './dnsfilter';
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

// A window inside one slice (DNSFILTER_SLICE_MS = 1 h), so each test sees one request per page.
const SINCE = new Date('2026-11-25T11:45:00.000Z');
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
    expect(params.get('from')).toBe('2026-11-25T11:45:00Z');
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
    expect(requestJsonMock).toHaveBeenCalledTimes(DNSFILTER_MAX_PAGES);
    expect(slices[0]!.events).toHaveLength(DNSFILTER_MAX_PAGES);
    expect(slices[0]!.truncated).toEqual({ from: SINCE, to: UNTIL, reachableRecords: DNSFILTER_MAX_PAGES });
  });

  it('does not mark a window truncated when its last page is exactly the page cap', async () => {
    requestJsonMock.mockImplementation(async (input) => {
      const n = Number(new URL(String(input)).searchParams.get('page[number]'));
      return docPage([docRow({ fqdn: `p${n}.example` })], {
        self: n, last: DNSFILTER_MAX_PAGES, next: n < DNSFILTER_MAX_PAGES ? n + 1 : null
      }) as never;
    });

    const slices = [];
    for await (const slice of makeProvider().syncEventSlices(SINCE, UNTIL)) slices.push(slice);

    expect(requestJsonMock).toHaveBeenCalledTimes(DNSFILTER_MAX_PAGES);
    expect(slices[0]!.truncated).toBeUndefined();
  });

  it('surfaces DNSFilter\'s status and error text when the call fails', async () => {
    requestJsonMock.mockRejectedValueOnce(
      new DnsProviderHttpError(401, 'Unauthorized', '{"error":"Not Authorized"}')
    );

    const failure = makeProvider().syncEvents(SINCE, UNTIL);
    await expect(failure).rejects.toBeInstanceOf(DnsProviderHttpError);
    await expect(failure).rejects.toThrow(/DNSFilter.*HTTP 401 Unauthorized.*Not Authorized.*Check that the DNSFilter API key is valid/);
  });
});

describe('DnsFilterProvider paging guards (#12699)', () => {
  it('stops on an empty page even if it names a next page', async () => {
    requestJsonMock.mockResolvedValueOnce(docPage([], { self: 1, last: 5, next: 2 }) as never);

    await makeProvider().syncEvents(SINCE, UNTIL);

    expect(requestJsonMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to self < last when next is absent', async () => {
    const first = docPage([docRow({ fqdn: 'a.example' })], { self: 1, last: 2, next: null });
    delete (first.data.page as Record<string, unknown>).next;
    requestJsonMock
      .mockResolvedValueOnce(first as never)
      .mockResolvedValueOnce(docPage([docRow({ fqdn: 'b.example' })], { self: 2, last: 2, next: null }) as never);

    const events = await makeProvider().syncEvents(SINCE, UNTIL);

    expect(events.map((e) => e.domain)).toEqual(['a.example', 'b.example']);
  });

  it('fails when paging does not advance, instead of looping or stopping quietly', async () => {
    requestJsonMock.mockResolvedValueOnce(docPage([docRow()], { self: 2, last: 5, next: 2 }) as never);

    await expect(makeProvider().syncEvents(SINCE, UNTIL)).rejects.toThrow(/paging did not advance/);
    expect(requestJsonMock).toHaveBeenCalledTimes(1);
  });

  it('fails on a full page with no paging information (the rest of the window would be lost)', async () => {
    const rows = Array.from({ length: DNSFILTER_PAGE_SIZE }, (_, i) => docRow({ fqdn: `r${i}.example` }));
    requestJsonMock.mockResolvedValueOnce({ data: { values: rows } } as never);

    await expect(makeProvider().syncEvents(SINCE, UNTIL)).rejects.toThrow(/full page with no paging information/);
  });

  it('accepts a short page with no paging information as the whole window', async () => {
    requestJsonMock.mockResolvedValueOnce({ data: { values: [docRow()] } } as never);

    await expect(makeProvider().syncEvents(SINCE, UNTIL)).resolves.toHaveLength(1);
  });

  it('fails when rows came back but none could be read (shape drift, not a quiet window)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    requestJsonMock.mockResolvedValueOnce(docPage([
      { timestamp: '2026-11-25T12:10:00Z', query: 'renamed.example', action: 'block' },
      docRow({ result: 'quarantined' })
    ], { self: 1, last: 1, next: null }) as never);

    await expect(makeProvider().syncEvents(SINCE, UNTIL)).rejects.toThrow(/2 row\(s\), none of which could be read/);
  });
});

describe('DnsFilterProvider config ids (#12699)', () => {
  it('refuses a non-numeric config.organizationId without calling DNSFilter', async () => {
    await expect(makeProvider({ organizationId: 'abc' }).syncEvents(SINCE, UNTIL)).rejects.toThrow(
      /organization ID on this integration is not a whole number/
    );
    expect(requestJsonMock).not.toHaveBeenCalled();
  });

  it('prefers config.organizationId over a legacy accountId', async () => {
    requestJsonMock.mockResolvedValueOnce(docPage([], { self: 1, last: 1, next: null }) as never);

    await makeProvider({ organizationId: '1001', accountId: 'acct-x' }).syncEvents(SINCE, UNTIL);

    expect(urlOf(requestJsonMock.mock.calls[0]!).searchParams.get('organization_id')).toBe('1001');
  });

  it.each(['default', '7/../x', '0'])('refuses policyId %j without calling DNSFilter', async (policyId) => {
    await expect(makeProvider({ policyId }).addBlocklistDomain('bad.example')).rejects.toThrow(/not a whole number/);
    expect(requestJsonMock).not.toHaveBeenCalled();
  });
});

describe('DnsFilterProvider error text (#12699)', () => {
  it.each([
    ['https://api.example-dns.test'],
    ['https://evildnsfilter.com'],
    ['https://dnsfilter.com.evil.test']
  ])('does not reflect the response body for a non-DNSFilter host (%s)', async (apiEndpoint) => {
    requestJsonMock.mockRejectedValueOnce(new DnsProviderHttpError(500, 'Server Error', '{"error":"SECRET-BODY"}'));

    const failure = makeProvider({ apiEndpoint }).syncEvents(SINCE, UNTIL);
    await expect(failure).rejects.toThrow(/HTTP 500 Server Error/);
    await expect(failure).rejects.not.toThrow(/SECRET-BODY/);
  });

  it.each([
    ['query logs', 403, '{"error":"Forbidden"}', /\(Forbidden\)\. The API key is not allowed to read DNSFilter query logs$/],
    ['query logs', 429, '{"error":"Too Many Requests"}', /rate limit reached/],
    ['query logs', 400, '{"error":{"message":"bad from"}}', /\(bad from\)$/],
    ['policy update', 403, '{"error":"Forbidden"}', /cannot edit the configured DNSFilter policy/],
    ['policy update', 422, '["Domain is invalid","Note is missing"]', /\(Domain is invalid; Note is missing\)$/],
    ['policy update', 400, '<html>oops</html>', /HTTP 400 Bad\s?$/]
  ] as const)('%s HTTP %i maps to a readable message', async (operation, status, body, message) => {
    requestJsonMock.mockRejectedValueOnce(new DnsProviderHttpError(status, status === 400 ? 'Bad' : 'Err', body));

    const run = operation === 'query logs'
      ? makeProvider().syncEvents(SINCE, UNTIL)
      : makeProvider({ policyId: '7' }).addBlocklistDomain('bad.example');
    await expect(run).rejects.toThrow(message);
  });

  it('names the configured organization ID in a query-log 403 only when one is sent', async () => {
    requestJsonMock.mockRejectedValueOnce(new DnsProviderHttpError(403, 'Forbidden', '{"error":"Forbidden"}'));

    await expect(makeProvider({ organizationId: '1001' }).syncEvents(SINCE, UNTIL)).rejects.toThrow(
      /cannot read the configured DNSFilter organization ID/
    );
  });

  it('strips control characters and caps DNSFilter\'s text at 200 characters', async () => {
    const long = `line1\nline2\u0007${'x'.repeat(300)}`;
    requestJsonMock.mockRejectedValueOnce(new DnsProviderHttpError(400, 'Bad Request', JSON.stringify({ error: long })));

    const error = (await makeProvider().syncEvents(SINCE, UNTIL).catch((e: unknown) => e)) as Error;

    const detail = /\((.*)\)/.exec(error.message)![1]!;
    expect(detail.startsWith('line1 line2 x')).toBe(true);
    expect(detail.length).toBe(200);
  });

  it('reports an unparseable 2xx body as non-JSON, not as "failed: HTTP 200 OK"', async () => {
    requestJsonMock.mockRejectedValueOnce(
      new DnsProviderHttpError(200, 'OK', '<html>maintenance</html>', 'Provider returned invalid JSON payload')
    );

    await expect(makeProvider().syncEvents(SINCE, UNTIL)).rejects.toThrow(
      'DNSFilter query logs returned a response that is not JSON (HTTP 200)'
    );
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

describe('DnsFilterProvider time slices (#12699)', () => {
  const DAY_SINCE = new Date('2026-11-24T12:15:00.000Z');
  const emptyPage = () => docPage([], { self: 1, last: 1, next: null });

  it('walks a 24-hour window in hourly slices, oldest first, each checkpointed at its end', async () => {
    requestJsonMock.mockImplementation(async () => emptyPage() as never);

    const slices = [];
    for await (const slice of makeProvider().syncEventSlices(DAY_SINCE, UNTIL)) slices.push(slice);

    expect(DNSFILTER_SLICE_MS).toBe(60 * 60 * 1000);
    expect(slices).toHaveLength(24);
    expect(slices[0]!.until).toEqual(new Date('2026-11-24T13:15:00.000Z'));
    expect(slices[23]!.until).toEqual(UNTIL);
    const windows = requestJsonMock.mock.calls.map((c) => {
      const p = urlOf(c).searchParams;
      return [p.get('from'), p.get('to')];
    });
    expect(windows[0]).toEqual(['2026-11-24T12:15:00Z', '2026-11-24T13:15:00Z']);
    expect(windows[1]).toEqual(['2026-11-24T13:15:00Z', '2026-11-24T14:15:00Z']);
    expect(windows[23]).toEqual(['2026-11-25T11:15:00Z', '2026-11-25T12:15:00Z']);
  });

  it('keeps the slices already yielded when a later slice fails', async () => {
    requestJsonMock
      .mockResolvedValueOnce(docPage([docRow({ fqdn: 'early.example' })], { self: 1, last: 1, next: null }) as never)
      .mockRejectedValueOnce(new DnsProviderHttpError(503, 'Service Unavailable', '{"error":"down"}'));

    const yielded: string[] = [];
    const walk = async () => {
      for await (const slice of makeProvider().syncEventSlices(DAY_SINCE, UNTIL)) {
        yielded.push(...slice.events.map((e) => e.domain));
      }
    };

    await expect(walk()).rejects.toThrow(/HTTP 503/);
    expect(yielded).toEqual(['early.example']);
  });

  it('stops at the per-run request budget and reports where the next run resumes', async () => {
    // Every slice is endless, so each spends DNSFILTER_MAX_PAGES requests and is truncated.
    requestJsonMock.mockImplementation(async (input) => {
      const n = Number(new URL(String(input)).searchParams.get('page[number]'));
      return docPage([docRow({ fqdn: `p${n}.example` })], { self: n, last: 999, next: n + 1 }) as never;
    });

    const walk = makeProvider().syncEventSlices(DAY_SINCE, UNTIL);
    const slices = [];
    let end;
    for (;;) {
      const step = await walk.next();
      if (step.done) { end = step.value; break; }
      slices.push(step.value);
    }

    const fullSlices = DNSFILTER_MAX_REQUESTS_PER_RUN / DNSFILTER_MAX_PAGES;
    expect(slices).toHaveLength(fullSlices);
    expect(slices.every((s) => s.truncated)).toBe(true);
    expect(requestJsonMock).toHaveBeenCalledTimes(DNSFILTER_MAX_REQUESTS_PER_RUN);
    expect(end).toEqual({
      stoppedShort: { from: new Date(DAY_SINCE.getTime() + fullSlices * DNSFILTER_SLICE_MS), to: UNTIL }
    });
  });

  it('syncEvents refuses to return a window it could not finish', async () => {
    requestJsonMock.mockImplementation(async (input) => {
      const n = Number(new URL(String(input)).searchParams.get('page[number]'));
      return docPage([docRow()], { self: n, last: 999, next: n + 1 }) as never;
    });

    await expect(makeProvider().syncEvents(DAY_SINCE, UNTIL)).rejects.toThrow(/more requests than one sync run allows/);
  });
});
