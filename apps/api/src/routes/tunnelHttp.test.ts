import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// --- UUID constants ---
const TUNNEL_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const DEVICE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER_ID = 'uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu';
const AGENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// --- DB join row (tunnelSessions ⋈ devices), driven by the setter below ---
let joinRow:
  | {
      session: {
        userId: string;
        status: string;
        orgId: string;
        type: string;
        targetHost: string;
        targetPort: number;
        scheme: string | null;
        skipTlsVerify: boolean;
        createdAt: Date;
        startedAt: Date | null;
        lastActivityAt: Date | null;
      };
      device: { id: string; status: string; agentId: string | null };
    }
  | undefined;

function setJoinRow(row: typeof joinRow) {
  joinRow = row;
}

function defaultJoinRow(
  over: Partial<{
    port: number;
    deviceStatus: string;
    ownerId: string;
    status: string;
    scheme: string | null;
    skipTlsVerify: boolean;
    createdAt: Date;
    startedAt: Date | null;
    lastActivityAt: Date | null;
  }> = {},
) {
  return {
    session: {
      userId: over.ownerId ?? USER_ID,
      status: over.status ?? 'active',
      orgId: ORG_ID,
      type: 'proxy',
      targetHost: '192.168.1.50',
      targetPort: over.port ?? 80,
      scheme: 'scheme' in over ? (over.scheme ?? null) : null,
      skipTlsVerify: over.skipTlsVerify ?? false,
      createdAt: over.createdAt ?? new Date(),
      startedAt: 'startedAt' in over ? (over.startedAt ?? null) : null,
      lastActivityAt: 'lastActivityAt' in over ? (over.lastActivityAt ?? null) : null,
    },
    device: { id: DEVICE_ID, status: over.deviceStatus ?? 'online', agentId: AGENT_ID },
  };
}

// Captures the values passed to db.update(...).set(values) for assertion —
// last call (back-compat) and the full call list (for count/throttle tests).
let capturedSessionUpdate: Record<string, unknown> | null = null;
let capturedSessionUpdates: Record<string, unknown>[] = [];

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => (joinRow ? [joinRow] : [])),
          })),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        capturedSessionUpdate = values;
        capturedSessionUpdates.push(values);
        return { where: vi.fn(async () => {}) };
      }),
    })),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
}));

vi.mock('../db/schema', () => ({
  tunnelSessions: { id: 'tunnelSessions.id', deviceId: 'tunnelSessions.deviceId' },
  devices: { id: 'devices.id' },
}));

const { consumeWsTicketMock } = vi.hoisted(() => ({ consumeWsTicketMock: vi.fn() }));
vi.mock('../services/remoteSessionAuth', () => ({
  consumeWsTicket: consumeWsTicketMock,
}));

const { isAgentConnectedMock } = vi.hoisted(() => ({ isAgentConnectedMock: vi.fn(() => true) }));
vi.mock('./agentWs', () => ({
  isAgentConnected: isAgentConnectedMock,
}));

const { sendCommandMock } = vi.hoisted(() => ({ sendCommandMock: vi.fn() }));
vi.mock('../services/agentCommandAwait', () => ({
  sendCommandToAgentAwaitResult: sendCommandMock,
}));

const { checkRemoteAccessMock } = vi.hoisted(() => ({
  checkRemoteAccessMock: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('../services/remoteAccessPolicy', () => ({
  checkRemoteAccess: checkRemoteAccessMock,
}));

vi.mock('../services/clientIp', () => ({
  getTrustedClientIp: vi.fn(() => '203.0.113.7'),
}));

// getActiveAllowlistPatterns is replicated in-file in the route, which queries
// the (mocked) db; it resolves to [] given the join-only db mock above.
vi.mock('../services/tunnelAllowlist', () => ({
  getActiveAllowlistPatterns: vi.fn(async () => ['192.168.1.0/24']),
}));

import { tunnelHttpRoutes, HTTP_TUNNEL_COOKIE_TTL_SECONDS, HTTP_TUNNEL_MAX_SESSION_HOURS } from './tunnelHttp';

function makeApp() {
  const app = new Hono();
  app.route('/api/v1/tunnel-http', tunnelHttpRoutes);
  return app;
}

const BASE = `/api/v1/tunnel-http/${TUNNEL_ID}`;

function okAgentResult(over: Partial<{ status: number; headers: Record<string, string[]>; bodyB64: string }> = {}) {
  return {
    status: 'completed',
    stdout: JSON.stringify({
      status: over.status ?? 200,
      headers: over.headers ?? { 'content-type': ['text/plain'] },
      bodyB64: over.bodyB64 ?? Buffer.from('hello').toString('base64'),
      truncated: false,
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedSessionUpdate = null;
  capturedSessionUpdates = [];
  setJoinRow(defaultJoinRow());
  isAgentConnectedMock.mockReturnValue(true);
  checkRemoteAccessMock.mockResolvedValue({ allowed: true });
  sendCommandMock.mockResolvedValue(okAgentResult());
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Helper: run the ticket flow and return the signed auth cookie value.
async function mintCookie(app: Hono): Promise<string> {
  consumeWsTicketMock.mockResolvedValueOnce({
    ok: true,
    sessionId: TUNNEL_ID,
    sessionType: 'tunnel-http',
    userId: USER_ID,
    expiresAt: Date.now() + 60_000,
  });
  const res = await app.request(`${BASE}/?__bzt=goodticket`);
  expect(res.status).toBe(302);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const m = setCookie.match(/(bz_tunnel_[^=]+=[^;]+)/);
  if (!m || !m[1]) throw new Error(`no auth cookie in: ${setCookie}`);
  return m[1];
}

describe('tunnelHttp auth: ticket + cookie', () => {
  it('returns 401 with no ticket and no cookie', async () => {
    const app = makeApp();
    const res = await app.request(`${BASE}/`);
    expect(res.status).toBe(401);
  });

  it('returns 401 for an invalid/expired ticket', async () => {
    consumeWsTicketMock.mockResolvedValueOnce({ ok: false, reason: 'not_found' });
    const app = makeApp();
    const res = await app.request(`${BASE}/?__bzt=bad`);
    expect(res.status).toBe(401);
  });

  it('returns 401 when ticket sessionType is not tunnel-http', async () => {
    consumeWsTicketMock.mockResolvedValueOnce({
      ok: true,
      sessionId: TUNNEL_ID,
      sessionType: 'tunnel',
      userId: USER_ID,
      expiresAt: Date.now() + 60_000,
    });
    const app = makeApp();
    const res = await app.request(`${BASE}/?__bzt=goodticket`);
    expect(res.status).toBe(401);
  });

  it('returns 401 when ticket sessionId does not match :tunnelId', async () => {
    consumeWsTicketMock.mockResolvedValueOnce({
      ok: true,
      sessionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      sessionType: 'tunnel-http',
      userId: USER_ID,
      expiresAt: Date.now() + 60_000,
    });
    const app = makeApp();
    const res = await app.request(`${BASE}/?__bzt=goodticket`);
    expect(res.status).toBe(401);
  });

  it('valid ticket -> 302 setting HttpOnly cookie, Location strips __bzt', async () => {
    consumeWsTicketMock.mockResolvedValueOnce({
      ok: true,
      sessionId: TUNNEL_ID,
      sessionType: 'tunnel-http',
      userId: USER_ID,
      expiresAt: Date.now() + 60_000,
    });
    const app = makeApp();
    const res = await app.request(`${BASE}/status?__bzt=goodticket&foo=bar`);
    expect(res.status).toBe(302);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`bz_tunnel_${TUNNEL_ID}=`);
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');
    expect(setCookie).toContain(`Path=/api/v1/tunnel-http/${TUNNEL_ID}/`);
    const loc = res.headers.get('location') ?? '';
    expect(loc).not.toContain('__bzt');
    expect(loc).toContain('foo=bar');
    expect(loc).toContain('/status');
  });
});

describe('tunnelHttp dispatch (cookie-authed)', () => {
  it('dispatches http_request with target from session, scheme http on port 80', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${BASE}/admin/page?x=1`, {
      method: 'GET',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    const [agentId, command] = sendCommandMock.mock.calls[0]!;
    expect(agentId).toBe(AGENT_ID);
    expect(command.type).toBe('http_request');
    expect(command.payload.targetHost).toBe('192.168.1.50');
    expect(command.payload.targetPort).toBe(80);
    expect(command.payload.scheme).toBe('http');
    expect(command.payload.method).toBe('GET');
    expect(command.payload.path).toBe('/admin/page?x=1');
    expect(command.payload.tunnelId).toBe(TUNNEL_ID);
    expect(Array.isArray(command.payload.allowlistRules)).toBe(true);
    // hop-by-hop + our own auth cookie must not be forwarded
    expect(JSON.stringify(command.payload.headers).toLowerCase()).not.toContain('bz_tunnel');
    expect(await res.text()).toBe('hello');
  });

  it('derives https scheme for port 443', async () => {
    setJoinRow(defaultJoinRow({ port: 443 }));
    const app = makeApp();
    const cookie = await mintCookie(app);
    setJoinRow(defaultJoinRow({ port: 443 }));
    await app.request(`${BASE}/`, { headers: { cookie } });
    const [, command] = sendCommandMock.mock.calls.at(-1)!;
    expect(command.payload.scheme).toBe('https');
    expect(command.payload.targetPort).toBe(443);
  });

  it('returns 404 when session is not owned by the cookie user', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    setJoinRow(defaultJoinRow({ ownerId: 'someone-else' }));
    const res = await app.request(`${BASE}/`, { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it('returns 502 when agent is not connected', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    isAgentConnectedMock.mockReturnValue(false);
    const res = await app.request(`${BASE}/`, { headers: { cookie } });
    expect(res.status).toBe(502);
  });

  it('returns 502 when device is offline', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    setJoinRow(defaultJoinRow({ deviceStatus: 'offline' }));
    const res = await app.request(`${BASE}/`, { headers: { cookie } });
    expect(res.status).toBe(502);
  });

  it('returns 504 when the agent command times out', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    sendCommandMock.mockResolvedValueOnce({ status: 'failed', error: 'timeout waiting for agent command result' });
    const res = await app.request(`${BASE}/`, { headers: { cookie } });
    expect(res.status).toBe(504);
  });

  it('returns 502 when the agent reports a generic failure', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    sendCommandMock.mockResolvedValueOnce({ status: 'failed', error: 'agent offline' });
    const res = await app.request(`${BASE}/`, { headers: { cookie } });
    expect(res.status).toBe(502);
  });
});

describe('tunnelHttp response rewriting', () => {
  it('replaces the device CSP with a restrictive sandbox CSP and drops content-length', async () => {
    sendCommandMock.mockResolvedValue(
      okAgentResult({
        headers: {
          'content-type': ['text/plain'],
          'content-security-policy': ["default-src 'self'"],
          'content-length': ['5'],
          'x-frame-options': ['SAMEORIGIN'],
        },
      }),
    );
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${BASE}/`, { headers: { cookie } });
    // The device's own CSP must not survive; we impose our own sandbox policy.
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).not.toContain("default-src 'self'");
    expect(csp).toContain('sandbox');
    expect(csp).toContain("frame-ancestors 'self'");
    expect(res.headers.get('x-frame-options')).toBeNull();
  });

  it('does not forward the user app cookies/authorization to the device, only device-prefixed cookies', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    // Browser sends: the proxy auth cookie, a leaked app cookie, and a device cookie.
    const res = await app.request(`${BASE}/`, {
      headers: {
        cookie: `${cookie}; breeze_refresh=SECRET; bzdev_session=devsid`,
        authorization: 'Bearer USER-API-TOKEN',
      },
    });
    expect(res.status).toBe(200);
    const [, command] = sendCommandMock.mock.calls.at(-1)!;
    const fwd = JSON.stringify(command.payload.headers);
    // App credentials must NOT reach the device.
    expect(fwd).not.toContain('breeze_refresh');
    expect(fwd).not.toContain('SECRET');
    expect(fwd.toLowerCase()).not.toContain('authorization');
    expect(fwd).not.toContain('USER-API-TOKEN');
    expect(fwd).not.toContain('bz_tunnel');
    // The device's own cookie round-trips, de-prefixed.
    expect(command.payload.headers.cookie?.[0]).toBe('session=devsid');
  });

  it('injects <base> tag into text/html responses', async () => {
    sendCommandMock.mockResolvedValue(
      okAgentResult({
        headers: { 'content-type': ['text/html'] },
        bodyB64: Buffer.from('<html><head><title>P</title></head><body>x</body></html>').toString('base64'),
      }),
    );
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${BASE}/`, { headers: { cookie } });
    const body = await res.text();
    expect(body).toContain(`<base href="/api/v1/tunnel-http/${TUNNEL_ID}/">`);
  });

  it('rewrites an absolute Location header to the proxy base', async () => {
    sendCommandMock.mockResolvedValue(
      okAgentResult({
        status: 302,
        headers: { location: ['http://192.168.1.50/foo'] },
        bodyB64: '',
      }),
    );
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${BASE}/`, { headers: { cookie }, redirect: 'manual' });
    expect(res.headers.get('location')).toBe(`/api/v1/tunnel-http/${TUNNEL_ID}/foo`);
  });

  it('rewrites a relative Location header to the proxy base', async () => {
    sendCommandMock.mockResolvedValue(
      okAgentResult({
        status: 302,
        headers: { location: ['/login'] },
        bodyB64: '',
      }),
    );
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${BASE}/`, { headers: { cookie }, redirect: 'manual' });
    expect(res.headers.get('location')).toBe(`/api/v1/tunnel-http/${TUNNEL_ID}/login`);
  });

  it('namespaces + path-scopes the device Set-Cookie so it round-trips without colliding with app cookies', async () => {
    sendCommandMock.mockResolvedValue(
      okAgentResult({
        headers: { 'content-type': ['text/plain'], 'set-cookie': ['sid=abc; Path=/; HttpOnly'] },
      }),
    );
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${BASE}/`, { headers: { cookie } });
    const sc = res.headers.get('set-cookie') ?? '';
    expect(sc).toContain('bzdev_sid=abc');
    expect(sc).toContain(`Path=/api/v1/tunnel-http/${TUNNEL_ID}/`);
  });
});

describe('tunnelHttp TLS + skipTlsVerify (#1916)', () => {
  it('maps a tls_cert_untrusted agent result to session-failed + 502', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    sendCommandMock.mockResolvedValueOnce({ status: 'failed', error: 'tls_cert_untrusted' });
    const res = await app.request(`${BASE}/`, { headers: { cookie } });
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('Untrusted');
    expect(capturedSessionUpdate).toMatchObject({
      status: 'failed',
      errorMessage: 'tls_cert_untrusted',
    });
    // endedAt must be a Date (not null/undefined)
    expect(capturedSessionUpdate?.endedAt).toBeInstanceOf(Date);
  });

  it('forwards session.scheme and skipTlsVerify in the http_request payload', async () => {
    setJoinRow(defaultJoinRow({ scheme: 'https', skipTlsVerify: true }));
    const app = makeApp();
    const cookie = await mintCookie(app);
    setJoinRow(defaultJoinRow({ scheme: 'https', skipTlsVerify: true }));
    const res = await app.request(`${BASE}/`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const [, command] = sendCommandMock.mock.calls.at(-1)!;
    expect(command.payload.scheme).toBe('https');
    expect(command.payload.skipTlsVerify).toBe(true);
  });

  it('falls back to port-based scheme when session.scheme is null', async () => {
    setJoinRow(defaultJoinRow({ port: 443, scheme: null }));
    const app = makeApp();
    const cookie = await mintCookie(app);
    setJoinRow(defaultJoinRow({ port: 443, scheme: null }));
    await app.request(`${BASE}/`, { headers: { cookie } });
    const [, command] = sendCommandMock.mock.calls.at(-1)!;
    expect(command.payload.scheme).toBe('https');
  });
});

describe('tunnelHttp session lifetime (#3199 Task 2)', () => {
  it('includes a refreshed cookie with fresh Max-Age on a successful authenticated proxied response', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${BASE}/`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const setCookieHeader = res.headers.get('set-cookie') ?? '';
    expect(setCookieHeader).toContain(`bz_tunnel_${TUNNEL_ID}=`);
    expect(setCookieHeader).toContain(`Max-Age=${HTTP_TUNNEL_COOKIE_TTL_SECONDS}`);
    expect(setCookieHeader.toLowerCase()).toContain('httponly');
    expect(setCookieHeader).toContain(`Path=/api/v1/tunnel-http/${TUNNEL_ID}/`);
  });

  it('401s when the cookie has expired (regression)', async () => {
    vi.useFakeTimers();
    try {
      const app = makeApp();
      const cookie = await mintCookie(app);
      vi.setSystemTime(Date.now() + (HTTP_TUNNEL_COOKIE_TTL_SECONDS + 5) * 1000);
      const res = await app.request(`${BASE}/`, { headers: { cookie } });
      expect(res.status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks a past-cap tunnel row terminal and returns 410 before contacting the agent', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    capturedSessionUpdates = []; // drop the mint's own status:'active' write
    const pastCapCreatedAt = new Date(Date.now() - (HTTP_TUNNEL_MAX_SESSION_HOURS * 60 * 60 * 1000 + 60_000));
    setJoinRow(defaultJoinRow({ createdAt: pastCapCreatedAt }));

    const res = await app.request(`${BASE}/`, { headers: { cookie } });

    expect(res.status).toBe(410);
    expect(sendCommandMock).not.toHaveBeenCalled();
    expect(capturedSessionUpdate).toMatchObject({
      status: 'disconnected',
      errorMessage: 'session_expired',
    });
    expect(capturedSessionUpdate?.endedAt).toBeInstanceOf(Date);
  });

  it('sets status active with startedAt at ticket exchange, and does not reset startedAt on re-mint', async () => {
    const app = makeApp();

    consumeWsTicketMock.mockResolvedValueOnce({
      ok: true,
      sessionId: TUNNEL_ID,
      sessionType: 'tunnel-http',
      userId: USER_ID,
      expiresAt: Date.now() + 60_000,
    });
    const res1 = await app.request(`${BASE}/?__bzt=goodticket1`);
    expect(res1.status).toBe(302);
    expect(capturedSessionUpdate).toMatchObject({ status: 'active' });
    expect(capturedSessionUpdate?.startedAt).toBeInstanceOf(Date);
    const firstStartedAt = capturedSessionUpdate!.startedAt as Date;

    // Simulate the DB now reflecting the persisted startedAt (idle-resume re-mint).
    setJoinRow(defaultJoinRow({ startedAt: firstStartedAt }));
    consumeWsTicketMock.mockResolvedValueOnce({
      ok: true,
      sessionId: TUNNEL_ID,
      sessionType: 'tunnel-http',
      userId: USER_ID,
      expiresAt: Date.now() + 60_000,
    });
    const res2 = await app.request(`${BASE}/?__bzt=goodticket2`);
    expect(res2.status).toBe(302);
    expect(capturedSessionUpdate).toMatchObject({ status: 'active' });
    expect(capturedSessionUpdate).not.toHaveProperty('startedAt');
  });

  it('throttles the lastActivityAt bump — two requests within 30s write once', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    capturedSessionUpdates = []; // drop the mint's own status:'active' write
    setJoinRow(defaultJoinRow({ lastActivityAt: null }));

    const res1 = await app.request(`${BASE}/`, { headers: { cookie } });
    expect(res1.status).toBe(200);
    const bumpsAfterFirst = capturedSessionUpdates.filter((u) => 'lastActivityAt' in u);
    expect(bumpsAfterFirst).toHaveLength(1);
    const bumpedAt = bumpsAfterFirst[0]!.lastActivityAt as Date;

    // Simulate the DB now reflecting the just-persisted lastActivityAt (<30s old).
    setJoinRow(defaultJoinRow({ lastActivityAt: bumpedAt }));
    const res2 = await app.request(`${BASE}/`, { headers: { cookie } });
    expect(res2.status).toBe(200);
    const bumpsAfterSecond = capturedSessionUpdates.filter((u) => 'lastActivityAt' in u);
    expect(bumpsAfterSecond).toHaveLength(1); // still just the one from before
  });

  it('does not bump lastActivityAt or refresh the cookie when a gate rejects the request', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    capturedSessionUpdates = []; // drop the mint's own status:'active' write
    setJoinRow(defaultJoinRow({ deviceStatus: 'offline', lastActivityAt: null }));

    const res = await app.request(`${BASE}/`, { headers: { cookie } });

    expect(res.status).toBe(502);
    expect(capturedSessionUpdates).toHaveLength(0);
    expect(res.headers.get('set-cookie')).toBeFalsy();
  });
});
