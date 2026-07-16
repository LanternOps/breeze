import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the row lookup, secret decryption, and token acquisition so the test
// focuses on invokeDirect's Graph endpoint/method/body mapping.
const mockRow = { tenantId: '11111111-1111-1111-1111-111111111111', clientId: 'client-1', clientSecret: 'enc-secret' };
let selectRows: unknown[] = [mockRow];
let wherePredicate: unknown;
vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((predicate: unknown) => ({
          limit: vi.fn(async () => {
            wherePredicate = predicate;
            return selectRows;
          }),
        })),
      })),
    })),
  },
}));
vi.mock('../db/schema/m365', () => ({
  m365Connections: { id: 'id', orgId: 'org_id', profile: 'profile', status: 'status' },
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((column: unknown, value: unknown) => `${String(column)}=${String(value)}`),
  and: vi.fn((...conditions: unknown[]) => conditions),
}));
vi.mock('./secretCrypto', () => ({ decryptForColumn: vi.fn(() => 'plaintext-secret') }));
vi.mock('./c2cM365', () => ({
  acquireClientCredentialsToken: vi.fn(async () => ({ accessToken: 'TOKEN-123', expiresIn: 3600 })),
  isM365TenantId: (x: string) => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(x),
}));

import {
  TOKEN_CACHE_MAX,
  clearTokenCache,
  getToken,
  hasDirectM365Connection,
  invokeDirect,
} from './m365DirectGraph';
import { acquireClientCredentialsToken } from './c2cM365';
import { decryptForColumn } from './secretCrypto';

const GRAPH = 'https://graph.microsoft.com/v1.0';

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async (_url: string, _opts: RequestInit): Promise<unknown> => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  clearTokenCache();
  selectRows = [mockRow];
  wherePredicate = undefined;
});

describe('m365DirectGraph legacy connection selection', () => {
  it('selects only the legacy-direct profile when checking direct availability', async () => {
    await hasDirectM365Connection('org-1');
    expect(wherePredicate).toEqual([
      'org_id=org-1',
      'profile=legacy-direct',
    ]);
  });

  it('requires an active legacy-direct row for token acquisition', async () => {
    await getToken('org-1');
    expect(wherePredicate).toEqual([
      'org_id=org-1',
      'profile=legacy-direct',
      'status=active',
    ]);
  });

  it('fails closed before decryption when a legacy row has no stored secret', async () => {
    selectRows = [{ ...mockRow, clientSecret: null }];
    const result = await getToken('org-1');
    expect(result).toMatchObject({ kind: 'error', code: 'connection_key_error' });
    expect(decryptForColumn).not.toHaveBeenCalled();
    expect(acquireClientCredentialsToken).not.toHaveBeenCalled();
  });

  it('fails closed before token acquisition when a legacy row has no tenant id', async () => {
    selectRows = [{ ...mockRow, tenantId: null }];
    const result = await getToken('org-1');
    expect(result).toMatchObject({ kind: 'error', code: 'connection_key_error' });
    expect(acquireClientCredentialsToken).not.toHaveBeenCalled();
  });
});

describe('m365DirectGraph.invokeDirect endpoint mapping', () => {
  it('get_user → GET /users/{key} with the bearer token', async () => {
    const f = mockFetch(200, { id: 'u1', displayName: 'Jane' });
    const res = await invokeDirect('org-1', 'get_user', { userId: 'jane@x.com' });
    expect(res.kind).toBe('ok');
    const [url, opts] = f.mock.calls[0]!;
    expect(url).toBe(`${GRAPH}/users/jane%40x.com`);
    expect(opts.method).toBe('GET');
    expect((opts.headers as Record<string, string>).Authorization).toBe('Bearer TOKEN-123');
  });

  it('disable_user → PATCH /users/{id} with accountEnabled:false', async () => {
    const f = mockFetch(204, null);
    const res = await invokeDirect('org-1', 'disable_user', { userId: 'u1', reason: 'offboard' });
    expect(res.kind).toBe('ok');
    const [url, opts] = f.mock.calls[0]!;
    expect(url).toBe(`${GRAPH}/users/u1`);
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body as string)).toEqual({ accountEnabled: false });
  });

  it('reset_user_password → PATCH passwordProfile and returns a generated temp password', async () => {
    const f = mockFetch(204, null);
    const res = await invokeDirect('org-1', 'reset_user_password', { userId: 'u1', reason: 'lockout' });
    expect(res.kind).toBe('ok');
    expect((res as { kind: 'ok'; data: { temporaryPassword?: string } }).data.temporaryPassword).toBeTruthy();
    const body = JSON.parse(f.mock.calls[0]![1].body as string);
    expect(body.passwordProfile.forceChangePasswordNextSignIn).toBe(true);
    expect(typeof body.passwordProfile.password).toBe('string');
  });

  it('list_groups → GET /groups', async () => {
    const f = mockFetch(200, { value: [] });
    await invokeDirect('org-1', 'list_groups', {});
    expect((f.mock.calls[0]![0]).startsWith(`${GRAPH}/groups`)).toBe(true);
    expect(f.mock.calls[0]![1].method).toBe('GET');
  });

  it('get_user_signin_activity → GET /auditLogs/signIns filtered by userId', async () => {
    const f = mockFetch(200, { value: [] });
    await invokeDirect('org-1', 'get_user_signin_activity', { userId: 'u1' });
    const url = f.mock.calls[0]![0];
    expect(url.startsWith(`${GRAPH}/auditLogs/signIns`)).toBe(true);
    expect(decodeURIComponent(url)).toContain("userId eq 'u1'");
  });

  it('maps a Graph 403 to a forbidden error result', async () => {
    mockFetch(403, { error: { message: 'Insufficient privileges' } });
    const res = await invokeDirect('org-1', 'get_user', { userId: 'u1' });
    expect(res.kind).toBe('error');
    expect((res as { kind: 'error'; code: string; message: string }).code).toBe('forbidden');
    expect((res as { kind: 'error'; code: string; message: string }).message).toContain('Insufficient privileges');
  });

  it('missing userId on get_user → bad_request without calling Graph', async () => {
    const f = mockFetch(200, {});
    const res = await invokeDirect('org-1', 'get_user', {});
    expect(res.kind).toBe('error');
    expect((res as { kind: 'error'; code: string }).code).toBe('bad_request');
    expect(f).not.toHaveBeenCalled();
  });
});

describe('getToken caching', () => {
  it('a second call within the token expiry does not re-acquire', async () => {
    const a = await getToken('org-1');
    expect(a).toEqual({ token: 'TOKEN-123' });
    const b = await getToken('org-1');
    expect(b).toEqual({ token: 'TOKEN-123' });
    expect(acquireClientCredentialsToken).toHaveBeenCalledTimes(1);
  });

  it('bounds the cached TTL at 30 minutes even though the token grants 60', async () => {
    vi.useFakeTimers();
    try {
      await getToken('org-1');
      vi.advanceTimersByTime(30 * 60 * 1000 - 1);
      await getToken('org-1');
      expect(acquireClientCredentialsToken).toHaveBeenCalledTimes(1); // still within the 30-min cap

      vi.advanceTimersByTime(2);
      await getToken('org-1');
      expect(acquireClientCredentialsToken).toHaveBeenCalledTimes(2); // cap elapsed — re-acquired
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies the 60s skew to a token with a shorter expiry', async () => {
    (acquireClientCredentialsToken as any).mockResolvedValueOnce({ accessToken: 'SHORT-1', expiresIn: 120 });
    vi.useFakeTimers();
    try {
      const a = await getToken('org-1');
      expect(a).toEqual({ token: 'SHORT-1' });

      // 120s expiry - 60s skew = 60s cached TTL.
      vi.advanceTimersByTime(60_000 - 1);
      const b = await getToken('org-1');
      expect(b).toEqual({ token: 'SHORT-1' }); // still cached
      expect(acquireClientCredentialsToken).toHaveBeenCalledTimes(1);

      (acquireClientCredentialsToken as any).mockResolvedValueOnce({ accessToken: 'SHORT-2', expiresIn: 120 });
      vi.advanceTimersByTime(2);
      const c = await getToken('org-1');
      expect(c).toEqual({ token: 'SHORT-2' });
      expect(acquireClientCredentialsToken).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('auth_failed drops any stale cache entry so a repaired secret is retried immediately', async () => {
    vi.useFakeTimers();
    try {
      const a = await getToken('org-1');
      expect(a).toEqual({ token: 'TOKEN-123' });
      expect(acquireClientCredentialsToken).toHaveBeenCalledTimes(1);

      // Let the cache expire, then simulate a broken secret on the next acquisition.
      vi.advanceTimersByTime(30 * 60 * 1000 + 1);
      (acquireClientCredentialsToken as any).mockRejectedValueOnce(new Error('invalid_client'));
      const b = await getToken('org-1');
      expect(b).toEqual({ kind: 'error', code: 'auth_failed', message: 'invalid_client' });
      expect(acquireClientCredentialsToken).toHaveBeenCalledTimes(2);

      // Secret is fixed — the very next call re-acquires rather than being blocked.
      (acquireClientCredentialsToken as any).mockResolvedValueOnce({ accessToken: 'TOKEN-456', expiresIn: 3600 });
      const c = await getToken('org-1');
      expect(c).toEqual({ token: 'TOKEN-456' });
      expect(acquireClientCredentialsToken).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('getToken cache bound', () => {
  it('evicts the oldest entries once the cache exceeds TOKEN_CACHE_MAX', async () => {
    const overflow = 5;
    for (let i = 0; i < TOKEN_CACHE_MAX + overflow; i++) {
      await getToken(`org-${i}`);
    }
    const callsAfterFill = (acquireClientCredentialsToken as any).mock.calls.length;
    expect(callsAfterFill).toBe(TOKEN_CACHE_MAX + overflow);

    // The earliest-inserted org key was evicted — asking again re-acquires.
    await getToken('org-0');
    expect((acquireClientCredentialsToken as any).mock.calls.length).toBe(callsAfterFill + 1);

    // The most-recently-inserted org key is still cached — no additional call.
    const callsAfterRefetch = (acquireClientCredentialsToken as any).mock.calls.length;
    await getToken(`org-${TOKEN_CACHE_MAX + overflow - 1}`);
    expect((acquireClientCredentialsToken as any).mock.calls.length).toBe(callsAfterRefetch);
  }, 20_000);
});
