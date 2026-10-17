import { describe, expect, it } from 'vitest';
import {
  RESERVED_PROXY_COOKIE_NAMES,
  TUNNEL_FRAME_COOKIE,
  TUNNEL_TAB_COOKIE,
  applyHostModeBaseHeaders,
  buildHostModeResponseHeaders,
  buildHostModeUpstreamHeaders,
  hostModeCsp,
  rewriteHostModeDeviceCookie,
  stripProxyCookies,
} from './tunnelHostHeaders';
import { rewriteTunnelHtml } from './tunnelHttpRewrite';

const TUNNEL_ORIGIN = 'https://eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.us.breezetunnel.test';
const SIBLING_ORIGIN = 'https://ffffffff-ffff-4fff-8fff-ffffffffffff.us.breezetunnel.test';
const TARGET = 'http://192.168.1.50:80';
const ANCESTOR = 'https://us.breeze-app.test';

describe('reserved proxy cookie names', () => {
  it('are exactly __Host-bzt and __Host-bzt-top', () => {
    expect(TUNNEL_FRAME_COOKIE).toBe('__Host-bzt');
    expect(TUNNEL_TAB_COOKIE).toBe('__Host-bzt-top');
    expect([...RESERVED_PROXY_COOKIE_NAMES].sort()).toEqual(['__host-bzt', '__host-bzt-top']);
  });
});

describe('device Set-Cookie (spec §5)', () => {
  it('strips Domain and forces Secure; SameSite=None; Partitioned in the iframe context, keeping name/value/Path', () => {
    expect(rewriteHostModeDeviceCookie('SID=abc; Domain=192.168.1.50; Path=/cgi; SameSite=Strict; HttpOnly', 'frame'))
      .toBe('SID=abc; Path=/cgi; HttpOnly; Secure; SameSite=None; Partitioned');
  });

  it('forces Secure; SameSite=Lax, unpartitioned, in the new-tab context', () => {
    expect(rewriteHostModeDeviceCookie('SID=abc; Partitioned; Secure; SameSite=None', 'tab'))
      .toBe('SID=abc; Secure; SameSite=Lax');
  });

  it('strips a Domain attribute in any case and spacing', () => {
    expect(rewriteHostModeDeviceCookie('a=1; DOMAIN = .breezetunnel.test; domain=x', 'tab')).toBe('a=1; Secure; SameSite=Lax');
  });

  it('keeps Expires and Max-Age', () => {
    expect(rewriteHostModeDeviceCookie('a=1; Max-Age=60; Expires=Wed, 21 Oct 2037 07:28:00 GMT', 'frame'))
      .toBe('a=1; Max-Age=60; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Secure; SameSite=None; Partitioned');
  });

  it('drops the reserved proxy cookie names (any case) but passes other __Host- cookies', () => {
    expect(rewriteHostModeDeviceCookie('__Host-bzt=evil; Path=/', 'frame')).toBeNull();
    expect(rewriteHostModeDeviceCookie('__HOST-BZT-TOP=evil; Path=/', 'tab')).toBeNull();
    expect(rewriteHostModeDeviceCookie('  __host-Bzt =evil; Path=/', 'tab')).toBeNull();
    expect(rewriteHostModeDeviceCookie('__Host-dev=1; Path=/; Secure', 'frame'))
      .toBe('__Host-dev=1; Path=/; Secure; SameSite=None; Partitioned');
    expect(rewriteHostModeDeviceCookie('__Host-bzt-other=1; Path=/', 'tab')).toBe('__Host-bzt-other=1; Path=/; Secure; SameSite=Lax');
  });

  it('drops nameless cookies (a browser would store "=x" / "x" with an empty name)', () => {
    expect(rewriteHostModeDeviceCookie('garbage-without-equals', 'frame')).toBeNull();
    expect(rewriteHostModeDeviceCookie('__Host-bzt', 'frame')).toBeNull();
    expect(rewriteHostModeDeviceCookie('=__Host-bzt=evil', 'frame')).toBeNull();
    expect(rewriteHostModeDeviceCookie('', 'frame')).toBeNull();
  });
});

describe('upstream request headers', () => {
  it('strips proxy cookies (any case), keeps device cookies, never forwards credentials or Referer', () => {
    expect(stripProxyCookies('__Host-bzt=x; SID=1; __Host-bzt-top=y; __Host-dev=2')).toBe('SID=1; __Host-dev=2');
    expect(stripProxyCookies('__HOST-BZT=x;__host-bzt-TOP=y; __Host-bzt; a=b')).toBe('a=b');
    expect(stripProxyCookies('__Host-bzt=x')).toBe('');
    const headers = buildHostModeUpstreamHeaders(
      {
        accept: '*/*',
        cookie: '__Host-bzt=x; SID=1',
        authorization: 'Bearer t',
        referer: `${TUNNEL_ORIGIN}/a`,
        'proxy-authorization': 'Basic x',
        'x-api-key': 'k',
        'x-forwarded-for': '203.0.113.7',
        'x-breeze-tunnel-site': '1',
      },
      { tunnelOrigin: TUNNEL_ORIGIN, targetOrigin: TARGET },
    );
    expect(headers).toEqual({ accept: ['*/*'], cookie: ['SID=1'] });
  });

  it('sends no Cookie header when only proxy cookies were present', () => {
    expect(buildHostModeUpstreamHeaders({ cookie: '__Host-bzt=x; __Host-bzt-top=y' }, { tunnelOrigin: TUNNEL_ORIGIN, targetOrigin: TARGET }))
      .toEqual({});
  });

  it('rewrites a same-tunnel Origin to the device origin (default port elided) and drops any other Origin', () => {
    const up = (origin: string, targetOrigin = TARGET) =>
      buildHostModeUpstreamHeaders({ origin }, { tunnelOrigin: TUNNEL_ORIGIN, targetOrigin }).origin;
    expect(up(TUNNEL_ORIGIN)).toEqual(['http://192.168.1.50']);
    expect(up(TUNNEL_ORIGIN, 'https://192.168.1.50:8443')).toEqual(['https://192.168.1.50:8443']);
    expect(up(ANCESTOR)).toBeUndefined();
    expect(up(SIBLING_ORIGIN)).toBeUndefined();
    expect(up('null')).toBeUndefined();
  });
});

describe('response headers (spec §6)', () => {
  it('applies the host-mode security headers and strips device CORS/CSP/XFO/cache/referrer/nosniff/SW headers', () => {
    const { headers, contentType } = buildHostModeResponseHeaders({
      'Content-Type': ['text/html'],
      'Access-Control-Allow-Origin': ['*'],
      'access-control-allow-credentials': ['true'],
      'Content-Security-Policy': ["default-src 'self'"],
      'Content-Security-Policy-Report-Only': ["default-src 'self'"],
      'X-Frame-Options': ['DENY'],
      'Cache-Control': ['public, max-age=3600'],
      'Referrer-Policy': ['unsafe-url'],
      'X-Content-Type-Options': ['bogus'],
      'Service-Worker-Allowed': ['/'],
      'Alt-Svc': ['h3=":443"'],
      'Transfer-Encoding': ['chunked'],
      'Content-Length': ['999'],
      'X-Device': ['kept'],
    }, { context: 'frame', targetOrigin: TARGET, frameAncestor: ANCESTOR });
    expect(contentType).toBe('text/html');
    expect(headers.get('content-type')).toBe('text/html');
    expect(headers.get('content-security-policy')).toBe(`frame-ancestors ${ANCESTOR} 'self'`);
    expect(headers.get('content-security-policy-report-only')).toBeNull();
    expect(headers.get('cache-control')).toBe('no-store');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('referrer-policy')).toBe('no-referrer');
    expect(headers.get('access-control-allow-origin')).toBeNull();
    expect(headers.get('access-control-allow-credentials')).toBeNull();
    expect(headers.get('x-frame-options')).toBeNull();
    expect(headers.get('service-worker-allowed')).toBeNull();
    expect(headers.get('alt-svc')).toBeNull();
    expect(headers.get('transfer-encoding')).toBeNull();
    expect(headers.get('content-length')).toBeNull();
    expect(headers.get('x-device')).toBe('kept');
  });

  it('rewrites device Set-Cookie per context and drops reserved names', () => {
    const upstream = { 'Set-Cookie': ['__Host-bzt=evil; Path=/', 'SID=1; Domain=192.168.1.50; Path=/'] };
    const frame = buildHostModeResponseHeaders(upstream, { context: 'frame', targetOrigin: TARGET, frameAncestor: ANCESTOR });
    expect(frame.headers.getSetCookie()).toEqual(['SID=1; Path=/; Secure; SameSite=None; Partitioned']);
    const tab = buildHostModeResponseHeaders(upstream, { context: 'tab', targetOrigin: TARGET, frameAncestor: ANCESTOR });
    expect(tab.headers.getSetCookie()).toEqual(['SID=1; Path=/; Secure; SameSite=Lax']);
  });

  it('maps only device-origin absolute Locations; relative and foreign Locations pass through', () => {
    const loc = (l: string) => buildHostModeResponseHeaders({ Location: [l] }, { context: 'frame', targetOrigin: TARGET, frameAncestor: ANCESTOR }).headers.get('location');
    expect(loc('http://192.168.1.50/login?x=1')).toBe('/login?x=1');
    expect(loc('http://192.168.1.50:80/a#b')).toBe('/a#b');
    expect(loc('//192.168.1.50/p')).toBe('/p');
    expect(loc('/home')).toBe('/home');
    expect(loc('next.html')).toBe('next.html');
    expect(loc('https://192.168.1.50/tls')).toBe('https://192.168.1.50/tls');
    expect(loc('https://vendor.example/help')).toBe('https://vendor.example/help');
  });

  it('base headers never overwrite a CSP the handler already set, and fail closed without config', () => {
    const h = new Headers({ 'content-security-policy': "default-src 'none'", 'cache-control': 'public' });
    applyHostModeBaseHeaders(h, ANCESTOR);
    expect(h.get('content-security-policy')).toBe("default-src 'none'");
    expect(h.get('cache-control')).toBe('no-store');
    const empty = new Headers();
    applyHostModeBaseHeaders(empty, null);
    expect(empty.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(empty.get('cache-control')).toBe('no-store');
    expect(empty.get('x-content-type-options')).toBe('nosniff');
    expect(empty.get('referrer-policy')).toBe('no-referrer');
    expect(hostModeCsp(ANCESTOR)).toBe(`frame-ancestors ${ANCESTOR} 'self'`);
  });
});

describe('rewriteTunnelHtml host mode', () => {
  it('injects no <base> and maps only absolute device URLs', () => {
    const out = rewriteTunnelHtml(
      '<html><head></head><body><a href="rel/x">r</a><img src="/root.png"><a href="http://192.168.1.50/abs">a</a></body></html>',
      { basePath: '/', targetOrigin: TARGET },
      { injectBase: false },
    );
    expect(out).not.toContain('<base');
    expect(out).toContain('href="rel/x"');
    expect(out).toContain('src="/root.png"');
    expect(out).toContain('href="/abs"');
  });

  it('path mode still injects <base> by default', () => {
    const out = rewriteTunnelHtml('<html><head></head><body></body></html>', { basePath: '/api/v1/tunnel-http/t/k/', targetOrigin: TARGET });
    expect(out).toContain('<base href="/api/v1/tunnel-http/t/k/">');
  });
});
