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
      };
      device: { id: string; status: string; agentId: string | null };
    }
  | undefined;

function setJoinRow(row: typeof joinRow) {
  joinRow = row;
}

function defaultJoinRow(over: Partial<{ port: number; deviceStatus: string; ownerId: string; status: string }> = {}) {
  return {
    session: {
      userId: over.ownerId ?? USER_ID,
      status: over.status ?? 'active',
      orgId: ORG_ID,
      type: 'proxy',
      targetHost: '192.168.1.50',
      targetPort: over.port ?? 80,
    },
    device: { id: DEVICE_ID, status: over.deviceStatus ?? 'online', agentId: AGENT_ID },
  };
}

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

// eslint-disable-next-line @typescript-eslint/no-var-requires
import { tunnelHttpRoutes } from './tunnelHttp';

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
  it('strips CSP and content-length headers', async () => {
    sendCommandMock.mockResolvedValue(
      okAgentResult({
        headers: {
          'content-type': ['text/plain'],
          'content-security-policy': ["default-src 'self'"],
          'content-length': ['5'],
        },
      }),
    );
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${BASE}/`, { headers: { cookie } });
    expect(res.headers.get('content-security-policy')).toBeNull();
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

  it('rewrites Set-Cookie Path to the proxy base', async () => {
    sendCommandMock.mockResolvedValue(
      okAgentResult({
        headers: { 'content-type': ['text/plain'], 'set-cookie': ['sid=abc; Path=/; HttpOnly'] },
      }),
    );
    const app = makeApp();
    const cookie = await mintCookie(app);
    const res = await app.request(`${BASE}/`, { headers: { cookie } });
    const sc = res.headers.get('set-cookie') ?? '';
    expect(sc).toContain(`Path=/api/v1/tunnel-http/${TUNNEL_ID}/`);
  });
});
