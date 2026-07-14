import { describe, expect, it, vi } from 'vitest';
import { createExecutorApp } from './app';
import { startExecutorServer } from './index';

describe('executor HTTP app', () => {
  it('authenticates the exact raw body before parsing JSON', async () => {
    const verify = vi.fn().mockRejectedValue(new Error('unauthorized'));
    const completeConsent = vi.fn();
    const app = createExecutorApp({
      authenticator: { verify },
      completeConsent,
      retest: vi.fn(),
    });

    const response = await app.request('/v1/complete-consent', {
      method: 'POST',
      headers: { authorization: 'Bearer invalid', 'content-type': 'application/json' },
      body: '{not-json',
    });

    expect(response.status).toBe(401);
    expect(verify).toHaveBeenCalledOnce();
    expect(completeConsent).not.toHaveBeenCalled();
  });

  it('passes the exact UTF-8 bytes and fixed operation to auth before executing', async () => {
    const body = JSON.stringify({
      correlationId: '11111111-1111-4111-8111-111111111111',
      tenantId: '22222222-2222-4222-8222-222222222222',
    });
    const verify = vi.fn().mockResolvedValue({ correlationId: '11111111-1111-4111-8111-111111111111' });
    const retest = vi.fn().mockResolvedValue({ success: false, errorCode: 'application_token_invalid' });
    const app = createExecutorApp({ authenticator: { verify }, completeConsent: vi.fn(), retest });

    const response = await app.request('/v1/retest', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body,
    });

    expect(response.status).toBe(200);
    expect(verify).toHaveBeenCalledWith({
      authorization: 'Bearer token',
      operation: 'retest',
      rawBody: new TextEncoder().encode(body),
    });
    expect(retest).toHaveBeenCalledOnce();
  });

  it('bounds bodies before auth and exposes only the two POST operations', async () => {
    const verify = vi.fn();
    const app = createExecutorApp({
      authenticator: { verify },
      completeConsent: vi.fn(),
      retest: vi.fn(),
      maxBodyBytes: 8,
    });
    const oversized = await app.request('/v1/retest', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: '{"more":true}',
    });
    expect(oversized.status).toBe(413);
    expect(verify).not.toHaveBeenCalled();
    expect((await app.request('/v1/retest')).status).toBe(404);
    expect((await app.request('/v1/arbitrary', { method: 'POST' })).status).toBe(404);
    expect(await (await app.request('/healthz')).json()).toEqual({ status: 'ok' });
  });

  it('sanitizes operation exceptions instead of classifying them as caller errors', async () => {
    const app = createExecutorApp({
      authenticator: { verify: vi.fn().mockResolvedValue({ correlationId: '11111111-1111-4111-8111-111111111111' }) },
      completeConsent: vi.fn(),
      retest: vi.fn().mockRejectedValue(new Error('provider body with secret access-token')),
    });
    const response = await app.request('/v1/retest', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify({
        correlationId: '11111111-1111-4111-8111-111111111111',
        tenantId: '22222222-2222-4222-8222-222222222222',
      }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal_error' });
  });

  it('binds the server only to the configured private interface and supports shutdown', () => {
    const close = vi.fn();
    const serve = vi.fn().mockReturnValue({ close });
    const app = createExecutorApp({
      authenticator: { verify: vi.fn() },
      completeConsent: vi.fn(),
      retest: vi.fn(),
    });
    const server = startExecutorServer(app, { bindHost: '10.20.30.40', port: 8788 }, serve);
    expect(serve).toHaveBeenCalledWith({ fetch: app.fetch, hostname: '10.20.30.40', port: 8788 });
    server.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
