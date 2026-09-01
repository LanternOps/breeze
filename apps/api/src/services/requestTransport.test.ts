import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Context } from 'hono';
import { effectiveRequestScheme, isCanonicalRequestHost, canonicalHttpsRedirect, isSameOriginRequest } from './requestTransport';

// Mirrors the canonical shim pattern used across services/clientIp.test.ts and
// routes/auth/helpers.test.ts.
const TRUSTED_PROXY_IP = '172.31.0.10';

function makeContext(opts: {
  forwardedProto?: string;
  host?: string;
  url?: string;
  remoteAddress?: string | null;
}): Context {
  const headers: Record<string, string> = {};
  if (opts.forwardedProto !== undefined) headers['x-forwarded-proto'] = opts.forwardedProto;
  if (opts.host !== undefined) headers['host'] = opts.host;
  const remoteAddress = opts.remoteAddress === null ? undefined : (opts.remoteAddress ?? TRUSTED_PROXY_IP);
  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()],
      url: opts.url ?? 'http://example.com/test',
    },
    ...(remoteAddress ? { env: { incoming: { socket: { remoteAddress } } } } : {}),
  } as unknown as Context;
}

function enableProxyTrust(): void {
  process.env.TRUST_PROXY_HEADERS = 'true';
  process.env.TRUSTED_PROXY_CIDRS = `${TRUSTED_PROXY_IP}/32`;
}

describe('requestTransport', () => {
  const originalTrustProxyHeaders = process.env.TRUST_PROXY_HEADERS;
  const originalTrustedProxyCidrs = process.env.TRUSTED_PROXY_CIDRS;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    enableProxyTrust();
  });

  afterEach(() => {
    if (originalTrustProxyHeaders === undefined) delete process.env.TRUST_PROXY_HEADERS;
    else process.env.TRUST_PROXY_HEADERS = originalTrustProxyHeaders;
    if (originalTrustedProxyCidrs === undefined) delete process.env.TRUSTED_PROXY_CIDRS;
    else process.env.TRUSTED_PROXY_CIDRS = originalTrustedProxyCidrs;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  describe('effectiveRequestScheme', () => {
    it.each([
      {
        name: 'direct HTTPS (no trusted proxy in the picture, request URL is https)',
        opts: { url: 'https://example.com/test', remoteAddress: null as string | null },
        expected: 'https' as const,
      },
      {
        name: 'direct HTTP (no forwarded header at all)',
        opts: { url: 'http://example.com/test', remoteAddress: null as string | null },
        expected: 'http' as const,
      },
      {
        name: 'trusted forwarded HTTPS (peer is a configured trusted proxy)',
        opts: { url: 'http://example.com/test', forwardedProto: 'https', remoteAddress: TRUSTED_PROXY_IP },
        expected: 'https' as const,
      },
      {
        name: 'untrusted forwarded HTTPS is a spoof attempt — ignored, falls back to the direct (http) URL',
        opts: { url: 'http://example.com/test', forwardedProto: 'https', remoteAddress: '203.0.113.9' },
        expected: 'http' as const,
      },
      {
        name: 'malformed proto value from a trusted peer is treated as insecure',
        opts: { url: 'http://example.com/test', forwardedProto: 'httpz', remoteAddress: TRUSTED_PROXY_IP },
        expected: 'http' as const,
      },
      {
        name: 'empty proto value from a trusted peer is treated as insecure',
        opts: { url: 'https://example.com/test', forwardedProto: '', remoteAddress: TRUSTED_PROXY_IP },
        // Empty header value is falsy, so this falls through to the URL check.
        expected: 'https' as const,
      },
      {
        name: 'multi-value proto (https first) from a trusted peer uses the first, client-facing hop',
        opts: { url: 'http://example.com/test', forwardedProto: 'https, http', remoteAddress: TRUSTED_PROXY_IP },
        expected: 'https' as const,
      },
      {
        name: 'multi-value proto (http first) from a trusted peer uses the first, client-facing hop',
        opts: { url: 'https://example.com/test', forwardedProto: 'http, https', remoteAddress: TRUSTED_PROXY_IP },
        expected: 'http' as const,
      },
      {
        name: 'mixed-case / whitespace proto from a trusted peer is normalized',
        opts: { url: 'http://example.com/test', forwardedProto: '  HTTPS  ', remoteAddress: TRUSTED_PROXY_IP },
        expected: 'https' as const,
      },
      {
        name: 'a malformed request URL with no trusted forwarded signal is treated as insecure',
        opts: { url: 'not a url', remoteAddress: null as string | null },
        expected: 'http' as const,
      },
    ])('$name', ({ opts, expected }) => {
      expect(effectiveRequestScheme(makeContext(opts))).toBe(expected);
    });
  });

  describe('isCanonicalRequestHost', () => {
    const publicApiUrl = new URL('https://api.example.com');

    it('matches the canonical host exactly', () => {
      expect(isCanonicalRequestHost(makeContext({ host: 'api.example.com' }), publicApiUrl)).toBe(true);
    });

    it('matches case-insensitively', () => {
      expect(isCanonicalRequestHost(makeContext({ host: 'API.Example.COM' }), publicApiUrl)).toBe(true);
    });

    it('is port-aware: a canonical host with an explicit default port still matches', () => {
      expect(isCanonicalRequestHost(makeContext({ host: 'api.example.com:443' }), publicApiUrl)).toBe(true);
    });

    it('rejects an attacker-controlled Host that does not match the canonical host', () => {
      expect(isCanonicalRequestHost(makeContext({ host: 'attacker.example.net' }), publicApiUrl)).toBe(false);
    });

    it('rejects a Host that matches only the hostname but not a non-default port', () => {
      const withPort = new URL('https://api.example.com:8443');
      expect(isCanonicalRequestHost(makeContext({ host: 'api.example.com' }), withPort)).toBe(false);
      expect(isCanonicalRequestHost(makeContext({ host: 'api.example.com:8443' }), withPort)).toBe(true);
    });

    it('handles bracketed IPv6 hosts', () => {
      const ipv6Url = new URL('https://[2001:db8::1]:8443');
      expect(isCanonicalRequestHost(makeContext({ host: '[2001:db8::1]:8443' }), ipv6Url)).toBe(true);
      expect(isCanonicalRequestHost(makeContext({ host: '[2001:db8::2]:8443' }), ipv6Url)).toBe(false);
    });

    it('rejects a missing Host header (fail closed)', () => {
      expect(isCanonicalRequestHost(makeContext({}), publicApiUrl)).toBe(false);
    });
  });

  describe('canonicalHttpsRedirect', () => {
    const publicApiUrl = new URL('https://api.example.com');

    it('returns null (pass) when the request is already effectively HTTPS', () => {
      const c = makeContext({ url: 'http://example.com/foo', host: 'api.example.com', forwardedProto: 'https', remoteAddress: TRUSTED_PROXY_IP });
      expect(canonicalHttpsRedirect(c, publicApiUrl)).toBeNull();
    });

    it('returns null when the Host is unrecognized (caller must reject with 400, not pass through)', () => {
      const c = makeContext({ url: 'http://attacker.example.net/foo', host: 'attacker.example.net', remoteAddress: null });
      expect(canonicalHttpsRedirect(c, publicApiUrl)).toBeNull();
      // The distinguishing signal for the caller:
      expect(isCanonicalRequestHost(c, publicApiUrl)).toBe(false);
    });

    it('builds a redirect Location from PUBLIC_API_URL for a canonical-Host insecure request', () => {
      const c = makeContext({ url: 'http://api.example.com/foo', host: 'api.example.com', remoteAddress: null });
      const location = canonicalHttpsRedirect(c, publicApiUrl);
      expect(location).not.toBeNull();
      expect(location!.origin).toBe('https://api.example.com');
    });

    it('never reflects the inbound Host into the Location, even when it differs from PUBLIC_API_URL in a way a naive implementation might carry over', () => {
      // Inbound Host equals canonical (so the request is accepted), but the
      // request URL carries a totally different host — the Location must
      // still be built from publicApiUrl, never from c.req.url's host.
      const c = makeContext({ url: 'http://attacker.example.net/foo?x=1', host: 'api.example.com', remoteAddress: null });
      const location = canonicalHttpsRedirect(c, publicApiUrl);
      expect(location).not.toBeNull();
      expect(location!.host).toBe('api.example.com');
      expect(location!.protocol).toBe('https:');
    });

    it('preserves the request path and query string in the redirect Location', () => {
      const c = makeContext({ url: 'http://api.example.com/api/v1/devices?org=abc&sort=-createdAt', host: 'api.example.com', remoteAddress: null });
      const location = canonicalHttpsRedirect(c, publicApiUrl);
      expect(location).not.toBeNull();
      expect(location!.toString()).toBe('https://api.example.com/api/v1/devices?org=abc&sort=-createdAt');
    });

    it('handles an IPv6 PUBLIC_API_URL host end-to-end', () => {
      const ipv6PublicUrl = new URL('https://[2001:db8::1]:8443');
      const c = makeContext({ url: 'http://[2001:db8::1]:8443/status', host: '[2001:db8::1]:8443', remoteAddress: null });
      const location = canonicalHttpsRedirect(c, ipv6PublicUrl);
      expect(location).not.toBeNull();
      expect(location!.toString()).toBe('https://[2001:db8::1]:8443/status');
    });

    it('returns null when the request URL itself is unparsable', () => {
      const c = makeContext({ url: 'not a url', host: 'api.example.com', remoteAddress: null });
      expect(canonicalHttpsRedirect(c, publicApiUrl)).toBeNull();
    });

    it('does not redirect a request already using canonical https (no-op pass-through)', () => {
      const c = makeContext({ url: 'https://api.example.com/foo', host: 'api.example.com', remoteAddress: null });
      expect(canonicalHttpsRedirect(c, publicApiUrl)).toBeNull();
    });
  });
});

describe('isSameOriginRequest', () => {
  const originalTrust = process.env.TRUST_PROXY_HEADERS;
  const originalCidrs = process.env.TRUSTED_PROXY_CIDRS;

  afterEach(() => {
    if (originalTrust === undefined) delete process.env.TRUST_PROXY_HEADERS;
    else process.env.TRUST_PROXY_HEADERS = originalTrust;
    if (originalCidrs === undefined) delete process.env.TRUSTED_PROXY_CIDRS;
    else process.env.TRUSTED_PROXY_CIDRS = originalCidrs;
  });

  function ctx(opts: {
    headers?: Record<string, string>;
    url?: string;
    remoteAddress?: string;
  }): Context {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
    return {
      req: {
        header: (name: string) => headers[name.toLowerCase()],
        url: opts.url ?? 'http://api:3001/api/v1/auth/refresh',
      },
      ...(opts.remoteAddress ? { env: { incoming: { socket: { remoteAddress: opts.remoteAddress } } } } : {}),
    } as unknown as Context;
  }

  it('accepts an origin outside the allowlist when the browser asserts Sec-Fetch-Site: same-origin', () => {
    process.env.TRUST_PROXY_HEADERS = 'false';
    const c = ctx({ headers: { origin: 'https://localhost:8443', 'sec-fetch-site': 'same-origin', host: 'api:3001' } });
    expect(isSameOriginRequest(c, 'https://localhost:8443')).toBe(true);
  });

  it.each([
    ['null origin', 'null'],
    ['malformed origin', 'not an origin'],
    ['non-http scheme', 'ftp://localhost:8443'],
    ['origin with a path', 'https://localhost:8443/login'],
    ['empty origin', ''],
  ])('rejects a %s even with Sec-Fetch-Site: same-origin', (_label, origin) => {
    process.env.TRUST_PROXY_HEADERS = 'false';
    const c = ctx({ headers: { origin, 'sec-fetch-site': 'same-origin', host: 'localhost:8443' }, url: 'https://localhost:8443/x' });
    expect(isSameOriginRequest(c, origin)).toBe(false);
  });

  it('does not treat Sec-Fetch-Site: same-site as proof (sibling subdomains are same-site)', () => {
    process.env.TRUST_PROXY_HEADERS = 'false';
    const c = ctx({ headers: { origin: 'https://evil.example.com', 'sec-fetch-site': 'same-site', host: 'app.example.com' }, url: 'https://app.example.com/x' });
    expect(isSameOriginRequest(c, 'https://evil.example.com')).toBe(false);
  });

  describe('direct requests (no proxy trust)', () => {
    beforeEach(() => { process.env.TRUST_PROXY_HEADERS = 'false'; });

    it('accepts Origin equal to the request scheme + Host', () => {
      const c = ctx({ headers: { host: 'localhost:8443' }, url: 'https://localhost:8443/api/v1/auth/refresh' });
      expect(isSameOriginRequest(c, 'https://localhost:8443')).toBe(true);
    });

    it('normalises host case and default ports', () => {
      const upper = ctx({ headers: { host: 'LOCALHOST:8443' }, url: 'https://localhost:8443/x' });
      expect(isSameOriginRequest(upper, 'https://localhost:8443')).toBe(true);
      const defaultPort = ctx({ headers: { host: 'app.example.com:443' }, url: 'https://app.example.com/x' });
      expect(isSameOriginRequest(defaultPort, 'https://app.example.com')).toBe(true);
    });

    it('rejects a scheme mismatch, a host mismatch, and a missing Host', () => {
      expect(isSameOriginRequest(ctx({ headers: { host: 'localhost:8443' }, url: 'https://localhost:8443/x' }), 'http://localhost:8443')).toBe(false);
      expect(isSameOriginRequest(ctx({ headers: { host: 'localhost:8443' }, url: 'https://localhost:8443/x' }), 'https://localhost:9443')).toBe(false);
      expect(isSameOriginRequest(ctx({ headers: {}, url: 'https://localhost:8443/x' }), 'https://localhost:8443')).toBe(false);
    });

    it('ignores X-Forwarded-Proto/X-Forwarded-Host from an untrusted peer', () => {
      const c = ctx({
        headers: { host: 'api:3001', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'localhost:8443' },
        url: 'http://api:3001/x',
        remoteAddress: '203.0.113.9',
      });
      expect(isSameOriginRequest(c, 'https://localhost:8443')).toBe(false);
    });
  });

  describe('behind a trusted reverse proxy', () => {
    const PROXY = '172.31.0.10';
    beforeEach(() => {
      process.env.TRUST_PROXY_HEADERS = 'true';
      process.env.TRUSTED_PROXY_CIDRS = `${PROXY}/32`;
    });

    it('uses the forwarded scheme and X-Forwarded-Host (the Caddy-fronted self-host topology)', () => {
      const c = ctx({
        headers: { host: 'api:3001', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'localhost:8443' },
        url: 'http://api:3001/x',
        remoteAddress: PROXY,
      });
      expect(isSameOriginRequest(c, 'https://localhost:8443')).toBe(true);
    });

    it('falls back to Host when the trusted proxy passes it through unchanged', () => {
      const c = ctx({
        headers: { host: 'localhost:8443', 'x-forwarded-proto': 'https' },
        url: 'http://localhost:8443/x',
        remoteAddress: PROXY,
      });
      expect(isSameOriginRequest(c, 'https://localhost:8443')).toBe(true);
    });

    it('fails closed on a multi-valued or empty X-Forwarded-Host', () => {
      const multi = ctx({
        headers: { host: 'localhost:8443', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'localhost:8443, evil.example' },
        url: 'http://localhost:8443/x',
        remoteAddress: PROXY,
      });
      expect(isSameOriginRequest(multi, 'https://localhost:8443')).toBe(false);
      const empty = ctx({
        headers: { host: 'localhost:8443', 'x-forwarded-proto': 'https', 'x-forwarded-host': '' },
        url: 'http://localhost:8443/x',
        remoteAddress: PROXY,
      });
      expect(isSameOriginRequest(empty, 'https://localhost:8443')).toBe(false);
    });

    it('still rejects a cross-site origin that merely matches nothing', () => {
      const c = ctx({
        headers: { host: 'api:3001', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'app.example.com' },
        url: 'http://api:3001/x',
        remoteAddress: PROXY,
      });
      expect(isSameOriginRequest(c, 'https://evil.example')).toBe(false);
    });
  });
});
