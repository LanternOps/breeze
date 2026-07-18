import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import {
  getAllowedOrigins,
  hashRecoveryCode,
  userRequiresSetup,
  parsePendingMfa,
  evaluatePendingMfa,
  getClientRateLimitKey,
  isRequestConnectionSecure,
  buildRefreshTokenCookie,
  buildCsrfTokenCookie,
  buildClearRefreshTokenCookie,
  setRefreshTokenCookie,
  clearRefreshTokenCookie,
  type PendingMfaRecord,
} from './helpers';
import type { RequestLike } from '../../services/auditEvents';
import type { Context } from 'hono';

// Mirrors the canonical shim in services/clientIp.test.ts.
function makeContext(headers: Record<string, string | undefined>, remoteAddress?: string): RequestLike {
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) normalized[k.toLowerCase()] = v;
  }
  return {
    req: {
      header: (name: string) => normalized[name.toLowerCase()],
    },
    ...(remoteAddress
      ? { env: { incoming: { socket: { remoteAddress } } } }
      : {}),
  } as RequestLike;
}

describe('getAllowedOrigins (G5 — dev-origin gating)', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalCorsOrigins = process.env.CORS_ALLOWED_ORIGINS;
  const originalIncludeFlag = process.env.CORS_INCLUDE_DEFAULT_ORIGINS;

  beforeEach(() => {
    delete process.env.CORS_ALLOWED_ORIGINS;
    delete process.env.CORS_INCLUDE_DEFAULT_ORIGINS;
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalCorsOrigins === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = originalCorsOrigins;
    if (originalIncludeFlag === undefined) delete process.env.CORS_INCLUDE_DEFAULT_ORIGINS;
    else process.env.CORS_INCLUDE_DEFAULT_ORIGINS = originalIncludeFlag;
  });

  it('includes localhost dev origins in development', () => {
    process.env.NODE_ENV = 'development';
    const origins = getAllowedOrigins();
    expect(origins.has('http://localhost:4321')).toBe(true);
    expect(origins.has('http://127.0.0.1:4321')).toBe(true);
  });

  it('does NOT include localhost dev origins in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com';

    const origins = getAllowedOrigins();

    expect(origins.has('http://localhost:4321')).toBe(false);
    expect(origins.has('http://127.0.0.1:4321')).toBe(false);
    expect(origins.has('http://localhost:1420')).toBe(false);
    expect(origins.has('https://app.example.com')).toBe(true);
  });

  it('allows explicit opt-in via CORS_INCLUDE_DEFAULT_ORIGINS=true in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_INCLUDE_DEFAULT_ORIGINS = 'true';
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com';

    const origins = getAllowedOrigins();

    expect(origins.has('http://localhost:4321')).toBe(true);
    expect(origins.has('https://app.example.com')).toBe(true);
  });
});

describe('userRequiresSetup', () => {
  it('requires setup for the legacy development bootstrap admin until setup is completed', () => {
    expect(
      userRequiresSetup({
        email: 'admin@breeze.local',
        setupCompletedAt: null,
      }),
    ).toBe(true);
  });

  it('requires setup for operator-provided bootstrap admins marked during seed', () => {
    expect(
      userRequiresSetup({
        email: 'owner@example.test',
        setupCompletedAt: null,
        preferences: { bootstrapSetupRequired: true },
      }),
    ).toBe(true);
  });

  it('does not send normal invited or provisioned users through bootstrap setup', () => {
    expect(
      userRequiresSetup({
        email: 'tech@example.test',
        setupCompletedAt: null,
      }),
    ).toBe(false);
  });

  it('does not require setup once completed', () => {
    expect(
      userRequiresSetup({
        email: 'owner@example.test',
        setupCompletedAt: new Date(),
        preferences: { bootstrapSetupRequired: true },
      }),
    ).toBe(false);
  });
});

describe('MFA recovery code peppering', () => {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    MFA_RECOVERY_CODE_PEPPER: process.env.MFA_RECOVERY_CODE_PEPPER,
    APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY,
    SECRET_ENCRYPTION_KEY: process.env.SECRET_ENCRYPTION_KEY,
    JWT_SECRET: process.env.JWT_SECRET,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('uses only MFA_RECOVERY_CODE_PEPPER for recovery code hashes', () => {
    process.env.NODE_ENV = 'production';
    process.env.MFA_RECOVERY_CODE_PEPPER = 'dedicated-recovery-pepper-32-chars';
    process.env.APP_ENCRYPTION_KEY = 'app-key-must-not-be-used';
    process.env.SECRET_ENCRYPTION_KEY = 'secret-key-must-not-be-used';
    process.env.JWT_SECRET = 'jwt-key-must-not-be-used';

    expect(hashRecoveryCode('abcd-1234')).toBe(
      createHash('sha256')
        .update('dedicated-recovery-pepper-32-chars:ABCD-1234')
        .digest('hex')
    );
  });

  it('does not fall back to app, secret, or JWT keys when the pepper is missing', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.MFA_RECOVERY_CODE_PEPPER;
    process.env.APP_ENCRYPTION_KEY = 'app-key-must-not-be-used';
    process.env.SECRET_ENCRYPTION_KEY = 'secret-key-must-not-be-used';
    process.env.JWT_SECRET = 'jwt-key-must-not-be-used';

    expect(() => hashRecoveryCode('abcd-1234')).toThrow('MFA_RECOVERY_CODE_PEPPER');
  });
});

// SR2-06: the pending MFA record now carries an epoch/status binding so every
// completion path can detect a factor/status change that happened during the
// 5-minute MFA window and reject rather than mint stale assurance.
describe('parsePendingMfa (SR2-06 strict parse)', () => {
  const fullRecord: PendingMfaRecord = {
    userId: 'user-1',
    mfaMethod: 'totp',
    passkeyAvailable: false,
    authEpoch: 3,
    mfaEpoch: 5,
    statusExpectation: 'active',
    allowedMethods: { totp: true, sms: false, passkey: true },
    expiresAt: Date.now() + 300_000,
  };

  it('round-trips a full JSON record', () => {
    expect(parsePendingMfa(JSON.stringify(fullRecord))).toEqual(fullRecord);
  });

  it('returns null for the legacy bare-userId string form', () => {
    expect(parsePendingMfa('user-1')).toBeNull();
  });

  it('returns null for JSON missing authEpoch (pre-SR2-06 record)', () => {
    const { authEpoch, ...rest } = fullRecord;
    expect(parsePendingMfa(JSON.stringify(rest))).toBeNull();
  });

  it('returns null for JSON missing mfaEpoch', () => {
    const { mfaEpoch, ...rest } = fullRecord;
    expect(parsePendingMfa(JSON.stringify(rest))).toBeNull();
  });

  it('returns null for JSON missing allowedMethods', () => {
    const { allowedMethods, ...rest } = fullRecord;
    expect(parsePendingMfa(JSON.stringify(rest))).toBeNull();
  });

  it('returns null for an invalid mfaMethod value', () => {
    expect(parsePendingMfa(JSON.stringify({ ...fullRecord, mfaMethod: 'sms-code' }))).toBeNull();
  });

  it('returns null for malformed (non-JSON) input', () => {
    expect(parsePendingMfa('{not json')).toBeNull();
  });

  it('defaults a missing per-method allowedMethods flag to true (only explicit false disables)', () => {
    const parsed = parsePendingMfa(JSON.stringify({ ...fullRecord, allowedMethods: {} }));
    expect(parsed?.allowedMethods).toEqual({ totp: true, sms: true, passkey: true });
  });
});

describe('evaluatePendingMfa (SR2-06)', () => {
  const record: PendingMfaRecord = {
    userId: 'user-1',
    mfaMethod: 'totp',
    passkeyAvailable: false,
    authEpoch: 3,
    mfaEpoch: 5,
    statusExpectation: 'active',
    allowedMethods: { totp: true, sms: true, passkey: true },
    expiresAt: Date.now() + 300_000,
  };

  it('returns ok:true when live epochs and status match the pending record', () => {
    expect(evaluatePendingMfa(record, { status: 'active', authEpoch: 3, mfaEpoch: 5 })).toEqual({ ok: true });
  });

  it('returns epoch_mismatch when the live mfaEpoch has advanced past the pending record', () => {
    expect(evaluatePendingMfa(record, { status: 'active', authEpoch: 3, mfaEpoch: 6 })).toEqual({
      ok: false,
      reason: 'epoch_mismatch',
    });
  });

  it('returns epoch_mismatch when the live authEpoch has advanced past the pending record', () => {
    expect(evaluatePendingMfa(record, { status: 'active', authEpoch: 4, mfaEpoch: 5 })).toEqual({
      ok: false,
      reason: 'epoch_mismatch',
    });
  });

  it('returns status_changed when the live status is no longer active', () => {
    expect(evaluatePendingMfa(record, { status: 'suspended', authEpoch: 3, mfaEpoch: 5 })).toEqual({
      ok: false,
      reason: 'status_changed',
    });
  });

  it('returns status_changed when the live status differs from the recorded expectation', () => {
    const pendingCapturedInactive: PendingMfaRecord = { ...record, statusExpectation: 'invited' };
    // live.status is forced to 'active' here specifically to isolate the
    // statusExpectation-mismatch branch from the "not active" branch above.
    expect(evaluatePendingMfa(pendingCapturedInactive, { status: 'active', authEpoch: 3, mfaEpoch: 5 })).toEqual({
      ok: false,
      reason: 'status_changed',
    });
  });

  it('returns expired when expiresAt is in the past', () => {
    const expiredRecord: PendingMfaRecord = { ...record, expiresAt: Date.now() - 1 };
    expect(evaluatePendingMfa(expiredRecord, { status: 'active', authEpoch: 3, mfaEpoch: 5 })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });
});

describe('getClientRateLimitKey — spoof-proof per-IP key (SR2-16)', () => {
  const origTrust = process.env.TRUST_PROXY_HEADERS;
  beforeEach(() => { process.env.TRUST_PROXY_HEADERS = 'false'; }); // untrusted / no proxy trust
  afterEach(() => { if (origTrust === undefined) delete process.env.TRUST_PROXY_HEADERS; else process.env.TRUST_PROXY_HEADERS = origTrust; delete process.env.TRUST_CF_CONNECTING_IP; });

  it('keys on the SOCKET peer, so a rotating spoofed X-Forwarded-For from the same peer yields the SAME key (cannot evade the per-IP limit)', () => {
    // GUARD-BITE: RED today — the fingerprint hashes x-forwarded-for, so the two
    // keys differ and an attacker mints a fresh bucket per request.
    const a = getClientRateLimitKey(makeContext({ 'x-forwarded-for': '1.2.3.4' }, '198.51.100.77'));
    const b = getClientRateLimitKey(makeContext({ 'x-forwarded-for': '5.6.7.8' }, '198.51.100.77'));
    expect(a).toBe('socket:198.51.100.77');
    expect(b).toBe('socket:198.51.100.77');
    expect(a).toBe(b);
  });

  it('never includes spoofable IP headers in the fingerprint fallback (no socket, no trusted IP)', () => {
    const withHdr = getClientRateLimitKey(makeContext({ 'x-forwarded-for': '9.9.9.9', 'user-agent': 'UA' }));
    const noHdr = getClientRateLimitKey(makeContext({ 'user-agent': 'UA' }));
    expect(withHdr.startsWith('fp:')).toBe(true);
    expect(withHdr).toBe(noHdr); // x-forwarded-for must NOT change the fingerprint
  });

  it('prefers the trusted client IP when proxy trust is properly configured', () => {
    process.env.TRUST_PROXY_HEADERS = 'true';
    process.env.TRUSTED_PROXY_CIDRS = '198.51.100.77/32';
    process.env.TRUST_CF_CONNECTING_IP = 'true';
    const key = getClientRateLimitKey(makeContext({ 'cf-connecting-ip': '203.0.113.5' }, '198.51.100.77'));
    expect(key).toBe('ip:203.0.113.5');
    delete process.env.TRUSTED_PROXY_CIDRS;
  });
});

// Build a minimal Hono-ish Context for the auth-cookie helpers: a request with
// header lookup + url, and a `header()` sink that records appended Set-Cookie
// values so we can assert on the exact cookie strings emitted.
function makeCookieContext(opts: { forwardedProto?: string; url?: string }): {
  c: Context;
  setCookies: string[];
} {
  const setCookies: string[] = [];
  const headers: Record<string, string> = {};
  if (opts.forwardedProto !== undefined) headers['x-forwarded-proto'] = opts.forwardedProto;
  const c = {
    req: {
      header: (name: string) => headers[name.toLowerCase()],
      url: opts.url ?? 'http://api:3001/api/v1/auth/refresh',
    },
    header: (name: string, value: string) => {
      if (name.toLowerCase() === 'set-cookie') setCookies.push(value);
    },
  } as unknown as Context;
  return { c, setCookies };
}

describe('isRequestConnectionSecure (#1618 — Secure flag tracks real transport)', () => {
  it('true when X-Forwarded-Proto is https (Caddy behind TLS)', () => {
    expect(isRequestConnectionSecure(makeCookieContext({ forwardedProto: 'https' }).c)).toBe(true);
  });

  it('false when X-Forwarded-Proto is http (browser reached the site over HTTP)', () => {
    expect(isRequestConnectionSecure(makeCookieContext({ forwardedProto: 'http' }).c)).toBe(false);
  });

  it('uses the first (client-facing) hop of a proxy chain', () => {
    expect(isRequestConnectionSecure(makeCookieContext({ forwardedProto: 'https, http' }).c)).toBe(true);
    expect(isRequestConnectionSecure(makeCookieContext({ forwardedProto: 'http, https' }).c)).toBe(false);
  });

  it('treats an https:// request URL as a positive signal when no X-Forwarded-Proto is present (direct-to-API TLS)', () => {
    expect(isRequestConnectionSecure(makeCookieContext({ url: 'https://api.example.com/x' }).c)).toBe(true);
  });

  it('does NOT downgrade on an ambiguous http:// internal hop with no X-Forwarded-Proto — falls back to NODE_ENV', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    try {
      // In the standard topology c.req.url is the internal Caddy->API hop (http),
      // which must not force non-Secure on a genuinely HTTPS deployment whose
      // proxy stripped the header.
      process.env.NODE_ENV = 'production';
      expect(isRequestConnectionSecure(makeCookieContext({ url: 'http://api:3001/x' }).c)).toBe(true);
      process.env.NODE_ENV = 'development';
      expect(isRequestConnectionSecure(makeCookieContext({ url: 'http://api:3001/x' }).c)).toBe(false);
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });
});

describe('auth cookie Secure flag (#1618 regression)', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    delete process.env.AUTH_COOKIE_FORCE_SECURE;
    delete process.env.AUTH_COOKIE_SAME_SITE;
  });

  it('REGRESSION: production served over HTTP issues NON-Secure cookies so the browser keeps them', () => {
    process.env.NODE_ENV = 'production';
    const { c, setCookies } = makeCookieContext({ forwardedProto: 'http' });
    setRefreshTokenCookie(c, 'refresh.jwt.value');
    expect(setCookies).toHaveLength(2);
    const [refresh, csrf] = setCookies;
    expect(refresh).toContain('breeze_refresh_token=');
    expect(refresh).not.toContain('Secure');
    expect(csrf).not.toContain('Secure');
    // Attributes that must survive regardless of transport.
    expect(refresh).toContain('HttpOnly');
    expect(refresh).toContain('SameSite=Lax');
  });

  it('production served over HTTPS still issues Secure cookies', () => {
    process.env.NODE_ENV = 'production';
    const { c, setCookies } = makeCookieContext({ forwardedProto: 'https' });
    setRefreshTokenCookie(c, 'refresh.jwt.value');
    expect(setCookies[0]).toContain('; Secure');
    expect(setCookies[1]).toContain('; Secure');
  });

  it('AUTH_COOKIE_FORCE_SECURE overrides an http transport (paranoid setups)', () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_COOKIE_FORCE_SECURE = 'true';
    const { c, setCookies } = makeCookieContext({ forwardedProto: 'http' });
    setRefreshTokenCookie(c, 'refresh.jwt.value');
    expect(setCookies[0]).toContain('; Secure');
    expect(setCookies[1]).toContain('; Secure');
  });

  it('clear cookies mirror the set-cookie Secure flag for the same transport', () => {
    process.env.NODE_ENV = 'production';
    const { c, setCookies } = makeCookieContext({ forwardedProto: 'http' });
    clearRefreshTokenCookie(c);
    expect(setCookies).toHaveLength(2);
    expect(setCookies[0]).toContain('Max-Age=0');
    expect(setCookies[0]).not.toContain('Secure'); // an http clear must NOT be Secure or the browser ignores it
    expect(setCookies[1]).not.toContain('Secure');
  });

  it('build* functions default to the NODE_ENV heuristic when no transport is threaded', () => {
    process.env.NODE_ENV = 'production';
    expect(buildRefreshTokenCookie('t')).toContain('; Secure');
    expect(buildCsrfTokenCookie('t')).toContain('; Secure');
    expect(buildClearRefreshTokenCookie()).toContain('; Secure');
    // explicit transport wins over the default
    expect(buildRefreshTokenCookie('t', false)).not.toContain('Secure');
  });
});
