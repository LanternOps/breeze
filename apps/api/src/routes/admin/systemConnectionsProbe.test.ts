/**
 * POST /api/v1/admin/system/connections/m365-executors/probe (#9324).
 * Auth mocking mirrors systemConnections.test.ts. fetch is stubbed: no test
 * here touches the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/auditService', () => ({
  createAuditLog: vi.fn(async () => undefined),
  createAuditLogAsync: vi.fn(async () => undefined),
}));

vi.mock('../../services/clientIp', () => ({
  getTrustedClientIpOrUndefined: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<typeof import('../../middleware/auth')>('../../middleware/auth');
  const { HTTPException } = await import('hono/http-exception');
  return {
    ...actual,
    authMiddleware: vi.fn(async (c: any, next: () => Promise<void>) => {
      if (!c.get('auth')) throw new HTTPException(401, { message: 'Not authenticated' });
      await next();
    }),
  };
});

import { Hono } from 'hono';
import { adminRoutes } from './index';

type FakeAuth = {
  scope: 'system' | 'partner' | 'organization';
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean };
  token: { mfa: boolean };
};

const platformAdmin: FakeAuth = {
  scope: 'partner',
  user: { id: 'admin-1', email: 'admin@breeze.test', name: 'PA', isPlatformAdmin: true },
  token: { mfa: true },
};
const partnerAdmin: FakeAuth = {
  scope: 'partner',
  user: { id: 'pa-1', email: 'partner@x.com', name: 'Partner', isPlatformAdmin: false },
  token: { mfa: true },
};

function buildApp(auth: FakeAuth | null) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (auth) c.set('auth', auth as never);
    await next();
  });
  app.route('/admin', adminRoutes);
  return app;
}

const PATH = '/admin/system/connections/m365-executors/probe';
const READ_URL = 'http://read-executor.internal:3003';
const ACTIONS_URL = 'http://actions-executor.internal:3004';
const touchedEnv = new Map<string, string | undefined>();

function setEnv(name: string, value: string | undefined): void {
  if (!touchedEnv.has(name)) touchedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const fetchMock = vi.fn();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Healthy executor: healthz 200, every /v1/* route 401 unauthenticated. */
function healthy(url: string, version: unknown = { version: '1.2.3', gitSha: 'abc1234' }) {
  const u = new URL(url);
  return async (input: unknown) => {
    const target = new URL(String(input));
    if (target.host !== u.host) return undefined;
    if (target.pathname === '/healthz') return json({ status: 'ok' });
    if (target.pathname === '/version') return json(version);
    return json({ error: 'unauthorized' }, 401);
  };
}

function route(...handlers: Array<(input: unknown, init?: RequestInit) => Promise<Response | undefined>>) {
  fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
    for (const h of handlers) {
      const r = await h(input, init);
      if (r) return r;
    }
    throw new Error('unrouted');
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  setEnv('M365_GRAPH_READ_EXECUTOR_URL', READ_URL);
  setEnv('M365_GRAPH_ACTIONS_EXECUTOR_URL', ACTIONS_URL);
  setEnv('APP_VERSION', '1.2.3');
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [name, original] of touchedEnv) {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
  touchedEnv.clear();
});

async function probe(auth: FakeAuth | null = platformAdmin) {
  const res = await buildApp(auth).request(PATH, { method: 'POST' });
  return { res, body: res.status === 200 ? await res.json() : null };
}

describe('POST /admin/system/connections/m365-executors/probe', () => {
  it('401 unauthenticated, 403 for a non-platform-admin, and never calls fetch', async () => {
    expect((await probe(null)).res.status).toBe(401);
    expect((await probe(partnerAdmin)).res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('healthz 200 + verify-identity 401 → reachable, route present', async () => {
    route(healthy(READ_URL), healthy(ACTIONS_URL));
    const { res, body } = await probe();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const read = body.data.executors.find((e: any) => e.id === 'm365-graph-read');
    expect(read.configured).toBe(true);
    expect(read.reachable).toBe(true);
    expect(typeof read.latencyMs).toBe('number');
    expect(read.routes['verify-identity']).toBe('present');
    expect(Object.keys(read.routes).sort()).toEqual(['read-action', 'retest', 'sync-action', 'verify-identity']);
    const actions = body.data.executors.find((e: any) => e.id === 'm365-graph-actions');
    expect(Object.keys(actions.routes).sort()).toEqual(['execute-action', 'retest', 'verify-identity']);
    expect(read.version).toEqual({ version: '1.2.3', gitSha: 'abc1234' });
    expect(read.versionMatchesApi).toBe(true);
  });

  it('verify-identity 404 (pre-W1 image) → missing', async () => {
    route(async (input) => {
      const p = new URL(String(input)).pathname;
      if (p === '/healthz') return json({ status: 'ok' });
      if (p === '/v1/verify-identity' || p === '/version') return json({ error: 'not_found' }, 404);
      return json({ error: 'unauthorized' }, 401);
    });
    const { body } = await probe();
    const read = body.data.executors.find((e: any) => e.id === 'm365-graph-read');
    expect(read.reachable).toBe(true);
    expect(read.routes['verify-identity']).toBe('missing');
    expect(read.routes.retest).toBe('present');
    expect(read.version).toBeNull();
    expect(read.versionMatchesApi).toBeNull();
  });

  it('fetch rejects → reachable:false, routes unknown, and no error text leaks', async () => {
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.9:3003'));
    const { res, body } = await probe();
    expect(res.status).toBe(200);
    const read = body.data.executors.find((e: any) => e.id === 'm365-graph-read');
    expect(read.reachable).toBe(false);
    expect(read.routes['verify-identity']).toBe('unknown');
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|10\.0\.0\.9|executor\.internal/);
  });

  it('unset URL → configured:false and no request is made for that executor', async () => {
    setEnv('M365_GRAPH_ACTIONS_EXECUTOR_URL', undefined);
    route(healthy(READ_URL));
    const { body } = await probe();
    const actions = body.data.executors.find((e: any) => e.id === 'm365-graph-actions');
    expect(actions).toMatchObject({ configured: false, reachable: false });
    const hosts = fetchMock.mock.calls.map((c) => new URL(String(c[0])).host);
    expect(hosts.every((h) => h === new URL(READ_URL).host)).toBe(true);
  });

  it('only contacts the configured URL, with a timeout, no redirects, and sends no credentials', async () => {
    route(healthy(READ_URL), healthy(ACTIONS_URL));
    await probe();
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.redirect).toBe('manual');
      expect(new Headers(init.headers).get('authorization')).toBeNull();
    }
  });

  it('version mismatch with the API is reported, not hidden', async () => {
    route(healthy(READ_URL, { version: '0.9.0', gitSha: 'old' }), healthy(ACTIONS_URL));
    const { body } = await probe();
    const read = body.data.executors.find((e: any) => e.id === 'm365-graph-read');
    expect(read.versionMatchesApi).toBe(false);
  });

  it('a malformed /version body is dropped, not echoed', async () => {
    route(healthy(READ_URL, { version: '<script>x</script>', gitSha: { a: 1 }, secret: 'hunter2' }), healthy(ACTIONS_URL));
    const { body } = await probe();
    expect(JSON.stringify(body)).not.toMatch(/hunter2|<script>/);
  });
});
