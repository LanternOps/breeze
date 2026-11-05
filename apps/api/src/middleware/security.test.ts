import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { securityMiddleware, _resetForceHttpsRedirectWarnStateForTests } from './security';

function createApp(options?: Parameters<typeof securityMiddleware>[0]) {
  const app = new Hono();
  app.use('*', securityMiddleware(options));
  app.get('/test', (c) => c.text('ok'));
  app.get('/health', (c) => c.text('healthy'));
  app.get('/health/live', (c) => c.text('live'));
  app.get('/health/ready', (c) => c.text('ready-probe'));
  app.get('/ready', (c) => c.text('ready'));
  return app;
}

describe('securityMiddleware', () => {
  describe('CSP header', () => {
    it('sets Content-Security-Policy on all requests', async () => {
      const app = createApp();
      const res = await app.request('/test');
      const csp = res.headers.get('Content-Security-Policy');
      expect(csp).toBeTruthy();
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("style-src 'self'");
    });

    it('allows unsafe-inline CSP when explicitly enabled', async () => {
      const app = createApp({ allowUnsafeInline: 'true' });
      const res = await app.request('/test');
      const csp = res.headers.get('Content-Security-Policy');
      expect(csp).toContain("script-src 'self' 'unsafe-inline'");
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    });

    it("sameOriginFrameWhen swaps only frame-ancestors to 'self' on matching paths (#10192)", async () => {
      const app = createApp({ cspReportUri: 'https://report.example.com/csp', sameOriginFrameWhen: (p) => p === '/test' });
      const framed = (await app.request('/test')).headers.get('Content-Security-Policy') ?? '';
      const denied = (await app.request('/health')).headers.get('Content-Security-Policy') ?? '';
      expect(framed).toContain("frame-ancestors 'self'");
      expect(framed).not.toContain("frame-ancestors 'none'");
      expect(denied).toContain("frame-ancestors 'none'");
      expect(framed.replace("frame-ancestors 'self'", "frame-ancestors 'none'")).toBe(denied);
    });

    it('includes report-uri when cspReportUri is set', async () => {
      const app = createApp({ cspReportUri: 'https://report.example.com/csp' });
      const res = await app.request('/test');
      const csp = res.headers.get('Content-Security-Policy');
      expect(csp).toContain('report-uri https://report.example.com/csp');
      expect(csp).toContain('report-to csp-endpoint');
    });

    it('omits report-uri when cspReportUri is not set', async () => {
      const app = createApp({ cspReportUri: '' });
      const res = await app.request('/test');
      const csp = res.headers.get('Content-Security-Policy');
      expect(csp).not.toContain('report-uri');
    });
  });

  describe('Report-To header', () => {
    it('sets Report-To when cspReportUri is set', async () => {
      const app = createApp({ cspReportUri: 'https://report.example.com/csp' });
      const res = await app.request('/test');
      const reportTo = res.headers.get('Report-To');
      expect(reportTo).toBeTruthy();
      const parsed = JSON.parse(reportTo!);
      expect(parsed.group).toBe('csp-endpoint');
      expect(parsed.endpoints[0].url).toBe('https://report.example.com/csp');
    });

    it('does not set Report-To when cspReportUri is not set', async () => {
      const app = createApp();
      const res = await app.request('/test');
      expect(res.headers.get('Report-To')).toBeNull();
    });
  });

  describe('Permissions-Policy header', () => {
    it('sets Permissions-Policy on all requests', async () => {
      const app = createApp();
      const res = await app.request('/test');
      const pp = res.headers.get('Permissions-Policy');
      expect(pp).toBe('camera=(), microphone=(), geolocation=()');
    });
  });

  describe('HTTPS redirect (TRANSPORT-001 — canonical scheme + Host)', () => {
    // In this test harness there is no real TCP peer (no `env.incoming.socket`),
    // so `trustsForwardedHeadersFrom` falls back to its NODE_ENV-based legacy
    // default: trusted outside production when TRUSTED_PROXY_CIDRS is unset.
    // The "spoof" case below forces production so that default flips closed,
    // matching the real deployed posture (TRUST_PROXY_HEADERS/TRUSTED_PROXY_CIDRS
    // explicitly configured).
    const PUBLIC_API_URL = 'https://api.example.com';

    it('redirects HTTP to HTTPS, built from PUBLIC_API_URL, when forceHttps is true', async () => {
      const app = createApp({ forceHttps: 'true', publicApiUrl: PUBLIC_API_URL });
      const req = new Request('http://api.example.com/test', {
        headers: { 'x-forwarded-proto': 'http', host: 'api.example.com' },
      });
      const res = await app.request(req);
      expect(res.status).toBe(308);
      expect(res.headers.get('Location')).toBe('https://api.example.com/test');
    });

    it('preserves query string in the redirect Location', async () => {
      const app = createApp({ forceHttps: 'true', publicApiUrl: PUBLIC_API_URL });
      const req = new Request('http://api.example.com/test?a=1&b=two', {
        headers: { 'x-forwarded-proto': 'http', host: 'api.example.com' },
      });
      const res = await app.request(req);
      expect(res.status).toBe(308);
      expect(res.headers.get('Location')).toBe('https://api.example.com/test?a=1&b=two');
    });

    it('does not redirect when proto is already https', async () => {
      const app = createApp({ forceHttps: 'true', publicApiUrl: PUBLIC_API_URL });
      const req = new Request('http://api.example.com/test', {
        headers: { 'x-forwarded-proto': 'https', host: 'api.example.com' },
      });
      const res = await app.request(req);
      expect(res.status).toBe(200);
    });

    it('does not redirect when forceHttps is not set', async () => {
      const app = createApp();
      const req = new Request('http://api.example.com/test', {
        headers: { 'x-forwarded-proto': 'http', host: 'api.example.com' },
      });
      const res = await app.request(req);
      expect(res.status).toBe(200);
    });

    it('does not redirect when forceHttps is true but PUBLIC_API_URL is not configured', async () => {
      const app = createApp({ forceHttps: 'true' });
      const req = new Request('http://api.example.com/test', {
        headers: { 'x-forwarded-proto': 'http', host: 'api.example.com' },
      });
      const res = await app.request(req);
      expect(res.status).toBe(200);
    });

    it('rejects an unrecognized Host with 400 instead of redirecting to it', async () => {
      const app = createApp({ forceHttps: 'true', publicApiUrl: PUBLIC_API_URL });
      const req = new Request('http://attacker.example.net/test', {
        headers: { 'x-forwarded-proto': 'http', host: 'attacker.example.net' },
      });
      const res = await app.request(req);
      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBeNull();
    });

    it('ignores a spoofed X-Forwarded-Proto: https from an untrusted peer and still redirects', async () => {
      const original = process.env.NODE_ENV;
      const originalCidrs = process.env.TRUSTED_PROXY_CIDRS;
      try {
        // Force the proxy-trust gate closed (production default) with no
        // TRUSTED_PROXY_CIDRS configured — the harness has no real socket peer,
        // so this is the deployed-equivalent "untrusted peer" posture.
        process.env.NODE_ENV = 'production';
        delete process.env.TRUSTED_PROXY_CIDRS;
        const app = createApp({ forceHttps: 'true', publicApiUrl: PUBLIC_API_URL, nodeEnv: 'production' });
        const req = new Request('http://api.example.com/test', {
          headers: { 'x-forwarded-proto': 'https', host: 'api.example.com' },
        });
        const res = await app.request(req);
        // The forwarded header is untrusted and dropped; the direct request URL
        // (http://) is the only signal left, so the redirect still fires.
        expect(res.status).toBe(308);
        expect(res.headers.get('Location')).toBe('https://api.example.com/test');
      } finally {
        if (original === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = original;
        if (originalCidrs === undefined) delete process.env.TRUSTED_PROXY_CIDRS;
        else process.env.TRUSTED_PROXY_CIDRS = originalCidrs;
      }
    });

    it('skips redirect for /health path', async () => {
      const app = createApp({ forceHttps: 'true', publicApiUrl: PUBLIC_API_URL });
      const req = new Request('http://api.example.com/health', {
        headers: { 'x-forwarded-proto': 'http', host: 'api.example.com' },
      });
      const res = await app.request(req);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('healthy');
    });

    it('skips redirect for /ready path', async () => {
      const app = createApp({ forceHttps: 'true', publicApiUrl: PUBLIC_API_URL });
      const req = new Request('http://api.example.com/ready', {
        headers: { 'x-forwarded-proto': 'http', host: 'api.example.com' },
      });
      const res = await app.request(req);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ready');
    });

    // Regression: an orchestrator/load-balancer probes /health/ready and
    // /health/live over plain HTTP with a raw IP/localhost Host (NOT the
    // canonical PUBLIC_API_URL host) and NO X-Forwarded-Proto. Under FORCE_HTTPS
    // these probe paths must pass through, never 400 for the non-canonical Host
    // (the CI smoke-test failure this covers) and never redirect.
    it.each([
      ['/health/live', 'live'],
      ['/health/ready', 'ready-probe'],
    ])('passes %s through under FORCE_HTTPS with a non-canonical Host over http', async (path, body) => {
      const app = createApp({ forceHttps: 'true', publicApiUrl: PUBLIC_API_URL });
      const req = new Request(`http://localhost:3001${path}`, {
        headers: { host: 'localhost:3001' },
      });
      const res = await app.request(req);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(body);
    });
  });

  describe('skipHeadersPathPrefix option', () => {
    // A route (the tunnel-http reverse proxy) sets its own conflicting
    // CSP/Permissions-Policy on every response and must not have this
    // middleware's values win on top of them — but FORCE_HTTPS enforcement
    // and canonical-Host rejection are unrelated to that header conflict and
    // must keep running for that path prefix too, not be dropped wholesale.
    const PUBLIC_API_URL = 'https://api.example.com';

    it('does not set Content-Security-Policy or Permissions-Policy for a path under the skipped prefix', async () => {
      const app = createApp({ skipHeadersPathPrefix: '/api/v1/tunnel-http/' });
      const res = await app.request('http://api.example.com/api/v1/tunnel-http/abc/status');
      expect(res.headers.get('Content-Security-Policy')).toBeNull();
      expect(res.headers.get('Permissions-Policy')).toBeNull();
    });

    it('still sets the headers for a path outside the skipped prefix', async () => {
      const app = createApp({ skipHeadersPathPrefix: '/api/v1/tunnel-http/' });
      const res = await app.request('/test');
      expect(res.headers.get('Content-Security-Policy')).toBeTruthy();
      expect(res.headers.get('Permissions-Policy')).toBeTruthy();
    });

    it('treats an empty prefix as "skip nothing", not "skip every path"', async () => {
      const app = createApp({ skipHeadersPathPrefix: '' });
      const res = await app.request('/test');
      expect(res.headers.get('Content-Security-Policy')).toBeTruthy();
      expect(res.headers.get('Permissions-Policy')).toBeTruthy();
    });

    it('still redirects HTTP to HTTPS for a path under the skipped prefix', async () => {
      const app = createApp({
        forceHttps: 'true',
        publicApiUrl: PUBLIC_API_URL,
        skipHeadersPathPrefix: '/api/v1/tunnel-http/',
      });
      app.get('/api/v1/tunnel-http/abc/status', (c) => c.text('proxied'));
      const req = new Request('http://api.example.com/api/v1/tunnel-http/abc/status', {
        headers: { 'x-forwarded-proto': 'http', host: 'api.example.com' },
      });
      const res = await app.request(req);
      expect(res.status).toBe(308);
      expect(res.headers.get('Location')).toBe('https://api.example.com/api/v1/tunnel-http/abc/status');
    });

    it('still rejects an unrecognized Host with 400 for a path under the skipped prefix', async () => {
      const app = createApp({
        forceHttps: 'true',
        publicApiUrl: PUBLIC_API_URL,
        skipHeadersPathPrefix: '/api/v1/tunnel-http/',
      });
      app.get('/api/v1/tunnel-http/abc/status', (c) => c.text('proxied'));
      const req = new Request('http://unrecognized-host.example.net/api/v1/tunnel-http/abc/status', {
        headers: { 'x-forwarded-proto': 'http', host: 'unrecognized-host.example.net' },
      });
      const res = await app.request(req);
      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBeNull();
    });

    // Network Proxy host mode (plan amendment 2026-10-12b item 6): a tunnel
    // host is never canonical to PUBLIC_API_URL. Behind a trusted proxy that
    // forwards `X-Forwarded-Proto: https` it must pass; resolved as http it is
    // refused 400 (fail-closed, documented in the Caddyfile and .env.example).
    describe('tunnel host under FORCE_HTTPS', () => {
      const TUNNEL_HOST = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.us.breezetunnel.test';
      const tunnelApp = () => {
        const app = createApp({ forceHttps: 'true', publicApiUrl: PUBLIC_API_URL, skipHeadersWhen: () => true });
        app.get('/device/page', (c) => c.text('device'));
        return app;
      };

      it('does not 400 a tunnel Host from a trusted proxy that forwarded https', async () => {
        const res = await tunnelApp().request(new Request(`http://${TUNNEL_HOST}/device/page`, {
          headers: { 'x-forwarded-proto': 'https', host: TUNNEL_HOST },
        }));
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('device');
      });

      it('400s (never redirects) a tunnel Host whose scheme resolves to http', async () => {
        const res = await tunnelApp().request(new Request(`http://${TUNNEL_HOST}/device/page`, {
          headers: { 'x-forwarded-proto': 'http', host: TUNNEL_HOST },
        }));
        expect(res.status).toBe(400);
        expect(res.headers.get('Location')).toBeNull();
      });
    });
  });

  describe('next() is called', () => {
    it('passes through to route handler', async () => {
      const app = createApp();
      const res = await app.request('/test');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
    });
  });

  describe('connect-src tightening (LOW-H3)', () => {
    it('production CSP does NOT include open ws:/wss: wildcards', async () => {
      const app = createApp({ nodeEnv: 'production' });
      const res = await app.request('/test');
      const csp = res.headers.get('Content-Security-Policy');
      // Must NOT contain the bare scheme allowlists that permit any host.
      expect(csp).not.toMatch(/connect-src[^;]*\bws:(?!\/)/);
      expect(csp).not.toMatch(/connect-src[^;]*\bwss:(?!\/)/);
      // Must restrict to explicit host(s).
      expect(csp).toMatch(/connect-src 'self' wss:\/\//);
    });

    it('production CSP defaults to wss://*.2breeze.app when no env override', async () => {
      const app = createApp({ nodeEnv: 'production', cspConnectHosts: '' });
      const res = await app.request('/test');
      const csp = res.headers.get('Content-Security-Policy');
      expect(csp).toContain("connect-src 'self' wss://*.2breeze.app");
    });

    it('production CSP honors CSP_CONNECT_HOSTS allowlist', async () => {
      const app = createApp({
        nodeEnv: 'production',
        cspConnectHosts: 'wss://us.example.com,wss://eu.example.com',
      });
      const res = await app.request('/test');
      const csp = res.headers.get('Content-Security-Policy');
      expect(csp).toContain("connect-src 'self' wss://us.example.com wss://eu.example.com");
    });

    it('non-production CSP keeps open ws: wss: for localhost dev', async () => {
      const app = createApp({ nodeEnv: 'development' });
      const res = await app.request('/test');
      const csp = res.headers.get('Content-Security-Policy');
      expect(csp).toContain("connect-src 'self' ws: wss:");
    });
  });

  describe('CSP_ALLOW_UNSAFE_INLINE production lockdown', () => {
    it('refuses to enable unsafe-inline in production even if env var is true', async () => {
      const app = createApp({ nodeEnv: 'production', allowUnsafeInline: 'true' });
      const res = await app.request('/test');
      const csp = res.headers.get('Content-Security-Policy');
      expect(csp).not.toContain("'unsafe-inline'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("style-src 'self'");
    });

    it('still permits unsafe-inline in development when explicitly enabled', async () => {
      const app = createApp({ nodeEnv: 'development', allowUnsafeInline: 'true' });
      const res = await app.request('/test');
      const csp = res.headers.get('Content-Security-Policy');
      expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    });
  });
});

// #3047: the FORCE_HTTPS redirect used to return without logging under any
// condition, so a proxy misconfiguration produced a fleet-wide 308 storm with
// no signal anywhere — /health is exempt and kept returning 200 throughout.
describe('FORCE_HTTPS redirect warning (#3047)', () => {
  const opts = { forceHttps: 'true', publicApiUrl: 'https://api.example.com' };
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const originalCidrs = process.env.TRUSTED_PROXY_CIDRS;

  beforeEach(() => {
    // Model a configured deployment. With TRUSTED_PROXY_CIDRS unset,
    // `isTrustedProxySource` returns `NODE_ENV !== 'production'` — so under test
    // every peer is trusted and the proxy-evidence gate can never be observed.
    // Naming an explicit CIDR the test peer is not in reproduces the production
    // semantics this suite is about.
    process.env.TRUSTED_PROXY_CIDRS = '10.9.9.9/32';
    _resetForceHttpsRedirectWarnStateForTests();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalCidrs === undefined) delete process.env.TRUSTED_PROXY_CIDRS;
    else process.env.TRUSTED_PROXY_CIDRS = originalCidrs;
    warnSpy.mockRestore();
    _resetForceHttpsRedirectWarnStateForTests();
  });

  // A direct plain-HTTP client with no forwarding headers at all is the redirect
  // working as designed — a port-80 scanner, an uptime probe, or a deploy that
  // intentionally runs without a reverse proxy. Warning there would emit a
  // misconfiguration line per scanner IP on any internet-facing origin, and
  // per-peer suppression is no defence because each source IP gets its own first
  // warn. It must redirect silently.
  it('stays silent for a direct client with no proxy evidence', async () => {
    const res = await createApp(opts).request('http://api.example.com/test', {
      headers: { host: 'api.example.com' },
    });

    expect(res.status).toBe(308);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns when a redirect fires, naming the symptom and the two config causes', async () => {
    const res = await createApp(opts).request('http://api.example.com/test', {
      headers: { host: 'api.example.com', 'x-forwarded-for': '203.0.113.9' },
    });

    expect(res.status).toBe(308);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0]?.[0]);
    expect(msg).toContain('[force-https]');
    expect(msg).toContain('trustedProxy=');
    expect(msg).toContain('xForwardedProto=');
    expect(msg).toContain('TRUSTED_PROXY_CIDRS');
  });

  // The variant #2988 could not catch: trust gate passes, no scheme header, so
  // no warning branch in clientIp.ts is reachable.
  it('reports xForwardedProto=(absent) when the proxy never sends the header', async () => {
    // Evidence of a proxy via the IP header, but no scheme header — exactly the
    // variant #2988 could not catch.
    await createApp(opts).request('http://api.example.com/test', {
      headers: { host: 'api.example.com', 'x-forwarded-for': '203.0.113.9' },
    });

    const msg = String(warnSpy.mock.calls[0]?.[0]);
    expect(msg).toContain('xForwardedProto=(absent)');
  });

  it('also warns on the 400 branch, which is the same fault via a non-canonical Host', async () => {
    const res = await createApp(opts).request('http://wrong-host.example.net/test', {
      headers: { host: 'wrong-host.example.net', 'x-forwarded-for': '203.0.113.9' },
    });

    expect(res.status).toBe(400);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('canonicalHost=false');
  });

  it('returns a stable reason code, never echoing the received Host (#7875)', async () => {
    const res = await createApp(opts).request('http://wrong-host.example.net/test', {
      headers: { host: 'wrong-host.example.net', 'x-forwarded-for': '203.0.113.9' },
    });

    expect(res.status).toBe(400);
    const raw = await res.text();
    expect(JSON.parse(raw)).toEqual({
      error: 'FORCE_HTTPS_NON_CANONICAL_HOST',
      docs: 'https://docs.breezermm.com/deploy/tls/',
    });
    expect(raw).not.toContain('wrong-host.example.net');
    expect(raw).not.toContain('api.example.com');
  });

  it('publishes the reject reason on the context for the request logger (#7875)', async () => {
    let reason: unknown;
    // Outer observer: runs before security, sees the value after it returns.
    const outer = new Hono();
    outer.use('*', async (c, next) => {
      await next();
      reason = c.get('rejectReason');
    });
    outer.use('*', securityMiddleware(opts));
    outer.get('/test', (c) => c.text('ok'));
    await outer.request('http://wrong-host.example.net/test', {
      headers: { host: 'wrong-host.example.net', 'x-forwarded-for': '203.0.113.9' },
    });
    expect(reason).toBe('force_https_non_canonical_host');
  });

  it('suppresses repeats per peer so a redirect storm cannot flood the log', async () => {
    const app = createApp(opts);
    for (let i = 0; i < 5; i++) {
      await app.request('http://api.example.com/test', {
        headers: { host: 'api.example.com', 'x-forwarded-for': '203.0.113.9' },
      });
    }

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  // Both negative cases below carry proxy evidence deliberately. Without it they
  // would pass because the new gate silenced them, not because of the exemption
  // they claim to test — green for the wrong reason.
  it('does not warn for health probes, which are exempt from the redirect', async () => {
    const app = createApp(opts);
    for (const p of ['/health', '/health/live', '/health/ready', '/ready']) {
      await app.request(`http://api.example.com${p}`, {
        headers: { host: 'api.example.com', 'x-forwarded-for': '203.0.113.9' },
      });
    }

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not warn when FORCE_HTTPS is off', async () => {
    await createApp({ publicApiUrl: 'https://api.example.com' }).request(
      'http://api.example.com/test',
      { headers: { host: 'api.example.com', 'x-forwarded-for': '203.0.113.9' } });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  // X-Forwarded-Proto alone is why hasTrustGatedForwardedHeaders exists as a
  // superset of the IP-header check: a proxy that forwards only the scheme is
  // still a proxy, and is precisely the TRANSPORT-001 shape.
  it('treats a lone X-Forwarded-Proto as proxy evidence', async () => {
    const res = await createApp(opts).request('http://api.example.com/test', {
      headers: { host: 'api.example.com', 'x-forwarded-proto': 'http' },
    });

    expect(res.status).toBe(308);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('xForwardedProto=http');
  });
});

describe('securityMiddleware skipHeadersWhen', () => {
  it('skips its response headers when skipHeadersWhen returns true', async () => {
    const app = new Hono();
    app.use('*', securityMiddleware({ nodeEnv: 'production', skipHeadersWhen: (c) => c.req.header('host') === 'tunnel.test' }));
    app.get('/', (c) => c.text('ok'));
    expect((await app.request('/', { headers: { host: 'tunnel.test' } })).headers.get('content-security-policy')).toBeNull();
    expect((await app.request('/', { headers: { host: 'app.test' } })).headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});

// #9700: portal/web SSR reaches the API over the plain-HTTP compose network at
// http://api:3001. Under FORCE_HTTPS that hop resolved to scheme `http` with a
// non-canonical Host and got 400 FORCE_HTTPS_NON_CANONICAL_HOST. The exemption
// keys on the TCP socket peer (unspoofable at L7) AND the Host, and never on a
// forwarded header — so a spoofed `Host: api:3001` from outside still fails.
describe('FORCE_HTTPS internal service exemption (#9700)', () => {
  const CADDY_IP = '172.31.0.10';
  const PORTAL_IP = '172.31.0.5';
  const opts = {
    forceHttps: 'true',
    publicApiUrl: 'https://api.example.com',
    internalServiceCidrs: '172.31.0.0/24',
    internalApiHosts: 'api:3001',
  };
  const originalCidrs = process.env.TRUSTED_PROXY_CIDRS;
  const originalInternalCidrs = process.env.INTERNAL_SERVICE_CIDRS;
  const originalInternalHosts = process.env.INTERNAL_API_HOSTS;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // The bundled Caddy is the only trusted proxy, as in docker-compose.yml.
    process.env.TRUSTED_PROXY_CIDRS = `${CADDY_IP}/32`;
    delete process.env.INTERNAL_SERVICE_CIDRS;
    delete process.env.INTERNAL_API_HOSTS;
    _resetForceHttpsRedirectWarnStateForTests();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('TRUSTED_PROXY_CIDRS', originalCidrs);
    restore('INTERNAL_SERVICE_CIDRS', originalInternalCidrs);
    restore('INTERNAL_API_HOSTS', originalInternalHosts);
    warnSpy.mockRestore();
    _resetForceHttpsRedirectWarnStateForTests();
  });

  function fromPeer(remoteAddress: string | undefined) {
    return remoteAddress === undefined ? {} : { incoming: { socket: { remoteAddress } } };
  }

  function request(
    app: Hono,
    host: string,
    peer: string | undefined,
    extraHeaders: Record<string, string> = {},
  ) {
    return app.request(`http://${host}/test`, { headers: { host, ...extraHeaders } }, fromPeer(peer));
  }

  it('lets a portal SSR call to the internal host through', async () => {
    const res = await request(createApp(opts), 'api:3001', PORTAL_IP);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('still applies the security headers to an exempted request', async () => {
    const res = await request(createApp(opts), 'api:3001', PORTAL_IP);
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
  });

  it('ignores browser forwarded headers relayed by the SSR caller (untrusted peer)', async () => {
    const res = await request(createApp(opts), 'api:3001', PORTAL_IP, {
      'x-forwarded-proto': 'http',
      'x-forwarded-host': 'portal.example.com',
    });
    expect(res.status).toBe(200);
  });

  it('accepts an IPv4-mapped IPv6 socket peer inside the internal range', async () => {
    const res = await request(createApp(opts), 'api:3001', `::ffff:${PORTAL_IP}`);
    expect(res.status).toBe(200);
  });

  it('matches the internal host case-insensitively', async () => {
    const res = await request(createApp(opts), 'API:3001', PORTAL_IP);
    expect(res.status).toBe(200);
  });

  it('rejects a spoofed internal Host from an external socket peer', async () => {
    const res = await request(createApp(opts), 'api:3001', '203.0.113.9');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'FORCE_HTTPS_NON_CANONICAL_HOST' });
  });

  it('rejects a spoofed internal Host relayed by the trusted proxy, even though Caddy sits inside the internal range', async () => {
    const res = await request(createApp(opts), 'api:3001', CADDY_IP, { 'x-forwarded-proto': 'http' });
    expect(res.status).toBe(400);
  });

  it('rejects an internal peer that names a host outside the internal host list', async () => {
    const res = await request(createApp(opts), 'evil.example.net', PORTAL_IP);
    expect(res.status).toBe(400);
  });

  it('requires the configured port, not just the hostname', async () => {
    const res = await request(createApp(opts), 'api', PORTAL_IP);
    expect(res.status).toBe(400);
  });

  it('still 308s an internal peer that addresses the canonical public host', async () => {
    const res = await request(createApp(opts), 'api.example.com', PORTAL_IP);
    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe('https://api.example.com/test');
  });

  it('fails closed when there is no socket peer to check', async () => {
    const res = await request(createApp(opts), 'api:3001', undefined);
    expect(res.status).toBe(400);
  });

  it('is disabled when no internal service CIDRs are configured', async () => {
    const res = await request(
      createApp({ forceHttps: 'true', publicApiUrl: 'https://api.example.com' }),
      'api:3001',
      PORTAL_IP,
    );
    expect(res.status).toBe(400);
  });

  it('reads INTERNAL_SERVICE_CIDRS from the environment, with api:3001 as the default internal host', async () => {
    process.env.INTERNAL_SERVICE_CIDRS = '172.31.0.0/24';
    const app = createApp({ forceHttps: 'true', publicApiUrl: 'https://api.example.com' });
    expect((await request(app, 'api:3001', PORTAL_IP)).status).toBe(200);
    expect((await request(app, 'api:3001', '203.0.113.9')).status).toBe(400);
  });

  it('reads INTERNAL_API_HOSTS from the environment as a comma-separated list', async () => {
    process.env.INTERNAL_SERVICE_CIDRS = '172.31.0.0/24';
    process.env.INTERNAL_API_HOSTS = 'breeze-api:3001, api:3001';
    const app = createApp({ forceHttps: 'true', publicApiUrl: 'https://api.example.com' });
    expect((await request(app, 'breeze-api:3001', PORTAL_IP)).status).toBe(200);
    expect((await request(app, 'api:3001', PORTAL_IP)).status).toBe(200);
  });

  it('ignores a CIDR that matches every address', async () => {
    const res = await request(
      createApp({ ...opts, internalServiceCidrs: '0.0.0.0/0' }),
      'api:3001',
      '203.0.113.9',
    );
    expect(res.status).toBe(400);
  });

  it('ignores a range that is wider than the private block its base address sits in', async () => {
    // 10.0.0.0/1 starts in 10/8 but spans 0.0.0.0-127.255.255.255 (public space).
    const res = await request(
      createApp({ ...opts, internalServiceCidrs: '10.0.0.0/1' }),
      'api:3001',
      '93.184.216.34',
    );
    expect(res.status).toBe(400);
  });

  it.each(['172.31.1.5', '10.0.0.5'])('rejects a private peer outside the configured range (%s)', async (peer) => {
    const res = await request(createApp(opts), 'api:3001', peer);
    expect(res.status).toBe(400);
  });

  it('rejects a spoofed internal Host from the trusted proxy in IPv4-mapped form', async () => {
    const res = await request(createApp(opts), 'api:3001', `::ffff:${CADDY_IP}`, { 'x-forwarded-proto': 'http' });
    expect(res.status).toBe(400);
  });

  it.each(['api:3001@evil.example.net', 'api:3001/x', 'api:30011', 'api.:3001'])(
    'rejects an internal peer whose Host only resembles the internal host (%s)',
    async (host) => {
      const app = createApp(opts);
      const res = await app.request('http://api.example.com/test', { headers: { host } }, fromPeer(PORTAL_IP));
      expect(res.status).toBe(400);
    },
  );

  it('keeps the valid entries when INTERNAL_SERVICE_CIDRS also holds invalid or public ones', async () => {
    process.env.INTERNAL_SERVICE_CIDRS = 'garbage, 0.0.0.0/0, 10.0.0.0/1, 172.31.0.0/24';
    const app = createApp({ forceHttps: 'true', publicApiUrl: 'https://api.example.com' });
    expect((await request(app, 'api:3001', PORTAL_IP)).status).toBe(200);
    expect((await request(app, 'api:3001', '93.184.216.34')).status).toBe(400);
  });

  // Defence in depth for a STALE TRUSTED_PROXY_CIDRS: if the proxy's address
  // drifts out of the trusted list but stays in the subnet, its relayed
  // internet traffic must still never qualify. Proxies append a client-IP
  // header; the SSR callers never send one.
  it.each(['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip'])(
    'rejects an internal-range peer that relays a client IP via %s (proxy-shaped)',
    async (header) => {
      const res = await request(createApp(opts), 'api:3001', '172.31.0.20', { [header]: '203.0.113.9' });
      expect(res.status).toBe(400);
    },
  );

  it('does not log a misconfiguration warning for an exempted internal call', async () => {
    await request(createApp(opts), 'api:3001', PORTAL_IP, { 'x-forwarded-proto': 'http' });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
