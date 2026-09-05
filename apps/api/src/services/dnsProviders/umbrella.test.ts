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
    queueTokenThen({ requests: [] });

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
    queueTokenThen({ requests: [] });

    await makeProvider().syncEvents(new Date('2026-08-01'), new Date('2026-08-02'));

    const apiCall = requestJsonMock.mock.calls[1]!;
    expect(urlOf(apiCall)).toContain('reports.api.umbrella.com');
    expect(initOf(apiCall).headers?.Authorization).toBe('Bearer tok-1');
  });

  it('sends from/to as epoch-millisecond strings, not ISO 8601 (#4597)', async () => {
    queueTokenThen({ requests: [] });

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
