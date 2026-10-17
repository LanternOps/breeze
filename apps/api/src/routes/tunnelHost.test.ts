import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TUNNEL_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER_TUNNEL = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const DEVICE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOST = `${TUNNEL_ID}.us.breezetunnel.test`;
const ORIGIN = `https://${HOST}`;
const ANCESTOR = 'https://us.breeze-app.test';

let joinRow: any;
let activationRows: Array<{ id: string }> = [{ id: TUNNEL_ID }];
let capturedUpdates: Record<string, unknown>[] = [];

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ innerJoin: vi.fn(() => ({ where: vi.fn(() => ({
      limit: vi.fn(async () => (joinRow ? [joinRow] : [])),
    })) })) })) })),
    update: vi.fn(() => ({ set: vi.fn((v: Record<string, unknown>) => {
      capturedUpdates.push(v);
      return { where: vi.fn(() => Object.assign(Promise.resolve(undefined), { returning: vi.fn(async () => activationRows) })) };
    }) })),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
}));
vi.mock('../db/schema', () => ({
  tunnelSessions: { id: 'tunnelSessions.id', deviceId: 'tunnelSessions.deviceId', status: 'tunnelSessions.status' },
  devices: { id: 'devices.id' },
}));
const { consumeWsTicketMock } = vi.hoisted(() => ({ consumeWsTicketMock: vi.fn() }));
vi.mock('../services/remoteSessionAuth', () => ({ consumeWsTicket: consumeWsTicketMock }));
vi.mock('./agentWs', () => ({ isAgentConnected: vi.fn(() => true) }));
const { sendCommandMock } = vi.hoisted(() => ({ sendCommandMock: vi.fn() }));
vi.mock('../services/agentCommandAwait', () => ({ sendCommandToAgentAwaitResult: sendCommandMock }));
vi.mock('../services/remoteAccessPolicy', () => ({ checkRemoteAccess: vi.fn(async () => ({ allowed: true })) }));
const { authorizeContinuationMock } = vi.hoisted(() => ({ authorizeContinuationMock: vi.fn() }));
vi.mock('../services/remoteWsAuthorization', () => ({ authorizeRemoteSessionContinuation: authorizeContinuationMock }));
vi.mock('../services/clientIp', () => ({ getTrustedClientIp: vi.fn(() => '203.0.113.7'), trustsForwardedHeadersFrom: vi.fn(() => false) }));
vi.mock('../services/tunnelAllowlist', () => ({ getActiveAllowlistPatterns: vi.fn(async () => ['192.168.1.0/24']) }));
const { optInMock } = vi.hoisted(() => ({ optInMock: vi.fn(async () => true) }));
vi.mock('../services/tunnelOriginOptIn', () => ({ isTunnelOriginEnabledForOrg: optInMock }));
const { rateMock, slotMock, releaseMock } = vi.hoisted(() => {
  const releaseMock = vi.fn();
  return {
    releaseMock,
    rateMock: vi.fn(async (): Promise<unknown> => ({ ok: true })),
    slotMock: vi.fn((): unknown => ({ ok: true, release: releaseMock })),
  };
});
vi.mock('../services/tunnelHttpBudget', () => ({ checkTunnelHttpRate: rateMock, acquireTunnelHttpSlot: slotMock }));
const { metricMock } = vi.hoisted(() => ({ metricMock: vi.fn() }));
vi.mock('../services/tunnelHttpMetrics', () => ({ recordTunnelHttpOutcome: metricMock }));

import { TUNNEL_COOKIE_BLOCKED_MESSAGE_TYPE, tunnelHostRoutes } from './tunnelHost';
import { __resetTunnelOriginConfigForTests } from '../config/tunnelOrigin';
import { HOST_COOKIE_AUDIENCE, signTunnelCookie } from './tunnelHttpCore';

function row(status = 'active') {
  return {
    session: { userId: USER_ID, status, orgId: ORG_ID, type: 'proxy', targetHost: '192.168.1.50', targetPort: 80,
      scheme: 'http', skipTlsVerify: false, createdAt: new Date(), startedAt: null, lastActivityAt: null },
    device: { id: DEVICE_ID, siteId: null, status: 'online', agentId: AGENT_ID },
  };
}
function agentOk(over: Partial<{ status: number; headers: Record<string, string[]>; body: string }> = {}) {
  return { status: 'completed', stdout: JSON.stringify({
    status: over.status ?? 200, headers: over.headers ?? { 'content-type': ['text/plain'] },
    bodyB64: Buffer.from(over.body ?? 'device-ok').toString('base64'),
  }) };
}
const req = (path: string, init: RequestInit & { host?: string } = {}) => {
  const headers = new Headers(init.headers);
  headers.set('host', init.host ?? HOST);
  return tunnelHostRoutes.request(`http://${init.host ?? HOST}${path}`, { ...init, headers });
};
const sameOrigin = (cookie: string, extra: Record<string, string> = {}) => ({ headers: { cookie, 'sec-fetch-site': 'same-origin', ...extra } });
function ticketOk(sessionId = TUNNEL_ID, sessionType = 'tunnel-http') {
  consumeWsTicketMock.mockResolvedValueOnce({ ok: true, sessionId, sessionType, userId: USER_ID, expiresAt: Date.now() + 60_000 });
}
async function enter(context: 'frame' | 'tab' = 'frame'): Promise<string> {
  ticketOk();
  const res = await req(`/__bz/enter?t=TKT${context === 'tab' ? '&mode=tab' : ''}`, { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': context === 'tab' ? 'document' : 'iframe' } });
  expect(res.status).toBe(200);
  const cookie = res.headers.get('set-cookie') ?? '';
  const m = cookie.match(/(__Host-bzt(?:-top)?=[^;]+)/);
  if (!m) throw new Error(`no proxy cookie in ${cookie}`);
  return m[1]!;
}
function expectBaseHeaders(res: Response, ancestor: string | null = ANCESTOR) {
  expect(res.headers.get('content-security-policy')).toBe(ancestor ? `frame-ancestors ${ancestor} 'self'` : "frame-ancestors 'none'");
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TUNNEL_ORIGIN_TEMPLATE = 'https://{id}.us.breezetunnel.test';
  process.env.TUNNEL_FRAME_ANCESTOR = ANCESTOR;
  __resetTunnelOriginConfigForTests();
  joinRow = row();
  activationRows = [{ id: TUNNEL_ID }];
  capturedUpdates = [];
  authorizeContinuationMock.mockResolvedValue({ ok: true, context: {} });
  sendCommandMock.mockResolvedValue(agentOk());
  optInMock.mockResolvedValue(true);
  rateMock.mockResolvedValue({ ok: true });
  slotMock.mockReturnValue({ ok: true, release: releaseMock });
});
afterEach(() => {
  delete process.env.TUNNEL_ORIGIN_TEMPLATE;
  delete process.env.TUNNEL_FRAME_ANCESTOR;
  __resetTunnelOriginConfigForTests();
});

describe('/__bz/enter', () => {
  it('returns a bootstrap page (never a redirect) that sets a partitioned __Host-bzt cookie', async () => {
    ticketOk();
    const res = await req('/__bz/enter?t=TKT', { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'iframe' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^__Host-bzt=/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=None/);
    expect(cookie).toMatch(/Partitioned/);
    expect(cookie).toMatch(/Max-Age=300/);
    expect(cookie).not.toMatch(/Domain=/i);
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain(`frame-ancestors ${ANCESTOR} 'self'`);
    expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+'/);
    expect(csp).toContain("default-src 'none'");
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await res.text();
    const nonce = csp.match(/'nonce-([^']+)'/)![1]!;
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain("fetch('/__bz/ping'");
    expect(html).toContain(TUNNEL_COOKIE_BLOCKED_MESSAGE_TYPE);
    expect(TUNNEL_COOKIE_BLOCKED_MESSAGE_TYPE).toBe('breeze-tunnel-cookie-blocked');
    // amended 2026-10-12b, item 1: the page probes web storage, not just the cookie
    expect(html).toContain('localStorage.setItem(');
    expect(html).toContain("blocked('storage')");
    expect(html).toContain("blocked('cookie')");
    expect(html).toContain("location.replace('/')");
    expect(html).toContain(JSON.stringify(ANCESTOR));
    expect(html).not.toContain('TKT');
    expect(capturedUpdates).toContainEqual(expect.objectContaining({ status: 'active' }));
    expect(metricMock).not.toHaveBeenCalledWith('host', 'auth_failed');
  });

  it('sets an unpartitioned SameSite=Lax __Host-bzt-top for mode=tab', async () => {
    ticketOk();
    const res = await req('/__bz/enter?t=TKT&mode=tab', { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'document' } });
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^__Host-bzt-top=/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).not.toMatch(/Partitioned/);
  });

  it('refuses a ticket minted for another tunnel, a non-http ticket, a missing ticket and a bad mode', async () => {
    ticketOk(OTHER_TUNNEL);
    expect((await req('/__bz/enter?t=TKT')).status).toBe(401);
    ticketOk(TUNNEL_ID, 'tunnel');
    expect((await req('/__bz/enter?t=TKT')).status).toBe(401);
    consumeWsTicketMock.mockResolvedValueOnce({ ok: false, reason: 'expired' });
    expect((await req('/__bz/enter?t=TKT')).status).toBe(401);
    expect((await req('/__bz/enter')).status).toBe(401);
    expect((await req('/__bz/enter?t=TKT&mode=popup')).status).toBe(401);
    // A bad mode is refused before the one-time ticket is spent.
    expect(consumeWsTicketMock).toHaveBeenCalledTimes(3);
    expect(metricMock).toHaveBeenCalledWith('host', 'auth_failed');
  });

  it('does not reopen a closed session (exchange after or racing Close)', async () => {
    joinRow = row('disconnected');
    ticketOk();
    const closed = await req('/__bz/enter?t=TKT');
    expect(closed.status).toBe(404);
    expect(closed.headers.get('set-cookie')).toBeNull();

    joinRow = row('active');
    activationRows = [];
    ticketOk();
    const raced = await req('/__bz/enter?t=TKT');
    expect(raced.status).toBe(404);
    expect(raced.headers.get('set-cookie')).toBeNull();
  });

  it('fails closed on revoked live authority before minting a cookie', async () => {
    authorizeContinuationMock.mockResolvedValueOnce({ ok: false, status: 403, reason: 'permission_denied' });
    ticketOk();
    const res = await req('/__bz/enter?t=TKT');
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(capturedUpdates).toEqual([]);
  });

  it('re-checks the partner opt-in after consuming the ticket and mints nothing when it is off (amendment 3)', async () => {
    optInMock.mockResolvedValueOnce(false);
    ticketOk();
    const res = await req('/__bz/enter?t=TKT', { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'iframe' } });
    expect(res.status).toBe(404);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(consumeWsTicketMock).toHaveBeenCalledTimes(1);
    // Keyed by the verified session row's org, never by request input.
    expect(optInMock).toHaveBeenCalledWith(ORG_ID);
    // Refused before the conditional activation: the row is not flipped to active.
    expect(capturedUpdates).toEqual([]);
    expectBaseHeaders(res);
  });

  it('refuses a subresource or non-GET request to /__bz/enter before spending the ticket', async () => {
    expect((await req('/__bz/enter?t=TKT', { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'image' } })).status).toBe(403);
    expect((await req('/__bz/enter?t=TKT', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect(consumeWsTicketMock).not.toHaveBeenCalled();
  });
});

describe('/__bz/ping and reserved paths', () => {
  it('204s with a valid cookie, 401s without', async () => {
    const cookie = await enter();
    expect((await req('/__bz/ping', sameOrigin(cookie))).status).toBe(204);
    const denied = await req('/__bz/ping', { headers: { 'sec-fetch-site': 'same-origin' } });
    expect(denied.status).toBe(401);
    expectBaseHeaders(denied);
  });

  it('never forwards /__bz/* (plain, cased, percent-encoded or dot-segment) to the device', async () => {
    const cookie = await enter();
    for (const p of ['/__bz/other', '/__bz', '/__BZ/ping', '/%5F%5Fbz/enter?t=x', '/%5f%5fBZ/x', '/a/..%2F__bz/x', '/%255F%255Fbz/x', '/%E0%A4%A']) {
      const res = await req(p, sameOrigin(cookie));
      expect(res.status, p).toBe(404);
    }
    expect(sendCommandMock).not.toHaveBeenCalled();
  });
});

describe('proxied requests', () => {
  it('runs every gate, forwards the unmodified device path, and refreshes the cookie', async () => {
    const cookie = await enter();
    const res = await req('/cgi-bin/status.cgi?x=1', sameOrigin(cookie, { authorization: 'Bearer app', referer: `${ORIGIN}/a` }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('device-ok');
    const payload = sendCommandMock.mock.calls[0]![1].payload;
    expect(payload.path).toBe('/cgi-bin/status.cgi?x=1');
    expect(payload.headers.cookie).toBeUndefined();
    expect(payload.headers.authorization).toBeUndefined();
    expect(payload.headers.referer).toBeUndefined();
    expect(sendCommandMock.mock.calls[0]![0]).toBe(AGENT_ID);
    expect(res.headers.get('set-cookie')).toMatch(/^__Host-bzt=.*Partitioned/);
    expectBaseHeaders(res);
    expect(authorizeContinuationMock).toHaveBeenCalledWith(expect.objectContaining({ sessionId: TUNNEL_ID, userId: USER_ID }), expect.any(Array));
  });

  it('forwards device cookies and a same-tunnel Origin rewritten to the device origin', async () => {
    const cookie = await enter();
    await req('/save', { method: 'POST', body: 'a=1', headers: { cookie: `${cookie}; SID=dev; __Host-bzt-top=x`, 'sec-fetch-site': 'same-origin', origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' } });
    const payload = sendCommandMock.mock.calls[0]![1].payload;
    expect(payload.method).toBe('POST');
    expect(payload.headers.cookie).toEqual(['SID=dev']);
    expect(payload.headers.origin).toEqual(['http://192.168.1.50']);
    expect(Buffer.from(payload.bodyB64, 'base64').toString()).toBe('a=1');
  });

  it('authenticates a tab with __Host-bzt-top and refreshes that cookie, with Lax device cookies', async () => {
    const cookie = await enter('tab');
    sendCommandMock.mockResolvedValueOnce(agentOk({ headers: { 'content-type': ['text/plain'], 'set-cookie': ['SID=1; Path=/'] } }));
    const res = await req('/', sameOrigin(cookie));
    expect(res.status).toBe(200);
    const all = res.headers.getSetCookie();
    expect(all).toContain('SID=1; Path=/; Secure; SameSite=Lax');
    expect(all.some((c) => c.startsWith('__Host-bzt-top=') && /SameSite=Lax/.test(c) && !/Partitioned/.test(c))).toBe(true);
  });

  it('binds the cookie to its context: a frame token under the tab name (or vice versa) is refused', async () => {
    const frameToken = await signTunnelCookie(USER_ID, TUNNEL_ID, { audience: HOST_COOKIE_AUDIENCE, context: 'frame' });
    expect((await req('/', sameOrigin(`__Host-bzt-top=${frameToken}`))).status).toBe(401);
    const tabToken = await signTunnelCookie(USER_ID, TUNNEL_ID, { audience: HOST_COOKIE_AUDIENCE, context: 'tab' });
    expect((await req('/', sameOrigin(`__Host-bzt=${tabToken}`))).status).toBe(401);
    const pathModeToken = await signTunnelCookie(USER_ID, TUNNEL_ID);
    expect((await req('/', sameOrigin(`__Host-bzt=${pathModeToken}`))).status).toBe(401);
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it('rejects a cookie minted for tunnel A on tunnel B’s host', async () => {
    const cookie = await enter();
    const res = await req('/', { host: `${OTHER_TUNNEL}.us.breezetunnel.test`, ...sameOrigin(cookie) });
    expect(res.status).toBe(401);
  });

  it('refuses a cross-tunnel request before auth or dispatch (GET included)', async () => {
    const cookie = await enter();
    const res = await req('/reboot', { headers: { cookie, 'sec-fetch-site': 'same-site' } });
    expect(res.status).toBe(403);
    expectBaseHeaders(res);
    const sibling = await req('/reboot', { method: 'POST', headers: { cookie, origin: `https://${OTHER_TUNNEL}.us.breezetunnel.test` } });
    expect(sibling.status).toBe(403);
    const noOrigin = await req('/reboot', { method: 'POST', headers: { cookie } });
    expect(noOrigin.status).toBe(403);
    expect(sendCommandMock).not.toHaveBeenCalled();
    expect(metricMock).toHaveBeenCalledWith('host', 'admission_refused');
  });

  it('404s a service-worker script fetch', async () => {
    const cookie = await enter();
    expect((await req('/sw.js', sameOrigin(cookie, { 'service-worker': 'script' }))).status).toBe(404);
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it('applies the 12h cap, device-offline and policy gates exactly like path mode', async () => {
    const cookie = await enter();
    joinRow = { ...row(), session: { ...row().session, createdAt: new Date(Date.now() - 13 * 3600_000) } };
    expect((await req('/', sameOrigin(cookie))).status).toBe(410);
    joinRow = { ...row(), device: { ...row().device, status: 'offline' } };
    expect((await req('/', sameOrigin(cookie))).status).toBe(502);
    joinRow = row('disconnected');
    expect((await req('/', sameOrigin(cookie))).status).toBe(404);
    joinRow = { ...row(), session: { ...row().session, userId: '22222222-2222-4222-8222-222222222222' } };
    expect((await req('/', sameOrigin(cookie))).status).toBe(404);
    const { checkRemoteAccess } = await import('../services/remoteAccessPolicy');
    joinRow = row();
    vi.mocked(checkRemoteAccess).mockResolvedValueOnce({ allowed: false, reason: 'Proxy disabled' } as never);
    expect((await req('/', sameOrigin(cookie))).status).toBe(403);
    authorizeContinuationMock.mockResolvedValueOnce({ ok: false, status: 403, reason: 'permission_denied' });
    expect((await req('/', sameOrigin(cookie))).status).toBe(403);
    expect(sendCommandMock).not.toHaveBeenCalled();
    expect(metricMock).toHaveBeenCalledWith('host', 'gate_denied');
  });

  it('refuses at dispatch when the row was closed after the gates (replica-safe Close)', async () => {
    const cookie = await enter();
    const { getActiveAllowlistPatterns } = await import('../services/tunnelAllowlist');
    vi.mocked(getActiveAllowlistPatterns).mockImplementationOnce(async () => {
      joinRow = row('disconnected');
      return ['192.168.1.0/24'];
    });
    const res = await req('/', sameOrigin(cookie));
    expect(res.status).toBe(502);
    expect(await res.text()).toBe('Tunnel closed');
    expect(sendCommandMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('drops a device Set-Cookie for the reserved names and rewrites device cookies', async () => {
    const cookie = await enter();
    sendCommandMock.mockResolvedValueOnce(agentOk({ headers: { 'content-type': ['text/plain'], 'set-cookie': ['__Host-bzt=evil; Path=/', '__HOST-BZT-TOP=evil', 'SID=1; Domain=192.168.1.50; Path=/', '__Host-dev=1; Path=/'] } }));
    const res = await req('/', sameOrigin(cookie));
    const all = res.headers.getSetCookie();
    expect(all.some((c) => /evil/.test(c))).toBe(false);
    expect(all).toContain('SID=1; Path=/; Secure; SameSite=None; Partitioned');
    expect(all).toContain('__Host-dev=1; Path=/; Secure; SameSite=None; Partitioned');
  });

  it('strips device CORS/CSP/XFO/cache/SW headers and maps a device-origin Location', async () => {
    const cookie = await enter();
    sendCommandMock.mockResolvedValueOnce(agentOk({ status: 302, headers: {
      location: ['http://192.168.1.50/login'], 'access-control-allow-origin': ['*'], 'content-security-policy': ['sandbox'],
      'x-frame-options': ['DENY'], 'cache-control': ['public'], 'service-worker-allowed': ['/'], 'x-request-id': ['device'],
    }, body: '' }));
    const res = await req('/', sameOrigin(cookie));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('x-frame-options')).toBeNull();
    expect(res.headers.get('service-worker-allowed')).toBeNull();
    expectBaseHeaders(res);
  });

  it('rewrites only absolute device URLs in HTML and never injects <base>', async () => {
    const cookie = await enter();
    sendCommandMock.mockResolvedValueOnce(agentOk({
      headers: { 'content-type': ['text/html'] },
      body: '<html><head></head><body><a href="http://192.168.1.50/a">x</a><a href="b">y</a></body></html>',
    }));
    const html = await (await req('/', sameOrigin(cookie))).text();
    expect(html).toContain('href="/a"');
    expect(html).toContain('href="b"');
    expect(html).not.toContain('<base');
  });

  it('passes a bodiless device status (204/304) through without a body', async () => {
    const cookie = await enter();
    sendCommandMock.mockResolvedValueOnce(agentOk({ status: 204, body: '' }));
    const res = await req('/', sameOrigin(cookie));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    sendCommandMock.mockResolvedValueOnce(agentOk({ status: 304, body: 'ignored' }));
    expect((await req('/', sameOrigin(cookie))).status).toBe(304);
  });

  it('502s an upstream status a Response cannot carry instead of throwing', async () => {
    const cookie = await enter();
    for (const status of [0, 99, 600, 101]) {
      sendCommandMock.mockResolvedValueOnce(agentOk({ status }));
      const res = await req('/', sameOrigin(cookie));
      expect(res.status, String(status)).toBe(502);
      expectBaseHeaders(res);
    }
  });

  it('an unexpected throw becomes a 500 with the host-mode headers and releases the slot', async () => {
    const cookie = await enter();
    sendCommandMock.mockRejectedValueOnce(new Error('boom'));
    const res = await req('/', sameOrigin(cookie));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('boom');
    expectBaseHeaders(res);
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(metricMock).toHaveBeenCalledWith('host', 'internal_error');
  });

  it('404s everything when host mode is off, with frame-ancestors none', async () => {
    delete process.env.TUNNEL_ORIGIN_TEMPLATE;
    __resetTunnelOriginConfigForTests();
    ticketOk();
    const res = await req('/__bz/enter?t=TKT');
    expect(res.status).toBe(404);
    expectBaseHeaders(res, null);
    expect(consumeWsTicketMock).not.toHaveBeenCalled();
  });

  it('404s a host that is not <uuid>.<suffix> on the configured port', async () => {
    for (const host of [`a.b.us.breezetunnel.test`, 'us.breezetunnel.test', `${TUNNEL_ID}.us.breezetunnel.test:8443`]) {
      expect((await req('/', { host, headers: { 'sec-fetch-site': 'same-origin' } })).status, host).toBe(404);
    }
  });
});

describe('budgets and metrics', () => {
  it('429s with Retry-After when a rate budget is exhausted, before dispatch', async () => {
    const cookie = await enter();
    rateMock.mockResolvedValueOnce({ ok: false, scope: 'tunnel', retryAfterSeconds: 17 });
    const res = await req('/', sameOrigin(cookie));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('17');
    expectBaseHeaders(res);
    expect(sendCommandMock).not.toHaveBeenCalled();
    expect(slotMock).not.toHaveBeenCalled();
    expect(metricMock).toHaveBeenCalledWith('host', 'rate_limited');
    expect(rateMock).toHaveBeenCalledWith({ userId: USER_ID, tunnelId: TUNNEL_ID, agentId: AGENT_ID });
  });

  it('429s when the concurrency budget is full and releases the slot after dispatch', async () => {
    const cookie = await enter();
    slotMock.mockReturnValueOnce({ ok: false, scope: 'agent' });
    const full = await req('/', sameOrigin(cookie));
    expect(full.status).toBe(429);
    expect(full.headers.get('retry-after')).toBe('1');
    expect(sendCommandMock).not.toHaveBeenCalled();
    await req('/', sameOrigin(cookie));
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('releases the slot when dispatch fails', async () => {
    const cookie = await enter();
    sendCommandMock.mockResolvedValueOnce({ status: 'failed', error: 'timeout waiting for agent command result' });
    const res = await req('/', sameOrigin(cookie));
    expect(res.status).toBe(504);
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(metricMock).toHaveBeenCalledWith('host', 'dispatch_failed');
  });

  it('counts admission refusals, auth failures and successes by mode', async () => {
    await req('/', { headers: { 'sec-fetch-site': 'cross-site' } });
    await req('/', { headers: { 'sec-fetch-site': 'same-origin' } });
    const cookie = await enter();
    await req('/', sameOrigin(cookie));
    expect(metricMock).toHaveBeenCalledWith('host', 'admission_refused');
    expect(metricMock).toHaveBeenCalledWith('host', 'auth_failed');
    expect(metricMock).toHaveBeenCalledWith('host', 'proxied');
    expect(metricMock.mock.calls.every((c) => c[0] === 'host')).toBe(true);
  });
});
