import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';

const transition = vi.hoisted(() => ({
  resolve: vi.fn(),
  rotate: vi.fn(),
}));

vi.mock('../../services/authBrowserTransition', () => {
  class AuthBindingRotationRequiredError extends Error {
    readonly status = 428;
    constructor(
      readonly replacement: { kind: 'browser' | 'native'; value: string },
      readonly reason: 'missing' | 'invalid' | 'expired' | 'retired',
    ) {
      super('rotation required');
    }
  }
  class AuthBindingUnavailableError extends Error {
    readonly status = 409;
    constructor(readonly reason: 'active' | 'logout_pending' | 'missing') {
      super('binding unavailable');
    }
  }
  class AuthIssuanceCapabilityError extends Error {
    readonly status = 409;
  }
  return {
    AuthBindingRotationRequiredError,
    AuthBindingUnavailableError,
    AuthIssuanceCapabilityError,
    NATIVE_AUTH_BINDING_HEADER: 'x-breeze-native-auth-binding',
    resolveAuthBinding: transition.resolve,
    rotateExpiredBinding: transition.rotate,
  };
});

import {
  AUTH_BINDING_COOKIE_NAME,
  NATIVE_AUTH_BINDING_HEADER,
  authBindingRoutes,
  buildAuthBindingCookie,
  buildClearAuthBindingCookie,
  installAuthBindingReplacement,
  requestAuthBinding,
} from './binding';
import {
  AuthBindingRotationRequiredError,
  AuthBindingUnavailableError,
} from '../../services/authBrowserTransition';

const C1 = '1'.repeat(64);
const C2 = '2'.repeat(64);

afterEach(() => {
  vi.unstubAllEnvs();
});

function context(headers: Record<string, string> = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const responseHeaders: Array<[string, string]> = [];
  return {
    c: {
      req: {
        header: (name: string) => normalized[name.toLowerCase()],
        url: 'https://app.example.test/api/v1/auth/browser-binding/bootstrap',
      },
      header: (name: string, value: string) => responseHeaders.push([name.toLowerCase(), value]),
    } as unknown as Context,
    responseHeaders,
  };
}

describe('dedicated auth binding transport', () => {
  it('builds a host-only HttpOnly cookie with the trusted transport Secure decision', () => {
    expect(buildAuthBindingCookie(C1, true)).toBe(
      `breeze_auth_binding=${C1}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=604800`,
    );
    expect(buildAuthBindingCookie(C1, false)).not.toContain('Secure');
    expect(buildClearAuthBindingCookie(true)).toBe(
      'breeze_auth_binding=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0',
    );
    expect(buildAuthBindingCookie(C1, true)).not.toContain('Domain=');
  });

  it('reads a native binding header before the browser cookie', () => {
    const { c } = context({
      [NATIVE_AUTH_BINDING_HEADER]: C2,
      cookie: `${AUTH_BINDING_COOKIE_NAME}=${C1}`,
    });
    expect(requestAuthBinding(c)).toEqual({ kind: 'native', value: C2 });
  });

  it('uses raw mobile metadata only to select missing native transport authority', () => {
    const { c } = context({
      'x-breeze-mobile-device-id': 'client-selected-install-id',
      cookie: `${AUTH_BINDING_COOKIE_NAME}=${C1}`,
    });
    expect(requestAuthBinding(c)).toEqual({ kind: 'native', value: '' });
  });

  it('reads the dedicated cookie without reusing the CSRF cookie', () => {
    const { c } = context({
      cookie: `breeze_csrf_token=csrf-only; ${AUTH_BINDING_COOKIE_NAME}=${C1}`,
    });
    expect(requestAuthBinding(c)).toEqual({ kind: 'browser', value: C1 });
    expect(requestAuthBinding(context({ cookie: 'breeze_csrf_token=csrf-only' }).c))
      .toEqual({ kind: 'browser', value: '' });
  });

  it('installs browser replacements as cookies and native replacements as headers', () => {
    const browser = context();
    installAuthBindingReplacement(browser.c, { kind: 'browser', value: C1 });
    expect(browser.responseHeaders).toEqual([
      ['set-cookie', expect.stringContaining(`${AUTH_BINDING_COOKIE_NAME}=${C1}`)],
    ]);

    const native = context();
    installAuthBindingReplacement(native.c, { kind: 'native', value: C2 });
    expect(native.responseHeaders).toEqual([[NATIVE_AUTH_BINDING_HEADER, C2]]);
  });
});

describe('POST /browser-binding/bootstrap', () => {
  const app = new Hono().route('/', authBindingRoutes);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://app.example.test');
    transition.resolve.mockReturnValue({ kind: 'browser', bindingDigest: 'f'.repeat(64) });
    transition.rotate.mockRejectedValue(new AuthBindingUnavailableError('active'));
  });

  it('validates and installs an existing binding without granting account authority', async () => {
    const response = await app.request('/browser-binding/bootstrap', {
      method: 'POST',
      headers: {
        origin: 'https://app.example.test',
        'sec-fetch-site': 'same-origin',
        cookie: `${AUTH_BINDING_COOKIE_NAME}=${C1}`,
        'x-forwarded-proto': 'https',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('set-cookie')).toContain(`${AUTH_BINDING_COOKIE_NAME}=${C1}`);
    expect(transition.resolve).toHaveBeenCalledWith({ kind: 'browser', value: C1 });
    expect(transition.rotate).toHaveBeenCalledWith({ kind: 'browser', value: C1 });
    expect(await response.text()).toBe('');
  });

  it('accepts a valid binding that has no durable transition row yet', async () => {
    transition.rotate.mockRejectedValueOnce(new AuthBindingUnavailableError('missing'));

    const response = await app.request('/browser-binding/bootstrap', {
      method: 'POST',
      headers: {
        origin: 'https://app.example.test',
        'sec-fetch-site': 'same-origin',
        cookie: `${AUTH_BINDING_COOKIE_NAME}=${C1}`,
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('set-cookie')).toContain(`${AUTH_BINDING_COOKIE_NAME}=${C1}`);
  });

  it.each(['expired', 'retired'] as const)(
    'installs the durable deterministic successor for a %s binding',
    async () => {
      transition.rotate.mockResolvedValueOnce({ kind: 'browser', value: C2 });

      const response = await app.request('/browser-binding/bootstrap', {
        method: 'POST',
        headers: {
          origin: 'https://app.example.test',
          'sec-fetch-site': 'same-origin',
          cookie: `${AUTH_BINDING_COOKIE_NAME}=${C1}`,
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get('set-cookie')).toContain(`${AUTH_BINDING_COOKIE_NAME}=${C2}`);
    },
  );

  it('rejects a binding while terminal logout is still pending', async () => {
    transition.rotate.mockRejectedValueOnce(new AuthBindingUnavailableError('logout_pending'));

    const response = await app.request('/browser-binding/bootstrap', {
      method: 'POST',
      headers: {
        origin: 'https://app.example.test',
        'sec-fetch-site': 'same-origin',
        cookie: `${AUTH_BINDING_COOKIE_NAME}=${C1}`,
      },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Authentication logout is still pending',
      reason: 'auth_logout_pending',
    });
  });

  it.each(['missing', 'invalid'] as const)(
    'bootstraps a fresh binding when the request binding is %s',
    async (reason) => {
      transition.resolve.mockImplementationOnce(() => {
        throw new AuthBindingRotationRequiredError({ kind: 'browser', value: C2 }, reason);
      });
      const cookie = reason === 'invalid'
        ? `${AUTH_BINDING_COOKIE_NAME}=not-valid`
        : undefined;

      const response = await app.request('/browser-binding/bootstrap', {
        method: 'POST',
        headers: {
          origin: 'https://app.example.test',
          'sec-fetch-site': 'same-origin',
          'x-forwarded-proto': 'https',
          ...(cookie ? { cookie } : {}),
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get('set-cookie')).toContain(`${AUTH_BINDING_COOKIE_NAME}=${C2}`);
    },
  );

  it('rejects a present Origin outside the configured allowlist', async () => {
    const response = await app.request('/browser-binding/bootstrap', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' },
    });
    expect(response.status).toBe(403);
    expect(transition.resolve).not.toHaveBeenCalled();
  });

  it('rejects Sec-Fetch-Site cross-site even when Origin is otherwise allowed', async () => {
    const response = await app.request('/browser-binding/bootstrap', {
      method: 'POST',
      headers: { origin: 'https://app.example.test', 'sec-fetch-site': 'cross-site' },
    });
    expect(response.status).toBe(403);
    expect(transition.resolve).not.toHaveBeenCalled();
  });
});
