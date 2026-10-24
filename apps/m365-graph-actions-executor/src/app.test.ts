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
  it('has no /v1/complete-consent route: a signed request is a 404 and reaches no dependency', async () => {
    const verify = vi.fn().mockResolvedValue({ correlationId: '11111111-1111-4111-8111-111111111111' });
    const deps = {
      authenticator: { verify },
      verifyIdentity: vi.fn(),
      retest: vi.fn(),
      executeAction: vi.fn(),
    };
    const app = createExecutorApp(deps as unknown as Parameters<typeof createExecutorApp>[0]);

    const response = await app.request('/v1/complete-consent', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify({ correlationId: '11111111-1111-4111-8111-111111111111' }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
    expect(verify).not.toHaveBeenCalled();
    for (const dependency of [deps.verifyIdentity, deps.retest, deps.executeAction]) {
      expect(dependency).not.toHaveBeenCalled();
    }
  });

  it('authenticates the exact raw body before parsing JSON', async () => {
    const verify = vi.fn().mockRejectedValue(new Error('unauthorized'));
    const executeAction = vi.fn();
    const app = createExecutorApp({
      authenticator: { verify },
      verifyIdentity: vi.fn(),
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

  it('serves unauthenticated GET /version with the build version and sha, and nothing else', async () => {
    const verify = vi.fn();
    const app = createExecutorApp({
      authenticator: { verify },
      verifyIdentity: vi.fn(),
      retest: vi.fn(),
      executeAction: vi.fn(),
      buildInfo: { version: '1.2.3', gitSha: 'abc1234' },
    });
    const response = await app.request('/version');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: '1.2.3', gitSha: 'abc1234' });
    expect(verify).not.toHaveBeenCalled();
  });

  it('GET /version defaults to the baked APP_VERSION / GIT_SHA, reporting unknown for unusable values', async () => {
    const previous = { v: process.env.APP_VERSION, s: process.env.GIT_SHA };
    process.env.APP_VERSION = '9.9.9';
    process.env.GIT_SHA = 'not a sha';
    try {
      const app = createExecutorApp({
        authenticator: { verify: vi.fn() },
        verifyIdentity: vi.fn(),
        retest: vi.fn(),
        executeAction: vi.fn(),
      });
      expect(await (await app.request('/version')).json()).toEqual({ version: '9.9.9', gitSha: 'unknown' });
    } finally {
      if (previous.v === undefined) delete process.env.APP_VERSION; else process.env.APP_VERSION = previous.v;
      if (previous.s === undefined) delete process.env.GIT_SHA; else process.env.GIT_SHA = previous.s;
    }
  });

  it('passes the exact UTF-8 bytes and fixed operation to auth before executing', async () => {
    const body = executeActionRequestBody();
    const verify = vi.fn().mockResolvedValue({ correlationId: CORRELATION_ID });
    const executeAction = vi.fn().mockResolvedValue({ success: false, errorCode: 'application_token_invalid' });
    const app = createExecutorApp({
      authenticator: { verify },
      verifyIdentity: vi.fn(),
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
      verifyIdentity: vi.fn(),
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
      verifyIdentity: vi.fn(),
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
      verifyIdentity: vi.fn(),
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
      verifyIdentity: vi.fn(),
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
      verifyIdentity: vi.fn(),
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
      verifyIdentity: vi.fn(),
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

describe('executor HTTP app — retest', () => {
  function retestBody(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({ correlationId: CORRELATION_ID, tenantId: TENANT_ID, ...overrides });
  }

  it('passes the exact UTF-8 bytes and fixed operation to auth before executing retest', async () => {
    const body = retestBody();
    const verify = vi.fn().mockResolvedValue({ correlationId: CORRELATION_ID });
    const retest = vi.fn().mockResolvedValue({ success: false, errorCode: 'application_token_invalid' });
    const app = createExecutorApp({
      authenticator: { verify },
      verifyIdentity: vi.fn(),
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
      verifyIdentity: vi.fn(),
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

  it('rejects a retest body whose correlationId does not match the authenticated one', async () => {
    const verify = vi.fn().mockResolvedValue({ correlationId: CORRELATION_ID });
    const retest = vi.fn();
    const app = createExecutorApp({
      authenticator: { verify },
      verifyIdentity: vi.fn(),
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
      verifyIdentity: vi.fn(),
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
      verifyIdentity: vi.fn(),
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

describe('executor HTTP app: failure logging (#9322)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const FAILURE_LOG = '[m365-graph-actions-executor] request failed';
  const verifyBody = JSON.stringify({
    correlationId: CORRELATION_ID,
    consentAttemptId: '33333333-3333-4333-8333-333333333333',
    expectedTenantId: null,
    authorizationCode: 'auth-code-secret-9322',
    codeVerifier: 'v'.repeat(43),
    nonce: 'nonce-secret-9322',
    redirectUri: 'https://console.example.test/api/v1/m365/actions-consent/callback',
  });

  function captureLogs() {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const calls = () => [...warn.mock.calls, ...error.mock.calls];
    return {
      lines: () => calls().filter((call) => call[0] === FAILURE_LOG).map((call) => call[1] as Record<string, unknown>),
      serialized: () => JSON.stringify(calls()),
    };
  }

  function deps(verify: unknown, verifyIdentity: unknown = vi.fn()) {
    return {
      authenticator: { verify }, verifyIdentity, retest: vi.fn(), executeAction: vi.fn(),
    } as unknown as Parameters<typeof createExecutorApp>[0];
  }

  function expectNoSecrets(serialized: string) {
    for (const secret of ['auth-code-secret-9322', 'nonce-secret-9322', 'v'.repeat(43), 'Bearer ', 'signed-token']) {
      expect(serialized).not.toContain(secret);
    }
  }

  it('a 401 from a token that does not verify logs one line with the operation and no correlation ID', async () => {
    const logs = captureLogs();
    const app = createExecutorApp(deps(vi.fn().mockRejectedValue(new Error('unauthorized'))));

    const response = await app.request('/v1/verify-identity', {
      method: 'POST',
      headers: { authorization: 'Bearer signed-token', 'content-type': 'application/json' },
      body: verifyBody,
    });

    expect(response.status).toBe(401);
    expect(logs.lines()).toEqual([{ operation: 'verify-identity', status: 401, error: 'unauthorized' }]);
    expectNoSecrets(logs.serialized());
  });

  it('a 401 for a verified token whose correlation ID disagrees logs the verified correlation ID', async () => {
    const logs = captureLogs();
    const app = createExecutorApp(deps(vi.fn().mockResolvedValue({ correlationId: '99999999-9999-4999-8999-999999999999' })));

    const response = await app.request('/v1/verify-identity', {
      method: 'POST',
      headers: { authorization: 'Bearer signed-token', 'content-type': 'application/json' },
      body: verifyBody,
    });

    expect(response.status).toBe(401);
    expect(logs.lines()).toEqual([{
      operation: 'verify-identity', correlationId: '99999999-9999-4999-8999-999999999999', status: 401, error: 'unauthorized',
    }]);
    expectNoSecrets(logs.serialized());
  });

  it('a 404 for a route this executor does not serve logs one line naming the requested operation', async () => {
    const logs = captureLogs();
    const verify = vi.fn();
    const app = createExecutorApp(deps(verify));

    const response = await app.request('/v1/not-yet-shipped', {
      method: 'POST',
      headers: { authorization: 'Bearer signed-token', 'content-type': 'application/json' },
      body: verifyBody,
    });

    expect(response.status).toBe(404);
    expect(logs.lines()).toEqual([{ operation: 'not-yet-shipped', status: 404, error: 'not_found' }]);
    expect(verify).not.toHaveBeenCalled();
    expectNoSecrets(logs.serialized());
  });

  it('a 500 from a throwing operation logs its operation, correlation ID and error class only', async () => {
    const logs = captureLogs();
    const verifyIdentity = vi.fn().mockRejectedValue(Object.assign(new Error('token auth-code-secret-9322 leaked'), { name: 'TokenRedeemError' }));
    const app = createExecutorApp(deps(vi.fn().mockResolvedValue({ correlationId: CORRELATION_ID }), verifyIdentity));

    const response = await app.request('/v1/verify-identity', {
      method: 'POST',
      headers: { authorization: 'Bearer signed-token', 'content-type': 'application/json' },
      body: verifyBody,
    });

    expect(response.status).toBe(500);
    expect(logs.lines()).toEqual([{
      operation: 'verify-identity', correlationId: CORRELATION_ID, status: 500, error: 'internal_error', errorName: 'TokenRedeemError',
    }]);
    expectNoSecrets(logs.serialized());
  });
});
