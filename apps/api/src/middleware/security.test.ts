import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { securityMiddleware } from './security';

function createApp(options?: Parameters<typeof securityMiddleware>[0]) {
  const app = new Hono();
  app.use('*', securityMiddleware(options));
  app.get('/test', (c) => c.text('ok'));
  app.get('/health', (c) => c.text('healthy'));
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

  describe('HTTPS redirect', () => {
    it('redirects HTTP to HTTPS when forceHttps is true', async () => {
      const app = createApp({ forceHttps: 'true' });
      const req = new Request('http://example.com/test', {
        headers: { 'x-forwarded-proto': 'http' },
      });
      const res = await app.request(req);
      expect(res.status).toBe(308);
      expect(res.headers.get('Location')).toContain('https://');
    });

    it('does not redirect when proto is already https', async () => {
      const app = createApp({ forceHttps: 'true' });
      const req = new Request('http://example.com/test', {
        headers: { 'x-forwarded-proto': 'https' },
      });
      const res = await app.request(req);
      expect(res.status).toBe(200);
    });

    it('does not redirect when forceHttps is not set', async () => {
      const app = createApp();
      const req = new Request('http://example.com/test', {
        headers: { 'x-forwarded-proto': 'http' },
      });
      const res = await app.request(req);
      expect(res.status).toBe(200);
    });

    it('skips redirect for /health path', async () => {
      const app = createApp({ forceHttps: 'true' });
      const req = new Request('http://example.com/health', {
        headers: { 'x-forwarded-proto': 'http' },
      });
      const res = await app.request(req);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('healthy');
    });

    it('skips redirect for /ready path', async () => {
      const app = createApp({ forceHttps: 'true' });
      const req = new Request('http://example.com/ready', {
        headers: { 'x-forwarded-proto': 'http' },
      });
      const res = await app.request(req);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ready');
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
});
