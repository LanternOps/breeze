import { describe, expect, it } from 'vitest';
import { scrubEvent } from './sentry';

const CAPABILITIES = [
  'quote-capability-7c4c7a91',
  'invite-capability-4b2ab036',
  'provision-capability-9f3d913e',
  'installer-capability-6a1e25cf',
  'remote-capability-2d8b745a',
] as const;

function capabilityEvent(token: string): Record<string, unknown> {
  const rawPath = `/capability/${token}`;
  return {
    request: {
      method: 'GET',
      url: `https://api.example.test${rawPath}?token=${token}`,
      path: rawPath,
      query_string: `token=${token}`,
      fragment: token,
      headers: {
        authorization: `Bearer ${token}`,
        COOKIE: `session=${token}`,
        'X-Capability': token,
      },
      data: { token },
      cookies: { capability: token },
      env: { capability: token },
    },
    transaction: rawPath,
    message: token,
    logentry: { message: token, params: [token] },
    exception: {
      values: [{
        type: 'Error',
        value: `failed ${rawPath}`,
        mechanism: { type: token, data: { capability: token } },
        stacktrace: {
          frames: [{
            function: 'handleCapability',
            module: 'capabilities',
            lineno: 12,
            colno: 4,
            in_app: true,
            filename: `/srv/${token}.ts`,
            abs_path: `/srv/${token}.ts`,
            context_line: token,
            pre_context: [token],
            post_context: [token],
            vars: { capability: token },
          }],
        },
      }],
    },
    tags: {
      method: 'GET',
      route_template: '/capability/:token',
      path: rawPath,
      capability: token,
    },
    contexts: {
      request: { path: rawPath },
      arbitrary: { values: [token, { nested: token }] },
    },
    breadcrumbs: [{
      category: 'request',
      message: token,
      data: { url: rawPath, arbitrary: [token] },
    }],
    extra: {
      diagnostics: token,
      harmless: {
        arbitraryArray: [token, { innocentlyNamed: token }],
      },
    },
  };
}

describe('Sentry capability-path non-disclosure', () => {
  it.each(CAPABILITIES)(
    'removes %s and its distinctive substring from every serialized surface',
    (token) => {
      const out = scrubEvent(capabilityEvent(token) as any);
      const serialized = JSON.stringify(out);

      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain(token.slice(-8));
      expect(out.extra).toBeUndefined();
      expect(out.request).toEqual({ method: 'GET' });
      expect(out.tags).toEqual({
        method: 'GET',
        route_template: '/capability/:token',
      });
    },
  );
});
