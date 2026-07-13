import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import { Hono } from 'hono';
import {
  clearRefreshCookieOnly,
  clearRefreshTokenCookie,
  getAllowedOrigins,
  hashRecoveryCode,
  rotateCsrfBindingCookie,
  setRefreshTokenCookie,
  userRequiresSetup,
  validateTerminalCookieCsrfRequest,
} from './helpers';

describe('retired Cloudflare logout quarantine cookie', () => {
  it('never treats the legacy response cookie as refresh issuance authority', async () => {
    const app = new Hono();
    app.get('/issue', (c) => {
      setRefreshTokenCookie(c, 'new-refresh-token');
      return c.json({ success: true });
    });

    const response = await app.request('/issue', {
      headers: { cookie: 'breeze_cf_logout_quarantine=1' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie') ?? '').toContain('new-refresh-token');
    expect(response.headers.get('set-cookie') ?? '').not.toContain('breeze_cf_logout_quarantine');
  });
});

describe('durable browser binding cookies', () => {
  const csrf = 'a'.repeat(64);

  it('preserves a valid stable CSRF binding when installing a refresh token', async () => {
    const app = new Hono();
    app.get('/issue', (c) => {
      setRefreshTokenCookie(c, 'new-refresh-token');
      return c.json({ success: true });
    });

    const response = await app.request('/issue', {
      headers: { cookie: `breeze_csrf_token=${csrf}` },
    });
    const setCookie = response.headers.get('set-cookie') ?? '';

    expect(setCookie).toContain('breeze_refresh_token=new-refresh-token');
    expect(setCookie).toContain(`breeze_csrf_token=${csrf}`);
    expect(setCookie.match(/breeze_csrf_token=([0-9a-f]{64})/)?.[1]).toBe(csrf);
  });

  it('bootstraps a missing binding with a fresh 256-bit CSRF value', async () => {
    const app = new Hono();
    app.get('/issue', (c) => {
      setRefreshTokenCookie(c, 'new-refresh-token');
      return c.json({ success: true });
    });

    const response = await app.request('/issue');

    expect(response.headers.get('set-cookie') ?? '').toMatch(
      /breeze_csrf_token=[0-9a-f]{64}/,
    );
  });

  it('can clear only the refresh cookie while preserving the transition binding', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalSameSite = process.env.AUTH_COOKIE_SAME_SITE;
    process.env.NODE_ENV = 'production';
    process.env.AUTH_COOKIE_SAME_SITE = 'Strict';
    const app = new Hono();
    app.get('/clear', (c) => {
      clearRefreshCookieOnly(c);
      return c.json({ success: true });
    });

    try {
      const response = await app.request('/clear');
      const setCookie = response.headers.get('set-cookie') ?? '';

      expect(setCookie).toBe(
        'breeze_refresh_token=; Path=/api/v1/auth; HttpOnly; SameSite=Strict; Secure; Max-Age=0',
      );
      expect(setCookie).not.toContain('breeze_csrf_token=');
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      if (originalSameSite === undefined) delete process.env.AUTH_COOKIE_SAME_SITE;
      else process.env.AUTH_COOKIE_SAME_SITE = originalSameSite;
    }
  });

  it('keeps ordinary clearing behavior for non-terminal logout', async () => {
    const app = new Hono();
    app.get('/clear', (c) => {
      clearRefreshTokenCookie(c);
      return c.json({ success: true });
    });

    const response = await app.request('/clear');
    const setCookie = response.headers.get('set-cookie') ?? '';

    expect(setCookie).toContain('breeze_refresh_token=');
    expect(setCookie).toContain('breeze_csrf_token=');
  });

  it('installs an explicitly admitted replacement binding', async () => {
    const replacement = 'b'.repeat(64);
    const app = new Hono();
    app.get('/rotate', (c) => {
      rotateCsrfBindingCookie(c, replacement);
      return c.json({ success: true });
    });

    const response = await app.request('/rotate');

    expect(response.headers.get('set-cookie') ?? '').toContain(
      `breeze_csrf_token=${replacement}`,
    );
  });
});

describe('strict terminal cookie CSRF validation', () => {
  const csrf = 'c'.repeat(64);
  const originalNodeEnv = process.env.NODE_ENV;
  const originalCorsOrigins = process.env.CORS_ALLOWED_ORIGINS;

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com';
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalCorsOrigins === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = originalCorsOrigins;
  });

  function terminalApp(): Hono {
    const app = new Hono();
    app.post('/prepare', (c) => {
      const error = validateTerminalCookieCsrfRequest(c);
      return error
        ? c.json({ error }, 403)
        : c.json({ success: true });
    });
    return app;
  }

  it.each([
    ['missing cookie', {
      'x-breeze-csrf': csrf,
      origin: 'https://app.example.com',
      'sec-fetch-site': 'same-origin',
    }, 'Missing CSRF cookie'],
    ['missing header', {
      cookie: `breeze_csrf_token=${csrf}`,
      origin: 'https://app.example.com',
      'sec-fetch-site': 'same-origin',
    }, 'Missing CSRF header'],
    ['mismatch', {
      cookie: `breeze_csrf_token=${csrf}`,
      'x-breeze-csrf': 'd'.repeat(64),
      origin: 'https://app.example.com',
      'sec-fetch-site': 'same-origin',
    }, 'Invalid CSRF token'],
    ['malformed matching values', {
      cookie: 'breeze_csrf_token=matching-but-not-a-binding',
      'x-breeze-csrf': 'matching-but-not-a-binding',
      origin: 'https://app.example.com',
      'sec-fetch-site': 'same-origin',
    }, 'Invalid CSRF token'],
    ['disallowed origin', {
      cookie: `breeze_csrf_token=${csrf}`,
      'x-breeze-csrf': csrf,
      origin: 'https://evil.example.com',
      'sec-fetch-site': 'same-origin',
    }, 'Invalid request origin'],
    ['cross-site fetch', {
      cookie: `breeze_csrf_token=${csrf}`,
      'x-breeze-csrf': csrf,
      origin: 'https://app.example.com',
      'sec-fetch-site': 'cross-site',
    }, 'Cross-site request blocked'],
    ['missing origin', {
      cookie: `breeze_csrf_token=${csrf}`,
      'x-breeze-csrf': csrf,
      'sec-fetch-site': 'same-origin',
    }, 'Missing request origin'],
    ['missing fetch metadata', {
      cookie: `breeze_csrf_token=${csrf}`,
      'x-breeze-csrf': csrf,
      origin: 'https://app.example.com',
    }, 'Missing Sec-Fetch-Site header'],
  ])('rejects %s', async (_label, headers, expectedError) => {
    const response = await terminalApp().request('/prepare', {
      method: 'POST',
      headers,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: expectedError });
  });

  it('does not accept the header-only non-browser compatibility branch', async () => {
    const response = await terminalApp().request('/prepare', {
      method: 'POST',
      headers: { 'x-breeze-csrf': '1' },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Missing CSRF cookie' });
  });

  it.each(['same-origin', 'same-site'])(
    'accepts a matching cookie/header from an allowed %s request',
    async (fetchSite) => {
      const response = await terminalApp().request('/prepare', {
        method: 'POST',
        headers: {
          cookie: `breeze_csrf_token=${csrf}`,
          'x-breeze-csrf': csrf,
          origin: 'https://app.example.com',
          'sec-fetch-site': fetchSite,
        },
      });

      expect(response.status).toBe(200);
    },
  );
});

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
