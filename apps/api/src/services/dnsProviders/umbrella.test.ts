import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UmbrellaProvider } from './umbrella';
import { DnsProviderHttpError, requestJson } from './http';

// Same shape as the AdGuard/Pi-hole provider tests: transport is not exercised,
// only the provider's request shaping and response handling. DnsProviderHttpError
// is kept REAL because the auth-retry path branches on `instanceof`.
vi.mock('./http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./http')>();
  return {
    ...actual,
    requestJson: vi.fn()
  };
});

const requestJsonMock = vi.mocked(requestJson);

const TOKEN_URL = 'https://api.umbrella.com/auth/v2/token';
const ORG_ID = 'org-123';

function urlOf(call: unknown[]): string {
  return String(call[0]);
}
function initOf(call: unknown[]): RequestInit & { headers?: Record<string, string> } {
  return (call[1] ?? {}) as RequestInit & { headers?: Record<string, string> };
}

function makeProvider() {
  return new UmbrellaProvider('key-abc', 'secret-xyz', {
    organizationId: ORG_ID,
    blocklistId: 'bl-1',
    allowlistId: 'al-1'
  });
}

/** A token response, then an empty activity page so syncEvents terminates. */
function queueTokenThen(...bodies: unknown[]) {
  const queue = [{ access_token: 'tok-1', token_type: 'bearer', expires_in: 3600 }, ...bodies];
  requestJsonMock.mockImplementation(async () => {
    if (!queue.length) throw new Error('requestJson mock exhausted');
    return queue.shift() as never;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('UmbrellaProvider OAuth2 client-credentials auth (#3271)', () => {
  it('exchanges key/secret for a bearer token before calling the API', async () => {
    queueTokenThen({ data: [] });

    await makeProvider().syncEvents(new Date('2026-08-01'), new Date('2026-08-02'));

    const tokenCall = requestJsonMock.mock.calls[0]!;
    expect(urlOf(tokenCall)).toBe(TOKEN_URL);

    const init = initOf(tokenCall);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('grant_type=client_credentials');
    expect(init.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');
    // key:secret is Basic ONLY on the token exchange, never on the API itself.
    expect(init.headers?.Authorization).toBe(
      `Basic ${Buffer.from('key-abc:secret-xyz').toString('base64')}`
    );
  });

  it('sends the bearer token — not Basic — to the reporting API', async () => {
    queueTokenThen({ data: [] });

    await makeProvider().syncEvents(new Date('2026-08-01'), new Date('2026-08-02'));

    const apiCall = requestJsonMock.mock.calls[1]!;
    expect(urlOf(apiCall)).toContain('api.umbrella.com/reports/v2/activity');
    expect(initOf(apiCall).headers?.Authorization).toBe('Bearer tok-1');
  });

  it('sends from/to as epoch-millisecond strings, not ISO 8601 (#4597)', async () => {
    queueTokenThen({ data: [] });

    const since = new Date('2026-08-14T00:30:00.151Z');
    const until = new Date('2026-08-15T00:30:00.151Z');
    await makeProvider().syncEvents(since, until);

    const apiCall = requestJsonMock.mock.calls[1]!;
    const params = new URL(urlOf(apiCall)).searchParams;
    // Cisco's reporting API rejects ISO strings ("invalid timestamp"); it
    // wants Unix epoch milliseconds as a numeric string.
    expect(params.get('from')).toBe(String(since.getTime()));
    expect(params.get('to')).toBe(String(until.getTime()));
    expect(params.get('from')).toMatch(/^\d+$/);
    expect(params.get('to')).toMatch(/^\d+$/);
  });

  it('sends the bearer token to the policies API too', async () => {
    queueTokenThen({});

    await makeProvider().addBlocklistDomain('evil.example', 'because');

    const apiCall = requestJsonMock.mock.calls[1]!;
    expect(urlOf(apiCall)).toContain('api.umbrella.com/policies/v2/destinationlists');
    expect(initOf(apiCall).headers?.Authorization).toBe('Bearer tok-1');
  });

  it('caches the token across calls instead of re-exchanging per request', async () => {
    queueTokenThen({}, {});
    const provider = makeProvider();

    await provider.addBlocklistDomain('a.example');
    await provider.addAllowlistDomain('b.example');

    const tokenCalls = requestJsonMock.mock.calls.filter((c) => urlOf(c) === TOKEN_URL);
    expect(tokenCalls).toHaveLength(1);
    expect(requestJsonMock).toHaveBeenCalledTimes(3); // 1 token + 2 API
  });

  // The non-obvious one: Umbrella reports an EXPIRED token as 400
  // invalid_request, not 401, so a plain retry-on-401 would never fire.
  it('refreshes and retries when an expired token yields 400 invalid_request', async () => {
    let call = 0;
    requestJsonMock.mockImplementation(async (input) => {
      call++;
      if (String(input) === TOKEN_URL) {
        return { access_token: `tok-${call}`, expires_in: 3600 } as never;
      }
      if (call === 2) {
        throw new DnsProviderHttpError(400, 'Bad Request', '{"error":"invalid_request"}');
      }
      return {} as never;
    });

    await makeProvider().addBlocklistDomain('evil.example');

    const tokenCalls = requestJsonMock.mock.calls.filter((c) => urlOf(c) === TOKEN_URL);
    expect(tokenCalls).toHaveLength(2); // original + forced refresh
    const retried = requestJsonMock.mock.calls[3]!;
    expect(initOf(retried).headers?.Authorization).toBe('Bearer tok-3');
  });

  it('refreshes and retries on 401', async () => {
    let call = 0;
    requestJsonMock.mockImplementation(async (input) => {
      call++;
      if (String(input) === TOKEN_URL) {
        return { access_token: `tok-${call}`, expires_in: 3600 } as never;
      }
      if (call === 2) {
        throw new DnsProviderHttpError(401, 'Unauthorized', '{"data":{"error":"unauthorized"}}');
      }
      return {} as never;
    });

    await makeProvider().addAllowlistDomain('ok.example');

    expect(requestJsonMock.mock.calls.filter((c) => urlOf(c) === TOKEN_URL)).toHaveLength(2);
  });

  // Control: without this, "retry on 400" would mask real validation errors and
  // silently double-send writes.
  it('does NOT retry a genuine validation 400', async () => {
    let call = 0;
    requestJsonMock.mockImplementation(async (input) => {
      call++;
      if (String(input) === TOKEN_URL) {
        return { access_token: 'tok-1', expires_in: 3600 } as never;
      }
      throw new DnsProviderHttpError(400, 'Bad Request', '{"error":"destination is not a valid domain"}');
    });

    await expect(makeProvider().addBlocklistDomain('not a domain')).rejects.toMatchObject({ status: 400 });

    expect(requestJsonMock.mock.calls.filter((c) => urlOf(c) === TOKEN_URL)).toHaveLength(1);
    // One attempt only — no retry, so no risk of a duplicate write.
    expect(requestJsonMock).toHaveBeenCalledTimes(2);
  });

  it('still requires apiSecret', async () => {
    const provider = new UmbrellaProvider('key-abc', null, { organizationId: ORG_ID, blocklistId: 'bl-1' });
    await expect(provider.addBlocklistDomain('x.example')).rejects.toThrow(/requires apiSecret/);
    expect(requestJsonMock).not.toHaveBeenCalled();
  });

  it('fails loudly if the token endpoint returns no access_token', async () => {
    requestJsonMock.mockImplementation(async () => ({ token_type: 'bearer' }) as never);
    await expect(makeProvider().addBlocklistDomain('x.example')).rejects.toThrow(/no access_token/);
  });
});

/**
 * Cisco retired the legacy "Umbrella Reporting v2" host
 * (`reports.api.umbrella.com`, EOL Sept 2023) — its routes 404 at Cisco's own
 * gateway, which is what #4597 hit once auth (#3271) and the epoch-ms
 * timestamps (#4637) were fixed. The current endpoint is
 * `https://api.umbrella.com/reports/v2/activity`, with the org taken from the
 * OAuth2 token's `sub` claim rather than a path segment.
 */
describe('UmbrellaProvider next-gen reports endpoint (#4597)', () => {
  const ACTIVITY_URL = 'https://api.umbrella.com/reports/v2/activity';

  function activityCalls() {
    return requestJsonMock.mock.calls.filter((call) => urlOf(call).startsWith(ACTIVITY_URL));
  }

  /**
   * Queue a token, then the given activity pages, then the empty page that
   * ends the offset walk (an empty page — not a short one — is the documented
   * end-of-collection signal; see the paging test below).
   */
  function queueActivityPages(...pages: unknown[]) {
    queueTokenThen(...pages, { data: [] });
  }

  /** One `data[]` record in the next-gen Reports API shape. */
  function activityRecord(overrides: Record<string, unknown> = {}) {
    return {
      timestamp: 1755131400151,
      domain: 'evil.example.com',
      verdict: 'blocked',
      querytype: 'AAAA',
      internalip: '10.1.2.3',
      externalip: '203.0.113.9',
      // Content category first on purpose: the security-typed one is the
      // meaningful classification for a DNS-security event.
      categories: [
        { id: 108, label: 'Business Services', type: 'content', integration: false },
        { id: 66, label: 'Malware', type: 'security', integration: false }
      ],
      policycategories: [{ id: 66, label: 'Malware', type: 'security' }],
      // `identities[].type` is an OBJECT in Umbrella's schema, not a string —
      // tolerant parsing must not choke on it.
      identities: [{ id: 12, label: 'LAPTOP-7', type: { id: 9, type: 'roaming', label: 'Roaming Computers' } }],
      threats: [{ label: 'Emotet', type: 'Malware' }],
      ...overrides
    };
  }

  it('calls the next-gen activity endpoint, with no organization id in the path', async () => {
    queueTokenThen({ data: [] });

    await makeProvider().syncEvents(new Date('2026-08-01'), new Date('2026-08-02'));

    const calls = activityCalls();
    expect(calls).toHaveLength(1);

    const url = new URL(urlOf(calls[0]!));
    expect(url.origin).toBe('https://api.umbrella.com');
    expect(url.pathname).toBe('/reports/v2/activity');
    // The retired Reporting v2 host must be gone entirely.
    expect(urlOf(calls[0]!)).not.toContain('reports.api.umbrella.com');
    // The org is carried by the token's `sub`, never the URL.
    expect(urlOf(calls[0]!)).not.toContain(ORG_ID);
  });

  it('sends from/to as epoch ms plus limit/offset paging params', async () => {
    queueTokenThen({ data: [] });

    const since = new Date('2026-08-14T00:30:00.151Z');
    const until = new Date('2026-08-15T00:30:00.151Z');
    await makeProvider().syncEvents(since, until);

    const params = new URL(urlOf(activityCalls()[0]!)).searchParams;
    expect(params.get('from')).toBe(String(since.getTime()));
    expect(params.get('to')).toBe(String(until.getTime()));
    expect(params.get('limit')).toBe('1000');
    expect(params.get('offset')).toBe('0');
    // The legacy paging vocabulary does not exist on this endpoint.
    expect(params.get('page')).toBeNull();
    expect(params.get('cursor')).toBeNull();
  });

  it('syncs without an organizationId configured — the token scopes the org', async () => {
    queueActivityPages({ data: [activityRecord()] });

    const provider = new UmbrellaProvider('key-abc', 'secret-xyz', { blocklistId: 'bl-1' });
    const events = await provider.syncEvents(new Date('2026-08-01'), new Date('2026-08-02'));

    expect(events).toHaveLength(1);
    // Nothing org-shaped reaches the wire: no path segment, no query param.
    expect(new URL(urlOf(activityCalls()[0]!)).pathname).toBe('/reports/v2/activity');
    expect(urlOf(activityCalls()[0]!)).not.toContain('organization');
  });

  it('maps a next-gen activity record onto DnsEvent', async () => {
    queueActivityPages({ data: [activityRecord()] });

    const [event] = await makeProvider().syncEvents(new Date('2026-08-01'), new Date('2026-08-02'));

    expect(event).toBeDefined();
    // epoch MILLISECONDS on `timestamp`, not an ISO `datetime` string.
    expect(event!.timestamp.toISOString()).toBe(new Date(1755131400151).toISOString());
    expect(event!.domain).toBe('evil.example.com');
    expect(event!.action).toBe('blocked');
    expect(event!.queryType).toBe('AAAA');
    // Security-typed category wins over the content-typed one listed first.
    expect(event!.category).toBe('Malware');
    expect(event!.threatType).toBe('Emotet');
    expect(event!.sourceIp).toBe('10.1.2.3');
    expect(event!.sourceHostname).toBe('LAPTOP-7');
    expect(event!.metadata?.categories).toEqual(['Business Services', 'Malware']);
    // Cisco documents no per-record id on dns/proxy activity records, so the
    // sync job's deterministic fallback id is what dedupes re-synced windows.
    expect(event!.providerEventId).toBeUndefined();
  });

  it('falls back to the external IP when the record has no internal IP', async () => {
    queueActivityPages({ data: [activityRecord({ internalip: '' })] });

    const [event] = await makeProvider().syncEvents(new Date('2026-08-01'), new Date('2026-08-02'));
    expect(event!.sourceIp).toBe('203.0.113.9');
  });

  it.each([
    ['allowed', 'allowed'],
    ['blocked', 'blocked'],
    // Umbrella's third verdict: the query went to the intelligent proxy. It is
    // neither a block nor a plain allow, so it keeps its own action.
    ['proxied', 'redirected']
  ])('maps verdict %s to action %s', async (verdict, action) => {
    queueActivityPages({ data: [activityRecord({ verdict })] });

    const [event] = await makeProvider().syncEvents(new Date('2026-08-01'), new Date('2026-08-02'));
    expect(event!.action).toBe(action);
  });

  it('drops malformed records instead of throwing', async () => {
    queueActivityPages({
      data: [
        'not-an-object',
        { domain: 'no-timestamp.example' },
        { timestamp: 1755131400151 },
        { timestamp: 'never', domain: 'bad-timestamp.example' },
        activityRecord({ domain: 'good.example' })
      ]
    });

    const events = await makeProvider().syncEvents(new Date('2026-08-01'), new Date('2026-08-02'));

    expect(events.map((e) => e.domain)).toEqual(['good.example']);
  });

  // Cisco documents NO maximum for `limit` on this endpoint and ships no
  // total/has-more in `meta`, so "the page was shorter than the limit I asked
  // for" is not a safe end-of-collection signal — a server-side cap below our
  // limit would silently truncate the sync. Advance by what actually came
  // back and stop only on an empty page.
  it('advances the offset by the records actually returned and stops on an empty page', async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) => activityRecord({ domain: `d${i}.example` }));
    queueTokenThen(
      { data: fullPage },
      { data: [activityRecord({ domain: 'last.example' })] },
      { data: [] }
    );

    const events = await makeProvider().syncEvents(new Date('2026-08-01'), new Date('2026-08-02'));

    const calls = activityCalls();
    expect(calls).toHaveLength(3);
    expect(new URL(urlOf(calls[0]!)).searchParams.get('offset')).toBe('0');
    expect(new URL(urlOf(calls[1]!)).searchParams.get('offset')).toBe('1000');
    // 1001, not 2000: a short page must not leave a hole in the offset walk.
    expect(new URL(urlOf(calls[2]!)).searchParams.get('offset')).toBe('1001');
    expect(events).toHaveLength(1001);
  });

  it('scopes the combined activity feed to DNS records with the x-traffic-type header', async () => {
    queueTokenThen({ data: [] });

    await makeProvider().syncEvents(new Date('2026-08-01'), new Date('2026-08-02'));

    // /reports/v2/activity returns dns + proxy + firewall + intrusion records
    // by default; only the DNS ones are DnsEvents.
    expect(initOf(activityCalls()[0]!).headers?.['x-traffic-type']).toBe('dns');
  });

  // "The time range set by the `to` and `from` query parameters cannot exceed
  // 30 days" — Cisco Reporting API docs. An integration that has been failing
  // for over a month (exactly this issue) would otherwise ask for a window the
  // API rejects, and stay broken after the endpoint fix.
  it('clamps a window wider than Umbrella\'s 30-day maximum', async () => {
    queueTokenThen({ data: [] });

    const until = new Date('2026-08-15T00:30:00.000Z');
    const since = new Date(until.getTime() - 90 * 24 * 60 * 60 * 1000);
    await makeProvider().syncEvents(since, until);

    const params = new URL(urlOf(activityCalls()[0]!)).searchParams;
    expect(params.get('to')).toBe(String(until.getTime()));
    expect(params.get('from')).toBe(String(until.getTime() - 30 * 24 * 60 * 60 * 1000));
  });

  it('leaves a window inside the 30-day maximum untouched', async () => {
    queueTokenThen({ data: [] });

    const until = new Date('2026-08-15T00:30:00.000Z');
    const since = new Date(until.getTime() - 7 * 24 * 60 * 60 * 1000);
    await makeProvider().syncEvents(since, until);

    const params = new URL(urlOf(activityCalls()[0]!)).searchParams;
    expect(params.get('from')).toBe(String(since.getTime()));
  });

  it('stops immediately when the first page is empty', async () => {
    queueTokenThen({ data: [] });

    const events = await makeProvider().syncEvents(new Date('2026-08-01'), new Date('2026-08-02'));

    expect(events).toEqual([]);
    expect(activityCalls()).toHaveLength(1);
  });

  it('respects the maxPages guard when every page comes back full', async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) => activityRecord({ domain: `d${i}.example` }));
    requestJsonMock.mockImplementation(async (input) => {
      if (String(input) === TOKEN_URL) return { access_token: 'tok-1', expires_in: 3600 } as never;
      return { data: fullPage } as never;
    });

    const events = await makeProvider().syncEvents(new Date('2026-08-01'), new Date('2026-08-02'));

    // 100 pages hard cap — an endlessly-full upstream must not loop forever.
    expect(activityCalls()).toHaveLength(100);
    expect(events).toHaveLength(100_000);
  });
});
