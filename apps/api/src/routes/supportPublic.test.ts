import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Public Quick Support endpoints. The code IS the auth, so the tests that
 * matter are the ones proving a code cannot be reused, cannot outlive its
 * TTL, and that failures are indistinguishable from one another.
 */

const { rateLimiter, getRedis, logSessionAudit, getTrustedClientIp } = vi.hoisted(() => ({
  rateLimiter: vi.fn(() => Promise.resolve({ allowed: true, currentCount: 1 })),
  getRedis: vi.fn(() => ({}) as unknown),
  logSessionAudit: vi.fn(() => Promise.resolve()),
  getTrustedClientIp: vi.fn(() => '203.0.113.9'),
}));

vi.mock('../services/rate-limit', () => ({ rateLimiter }));
vi.mock('../services/redis', () => ({ getRedis }));
vi.mock('./remote/helpers', () => ({ logSessionAudit }));
vi.mock('../services/clientIp', () => ({ getTrustedClientIp }));

// Binary resolution is stubbed so the download tests never touch the network.
const { getBinarySource, getGithubAgentUrl, isS3Configured, getPresignedUrl, isS3NotFound } =
  vi.hoisted(() => ({
    getBinarySource: vi.fn((): 'github' | 'local' => 'github'),
    getGithubAgentUrl: vi.fn((os: string, arch: string) => `https://gh.test/breeze-agent-${os}-${arch}.exe`),
    isS3Configured: vi.fn(() => false),
    getPresignedUrl: vi.fn(() => Promise.resolve('https://s3.test/agent.exe')),
    isS3NotFound: vi.fn(() => false),
  }));

vi.mock('../services/binarySource', () => ({ getBinarySource, getGithubAgentUrl }));
vi.mock('../services/s3Storage', () => ({ isS3Configured, getPresignedUrl, isS3NotFound }));

vi.mock('../services/enrollmentKeySecurity', async () => {
  const { createHash } = await import('node:crypto');
  return {
    hashEnrollmentKey: vi.fn((k: string) => `keyhash:${k}`),
    hashEnrollmentSecret: vi.fn((s: string) => createHash('sha256').update(s).digest('hex')),
  };
});

const selectResults: unknown[][] = [];
const updateResults: unknown[][] = [];
const insertedValues: unknown[] = [];
let updateWhereCalled = 0;

vi.mock('../db', () => {
  const select = vi.fn(() => {
    const rows = selectResults.shift() ?? [];
    const builder: Record<string, unknown> = {};
    for (const m of ['from', 'where']) builder[m] = vi.fn(() => builder);
    builder.limit = vi.fn(() => Promise.resolve(rows));
    return builder;
  });

  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => {
        updateWhereCalled++;
        return { returning: vi.fn(() => Promise.resolve(updateResults.shift() ?? [])) };
      }),
    })),
  }));

  const insert = vi.fn(() => ({
    values: vi.fn((v: unknown) => {
      insertedValues.push(v);
      return Promise.resolve([]);
    }),
  }));

  return {
    db: { select, update, insert },
    withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
    runOutsideDbContext: vi.fn(<T>(fn: () => T): T => fn()),
  };
});

vi.mock('../db/schema', () => ({
  supportSessions: {
    id: 'supportSessions.id',
    codeHash: 'supportSessions.codeHash',
    status: 'supportSessions.status',
    codeExpiresAt: 'supportSessions.codeExpiresAt',
  },
  enrollmentKeys: {},
  sites: { id: 'sites.id', orgId: 'sites.orgId' },
}));

import { hashSupportCode } from '../services/quickSupportCode';
import { supportPublicRoutes } from './supportPublic';

const CODE = 'KTM4H7P2X';
const FUTURE = new Date(Date.now() + 10 * 60_000);
const PAST = new Date(Date.now() - 60_000);

function pendingSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    orgId: 'qs-org',
    createdByUserId: 'creator-1',
    status: 'pending',
    codeExpiresAt: FUTURE,
    hardExpiresAt: new Date(Date.now() + 8 * 3_600_000),
    ...overrides,
  };
}

function redeem(body: Record<string, unknown> = {}) {
  return supportPublicRoutes.request('/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: CODE, hostname: 'DESKTOP-1', osType: 'windows', ...body }),
  });
}

/** Stands in for the ~60 MB agent asset — a real body, three bytes long. */
const fetchMock = vi.fn(() => Promise.resolve(
  new Response(new Uint8Array([0x4d, 0x5a, 0x90]), {
    status: 200,
    headers: { 'content-length': '3' },
  }),
));

beforeEach(() => {
  selectResults.length = 0;
  updateResults.length = 0;
  insertedValues.length = 0;
  updateWhereCalled = 0;
  vi.clearAllMocks();
  rateLimiter.mockResolvedValue({ allowed: true, currentCount: 1 });
  getTrustedClientIp.mockReturnValue('203.0.113.9');
  getBinarySource.mockReturnValue('github');
  getGithubAgentUrl.mockImplementation((os: string, arch: string) => `https://gh.test/breeze-agent-${os}-${arch}.exe`);
  isS3Configured.mockReturnValue(false);
  fetchMock.mockResolvedValue(new Response(new Uint8Array([0x4d, 0x5a, 0x90]), {
    status: 200,
    headers: { 'content-length': '3' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  process.env.PUBLIC_API_URL = 'https://us.2breeze.app';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.API_URL;
});

describe('GET /check/:code', () => {
  it('reports a pending unexpired code as valid', async () => {
    selectResults.push([{ status: 'pending', codeExpiresAt: FUTURE }]);
    const body = await (await supportPublicRoutes.request(`/check/${CODE}`)).json();
    expect(body).toEqual({ valid: true });
  });

  it('reports an expired code as invalid', async () => {
    selectResults.push([{ status: 'pending', codeExpiresAt: PAST }]);
    expect(await (await supportPublicRoutes.request(`/check/${CODE}`)).json()).toEqual({ valid: false });
  });

  it('reports an already-claimed code as invalid', async () => {
    selectResults.push([{ status: 'claimed', codeExpiresAt: FUTURE }]);
    expect(await (await supportPublicRoutes.request(`/check/${CODE}`)).json()).toEqual({ valid: false });
  });

  it('reports an unknown code as invalid', async () => {
    selectResults.push([]);
    expect(await (await supportPublicRoutes.request(`/check/${CODE}`)).json()).toEqual({ valid: false });
  });

  it('rejects a malformed code without touching the database', async () => {
    const body = await (await supportPublicRoutes.request('/check/not-a-code')).json();
    expect(body).toEqual({ valid: false });
    expect(selectResults).toHaveLength(0); // nothing was consumed
  });

  it('accepts the human-formatted code', async () => {
    selectResults.push([{ status: 'pending', codeExpiresAt: FUTURE }]);
    expect(await (await supportPublicRoutes.request('/check/KTM-4H7-P2X')).json())
      .toEqual({ valid: true });
  });

  it('429s when rate limited', async () => {
    rateLimiter.mockResolvedValue({ allowed: false, currentCount: 99 });
    const res = await supportPublicRoutes.request(`/check/${CODE}`);
    expect(res.status).toBe(429);
  });
});

describe('POST /redeem', () => {
  it('claims the session and mints a single-use key with its own secret', async () => {
    const session = pendingSession();
    selectResults.push([session]); // code lookup
    updateResults.push([{ ...session, status: 'claimed' }]); // atomic claim wins
    selectResults.push([{ id: 'site-1' }]); // site lookup

    const res = await redeem();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.enrollmentKey).toMatch(/^[0-9a-f]{64}$/);
    expect(body.enrollmentSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(body.serverUrl).toBe('https://us.2breeze.app');
    expect(body.sessionId).toBe(session.id);

    const key = insertedValues[0] as Record<string, unknown>;
    expect(key.maxUsage).toBe(1);
    expect(key.supportSessionId).toBe(session.id);
    expect(key.orgId).toBe('qs-org');
    expect(key.installerPlatform).toBe('windows');
    // The raw key/secret are never stored.
    expect(key.key).toBe(`keyhash:${body.enrollmentKey}`);
    expect(key.key).not.toBe(body.enrollmentKey);
    expect(key.keySecretHash).not.toBe(body.enrollmentSecret);
  });

  it('never hands out the global AGENT_ENROLLMENT_SECRET', async () => {
    process.env.AGENT_ENROLLMENT_SECRET = 'super-secret-global-value';
    const session = pendingSession();
    selectResults.push([session]);
    updateResults.push([{ ...session, status: 'claimed' }]);
    selectResults.push([{ id: 'site-1' }]);

    const body = await (await redeem()).json();
    expect(JSON.stringify(body)).not.toContain('super-secret-global-value');
    delete process.env.AGENT_ENROLLMENT_SECRET;
  });

  it('guards the claim on status=pending so a concurrent redeem loses', async () => {
    const session = pendingSession();
    selectResults.push([session]);
    updateResults.push([]); // the racer already flipped it — 0 rows updated

    const res = await redeem();
    expect(res.status).toBe(404);
    expect(updateWhereCalled).toBe(1);
    expect(insertedValues).toHaveLength(0); // no key minted
  });

  it('404s an already-claimed code', async () => {
    selectResults.push([pendingSession({ status: 'claimed' })]);
    const res = await redeem();
    expect(res.status).toBe(404);
    expect(updateWhereCalled).toBe(0);
  });

  it('404s an expired code without touching the session', async () => {
    selectResults.push([pendingSession({ codeExpiresAt: PAST })]);
    const res = await redeem();
    expect(res.status).toBe(404);
    expect(updateWhereCalled).toBe(0);
    expect(insertedValues).toHaveLength(0);
  });

  it('404s a session already past its hard cap', async () => {
    selectResults.push([pendingSession({ hardExpiresAt: PAST })]);
    expect((await redeem()).status).toBe(404);
    expect(updateWhereCalled).toBe(0);
  });

  it('404s an unknown code', async () => {
    selectResults.push([]);
    expect((await redeem()).status).toBe(404);
  });

  it('returns the same error shape for unknown, expired and claimed codes', async () => {
    const bodies: unknown[] = [];
    selectResults.push([]);
    bodies.push(await (await redeem()).json());
    selectResults.push([pendingSession({ codeExpiresAt: PAST })]);
    bodies.push(await (await redeem()).json());
    selectResults.push([pendingSession({ status: 'claimed' })]);
    bodies.push(await (await redeem()).json());
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it('records the claiming IP and audits the anonymous actor', async () => {
    const session = pendingSession();
    selectResults.push([session]);
    updateResults.push([{ ...session, status: 'claimed' }]);
    selectResults.push([{ id: 'site-1' }]);

    await redeem();
    expect(logSessionAudit).toHaveBeenCalledWith(
      'support_session_claimed',
      'creator-1',
      'qs-org',
      expect.objectContaining({ actor: 'end_user', sessionId: session.id }),
      '203.0.113.9',
    );
  });

  it('429s when rate limited before any DB work', async () => {
    rateLimiter.mockResolvedValue({ allowed: false, currentCount: 99 });
    expect((await redeem()).status).toBe(429);
    expect(selectResults).toHaveLength(0);
  });

  it('rejects a payload with an unknown osType', async () => {
    const res = await redeem({ osType: 'freebsd' });
    expect(res.status).toBe(400);
  });

  it('hashes the code before lookup — the plaintext is never queried', async () => {
    selectResults.push([]);
    await redeem();
    expect(hashSupportCode(CODE)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('GET /download/:platform', () => {
  function download(platform = 'windows', query = `?code=${CODE}`) {
    return supportPublicRoutes.request(`/download/${platform}${query}`);
  }

  it('serves the agent binary named after the code and API host', async () => {
    selectResults.push([{ status: 'pending', codeExpiresAt: FUTURE }]);

    const res = await download();
    expect(res.status).toBe(200);
    // Exact wire format — the Go client parses this filename (Task 12).
    expect(res.headers.get('Content-Disposition'))
      .toBe('attachment; filename="breeze-support-KTM4H7P2X-us.2breeze.app.exe"');
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    // The code is in the filename, so the response must never be cached.
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0x4d, 0x5a, 0x90]));
  });

  it('proxies the release asset rather than redirecting to it', async () => {
    selectResults.push([{ status: 'pending', codeExpiresAt: FUTURE }]);
    const res = await download();
    // A 302 would hand the browser GitHub's filename and lose the code.
    expect(res.status).toBe(200);
    expect(getGithubAgentUrl).toHaveBeenCalledWith('windows', 'amd64');
    expect(fetchMock).toHaveBeenCalledWith('https://gh.test/breeze-agent-windows-amd64.exe');
  });

  it('normalizes the human-formatted code into the filename', async () => {
    selectResults.push([{ status: 'pending', codeExpiresAt: FUTURE }]);
    const res = await download('windows', '?code=ktm-4h7-p2x');
    expect(res.headers.get('Content-Disposition'))
      .toBe('attachment; filename="breeze-support-KTM4H7P2X-us.2breeze.app.exe"');
  });

  it('encodes a nonstandard port as host_PORT, never host:PORT', async () => {
    // `:` is illegal in a Windows filename and gets silently rewritten by the
    // browser at save time, which is how #2341 shipped un-enrollable installers.
    process.env.PUBLIC_API_URL = 'https://breeze.example.com:8443';
    selectResults.push([{ status: 'pending', codeExpiresAt: FUTURE }]);
    const res = await download();
    expect(res.headers.get('Content-Disposition'))
      .toBe('attachment; filename="breeze-support-KTM4H7P2X-breeze.example.com_8443.exe"');
  });

  it('404s an unknown code', async () => {
    selectResults.push([]);
    const res = await download();
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('404s an already-claimed code', async () => {
    selectResults.push([{ status: 'claimed', codeExpiresAt: FUTURE }]);
    expect((await download()).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('404s an expired code', async () => {
    selectResults.push([{ status: 'pending', codeExpiresAt: PAST }]);
    expect((await download()).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('404s a malformed or missing code without touching the database', async () => {
    expect((await download('windows', '?code=not-a-code')).status).toBe(404);
    expect((await download('windows', '')).status).toBe(404);
    expect(selectResults).toHaveLength(0); // nothing was consumed
  });

  it('400s macOS with the coming-soon message and no DB work', async () => {
    const res = await download('macos');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'macOS support client coming soon' });
    expect(selectResults).toHaveLength(0);
  });

  it('400s an unknown platform', async () => {
    const res = await download('linux');
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('429s when rate limited before any DB or upstream work', async () => {
    rateLimiter.mockResolvedValue({ allowed: false, currentCount: 99 });
    expect((await download()).status).toBe(429);
    expect(selectResults).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shares the /check rate-limit bucket', async () => {
    selectResults.push([{ status: 'pending', codeExpiresAt: FUTURE }]);
    await download();
    expect(rateLimiter).toHaveBeenCalledWith(expect.anything(), 'support-check:203.0.113.9', 30, 60);
  });

  it('503s rather than serving a partial download when the upstream fails', async () => {
    selectResults.push([{ status: 'pending', codeExpiresAt: FUTURE }]);
    fetchMock.mockResolvedValue(new Response('nope', { status: 404 }));
    const res = await download();
    expect(res.status).toBe(503);
  });

  it('503s when PUBLIC_API_URL cannot produce a filename host', async () => {
    // A filename with no host yields a client that can never phone home.
    process.env.PUBLIC_API_URL = '';
    process.env.API_URL = '';
    selectResults.push([{ status: 'pending', codeExpiresAt: FUTURE }]);
    const res = await download();
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('proxies the S3 object in local mode instead of redirecting', async () => {
    getBinarySource.mockReturnValue('local');
    isS3Configured.mockReturnValue(true);
    selectResults.push([{ status: 'pending', codeExpiresAt: FUTURE }]);

    const res = await download();
    expect(res.status).toBe(200);
    expect(getPresignedUrl).toHaveBeenCalledWith('agent/breeze-agent-windows-amd64.exe');
    expect(fetchMock).toHaveBeenCalledWith('https://s3.test/agent.exe');
    expect(res.headers.get('Content-Disposition'))
      .toBe('attachment; filename="breeze-support-KTM4H7P2X-us.2breeze.app.exe"');
  });
});
