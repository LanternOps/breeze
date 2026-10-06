import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';

// --- UUID constants ---
const TUNNEL_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const DEVICE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER_ID = 'uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu';
const AGENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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
      device: { id: string; siteId: string | null; status: string; agentId: string | null };
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
    device: { id: DEVICE_ID, siteId: SITE_ID, status: over.deviceStatus ?? 'online', agentId: AGENT_ID },
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

const { authorizeContinuationMock } = vi.hoisted(() => ({
  authorizeContinuationMock: vi.fn(),
}));
vi.mock('../services/remoteWsAuthorization', () => ({
  authorizeRemoteSessionContinuation: authorizeContinuationMock,
}));

vi.mock('../services/clientIp', () => ({
  getTrustedClientIp: vi.fn(() => '203.0.113.7'),
  // requestTransport.ts (imported for the cross-site Origin check) reads this
  // transitively; the whole-module mock above previously exported only
  // getTrustedClientIp, so this was undefined and requestTransport's own call
  // threw before the check could produce its intended 403 (surfaced as a 500
  // in the cross-site tests below).
  trustsForwardedHeadersFrom: vi.fn(() => false),
}));

// getActiveAllowlistPatterns is replicated in-file in the route, which queries
// the (mocked) db; it resolves to [] given the join-only db mock above.
vi.mock('../services/tunnelAllowlist', () => ({
  getActiveAllowlistPatterns: vi.fn(async () => ['192.168.1.0/24']),
}));

import {
  tunnelHttpRoutes,
  HTTP_TUNNEL_COOKIE_TTL_SECONDS,
  HTTP_TUNNEL_MAX_SESSION_HOURS,
  computeTunnelPathToken,
} from './tunnelHttp';
import { getActiveAllowlistPatterns } from '../services/tunnelAllowlist';

function makeApp() {
  const app = new Hono();
  app.route('/api/v1/tunnel-http', tunnelHttpRoutes);
  return app;
}

const BASE = `/api/v1/tunnel-http/${TUNNEL_ID}`;
// Every `mintCookie()` call in this file consumes a ticket resolving to the
// same USER_ID, so the per-(tunnel,user) path token (see tunnelHttp.ts) is
// constant for the whole file — computed once here rather than re-derived
// from each redirect Location.
const TOKEN_BASE = `${BASE}/${computeTunnelPathToken(TUNNEL_ID, USER_ID)}`;

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
  authorizeContinuationMock.mockResolvedValue({
    ok: true,
    context: {
      sessionId: TUNNEL_ID,
      sessionType: 'tunnel',
      userId: USER_ID,
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      agentId: AGENT_ID,
      tunnelType: 'proxy',
    },
  });
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

it('fails closed before cookie mint or agent dispatch when live tunnel authority was revoked', async () => {
  const app = makeApp();
  authorizeContinuationMock.mockResolvedValueOnce({
    ok: false,
    status: 403,
    reason: 'permission_denied',
  });
  consumeWsTicketMock.mockResolvedValueOnce({
    ok: true,
    sessionId: TUNNEL_ID,
    sessionType: 'tunnel-http',
    userId: USER_ID,
    expiresAt: Date.now() + 60_000,
  });

  const response = await app.request(`${BASE}/?__bzt=goodticket`);

  expect(response.status).toBe(403);
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(sendCommandMock).not.toHaveBeenCalled();
  expect(capturedSessionUpdates).toEqual([]);
});

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
    expect(setCookie.toLowerCase()).toContain('samesite=none');
    expect(setCookie.toLowerCase()).toContain('secure');
    // Cookie is scoped to the token-bearing path, not the bare tunnel root —
    // see the path-token doc comment in tunnelHttp.ts.
    expect(setCookie).toContain(`Path=${TOKEN_BASE}/`);
    const loc = res.headers.get('location') ?? '';
    expect(loc).not.toContain('__bzt');
    expect(loc).toContain('foo=bar');
    expect(loc).toContain('/status');
    // The redirect target carries the path token so every subsequent
    // request the browser makes (including this one) is automatically
    // covered.
    expect(loc.startsWith(`${TOKEN_BASE}/status`)).toBe(true);
  });

  it('redirect target and cookie path both carry the per-session path token, not the bare tunnel root', async () => {
    consumeWsTicketMock.mockResolvedValueOnce({
      ok: true,
      sessionId: TUNNEL_ID,
      sessionType: 'tunnel-http',
      userId: USER_ID,
      expiresAt: Date.now() + 60_000,
    });
    const app = makeApp();
    const res = await app.request(`${BASE}/?__bzt=goodticket`);
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') ?? '';
    // A request to the bare tunnel root (no path token) is not treated as
    // authenticated by the cookie alone — see the "Origin:null" path-token
    // tests below.
    expect(loc).not.toBe(`${BASE}/`);
    expect(loc.startsWith(TOKEN_BASE)).toBe(true);
  });
});

describe('tunnelHttp dispatch (cookie-authed)', () => {
  it('dispatches http_request with target from session, scheme http on port 80', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${TOKEN_BASE}/admin/page?x=1`, {
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
    expect(getActiveAllowlistPatterns).toHaveBeenCalledWith(ORG_ID, SITE_ID);
    // hop-by-hop + our own auth cookie must not be forwarded
    expect(JSON.stringify(command.payload.headers).toLowerCase()).not.toContain('bz_tunnel');
    expect(await res.text()).toBe('hello');
  });

  it('refuses a device parked in a holding org with 403 and sends nothing to the agent', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    checkRemoteAccessMock.mockResolvedValueOnce({
      allowed: false,
      code: 'DEVICE_PENDING_ASSIGNMENT',
      reason: 'This device is waiting to be assigned to an organization; remote access is unavailable until then',
    } as never);
    const res = await app.request(`${TOKEN_BASE}/admin/page`, { method: 'GET', headers: { cookie } });
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/waiting to be assigned/);
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it('derives https scheme for port 443', async () => {
    setJoinRow(defaultJoinRow({ port: 443 }));
    const app = makeApp();
    const cookie = await mintCookie(app);
    setJoinRow(defaultJoinRow({ port: 443 }));
    await app.request(`${TOKEN_BASE}/`, { headers: { cookie } });
    const [, command] = sendCommandMock.mock.calls.at(-1)!;
    expect(command.payload.scheme).toBe('https');
    expect(command.payload.targetPort).toBe(443);
  });

  it('returns 404 when session is not owned by the cookie user', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    setJoinRow(defaultJoinRow({ ownerId: 'someone-else' }));
    const res = await app.request(`${TOKEN_BASE}/`, { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it('returns 502 when agent is not connected', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    isAgentConnectedMock.mockReturnValue(false);
    const res = await app.request(`${TOKEN_BASE}/`, { headers: { cookie } });
    expect(res.status).toBe(502);
  });

  it('returns 502 when device is offline', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    setJoinRow(defaultJoinRow({ deviceStatus: 'offline' }));
    const res = await app.request(`${TOKEN_BASE}/`, { headers: { cookie } });
    expect(res.status).toBe(502);
  });

  it('returns 504 when the agent command times out', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    sendCommandMock.mockResolvedValueOnce({ status: 'failed', error: 'timeout waiting for agent command result' });
    const res = await app.request(`${TOKEN_BASE}/`, { headers: { cookie } });
    expect(res.status).toBe(504);
  });

  it('returns 502 when the agent reports a generic failure', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    sendCommandMock.mockResolvedValueOnce({ status: 'failed', error: 'agent offline' });
    const res = await app.request(`${TOKEN_BASE}/`, { headers: { cookie } });
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
    const res = await app.request(`${TOKEN_BASE}/`, { headers: { cookie } });
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
    const res = await app.request(`${TOKEN_BASE}/`, {
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
        bodyB64: Buffer.from('<html><head><title>P</title><script src="/app.js"></script></head><body>x</body></html>').toString('base64'),
      }),
    );
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${TOKEN_BASE}/`, { headers: { cookie } });
    const body = await res.text();
    expect(body).toContain(`<base href="${TOKEN_BASE}/">`);
    expect(body).toContain(`src="${TOKEN_BASE}/app.js"`);
    expect(body.match(/<script data-breeze-tunnel-rewrite>/g)).toHaveLength(1);
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
    const res = await app.request(`${TOKEN_BASE}/`, { headers: { cookie }, redirect: 'manual' });
    expect(res.headers.get('location')).toBe(`${TOKEN_BASE}/foo`);
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
    const res = await app.request(`${TOKEN_BASE}/`, { headers: { cookie }, redirect: 'manual' });
    expect(res.headers.get('location')).toBe(`${TOKEN_BASE}/login`);
  });

  it('namespaces + path-scopes the device Set-Cookie so it round-trips without colliding with app cookies', async () => {
    sendCommandMock.mockResolvedValue(
      okAgentResult({
        headers: { 'content-type': ['text/plain'], 'set-cookie': ['sid=abc; Path=/; HttpOnly'] },
      }),
    );
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${TOKEN_BASE}/`, { headers: { cookie } });
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
    const res = await app.request(`${TOKEN_BASE}/`, { headers: { cookie } });
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
    const res = await app.request(`${TOKEN_BASE}/`, { headers: { cookie } });
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
    await app.request(`${TOKEN_BASE}/`, { headers: { cookie } });
    const [, command] = sendCommandMock.mock.calls.at(-1)!;
    expect(command.payload.scheme).toBe('https');
  });
});

describe('tunnelHttp session lifetime (#3199 Task 2)', () => {
  it('includes a refreshed cookie with fresh Max-Age on a successful authenticated proxied response', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${TOKEN_BASE}/`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const setCookieHeader = res.headers.get('set-cookie') ?? '';
    expect(setCookieHeader).toContain(`bz_tunnel_${TUNNEL_ID}=`);
    expect(setCookieHeader).toContain(`Max-Age=${HTTP_TUNNEL_COOKIE_TTL_SECONDS}`);
    expect(setCookieHeader.toLowerCase()).toContain('httponly');
    expect(setCookieHeader.toLowerCase()).toContain('samesite=none');
    expect(setCookieHeader.toLowerCase()).toContain('secure');
    expect(setCookieHeader).toContain(`Path=/api/v1/tunnel-http/${TUNNEL_ID}/`);
  });

  it('401s when the cookie has expired (regression)', async () => {
    vi.useFakeTimers();
    try {
      const app = makeApp();
      const cookie = await mintCookie(app);
      vi.setSystemTime(Date.now() + (HTTP_TUNNEL_COOKIE_TTL_SECONDS + 5) * 1000);
      const res = await app.request(`${TOKEN_BASE}/`, { headers: { cookie } });
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

    const res = await app.request(`${TOKEN_BASE}/`, { headers: { cookie } });

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

    const res1 = await app.request(`${TOKEN_BASE}/`, { headers: { cookie } });
    expect(res1.status).toBe(200);
    const bumpsAfterFirst = capturedSessionUpdates.filter((u) => 'lastActivityAt' in u);
    expect(bumpsAfterFirst).toHaveLength(1);
    const bumpedAt = bumpsAfterFirst[0]!.lastActivityAt as Date;

    // Simulate the DB now reflecting the just-persisted lastActivityAt (<30s old).
    setJoinRow(defaultJoinRow({ lastActivityAt: bumpedAt }));
    const res2 = await app.request(`${TOKEN_BASE}/`, { headers: { cookie } });
    expect(res2.status).toBe(200);
    const bumpsAfterSecond = capturedSessionUpdates.filter((u) => 'lastActivityAt' in u);
    expect(bumpsAfterSecond).toHaveLength(1); // still just the one from before
  });

  it('does not bump lastActivityAt or refresh the cookie when a gate rejects the request', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    capturedSessionUpdates = []; // drop the mint's own status:'active' write
    setJoinRow(defaultJoinRow({ deviceStatus: 'offline', lastActivityAt: null }));

    const res = await app.request(`${TOKEN_BASE}/`, { headers: { cookie } });

    expect(res.status).toBe(502);
    expect(capturedSessionUpdates).toHaveLength(0);
    expect(res.headers.get('set-cookie')).toBeFalsy();
  });
});

it('rewrites CSS responses using the session target and proxy base', async () => {
  sendCommandMock.mockResolvedValue(okAgentResult({
    headers: { 'content-type': ['text/css; charset=utf-8'] },
    bodyB64: Buffer.from('@import "/theme.css"; a{background:url(http://192.168.1.50/image.png)}').toString('base64'),
  }));
  const app = makeApp();
  const cookie = await mintCookie(app);
  const res = await app.request(`${TOKEN_BASE}/style.css`, { headers: { cookie } });
  expect(await res.text()).toBe(`@import "${TOKEN_BASE}/theme.css"; a{background:url(${TOKEN_BASE}/image.png)}`);
});


it('does not forward browser compression negotiation to the agent', async () => {
  const app = makeApp();
  const cookie = await mintCookie(app);
  await app.request(`${TOKEN_BASE}/`, { headers: { cookie, 'accept-encoding': 'gzip, deflate, br' } });
  const [, command] = sendCommandMock.mock.calls.at(-1)!;
  expect(command.payload.headers).not.toHaveProperty('accept-encoding');
});

const upstreamEncodings = [
  ['gzip', gzipSync],
  ['deflate', deflateSync],
  ['br', brotliCompressSync],
  ['GZip, br', (body: Buffer) => brotliCompressSync(gzipSync(body))],
  ['identity', (body: Buffer) => body],
] as const;

it.each(upstreamEncodings)('decodes %s HTML before rewriting and fixes response headers', async (encoding, compress) => {
  const compressed = compress(Buffer.from('<html><head><title>Prínter</title></head><body><img src="/logo.png"></body></html>'));
  sendCommandMock.mockResolvedValue(okAgentResult({
    headers: { 'Content-Type': ['text/html'], 'Content-Encoding': [encoding], 'Content-Length': [String(compressed.length)] },
    bodyB64: compressed.toString('base64'),
  }));
  const app = makeApp();
  const cookie = await mintCookie(app);
  const res = await app.request(`${TOKEN_BASE}/`, { headers: { cookie } });
  const body = await res.text();
  expect(res.status).toBe(200);
  expect(body).toContain('<title>Prínter</title>');
  expect(body).toContain(`src="${TOKEN_BASE}/logo.png"`);
  expect(body.match(/<script data-breeze-tunnel-rewrite>/g)).toHaveLength(1);
  expect(res.headers.get('content-encoding')).toBeNull();
  expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(body)));
});

it('decodes compressed CSS before rewriting', async () => {
  const compressed = gzipSync(Buffer.from('a{background:url(/logo.png)}'));
  sendCommandMock.mockResolvedValue(okAgentResult({
    headers: { 'content-type': ['text/css'], 'content-encoding': ['gzip'] },
    bodyB64: compressed.toString('base64'),
  }));
  const app = makeApp();
  const cookie = await mintCookie(app);
  const res = await app.request(`${TOKEN_BASE}/style.css`, { headers: { cookie } });
  const body = await res.text();
  expect(body).toBe(`a{background:url(${TOKEN_BASE}/logo.png)}`);
  expect(res.headers.get('content-encoding')).toBeNull();
  expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(body)));
});

it.each(['unknown', 'unknown, gzip'])('passes %s encoding through byte-identically without injecting a shim', async (encoding) => {
  const original = Buffer.concat([Buffer.from([0xff, 0x00, 0x80]), Buffer.from('<head></head><img src="/logo.png">')]);
  const body = encoding.includes('gzip') ? gzipSync(original) : original;
  sendCommandMock.mockResolvedValue(okAgentResult({
    headers: { 'content-type': ['text/html'], 'content-encoding': [encoding] },
    bodyB64: body.toString('base64'),
  }));
  const app = makeApp();
  const cookie = await mintCookie(app);
  const res = await app.request(`${TOKEN_BASE}/`, { headers: { cookie } });
  const received = Buffer.from(await res.arrayBuffer());
  expect(res.status).toBe(200);
  expect(received).toEqual(body);
  expect(received.toString()).not.toContain('data-breeze-tunnel-rewrite');
  expect(res.headers.get('content-encoding')).toBe(encoding);
});

// -------------------------------------------------------------------------
// Response size bound on decompression (compression-bomb guard).
// -------------------------------------------------------------------------
describe('tunnelHttp decompression bound', () => {
  it('returns 502 instead of decoding past the output-size ceiling', async () => {
    // A few KB of gzip-of-zeros expands to tens of MB — cheap to produce,
    // and the point of the bound is exactly that decoding it must fail fast
    // rather than actually allocate the decoded size.
    const bomb = gzipSync(Buffer.alloc(40 * 1024 * 1024)); // decodes to 40 MiB
    sendCommandMock.mockResolvedValue(okAgentResult({
      headers: { 'content-type': ['text/html'], 'content-encoding': ['gzip'] },
      bodyB64: bomb.toString('base64'),
    }));
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${TOKEN_BASE}/`, { headers: { cookie } });
    expect(res.status).toBe(502);
  });

  it('still rejects genuinely malformed upstream encoding with 502', async () => {
    sendCommandMock.mockResolvedValue(okAgentResult({
      headers: { 'content-type': ['text/html'], 'content-encoding': ['gzip'] },
      bodyB64: Buffer.from('not actually gzip').toString('base64'),
    }));
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${TOKEN_BASE}/`, { headers: { cookie } });
    expect(res.status).toBe(502);
  });
});

// -------------------------------------------------------------------------
// Cross-site request admission on state-changing methods, and the per-
// request path token that closes the residual Origin:null gap a pure
// Origin check leaves open (a same-shaped sandboxed iframe/`srcdoc` form
// POST also presents Origin:null, indistinguishable from this route's own
// legitimate sandboxed subresource traffic by Origin alone).
// -------------------------------------------------------------------------
describe('tunnelHttp cross-site request admission', () => {
  it('refuses a cross-site POST carrying a real foreign Origin', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${TOKEN_BASE}/submit`, {
      method: 'POST',
      headers: { cookie, origin: 'https://other-origin.example' },
      body: 'x=1',
    });
    expect(res.status).toBe(403);
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it('refuses a cross-site PUT carrying a real foreign Origin', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${TOKEN_BASE}/submit`, {
      method: 'PUT',
      headers: { cookie, origin: 'https://other-origin.example' },
      body: 'x=1',
    });
    expect(res.status).toBe(403);
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it('allows a same-site POST with no Origin header (the common legitimate case)', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${TOKEN_BASE}/submit`, {
      method: 'POST',
      headers: { cookie },
      body: 'x=1',
    });
    expect(res.status).toBe(200);
  });

  it('allows a POST with Origin:null (the sandboxed document\'s own opaque-origin traffic) IF it also carries the correct path token', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${TOKEN_BASE}/submit`, {
      method: 'POST',
      headers: { cookie, origin: 'null' },
      body: 'x=1',
    });
    expect(res.status).toBe(200);
  });

  it('allows a cross-site GET (read-only, exempt by method)', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${TOKEN_BASE}/`, {
      headers: { cookie, origin: 'https://other-origin.example' },
    });
    expect(res.status).toBe(200);
  });

  it('refuses an Origin:null POST to a tunnel id with the correct cookie but a wrong/absent path token', async () => {
    // A sandboxed-iframe/srcdoc form POST looks the same as legitimate
    // traffic to the Origin check: same method, same Origin:null, same cookie
    // behavior (SameSite=None sends it cross-site too). The per-(tunnel,user)
    // path token is only delivered to the browser that completed the ticket
    // exchange, via the redirect Location and every rewritten in-document
    // URL. A request without the right token (128 bits) is refused here.
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${BASE}/wrong-token-segment/submit`, {
      method: 'POST',
      headers: { cookie, origin: 'null' },
      body: 'x=1',
    });
    expect(res.status).toBe(404);
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it('refuses cookie-authenticated traffic at the bare tunnel root (no path token segment at all)', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${BASE}/`, { headers: { cookie } });
    expect(res.status).toBe(404);
    expect(sendCommandMock).not.toHaveBeenCalled();
  });
});

describe('tunnelHttp error responses carry protective headers', () => {
  // The global app-wide CSP/X-Frame-Options middleware is exempted for the
  // whole tunnel-http path prefix (see index.ts), because this route's own
  // sandboxed CSP must win on the successful proxied-content response. That
  // exemption must not leave the route's *error* responses (401/403/404/etc)
  // with no framing protection at all — every response this route returns
  // needs to carry at least a restrictive frame-ancestors, not only the 200
  // path where PROXY_RESPONSE_CSP is set explicitly.
  it('sets a restrictive content-security-policy on a 401 (no ticket, no cookie)', async () => {
    const app = makeApp();
    const res = await app.request(`${BASE}/`);
    expect(res.status).toBe(401);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-ancestors 'self'");
  });

  it('sets a restrictive content-security-policy on a 403 (cross-site denial)', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${TOKEN_BASE}/`, {
      method: 'POST',
      headers: { cookie, origin: 'https://other-origin.example' },
    });
    expect(res.status).toBe(403);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-ancestors 'self'");
  });

  it('sets a restrictive content-security-policy on a 404 (bare tunnel root, no path token)', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${BASE}/`, { headers: { cookie } });
    expect(res.status).toBe(404);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-ancestors 'self'");
  });
});

describe('tunnelHttp path-token auth (no cookie — opaque-origin subresources)', () => {
  // Firefox does not attach the SameSite=None tunnel cookie to subresource
  // requests issued from the sandboxed (opaque-origin) proxied document, so a
  // device page's own CSS/JS arrives cookie-less. The per-(tunnel,user) path
  // token alone must authenticate it, bounded by the same idle window the
  // sliding cookie enforces.
  const recent = () => new Date(Date.now() - 10_000);

  it('serves a cookie-less request carrying the owner\'s path token on a recently active session', async () => {
    setJoinRow(defaultJoinRow({ lastActivityAt: recent() }));
    const app = makeApp();
    const res = await app.request(`${TOKEN_BASE}/static/js/login.js`);
    expect(res.status).toBe(200);
    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    expect(sendCommandMock.mock.calls[0]![1].payload.path).toBe('/static/js/login.js');
  });

  it('falls back to startedAt when the session has no lastActivityAt yet', async () => {
    setJoinRow(defaultJoinRow({ startedAt: recent(), lastActivityAt: null }));
    const app = makeApp();
    const res = await app.request(`${TOKEN_BASE}/`);
    expect(res.status).toBe(200);
  });

  it('accepts a cookie-less Origin:null POST with the path token (sandboxed form submit)', async () => {
    setJoinRow(defaultJoinRow({ lastActivityAt: recent() }));
    const app = makeApp();
    const res = await app.request(`${TOKEN_BASE}/login`, {
      method: 'POST',
      headers: { origin: 'null' },
      body: 'x=1',
    });
    expect(res.status).toBe(200);
  });

  it('401s a cookie-less request once the session has been idle past the cookie TTL', async () => {
    setJoinRow(defaultJoinRow({
      startedAt: new Date(Date.now() - 3_600_000),
      lastActivityAt: new Date(Date.now() - (HTTP_TUNNEL_COOKIE_TTL_SECONDS + 5) * 1000),
    }));
    const app = makeApp();
    const res = await app.request(`${TOKEN_BASE}/`);
    expect(res.status).toBe(401);
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it('401s a cookie-less request on a session that was never started', async () => {
    setJoinRow(defaultJoinRow({ startedAt: null, lastActivityAt: null }));
    const app = makeApp();
    const res = await app.request(`${TOKEN_BASE}/`);
    expect(res.status).toBe(401);
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it('401s a cookie-less request with a wrong path token', async () => {
    setJoinRow(defaultJoinRow({ lastActivityAt: recent() }));
    const app = makeApp();
    const res = await app.request(`${BASE}/${'0'.repeat(32)}/`);
    expect(res.status).toBe(401);
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it('401s a cookie-less request whose token belongs to a user who does not own the session', async () => {
    setJoinRow(defaultJoinRow({ ownerId: 'someone-else', lastActivityAt: recent() }));
    const app = makeApp();
    const res = await app.request(`${TOKEN_BASE}/`);
    expect(res.status).toBe(401);
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it('401s a cookie-less request on a terminal session', async () => {
    setJoinRow(defaultJoinRow({ status: 'disconnected', lastActivityAt: recent() }));
    const app = makeApp();
    const res = await app.request(`${TOKEN_BASE}/`);
    expect(res.status).toBe(401);
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it('still runs the live-authority gate on a path-token request', async () => {
    setJoinRow(defaultJoinRow({ lastActivityAt: recent() }));
    authorizeContinuationMock.mockResolvedValueOnce({ ok: false, status: 403, reason: 'permission_denied' });
    const app = makeApp();
    const res = await app.request(`${TOKEN_BASE}/`);
    expect(res.status).toBe(403);
    expect(sendCommandMock).not.toHaveBeenCalled();
  });
});

describe('tunnelHttp Referrer-Policy (path token must not leak via Referer)', () => {
  it('sets no-referrer on a proxied 200', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${TOKEN_BASE}/`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('overrides a device-supplied Referrer-Policy', async () => {
    sendCommandMock.mockResolvedValueOnce(okAgentResult({
      headers: { 'content-type': ['text/html'], 'referrer-policy': ['unsafe-url'] },
    }));
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${TOKEN_BASE}/`, { headers: { cookie } });
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('sets no-referrer on the ticket redirect and on error responses', async () => {
    const app = makeApp();
    consumeWsTicketMock.mockResolvedValueOnce({
      ok: true, sessionId: TUNNEL_ID, sessionType: 'tunnel-http', userId: USER_ID, expiresAt: Date.now() + 60_000,
    });
    const redirect = await app.request(`${BASE}/?__bzt=goodticket`);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('referrer-policy')).toBe('no-referrer');
    const denied = await app.request(`${BASE}/`);
    expect(denied.status).toBe(401);
    expect(denied.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

describe('tunnelHttp sandboxed-origin CORS (Origin: null)', () => {
  // Requests from the sandboxed document are cross-origin (opaque origin), so
  // CORS-mode loads (`crossorigin` tags, fetch, XHR) need the response to
  // admit Origin:null or the browser hides it from the page.
  it('admits Origin:null on a proxied response, with credentials', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${TOKEN_BASE}/api/status`, { headers: { cookie, origin: 'null' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('null');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('vary')?.toLowerCase()).toContain('origin');
  });

  it('does not emit CORS headers for a real foreign origin or a same-origin request', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    for (const headers of [{ cookie, origin: 'https://other-origin.example' }, { cookie }] as Record<string, string>[]) {
      const res = await app.request(`${TOKEN_BASE}/`, { headers });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('drops a device-supplied CORS grant', async () => {
    sendCommandMock.mockResolvedValueOnce(okAgentResult({
      headers: { 'content-type': ['text/plain'], 'access-control-allow-origin': ['*'] },
    }));
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${TOKEN_BASE}/`, { headers: { cookie } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers a cookie-less Origin:null preflight locally (204) without contacting the agent', async () => {
    setJoinRow(defaultJoinRow({ lastActivityAt: new Date() }));
    const app = makeApp();
    const res = await app.request(`${TOKEN_BASE}/api/sonicos/auth`, {
      method: 'OPTIONS',
      headers: {
        origin: 'null',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-requested-with',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('null');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toBe('content-type,x-requested-with');
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it('refuses a preflight without a valid path token', async () => {
    setJoinRow(defaultJoinRow({ lastActivityAt: new Date() }));
    const app = makeApp();
    const res = await app.request(`${BASE}/${'0'.repeat(32)}/api`, {
      method: 'OPTIONS',
      headers: { origin: 'null', 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('tunnelHttp device cookies + caching under cookie partitioning', () => {
  it('forces SameSite=None; Secure on device cookies so the sandbox can send them back', async () => {
    sendCommandMock.mockResolvedValueOnce(okAgentResult({
      headers: { 'content-type': ['text/plain'], 'set-cookie': ['sid=abc; Path=/; HttpOnly; SameSite=Strict'] },
    }));
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${TOKEN_BASE}/`, { headers: { cookie } });
    const deviceCookie = res.headers.getSetCookie().find((v) => v.startsWith('bzdev_sid='))!;
    expect(deviceCookie).toBeDefined();
    expect(deviceCookie).toMatch(/;\s*SameSite=None/i);
    expect(deviceCookie).not.toMatch(/SameSite=Strict/i);
    expect(deviceCookie).toMatch(/;\s*Secure/i);
    expect(deviceCookie).toMatch(/HttpOnly/i);
  });

  it('marks proxied responses private so no shared cache stores token-addressed content', async () => {
    sendCommandMock.mockResolvedValueOnce(okAgentResult({
      headers: { 'content-type': ['text/javascript'], 'cache-control': ['public, max-age=31536000, s-maxage=600'] },
    }));
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${TOKEN_BASE}/app.js`, { headers: { cookie } });
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toMatch(/\bprivate\b/);
    expect(cc).toContain('max-age=31536000');
    expect(cc).not.toMatch(/\bpublic\b|s-maxage/);
  });

  it('marks a response private when the device sent no cache-control', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${TOKEN_BASE}/`, { headers: { cookie } });
    expect(res.headers.get('cache-control')).toBe('private');
  });
});

it('401s a cookie-less request for a non-UUID tunnel id without querying the session', async () => {
  const { db } = await import('../db');
  const app = makeApp();
  const res = await app.request(`/api/v1/tunnel-http/not-a-uuid/${'a'.repeat(32)}/`);
  expect(res.status).toBe(401);
  expect(db.select).not.toHaveBeenCalled();
});
