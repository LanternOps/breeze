import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { securityMiddleware } from './security';

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
