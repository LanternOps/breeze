import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudflareGatewayProvider, cloudflareDecisionToAction } from './cloudflare';
import { requestJson } from './http';

// Same shape as the Umbrella/AdGuard/Pi-hole provider tests: transport is not
// exercised, only the provider's request shaping and response handling.
vi.mock('./http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./http')>();
  return {
    ...actual,
    requestJson: vi.fn()
  };
});

const requestJsonMock = vi.mocked(requestJson);

const ACCOUNT_ID = 'acct-123';
const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
const LIST_URL = (id: string) => `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/gateway/lists/${id}`;

function urlOf(call: unknown[]): string {
  return String(call[0]);
}
function initOf(call: unknown[]): RequestInit & { headers?: Record<string, string> } {
  return (call[1] ?? {}) as RequestInit & { headers?: Record<string, string> };
}
function bodyOf(call: unknown[]): any {
  return JSON.parse(String(initOf(call).body));
}

function makeProvider() {
  return new CloudflareGatewayProvider('cf-token', {
    accountId: ACCOUNT_ID,
    blocklistId: 'bl-1',
    allowlistId: 'al-1'
  });
}

function gqlPage(groups: unknown[]) {
  return { data: { viewer: { accounts: [{ gatewayResolverQueriesAdaptiveGroups: groups }] } }, errors: null };
}

function group(datetime: string, queryName: string, resolverDecision: number, extra: Record<string, unknown> = {}) {
  return {
    count: 2,
    dimensions: {
      datetime,
      queryName,
      resolverDecision,
      categoryNames: [],
      locationName: 'office',
      policyName: '',
      resourceRecordTypes: ['A'],
      ...extra
    }
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CloudflareGatewayProvider.syncEvents (GraphQL, #7617)', () => {
  it('queries the GraphQL analytics dataset instead of the non-existent /gateway/logs', async () => {
    requestJsonMock.mockResolvedValueOnce(gqlPage([]) as never);

    await makeProvider().syncEvents(new Date('2026-09-30T00:00:00Z'), new Date('2026-09-30T01:00:00Z'));

    expect(requestJsonMock).toHaveBeenCalledTimes(1);
    const call = requestJsonMock.mock.calls[0]!;
    expect(urlOf(call)).toBe(GRAPHQL_URL);
    expect(urlOf(call)).not.toContain('/gateway/logs');
    const init = initOf(call);
    expect(init.method).toBe('POST');
    expect(init.headers?.Authorization).toBe('Bearer cf-token');
    const body = bodyOf(call);
    expect(body.query).toContain('gatewayResolverQueriesAdaptiveGroups');
    expect(body.variables).toEqual({
      accountTag: ACCOUNT_ID,
      since: '2026-09-30T00:00:00.000Z',
      until: '2026-09-30T01:00:00.000Z',
      limit: 1000
    });
  });

  it('maps groups to DnsEvents with action from resolverDecision', async () => {
    requestJsonMock.mockResolvedValueOnce(gqlPage([
      group('2026-09-30T00:10:00Z', 'malware.testcategory.com', 9, {
        categoryNames: ['Malware'],
        policyName: 'block security threats'
      }),
      group('2026-09-30T00:11:00Z', 'example.org', 5),
      group('2026-09-30T00:12:00Z', 'search.example', 7)
    ]) as never);

    const events = await makeProvider().syncEvents(new Date('2026-09-30T00:00:00Z'), new Date('2026-09-30T01:00:00Z'));

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      domain: 'malware.testcategory.com',
      action: 'blocked',
      category: 'Malware',
      queryType: 'A',
      sourceHostname: 'office'
    });
    expect(events[0]!.timestamp.toISOString()).toBe('2026-09-30T00:10:00.000Z');
    expect(events[0]!.metadata).toMatchObject({ count: 2, resolverDecision: 9, policyName: 'block security threats' });
    expect(events[0]!.providerEventId).toMatch(/^[0-9a-f]{32}$/);
    expect(events[1]!.action).toBe('allowed');
    expect(events[2]!.action).toBe('redirected');
  });

  it('pages forward from the last timestamp when a page is full, without duplicating', async () => {
    const full = Array.from({ length: 1000 }, (_, i) =>
      group(`2026-09-30T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`, `d${i}.example`, 5)
    );
    const last = full[full.length - 1]!;
    requestJsonMock
      .mockResolvedValueOnce(gqlPage(full) as never)
      .mockResolvedValueOnce(gqlPage([last, group('2026-09-30T00:59:59Z', 'tail.example', 5)]) as never);

    const events = await makeProvider().syncEvents(new Date('2026-09-30T00:00:00Z'), new Date('2026-09-30T01:00:00Z'));

    expect(requestJsonMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(requestJsonMock.mock.calls[1]!).variables.since).toBe(new Date(last.dimensions.datetime).toISOString());
    expect(events).toHaveLength(1001);
    expect(events[events.length - 1]!.domain).toBe('tail.example');
  });

  it('splits a long window into one-hour slices (wide windows return no groups)', async () => {
    requestJsonMock.mockResolvedValue(gqlPage([]) as never);

    await makeProvider().syncEvents(new Date('2026-09-30T00:00:00Z'), new Date('2026-09-30T02:30:00Z'));

    const windows = requestJsonMock.mock.calls.map((c) => {
      const v = bodyOf(c).variables;
      return [v.since, v.until];
    });
    expect(windows).toEqual([
      ['2026-09-30T00:00:00.000Z', '2026-09-30T01:00:00.000Z'],
      ['2026-09-30T01:00:00.000Z', '2026-09-30T02:00:00.000Z'],
      ['2026-09-30T02:00:00.000Z', '2026-09-30T02:30:00.000Z']
    ]);
  });

  it('surfaces GraphQL errors', async () => {
    requestJsonMock.mockResolvedValueOnce({ data: null, errors: [{ message: 'not authorized for that account' }] } as never);

    await expect(
      makeProvider().syncEvents(new Date('2026-09-30T00:00:00Z'), new Date('2026-09-30T01:00:00Z'))
    ).rejects.toThrow('Cloudflare GraphQL error: not authorized for that account');
  });
});

describe('CloudflareGatewayProvider list sync (PATCH append/remove, #7617)', () => {
  beforeEach(() => {
    requestJsonMock.mockResolvedValue({ success: true, result: {} } as never);
  });

  it('adds a blocklist domain with PATCH append, not POST /items', async () => {
    await makeProvider().addBlocklistDomain('bad.example', 'phishing');

    const call = requestJsonMock.mock.calls[0]!;
    expect(urlOf(call)).toBe(LIST_URL('bl-1'));
    expect(initOf(call).method).toBe('PATCH');
    expect(bodyOf(call)).toEqual({ append: [{ value: 'bad.example', description: 'phishing' }] });
  });

  it('removes a blocklist domain with PATCH remove, not DELETE /items', async () => {
    await makeProvider().removeBlocklistDomain('bad.example');

    const call = requestJsonMock.mock.calls[0]!;
    expect(urlOf(call)).toBe(LIST_URL('bl-1'));
    expect(initOf(call).method).toBe('PATCH');
    expect(bodyOf(call)).toEqual({ remove: ['bad.example'] });
  });

  it('uses the allowlist for allowlist operations', async () => {
    const provider = makeProvider();
    await provider.addAllowlistDomain('good.example');
    await provider.removeAllowlistDomain('good.example');

    expect(urlOf(requestJsonMock.mock.calls[0]!)).toBe(LIST_URL('al-1'));
    expect(bodyOf(requestJsonMock.mock.calls[0]!)).toEqual({ append: [{ value: 'good.example' }] });
    expect(bodyOf(requestJsonMock.mock.calls[1]!)).toEqual({ remove: ['good.example'] });
  });

  it('requires the list id in config', async () => {
    const provider = new CloudflareGatewayProvider('cf-token', { accountId: ACCOUNT_ID });
    await expect(provider.addBlocklistDomain('x.example')).rejects.toThrow('blocklistId');
  });
});

describe('cloudflareDecisionToAction', () => {
  it('maps the documented resolverDecision values', () => {
    for (const d of [2, 3, 6, 9]) expect(cloudflareDecisionToAction(d)).toBe('blocked');
    for (const d of [7, 8]) expect(cloudflareDecisionToAction(d)).toBe('redirected');
    for (const d of [0, 1, 4, 5, 10, undefined]) expect(cloudflareDecisionToAction(d)).toBe('allowed');
  });
});
