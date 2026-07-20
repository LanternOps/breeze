import { describe, expect, it, vi } from 'vitest';
import { createExecutorApp } from './app';
import { startExecutorServer } from './index';

const CORRELATION_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';

function requestBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    correlationId: CORRELATION_ID,
    tenantId: TENANT_ID,
    idempotencyKey: 'intent-1',
    action: {
      type: 'm365.user.disable',
      userIdentifier: 'user@example.test',
      reason: 'compromised credentials',
    },
    ...overrides,
  });
}

describe('executor HTTP app', () => {
  it('authenticates the exact raw body before parsing JSON', async () => {
    const verify = vi.fn().mockRejectedValue(new Error('unauthorized'));
    const executeAction = vi.fn();
    const app = createExecutorApp({ authenticator: { verify }, executeAction });

    const response = await app.request('/v1/execute-action', {
      method: 'POST',
      headers: { authorization: 'Bearer invalid', 'content-type': 'application/json' },
      body: '{not-json',
    });

    expect(response.status).toBe(401);
    expect(verify).toHaveBeenCalledOnce();
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('passes the exact UTF-8 bytes and fixed operation to auth before executing', async () => {
    const body = requestBody();
    const verify = vi.fn().mockResolvedValue({ correlationId: CORRELATION_ID });
    const executeAction = vi.fn().mockResolvedValue({ success: false, errorCode: 'application_token_invalid' });
    const app = createExecutorApp({ authenticator: { verify }, executeAction });

    const response = await app.request('/v1/execute-action', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body,
    });

    expect(response.status).toBe(200);
    expect(verify).toHaveBeenCalledWith({
      authorization: 'Bearer token',
      operation: 'execute-action',
      rawBody: new TextEncoder().encode(body),
    });
    expect(executeAction).toHaveBeenCalledOnce();
  });

  it('bounds bodies before auth and exposes only the one POST operation', async () => {
    const verify = vi.fn();
    const app = createExecutorApp({
      authenticator: { verify },
      executeAction: vi.fn(),
      maxBodyBytes: 8,
    });
    const oversized = await app.request('/v1/execute-action', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: '{"more":true}',
    });
    expect(oversized.status).toBe(413);
    expect(verify).not.toHaveBeenCalled();
    expect((await app.request('/v1/execute-action')).status).toBe(404);
    expect((await app.request('/v1/arbitrary', { method: 'POST' })).status).toBe(404);
    expect(await (await app.request('/healthz')).json()).toEqual({ status: 'ok' });
  });

  it('sanitizes operation exceptions instead of classifying them as caller errors', async () => {
    const app = createExecutorApp({
      authenticator: { verify: vi.fn().mockResolvedValue({ correlationId: CORRELATION_ID }) },
      executeAction: vi.fn().mockRejectedValue(new Error('provider body with secret access-token')),
    });
    const response = await app.request('/v1/execute-action', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: requestBody(),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal_error' });
  });

  it('binds the server only to the configured private interface and supports shutdown', () => {
    const close = vi.fn();
    const serve = vi.fn().mockReturnValue({ close });
    const app = createExecutorApp({
      authenticator: { verify: vi.fn() },
      executeAction: vi.fn(),
    });
    const server = startExecutorServer(app, { bindHost: '10.20.30.40', port: 8788 }, serve);
    expect(serve).toHaveBeenCalledWith({ fetch: app.fetch, hostname: '10.20.30.40', port: 8788 });
    server.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('serves POST /v1/execute-action with the stubbed dependency result', async () => {
    const verify = vi.fn().mockResolvedValue({ correlationId: CORRELATION_ID });
    const stubbedResult = { success: false, errorCode: 'invalid_action' };
    const executeAction = vi.fn().mockResolvedValue(stubbedResult);
    const app = createExecutorApp({ authenticator: { verify }, executeAction });

    const response = await app.request('/v1/execute-action', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: requestBody(),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(stubbedResult);
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ operation: 'execute-action' }));
    expect(executeAction).toHaveBeenCalledOnce();
  });

  it('rejects an execute-action body whose correlationId does not match the authenticated one', async () => {
    const verify = vi.fn().mockResolvedValue({ correlationId: CORRELATION_ID });
    const executeAction = vi.fn();
    const app = createExecutorApp({ authenticator: { verify }, executeAction });

    const response = await app.request('/v1/execute-action', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: requestBody({ correlationId: '99999999-9999-4999-8999-999999999999' }),
    });

    expect(response.status).toBe(401);
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('rejects an invalid execute-action body', async () => {
    const verify = vi.fn().mockResolvedValue({ correlationId: CORRELATION_ID });
    const executeAction = vi.fn();
    const app = createExecutorApp({ authenticator: { verify }, executeAction });

    const response = await app.request('/v1/execute-action', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: requestBody({ tenantId: 'not-a-guid' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
    expect(executeAction).not.toHaveBeenCalled();
  });
});
