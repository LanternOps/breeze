import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the row lookup, secret decryption, and token acquisition so the test
// focuses on invokeDirect's Graph endpoint/method/body mapping.
const mockRow = { tenantId: 'tenant-1', clientId: 'client-1', clientSecret: 'enc-secret' };
vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [mockRow]),
        })),
      })),
    })),
  },
}));
vi.mock('./secretCrypto', () => ({ decryptForColumn: vi.fn(() => 'plaintext-secret') }));
vi.mock('./c2cM365', () => ({
  acquireClientCredentialsToken: vi.fn(async () => ({ accessToken: 'TOKEN-123', expiresIn: 3600 })),
}));

import { invokeDirect } from './m365DirectGraph';

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
