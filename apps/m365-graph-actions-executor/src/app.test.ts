import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExecutorApp } from './app';
import { EventEmitter } from 'node:events';
import { reportStartupFailure, startExecutorServer } from './index';

const CORRELATION_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';

function executeActionRequestBody(overrides: Record<string, unknown> = {}) {
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

describe('executor HTTP app — execute-action', () => {
  it('authenticates the exact raw body before parsing JSON', async () => {
    const verify = vi.fn().mockRejectedValue(new Error('unauthorized'));
    const executeAction = vi.fn();
    const app = createExecutorApp({
      authenticator: { verify },
      completeConsent: vi.fn(),
      retest: vi.fn(),
      executeAction,
    });

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
    const body = executeActionRequestBody();
    const verify = vi.fn().mockResolvedValue({ correlationId: CORRELATION_ID });
    const executeAction = vi.fn().mockResolvedValue({ success: false, errorCode: 'application_token_invalid' });
    const app = createExecutorApp({
      authenticator: { verify },
      completeConsent: vi.fn(),
      retest: vi.fn(),
      executeAction,
    });

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

  it('bounds bodies before auth and exposes only the three POST operations', async () => {
    const verify = vi.fn();
    const app = createExecutorApp({
      authenticator: { verify },
      completeConsent: vi.fn(),
      retest: vi.fn(),
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
      completeConsent: vi.fn(),
      retest: vi.fn(),
      executeAction: vi.fn().mockRejectedValue(new Error('provider body with secret access-token')),
    });
    const response = await app.request('/v1/execute-action', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: executeActionRequestBody(),
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
    const app = createExecutorApp({
      authenticator: { verify },
      completeConsent: vi.fn(),
      retest: vi.fn(),
      executeAction,
    });

    const response = await app.request('/v1/execute-action', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: executeActionRequestBody(),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(stubbedResult);
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ operation: 'execute-action' }));
    expect(executeAction).toHaveBeenCalledOnce();
  });

  it('rejects an execute-action body whose correlationId does not match the authenticated one', async () => {
    const verify = vi.fn().mockResolvedValue({ correlationId: CORRELATION_ID });
    const executeAction = vi.fn();
    const app = createExecutorApp({
      authenticator: { verify },
      completeConsent: vi.fn(),
      retest: vi.fn(),
      executeAction,
    });

    const response = await app.request('/v1/execute-action', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: executeActionRequestBody({ correlationId: '99999999-9999-4999-8999-999999999999' }),
    });

    expect(response.status).toBe(401);
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('rejects an invalid execute-action body', async () => {
    const verify = vi.fn().mockResolvedValue({ correlationId: CORRELATION_ID });
    const executeAction = vi.fn();
    const app = createExecutorApp({
      authenticator: { verify },
      completeConsent: vi.fn(),
      retest: vi.fn(),
      executeAction,
    });

    const response = await app.request('/v1/execute-action', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: executeActionRequestBody({ tenantId: 'not-a-guid' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
    expect(executeAction).not.toHaveBeenCalled();
  });
});

describe('executor HTTP app — complete-consent / retest', () => {
  function retestBody(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({ correlationId: CORRELATION_ID, tenantId: TENANT_ID, ...overrides });
  }

  it('passes the exact UTF-8 bytes and fixed operation to auth before executing retest', async () => {
    const body = retestBody();
    const verify = vi.fn().mockResolvedValue({ correlationId: CORRELATION_ID });
    const retest = vi.fn().mockResolvedValue({ success: false, errorCode: 'application_token_invalid' });
    const app = createExecutorApp({
      authenticator: { verify },
      completeConsent: vi.fn(),
      retest,
      executeAction: vi.fn(),
    });

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

  it('sanitizes retest exceptions instead of classifying them as caller errors', async () => {
    const app = createExecutorApp({
      authenticator: { verify: vi.fn().mockResolvedValue({ correlationId: CORRELATION_ID }) },
      completeConsent: vi.fn(),
      retest: vi.fn().mockRejectedValue(new Error('provider body with secret access-token')),
      executeAction: vi.fn(),
    });
    const response = await app.request('/v1/retest', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: retestBody(),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal_error' });
  });

  it('serves POST /v1/complete-consent with the stubbed dependency result', async () => {
    const verify = vi.fn().mockResolvedValue({ correlationId: CORRELATION_ID });
    const stubbedResult = { success: false, errorCode: 'identity_token_invalid' };
    const completeConsent = vi.fn().mockResolvedValue(stubbedResult);
    const app = createExecutorApp({
      authenticator: { verify },
      completeConsent,
      retest: vi.fn(),
      executeAction: vi.fn(),
    });

    const response = await app.request('/v1/complete-consent', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify({
        correlationId: CORRELATION_ID,
        consentAttemptId: '33333333-3333-4333-8333-333333333333',
        tenantHint: TENANT_ID,
        authorizationCode: 'code',
        codeVerifier: 'v'.repeat(43),
        nonce: 'nonce',
        redirectUri: 'https://console.example.test/api/v1/m365/actions-consent/callback',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(stubbedResult);
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ operation: 'complete-consent' }));
    expect(completeConsent).toHaveBeenCalledOnce();
  });

  it('rejects a complete-consent body whose correlationId does not match the authenticated one', async () => {
    const verify = vi.fn().mockResolvedValue({ correlationId: CORRELATION_ID });
    const completeConsent = vi.fn();
    const app = createExecutorApp({
      authenticator: { verify },
      completeConsent,
      retest: vi.fn(),
      executeAction: vi.fn(),
    });

    const response = await app.request('/v1/complete-consent', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify({
        correlationId: '99999999-9999-4999-8999-999999999999',
        consentAttemptId: '33333333-3333-4333-8333-333333333333',
        tenantHint: TENANT_ID,
        authorizationCode: 'code',
        codeVerifier: 'v'.repeat(43),
        nonce: 'nonce',
        redirectUri: 'https://console.example.test/api/v1/m365/actions-consent/callback',
      }),
    });

    expect(response.status).toBe(401);
    expect(completeConsent).not.toHaveBeenCalled();
  });

  it('rejects an invalid complete-consent body', async () => {
    const verify = vi.fn().mockResolvedValue({ correlationId: CORRELATION_ID });
    const completeConsent = vi.fn();
    const app = createExecutorApp({
      authenticator: { verify },
      completeConsent,
      retest: vi.fn(),
      executeAction: vi.fn(),
    });

    const response = await app.request('/v1/complete-consent', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify({
        correlationId: CORRELATION_ID,
        consentAttemptId: '33333333-3333-4333-8333-333333333333',
        tenantHint: 'not-a-guid',
        authorizationCode: 'code',
        codeVerifier: 'v'.repeat(43),
        nonce: 'nonce',
        redirectUri: 'https://console.example.test/api/v1/m365/actions-consent/callback',
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
    expect(completeConsent).not.toHaveBeenCalled();
  });

  it('rejects a retest body whose correlationId does not match the authenticated one', async () => {
    const verify = vi.fn().mockResolvedValue({ correlationId: CORRELATION_ID });
    const retest = vi.fn();
    const app = createExecutorApp({
      authenticator: { verify },
      completeConsent: vi.fn(),
      retest,
      executeAction: vi.fn(),
    });

    const response = await app.request('/v1/retest', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: retestBody({ correlationId: '99999999-9999-4999-8999-999999999999' }),
    });

    expect(response.status).toBe(401);
    expect(retest).not.toHaveBeenCalled();
  });

  it('rejects an invalid retest body', async () => {
    const verify = vi.fn().mockResolvedValue({ correlationId: CORRELATION_ID });
    const retest = vi.fn();
    const app = createExecutorApp({
      authenticator: { verify },
      completeConsent: vi.fn(),
      retest,
      executeAction: vi.fn(),
    });

    const response = await app.request('/v1/retest', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: retestBody({ tenantId: 'not-a-guid' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
    expect(retest).not.toHaveBeenCalled();
  });
});

describe('executor process lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('logs the listen error code and exits non-zero when the server fails to bind', () => {
    const server = Object.assign(new EventEmitter(), { close: vi.fn() });
    const serve = vi.fn().mockReturnValue(server);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const app = createExecutorApp({
      authenticator: { verify: vi.fn() },
      completeConsent: vi.fn(),
      retest: vi.fn(),
      executeAction: vi.fn(),
    });

    startExecutorServer(app, { bindHost: '127.0.0.1', port: 8788 }, serve);
    server.emit('error', Object.assign(new Error('listen EADDRNOTAVAIL 127.0.0.1:1'), { code: 'EADDRNOTAVAIL' }));

    expect(errorLog).toHaveBeenCalledWith('[m365-graph-actions-executor] server error: EADDRNOTAVAIL');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('logs only the startup error message, never the stack, and sets a failing exit code', () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new Error('M365_GRAPH_ACTIONS_EXECUTOR_BIND_HOST must be a private IP interface');

    reportStartupFailure(error);

    expect(errorLog).toHaveBeenCalledOnce();
    expect(errorLog).toHaveBeenCalledWith(`[m365-graph-actions-executor] startup failed: ${error.message}`);
    expect(String(errorLog.mock.calls[0]?.[0])).not.toContain('    at ');
    expect(process.exitCode).toBe(1);
  });

  it('does not log non-Error startup rejections verbatim', () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    reportStartupFailure({ secret: 'do-not-log' });

    expect(errorLog).toHaveBeenCalledWith('[m365-graph-actions-executor] startup failed: unknown error');
    expect(process.exitCode).toBe(1);
  });
});
