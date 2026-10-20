import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the row lookup, secret decryption, and token acquisition so the test
// focuses on invokeDirect's Graph endpoint/method/body mapping.
const mockRow = { id: 'conn-1', tenantId: '11111111-1111-1111-1111-111111111111', clientId: 'client-1', clientSecret: 'enc-secret' };
let selectRows: unknown[] = [mockRow];
let wherePredicate: unknown;
const dbContexts = vi.hoisted(() => [] as string[]);
vi.mock('../db', () => ({
  withSystemDbAccessContext: async (fn: () => Promise<unknown>, label?: string) => { dbContexts.push(label ?? 'system'); return fn(); },
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
const randomBytesMock = vi.hoisted(() => vi.fn());
vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  randomBytesMock.mockImplementation(actual.randomBytes);
  return { ...actual, default: actual, randomBytes: randomBytesMock };
});
const prepareMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
const gateMock = vi.hoisted(() => vi.fn());
vi.mock('./callerVerification/dispatch', () => ({ prepareCallerDispatch: prepareMock }));
vi.mock('./callerVerification/gate', () => ({ requireCallerVerification: gateMock }));
const captureExceptionMock = vi.hoisted(() => vi.fn());
vi.mock('./sentry', () => ({ captureException: captureExceptionMock }));
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
  readMailboxesDirect,
} from './m365DirectGraph';
import { acquireClientCredentialsToken } from './c2cM365';
import { CallerVerificationRequiredError, CallerVerificationValidationError } from './callerVerification/errors';
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
  dbContexts.length = 0;
  prepareMock.mockReset();
  prepareMock.mockResolvedValue(undefined);
});

describe('readMailboxesDirect (#6354 W03)', () => {
  const userId = '22222222-2222-4222-8222-222222222222';
  const orgRow = { ...mockRow, orgId: 'org-1' };

  it('projects the four mailbox fields by object id, never extra Graph fields', async () => {
    selectRows = [orgRow];
    const resource = { id: userId, userPrincipalName: 'alex@example.com', mail: null,
      proxyAddresses: ['SMTP:alias@example.com'], passwordProfile: { password: 'secret' }, displayName: 'Alex' };
    const fetch = mockFetch(200, resource);
    const result = await readMailboxesDirect('org-1', { userId, expectedTenantId: mockRow.tenantId });
    expect(result).toEqual({ kind: 'ok', data: { id: userId, userPrincipalName: 'alex@example.com', mail: null, proxyAddresses: ['SMTP:alias@example.com'] } });
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.pathname).toBe(`/v1.0/users/${userId}`);
    expect(url.searchParams.get('$select')).toBe('id,userPrincipalName,mail,proxyAddresses');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
    // The only DB read ran in its own short system scope, before any I/O.
    expect(dbContexts).toEqual(['callerVerification.mailboxes.directConnection']);
  });

  it('leaves a missing alias list missing rather than inventing an empty one', async () => {
    selectRows = [orgRow];
    mockFetch(200, { id: userId, userPrincipalName: 'alex@example.com', mail: null });
    expect(await readMailboxesDirect('org-1', { userId, expectedTenantId: mockRow.tenantId }))
      .toEqual({ kind: 'ok', data: { id: userId, userPrincipalName: 'alex@example.com', mail: null } });
  });

  it('rejects a different connection tenant before token or Graph access', async () => {
    selectRows = [orgRow];
    const fetch = mockFetch(200, {});
    const result = await readMailboxesDirect('org-1', { userId, expectedTenantId: '33333333-3333-4333-8333-333333333333' });
    expect(result).toMatchObject({ kind: 'error', code: 'tenant_mismatch' });
    expect(acquireClientCredentialsToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['a UPN', { userId: 'alex@example.com', expectedTenantId: mockRow.tenantId }],
    ['a non-GUID tenant', { userId, expectedTenantId: 'contoso.onmicrosoft.com' }],
  ])('refuses %s before any DB or network access', async (_label, input) => {
    const fetch = mockFetch(200, {});
    expect(await readMailboxesDirect('org-1', input)).toMatchObject({ kind: 'error', code: 'bad_request' });
    expect(dbContexts).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports a missing connection without a network call', async () => {
    selectRows = [];
    const fetch = mockFetch(200, {});
    expect(await readMailboxesDirect('org-1', { userId, expectedTenantId: mockRow.tenantId })).toMatchObject({ kind: 'error', code: 'no_connection' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('surfaces a Graph failure instead of an empty result', async () => {
    selectRows = [orgRow];
    mockFetch(403, { error: { message: 'Insufficient privileges' } });
    expect(await readMailboxesDirect('org-1', { userId, expectedTenantId: mockRow.tenantId })).toMatchObject({ kind: 'error', code: 'forbidden' });
  });
});

describe('token cache tenant binding (#6354 W03)', () => {
  it('does not reuse a cached token after the connection tenant changes', async () => {
    await getToken('org-1');
    selectRows = [{ ...mockRow, tenantId: '33333333-3333-4333-8333-333333333333' }];
    await getToken('org-1');
    expect(acquireClientCredentialsToken).toHaveBeenCalledTimes(2);
  });
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
    const res = await invokeDirect('org-1', 'disable_user', { userId: 'u1', reason: 'offboard' }, { actionIntentId: 'intent-1' });
    expect(res.kind).toBe('ok');
    const [url, opts] = f.mock.calls[0]!;
    expect(url).toBe(`${GRAPH}/users/u1`);
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body as string)).toEqual({ accountEnabled: false });
  });

  it('reset_user_password → PATCH passwordProfile and returns a generated temp password', async () => {
    const f = mockFetch(204, null);
    const res = await invokeDirect('org-1', 'reset_user_password', { userId: 'u1', reason: 'lockout' }, { actionIntentId: 'intent-1' });
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
    expect(a).toEqual({ token: 'TOKEN-123', connectionId: 'conn-1', tenantId: mockRow.tenantId });
    const b = await getToken('org-1');
    expect(b).toEqual({ token: 'TOKEN-123', connectionId: 'conn-1', tenantId: mockRow.tenantId });
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
      expect(a).toEqual({ token: 'SHORT-1', connectionId: 'conn-1', tenantId: mockRow.tenantId });

      // 120s expiry - 60s skew = 60s cached TTL.
      vi.advanceTimersByTime(60_000 - 1);
      const b = await getToken('org-1');
      expect(b).toEqual({ token: 'SHORT-1', connectionId: 'conn-1', tenantId: mockRow.tenantId }); // still cached
      expect(acquireClientCredentialsToken).toHaveBeenCalledTimes(1);

      (acquireClientCredentialsToken as any).mockResolvedValueOnce({ accessToken: 'SHORT-2', expiresIn: 120 });
      vi.advanceTimersByTime(2);
      const c = await getToken('org-1');
      expect(c).toEqual({ token: 'SHORT-2', connectionId: 'conn-1', tenantId: mockRow.tenantId });
      expect(acquireClientCredentialsToken).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('auth_failed drops any stale cache entry so a repaired secret is retried immediately', async () => {
    vi.useFakeTimers();
    try {
      const a = await getToken('org-1');
      expect(a).toEqual({ token: 'TOKEN-123', connectionId: 'conn-1', tenantId: mockRow.tenantId });
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
      expect(c).toEqual({ token: 'TOKEN-456', connectionId: 'conn-1', tenantId: mockRow.tenantId });
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

describe('getToken with a supplied connection (#8142)', () => {
  it('uses the supplied row and issues no DB read', async () => {
    const { db } = await import('../db');
    vi.mocked(db.select).mockClear();
    const result = await getToken('org-1', { connection: { ...mockRow, orgId: 'org-1' } as never });
    expect(result).toEqual({ token: 'TOKEN-123', connectionId: 'conn-1', tenantId: mockRow.tenantId });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('supplied null means "no connection", still without a DB read', async () => {
    const { db } = await import('../db');
    vi.mocked(db.select).mockClear();
    expect(await getToken('org-1', { connection: null })).toMatchObject({ kind: 'error', code: 'no_connection' });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('refuses a supplied row that belongs to another org with a distinct, loud, non-cacheable error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    captureExceptionMock.mockClear();
    const result = await getToken('org-1', { connection: { ...mockRow, orgId: 'org-2' } as never });
    expect(result).toMatchObject({ kind: 'error', code: 'connection_org_mismatch' });
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0]![0])).toContain('org-1');
    expect(String(errSpy.mock.calls[0]![0])).toContain('org-2');
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock.mock.calls[0]![2]).toMatchObject({ requestedOrgId: 'org-1', connectionOrgId: 'org-2' });
    errSpy.mockRestore();
  });

  it('a supplied null is still plain no_connection and is not reported', async () => {
    captureExceptionMock.mockClear();
    expect(await getToken('org-1', { connection: null })).toMatchObject({ code: 'no_connection' });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
});


describe('protected direct mutations (#6354 W05)', () => {
  const OID = '44444444-4444-4444-8444-444444444444';
  const refusal = () => new CallerVerificationRequiredError({
    orgId: 'org-1', contactId: null, action: 'disable_user', requiredTier: 2,
    reason: 'no_fresh_verification', latest: null,
  });

  it('disable_user refusal propagates and sends zero PATCH', async () => {
    prepareMock.mockRejectedValueOnce(refusal());
    const f = mockFetch(204, null);
    await expect(invokeDirect('org-1', 'disable_user', { userId: OID }, { actionIntentId: 'intent-1' }))
      .rejects.toBeInstanceOf(CallerVerificationRequiredError);
    expect(f).not.toHaveBeenCalled();
  });

  it('reset_user_password refusal sends zero PATCH and never generates a password', async () => {
    prepareMock.mockRejectedValueOnce(refusal());
    const f = mockFetch(204, null);
    randomBytesMock.mockClear();
    await expect(invokeDirect('org-1', 'reset_user_password', { userId: OID }, { actionIntentId: 'intent-1' }))
      .rejects.toBeInstanceOf(CallerVerificationRequiredError);
    expect(f).not.toHaveBeenCalled();
    expect(randomBytesMock).not.toHaveBeenCalled();
  });

  it('disable_user pass sends exactly one PATCH to /users/<oid>; guard gets the token connection id and tenant', async () => {
    const f = mockFetch(204, null);
    const res = await invokeDirect('org-1', 'disable_user', { userId: OID }, { actionIntentId: 'intent-1' });
    expect(res.kind).toBe('ok');
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]![0]).toBe(`${GRAPH}/users/${OID}`);
    expect(f.mock.calls[0]![1].method).toBe('PATCH');
    expect(prepareMock).toHaveBeenCalledTimes(1);
    expect(prepareMock.mock.calls[0]![0]).toEqual({
      orgId: 'org-1', intentId: 'intent-1', action: 'disable_user',
      connectionId: 'conn-1', backendTenantId: mockRow.tenantId, oid: OID,
    });
    expect(prepareMock.mock.calls[0]![1]).toBe(gateMock);
  });

  it('reset_user_password pass sends exactly one PATCH and guards as reset_password', async () => {
    const f = mockFetch(204, null);
    const res = await invokeDirect('org-1', 'reset_user_password', { userId: OID }, { actionIntentId: 'intent-1' });
    expect(res.kind).toBe('ok');
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]![0]).toBe(`${GRAPH}/users/${OID}`);
    expect(prepareMock.mock.calls[0]![0]).toMatchObject({ action: 'reset_password', connectionId: 'conn-1', oid: OID });
  });

  it('a protected mutation without an intent id still reaches the guard with intentId undefined (guard refuses)', async () => {
    prepareMock.mockRejectedValueOnce(refusal());
    const f = mockFetch(204, null);
    await expect(invokeDirect('org-1', 'disable_user', { userId: OID })).rejects.toBeInstanceOf(CallerVerificationRequiredError);
    expect(prepareMock.mock.calls[0]![0]).toMatchObject({ intentId: undefined });
    expect(f).not.toHaveBeenCalled();
  });

  it('read tools never call the guard', async () => {
    mockFetch(200, {});
    await invokeDirect('org-1', 'get_user', { userId: OID });
    await invokeDirect('org-1', 'list_groups', {});
    expect(prepareMock).not.toHaveBeenCalled();
  });

  it('expectedConnection mismatch throws tenant_mismatch before any Graph call or guard', async () => {
    const f = mockFetch(204, null);
    await expect(invokeDirect('org-1', 'disable_user', { userId: OID }, {
      actionIntentId: 'intent-1', expectedConnection: { connectionId: 'conn-OTHER', tenantId: mockRow.tenantId },
    })).rejects.toMatchObject({ name: 'CallerVerificationValidationError', code: 'tenant_mismatch' });
    await expect(invokeDirect('org-1', 'disable_user', { userId: OID }, {
      actionIntentId: 'intent-1', expectedConnection: { connectionId: 'conn-1', tenantId: '33333333-3333-4333-8333-333333333333' },
    })).rejects.toBeInstanceOf(CallerVerificationValidationError);
    expect(f).not.toHaveBeenCalled();
    expect(prepareMock).not.toHaveBeenCalled();
  });

  it('expectedConnection match (tenant case-insensitive) proceeds', async () => {
    const f = mockFetch(200, {});
    const res = await invokeDirect('org-1', 'get_user', { userId: OID }, {
      expectedConnection: { connectionId: 'conn-1', tenantId: mockRow.tenantId.toUpperCase() },
    });
    expect(res.kind).toBe('ok');
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('token cache connection binding (#6354 W05)', () => {
  it('a changed connection id alone forces a new token acquisition', async () => {
    await getToken('org-1');
    selectRows = [{ ...mockRow, id: 'conn-2' }];
    const second = await getToken('org-1');
    expect(acquireClientCredentialsToken).toHaveBeenCalledTimes(2);
    expect(second).toMatchObject({ connectionId: 'conn-2' });
  });

  it('an unchanged connection reuses the cached token and still reports its id and tenant', async () => {
    await getToken('org-1');
    const again = await getToken('org-1');
    expect(acquireClientCredentialsToken).toHaveBeenCalledTimes(1);
    expect(again).toEqual({ token: 'TOKEN-123', connectionId: 'conn-1', tenantId: mockRow.tenantId });
  });

  it('a non-GUID tenant is rejected before the cache even when a token is cached for that row id', async () => {
    await getToken('org-1');
    selectRows = [{ ...mockRow, tenantId: 'contoso.onmicrosoft.com' }];
    expect(await getToken('org-1')).toMatchObject({ kind: 'error', code: 'connection_key_error' });
  });
});
