import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// Dataset settings answer: how far back the account may query, in seconds.
function settingsPage(notOlderThan: number) {
  return {
    data: { viewer: { accounts: [{ settings: { gatewayResolverQueriesAdaptiveGroups: { notOlderThan } } }] } },
    errors: null
  };
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

const DAY_S = 24 * 60 * 60;
const NOW = new Date('2026-09-30T12:00:00Z');

/** Dataset calls only (the first call of a sync is the settings lookup). */
function datasetCalls() {
  return requestJsonMock.mock.calls.filter((c) => String(bodyOf(c).query).includes('gatewayResolverQueriesAdaptiveGroups('));
}
function windowsOf(calls: unknown[][]) {
  return calls.map((c) => {
    const v = bodyOf(c).variables;
    return [v.since, v.until];
  });
}

async function collectSlices(provider: CloudflareGatewayProvider, since: Date, until: Date) {
  const slices: Array<{ until: string; domains: string[] }> = [];
  for await (const slice of provider.syncEventSlices(since, until)) {
    slices.push({ until: slice.until.toISOString(), domains: slice.events.map((e) => e.domain) });
  }
  return slices;
}

beforeEach(() => {
  requestJsonMock.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CloudflareGatewayProvider.syncEvents (GraphQL, #7617)', () => {
  it('queries the GraphQL analytics dataset instead of the non-existent /gateway/logs', async () => {
    requestJsonMock
      .mockResolvedValueOnce(settingsPage(DAY_S) as never)
      .mockResolvedValueOnce(gqlPage([]) as never);

    await makeProvider().syncEvents(new Date('2026-09-30T00:00:00Z'), new Date('2026-09-30T01:00:00Z'));

    expect(requestJsonMock).toHaveBeenCalledTimes(2);
    for (const call of requestJsonMock.mock.calls) {
      expect(urlOf(call)).toBe(GRAPHQL_URL);
      expect(initOf(call).method).toBe('POST');
      expect(initOf(call).headers?.Authorization).toBe('Bearer cf-token');
    }
    expect(bodyOf(requestJsonMock.mock.calls[0]!).query).toContain('notOlderThan');
    const body = bodyOf(requestJsonMock.mock.calls[1]!);
    expect(body.query).toContain('gatewayResolverQueriesAdaptiveGroups');
    expect(body.variables).toEqual({
      accountTag: ACCOUNT_ID,
      since: '2026-09-30T00:00:00.000Z',
      until: '2026-09-30T01:00:00.000Z',
      limit: 1000
    });
  });

  it('maps groups to DnsEvents with action from resolverDecision', async () => {
    requestJsonMock
      .mockResolvedValueOnce(settingsPage(DAY_S) as never)
      .mockResolvedValueOnce(gqlPage([
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

  it('surfaces GraphQL errors', async () => {
    requestJsonMock
      .mockResolvedValueOnce(settingsPage(DAY_S) as never)
      .mockResolvedValueOnce({ data: null, errors: [{ message: 'not authorized for that account' }] } as never);

    await expect(
      makeProvider().syncEvents(new Date('2026-09-30T00:00:00Z'), new Date('2026-09-30T01:00:00Z'))
    ).rejects.toThrow('Cloudflare GraphQL error: not authorized for that account');
  });

  it('fails clearly when the account is not visible to the token, instead of returning no events', async () => {
    requestJsonMock
      .mockResolvedValueOnce(settingsPage(DAY_S) as never)
      .mockResolvedValueOnce({ data: { viewer: { accounts: [] } }, errors: null } as never);

    await expect(
      makeProvider().syncEvents(new Date('2026-09-30T00:00:00Z'), new Date('2026-09-30T01:00:00Z'))
    ).rejects.toThrow(/account acct-123 not found.*Account Analytics: Read/);
  });
});

describe('CloudflareGatewayProvider.syncEventSlices (checkpointed slices)', () => {
  it('yields one checkpointable slice per hour, including an empty hour between hours with data', async () => {
    requestJsonMock
      .mockResolvedValueOnce(settingsPage(DAY_S) as never)
      .mockResolvedValueOnce(gqlPage([group('2026-09-30T00:10:00Z', 'first.example', 5)]) as never)
      .mockResolvedValueOnce(gqlPage([]) as never)
      .mockResolvedValueOnce(gqlPage([group('2026-09-30T02:05:00Z', 'third.example', 5)]) as never);

    const slices = await collectSlices(makeProvider(), new Date('2026-09-30T00:00:00Z'), new Date('2026-09-30T02:30:00Z'));

    expect(windowsOf(datasetCalls())).toEqual([
      ['2026-09-30T00:00:00.000Z', '2026-09-30T01:00:00.000Z'],
      ['2026-09-30T01:00:00.000Z', '2026-09-30T02:00:00.000Z'],
      ['2026-09-30T02:00:00.000Z', '2026-09-30T02:30:00.000Z']
    ]);
    expect(slices).toEqual([
      { until: '2026-09-30T01:00:00.000Z', domains: ['first.example'] },
      { until: '2026-09-30T02:00:00.000Z', domains: [] },
      { until: '2026-09-30T02:30:00.000Z', domains: ['third.example'] }
    ]);
  });

  it('stops short of now so late-arriving analytics are not checkpointed as partial counts', async () => {
    requestJsonMock
      .mockResolvedValueOnce(settingsPage(DAY_S) as never)
      .mockResolvedValue(gqlPage([]) as never);

    const slices = await collectSlices(makeProvider(), new Date('2026-09-30T11:30:00Z'), NOW);

    expect(windowsOf(datasetCalls())).toEqual([['2026-09-30T11:30:00.000Z', '2026-09-30T11:55:00.000Z']]);
    expect(slices.map((s) => s.until)).toEqual(['2026-09-30T11:55:00.000Z']);
  });

  it('clamps since to the dataset retention edge and warns about the unrecoverable gap', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    requestJsonMock
      .mockResolvedValueOnce(settingsPage(DAY_S) as never)
      .mockResolvedValue(gqlPage([]) as never);

    await collectSlices(makeProvider(), new Date('2026-09-27T00:00:00Z'), new Date('2026-09-29T14:00:00Z'));

    const first = new Date(bodyOf(datasetCalls()[0]!).variables.since).getTime();
    // 24h retention back from NOW (12:00), plus a small safety margin — never older than the data.
    expect(first).toBeGreaterThanOrEqual(new Date('2026-09-29T12:00:00Z').getTime());
    expect(first).toBeLessThan(new Date('2026-09-29T12:10:00Z').getTime());
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/retention.*2026-09-27T00:00:00\.000Z/));
  });

  it('falls back to a conservative retention when the settings lookup fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    requestJsonMock
      .mockResolvedValueOnce({ data: null, errors: [{ message: 'unknown field settings' }] } as never)
      .mockResolvedValue(gqlPage([]) as never);

    await collectSlices(makeProvider(), new Date('2026-09-20T00:00:00Z'), new Date('2026-09-29T14:00:00Z'));

    const first = new Date(bodyOf(datasetCalls()[0]!).variables.since).getTime();
    expect(first).toBeGreaterThanOrEqual(new Date('2026-09-29T12:00:00Z').getTime());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown field settings'));
  });

  it('fails the run (no clamp, no checkpoint) when the settings lookup itself fails to reach Cloudflare', async () => {
    requestJsonMock.mockRejectedValueOnce(new Error('Cloudflare request failed: 503'));

    await expect(
      collectSlices(makeProvider(), new Date('2026-09-20T00:00:00Z'), new Date('2026-09-29T14:00:00Z'))
    ).rejects.toThrow('503');
    // A transient failure must not clamp away a backlog the account still holds.
    expect(datasetCalls()).toHaveLength(0);
  });

  it('checkpoints a full page at its last timestamp and re-reads from there, without duplicating', async () => {
    const full = Array.from({ length: 1000 }, (_, i) =>
      group(`2026-09-30T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`, `d${i}.example`, 5)
    );
    const last = full[full.length - 1]!;
    const lastIso = new Date(last.dimensions.datetime).toISOString();
    requestJsonMock
      .mockResolvedValueOnce(settingsPage(DAY_S) as never)
      .mockResolvedValueOnce(gqlPage(full) as never)
      .mockResolvedValueOnce(gqlPage([last, group('2026-09-30T00:59:59Z', 'tail.example', 5)]) as never);

    const slices = await collectSlices(makeProvider(), new Date('2026-09-30T00:00:00Z'), new Date('2026-09-30T01:00:00Z'));

    expect(windowsOf(datasetCalls())).toEqual([
      ['2026-09-30T00:00:00.000Z', '2026-09-30T01:00:00.000Z'],
      [lastIso, '2026-09-30T01:00:00.000Z']
    ]);
    expect(slices.map((s) => s.until)).toEqual([lastIso, '2026-09-30T01:00:00.000Z']);
    expect(slices[0]!.domains).toHaveLength(1000);
    expect(slices[1]!.domains).toEqual(['tail.example']);
  });

  it('fails the slice instead of silently dropping rows when a full page cannot advance', async () => {
    const stuck = Array.from({ length: 1000 }, (_, i) => group('2026-09-30T01:00:00Z', `d${i}.example`, 5));
    requestJsonMock
      .mockResolvedValueOnce(settingsPage(DAY_S) as never)
      .mockResolvedValueOnce(gqlPage([group('2026-09-30T00:10:00Z', 'kept.example', 5)]) as never)
      .mockResolvedValueOnce(gqlPage(stuck) as never);

    const seen: string[] = [];
    await expect((async () => {
      for await (const slice of makeProvider().syncEventSlices(new Date('2026-09-30T00:00:00Z'), new Date('2026-09-30T02:00:00Z'))) {
        seen.push(slice.until.toISOString());
      }
    })()).rejects.toThrow(/1000 or more groups at 2026-09-30T01:00:00\.000Z/);
    // The complete earlier slice was still handed over for checkpointing.
    expect(seen).toEqual(['2026-09-30T01:00:00.000Z']);
  });

  it('stops at the per-run request budget and leaves the rest for the next run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    requestJsonMock
      .mockResolvedValueOnce(settingsPage(31 * DAY_S) as never)
      .mockResolvedValue(gqlPage([]) as never);

    const slices = await collectSlices(makeProvider(), new Date('2026-09-20T00:00:00Z'), new Date('2026-09-30T00:00:00Z'));

    expect(slices).toHaveLength(100);
    expect(slices[99]!.until).toBe('2026-09-24T04:00:00.000Z');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('request budget'));
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
