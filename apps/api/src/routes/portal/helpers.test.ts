import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  buildPortalUrl,
  buildPortalSessionCookie,
  buildPortalCsrfCookie,
  buildClearPortalSessionCookie,
  setPortalSessionCookies,
  clearPortalSessionCookies,
  _resetPortalCookieWarnStateForTests,
} from './helpers';
import type { Context } from 'hono';

const ENV_KEYS = ['PUBLIC_PORTAL_URL', 'DASHBOARD_URL', 'PUBLIC_APP_URL'] as const;
const saved: Record<string, string | undefined> = {};
function setEnv(vals: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(vals)) process.env[k] = v;
}
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('buildPortalUrl', () => {
  it('uses PUBLIC_PORTAL_URL when set', () => {
    setEnv({ PUBLIC_PORTAL_URL: 'https://us.2breeze.app/portal' });
    expect(buildPortalUrl('/accept-invite?token=abc')).toBe('https://us.2breeze.app/portal/accept-invite?token=abc');
  });
  it('falls back to DASHBOARD_URL + /portal', () => {
    setEnv({ DASHBOARD_URL: 'https://us.2breeze.app' });
    expect(buildPortalUrl('/reset-password?token=x')).toBe('https://us.2breeze.app/portal/reset-password?token=x');
  });
  it('does not double the /portal segment', () => {
    setEnv({ PUBLIC_PORTAL_URL: 'https://us.2breeze.app/portal/' });
    expect(buildPortalUrl('/reset-password')).toBe('https://us.2breeze.app/portal/reset-password');
  });
});

// ============================================
// #2611 — portal cookie Secure flag tracks the real transport, not NODE_ENV
// (follow-up to the admin-app #1618 fix; mirrors routes/auth/helpers.test.ts)
// ============================================

// isRequestConnectionSecure (reused from auth/helpers) only honors
// X-Forwarded-Proto when the immediate TCP peer passes the TRUSTED_PROXY_CIDRS
// gate, so the cookie context needs a socket peer + a header sink recording the
// exact Set-Cookie strings emitted.
const TRUSTED_PROXY_IP = '172.31.0.10';

function makeCookieContext(opts: {
  forwardedProto?: string;
  url?: string;
  host?: string;
  remoteAddress?: string | null;
}): { c: Context; setCookies: string[] } {
  const setCookies: string[] = [];
  const headers: Record<string, string> = {};
  if (opts.forwardedProto !== undefined) headers['x-forwarded-proto'] = opts.forwardedProto;
  if (opts.host !== undefined) headers['host'] = opts.host;
  const remoteAddress = opts.remoteAddress === null ? undefined : (opts.remoteAddress ?? TRUSTED_PROXY_IP);
  const c = {
    req: {
      header: (name: string) => headers[name.toLowerCase()],
      url: opts.url ?? 'http://api:3001/api/v1/portal/auth/login',
    },
    header: (name: string, value: string) => {
      if (name.toLowerCase() === 'set-cookie') setCookies.push(value);
    },
    ...(remoteAddress ? { env: { incoming: { socket: { remoteAddress } } } } : {}),
  } as unknown as Context;
  return { c, setCookies };
}

// In production the proxy-trust gate defaults CLOSED; open it to mirror the
// out-of-the-box compose config (Caddy's static IP in TRUSTED_PROXY_CIDRS).
function enableProxyTrust(): void {
  process.env.TRUST_PROXY_HEADERS = 'true';
  process.env.TRUSTED_PROXY_CIDRS = `${TRUSTED_PROXY_IP}/32`;
}

function disableProxyTrustEnv(): void {
  delete process.env.TRUST_PROXY_HEADERS;
  delete process.env.TRUSTED_PROXY_CIDRS;
}

describe('portal cookie Secure flag (#2611)', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  beforeEach(() => {
    enableProxyTrust();
  });
  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    disableProxyTrustEnv();
    delete process.env.PORTAL_COOKIE_FORCE_SECURE;
    delete process.env.PORTAL_COOKIE_SAME_SITE;
  });

  it('REGRESSION: production served over HTTP issues NON-Secure portal cookies so the browser keeps them', () => {
    process.env.NODE_ENV = 'production';
    const { c, setCookies } = makeCookieContext({ forwardedProto: 'http' });
    setPortalSessionCookies(c, 'session.token.value');
    expect(setCookies).toHaveLength(2);
    const [session, csrf] = setCookies;
    expect(session).toContain('breeze_portal_session=');
    expect(session).not.toContain('Secure');
    expect(csrf).toContain('breeze_portal_csrf_token=');
    expect(csrf).not.toContain('Secure');
    // Attributes that must survive regardless of transport.
    expect(session).toContain('HttpOnly');
    expect(session).toContain('SameSite=Lax');
  });

  it('production served over HTTPS still issues Secure portal cookies', () => {
    process.env.NODE_ENV = 'production';
    const { c, setCookies } = makeCookieContext({ forwardedProto: 'https' });
    setPortalSessionCookies(c, 'session.token.value');
    expect(setCookies[0]).toContain('; Secure');
    expect(setCookies[1]).toContain('; Secure');
  });

  it('PORTAL_COOKIE_FORCE_SECURE overrides an http transport (paranoid setups)', () => {
    process.env.NODE_ENV = 'production';
    process.env.PORTAL_COOKIE_FORCE_SECURE = 'true';
    const { c, setCookies } = makeCookieContext({ forwardedProto: 'http' });
    setPortalSessionCookies(c, 'session.token.value');
    expect(setCookies[0]).toContain('; Secure');
    expect(setCookies[1]).toContain('; Secure');
  });

  it('SameSite=None forces Secure regardless of transport (browsers reject SameSite=None without it)', () => {
    process.env.NODE_ENV = 'production';
    process.env.PORTAL_COOKIE_SAME_SITE = 'None';
    const { c, setCookies } = makeCookieContext({ forwardedProto: 'http' });
    setPortalSessionCookies(c, 'session.token.value');
    expect(setCookies[0]).toContain('SameSite=None; Secure');
    expect(setCookies[1]).toContain('SameSite=None; Secure');
  });

  it('untrusted-peer X-Forwarded-Proto=http cannot strip Secure in production (falls back to NODE_ENV)', () => {
    process.env.NODE_ENV = 'production';
    const { c, setCookies } = makeCookieContext({ forwardedProto: 'http', remoteAddress: '203.0.113.9' });
    setPortalSessionCookies(c, 'session.token.value');
    expect(setCookies[0]).toContain('; Secure');
    expect(setCookies[1]).toContain('; Secure');
  });

  it('clear cookies mirror the set-cookie Secure flag for the same transport (http → non-Secure)', () => {
    process.env.NODE_ENV = 'production';
    const { c, setCookies } = makeCookieContext({ forwardedProto: 'http' });
    clearPortalSessionCookies(c);
    expect(setCookies).toHaveLength(2);
    expect(setCookies[0]).toContain('Max-Age=0');
    expect(setCookies[0]).not.toContain('Secure'); // an http clear must NOT be Secure or the browser ignores it
    expect(setCookies[1]).not.toContain('Secure');
  });

  it('clear cookies carry Secure over an https transport', () => {
    process.env.NODE_ENV = 'production';
    const { c, setCookies } = makeCookieContext({ forwardedProto: 'https' });
    clearPortalSessionCookies(c);
    expect(setCookies[0]).toContain('Max-Age=0');
    expect(setCookies[0]).toContain('; Secure');
    expect(setCookies[1]).toContain('; Secure');
  });

  it('build* functions require an explicit transport — no silent NODE_ENV fallback', () => {
    process.env.NODE_ENV = 'production';
    expect(buildPortalSessionCookie('t', true)).toContain('; Secure');
    expect(buildPortalSessionCookie('t', false)).not.toContain('Secure');
    expect(buildPortalCsrfCookie('t', true)).toContain('; Secure');
    expect(buildPortalCsrfCookie('t', false)).not.toContain('Secure');
    expect(buildClearPortalSessionCookie(true)).toContain('; Secure');
    expect(buildClearPortalSessionCookie(false)).not.toContain('Secure');
  });
});

describe('portal cookie transport warnings (#2611 diagnostics)', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    _resetPortalCookieWarnStateForTests();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    enableProxyTrust();
  });

  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    disableProxyTrustEnv();
    delete process.env.PORTAL_COOKIE_FORCE_SECURE;
    delete process.env.PORTAL_COOKIE_SAME_SITE;
  });

  function allWarnings(): string {
    return warnSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
  }

  it('warns (throttled) when production issues non-Secure portal cookies over HTTP, with host + observed proto', () => {
    process.env.NODE_ENV = 'production';
    setPortalSessionCookies(makeCookieContext({ forwardedProto: 'http', host: 'rmm.example.com' }).c, 't');
    expect(allWarnings()).toContain('[portal] Issuing NON-Secure session cookies');
    expect(allWarnings()).toContain('rmm.example.com');
    expect(allWarnings()).toContain('"http"');
    const afterFirst = warnSpy.mock.calls.length;

    // Suppressed inside the throttle window…
    setPortalSessionCookies(makeCookieContext({ forwardedProto: 'http' }).c, 't');
    expect(warnSpy.mock.calls.length).toBe(afterFirst);
    // …and fires again after it.
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    setPortalSessionCookies(makeCookieContext({ forwardedProto: 'http' }).c, 't');
    expect(warnSpy.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('stays quiet for dev-over-http (the normal local flow)', () => {
    process.env.NODE_ENV = 'development';
    setPortalSessionCookies(makeCookieContext({ forwardedProto: 'http' }).c, 't');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('stays quiet for production-over-https', () => {
    process.env.NODE_ENV = 'production';
    setPortalSessionCookies(makeCookieContext({ forwardedProto: 'https' }).c, 't');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns that login WILL break when PORTAL_COOKIE_FORCE_SECURE forces Secure onto an http transport', () => {
    process.env.NODE_ENV = 'production';
    process.env.PORTAL_COOKIE_FORCE_SECURE = 'true';
    const { c, setCookies } = makeCookieContext({ forwardedProto: 'http' });
    setPortalSessionCookies(c, 't');
    expect(setCookies[0]).toContain('; Secure'); // cookie really is forced Secure
    expect(allWarnings()).toContain('WILL silently discard');
    expect(allWarnings()).toContain('PORTAL_COOKIE_FORCE_SECURE');
  });

  it('warns with the SameSite=None cause when SameSite=None forces Secure onto an http transport', () => {
    process.env.NODE_ENV = 'production';
    process.env.PORTAL_COOKIE_SAME_SITE = 'None';
    setPortalSessionCookies(makeCookieContext({ forwardedProto: 'http' }).c, 't');
    expect(allWarnings()).toContain('PORTAL_COOKIE_SAME_SITE=None');
    expect(allWarnings()).toContain('WILL silently discard');
  });
});
