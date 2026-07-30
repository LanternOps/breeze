import { describe, expect, it, vi } from 'vitest';
import { createExecutorApp } from './app';
import { startExecutorServer } from './index';

const CORRELATION_ID = '11111111-1111-4111-8111-111111111111';
const CONNECTION_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const USER_OBJECT_ID = '44444444-4444-4444-8444-444444444444';

const AUTHENTICATION = {
  correlationId: CORRELATION_ID,
  effectDigest: null,
  planDigest: null,
  consentGeneration: null,
};

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    correlationId: CORRELATION_ID,
    connectionId: CONNECTION_ID,
    tenantId: TENANT_ID,
    expectedUserObjectId: USER_OBJECT_ID,
    consentGeneration: 1,
    ...overrides,
  };
}

function readRequestBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify(baseRequest({
    action: { type: 'm365.comms.mail.get', messageId: 'AAMkAA==' },
    ...overrides,
  }));
}

function sendEnvelope(bodyText = 'Body') {
  return {
    envelopeVersion: 1,
    action: 'm365.comms.mail.send',
    actionVersion: 1,
    connectionId: CONNECTION_ID,
    tenantId: TENANT_ID,
    senderObjectId: USER_OBJECT_ID,
    consentGeneration: 1,
    to: ['a@example.com'],
    cc: [],
    bcc: [],
    subject: 'Subject',
    bodyText,
  };
}

function sendRequestBody(bodyText = 'Body') {
  return JSON.stringify(baseRequest({ envelope: sendEnvelope(bodyText) }));
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    authenticator: { verify: vi.fn().mockResolvedValue(AUTHENTICATION) },
    completeConsent: vi.fn(),
    retest: vi.fn(),
    revokeConnection: vi.fn(),
    executeAction: vi.fn(),
    ...overrides,
  };
}

describe('executor HTTP app — execute-action', () => {
  it('authenticates the exact raw body before parsing JSON', async () => {
    const verify = vi.fn().mockRejectedValue(new Error('unauthorized'));
    const executeAction = vi.fn();
    const app = createExecutorApp(deps({ authenticator: { verify }, executeAction }));

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
    const body = readRequestBody();
    const verify = vi.fn().mockResolvedValue(AUTHENTICATION);
    const executeAction = vi.fn().mockResolvedValue({ success: false, errorCode: 'credential_unavailable' });
    const app = createExecutorApp(deps({ authenticator: { verify }, executeAction }));

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

  it('accepts a request larger than the sibling 16 KiB default but under 128 KiB', async () => {
    // Pins the load-bearing cap divergence (design §2 item 1): a legal max-size
    // send is bigger than the sibling executors' whole request ceiling.
    const body = sendRequestBody('x'.repeat(20_000));
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(16 * 1024);
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(128 * 1024);
    const executeAction = vi.fn().mockResolvedValue({ success: false, errorCode: 'effect_digest_mismatch' });
    const app = createExecutorApp(deps({ executeAction }));

    const response = await app.request('/v1/execute-action', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body,
    });

    expect(response.status).toBe(200);
    expect(executeAction).toHaveBeenCalledOnce();
  });

  it('passes the authentication object verify returned to executeAction', async () => {
    const authentication = {
      correlationId: CORRELATION_ID,
      effectDigest: 'a'.repeat(64),
      planDigest: 'b'.repeat(64),
      consentGeneration: 1,
    };
    const executeAction = vi.fn().mockResolvedValue({ success: false, errorCode: 'effect_digest_mismatch' });
    const app = createExecutorApp(deps({
      authenticator: { verify: vi.fn().mockResolvedValue(authentication) },
      executeAction,
    }));

    const response = await app.request('/v1/execute-action', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: sendRequestBody(),
    });

    expect(response.status).toBe(200);
    expect(executeAction).toHaveBeenCalledOnce();
    expect(executeAction.mock.calls[0]![1]).toBe(authentication);
  });

  it('bounds bodies before auth and exposes only the four POST operations', async () => {
    const verify = vi.fn();
    const app = createExecutorApp(deps({ authenticator: { verify }, maxBodyBytes: 8 }));
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
    const app = createExecutorApp(deps({
      executeAction: vi.fn().mockRejectedValue(new Error('provider body with secret access-token')),
    }));
    const response = await app.request('/v1/execute-action', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: readRequestBody(),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal_error' });
  });

  it('binds the server only to the configured private interface and supports shutdown', () => {
    const close = vi.fn();
    const serve = vi.fn().mockReturnValue({ close });
    const app = createExecutorApp(deps());
    const server = startExecutorServer(app, { bindHost: '10.20.30.40', port: 3005 }, serve);
    expect(serve).toHaveBeenCalledWith({ fetch: app.fetch, hostname: '10.20.30.40', port: 3005 });
    server.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('serves POST /v1/execute-action with the stubbed dependency result', async () => {
    const stubbedResult = { success: false, errorCode: 'invalid_action' };
    const executeAction = vi.fn().mockResolvedValue(stubbedResult);
    const verify = vi.fn().mockResolvedValue(AUTHENTICATION);
    const app = createExecutorApp(deps({ authenticator: { verify }, executeAction }));

    const response = await app.request('/v1/execute-action', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: readRequestBody(),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(stubbedResult);
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ operation: 'execute-action' }));
    expect(executeAction).toHaveBeenCalledOnce();
  });

  it('rejects an execute-action body whose correlationId does not match the authenticated one', async () => {
    const executeAction = vi.fn();
    const app = createExecutorApp(deps({ executeAction }));

    const response = await app.request('/v1/execute-action', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: readRequestBody({ correlationId: '99999999-9999-4999-8999-999999999999' }),
    });

    expect(response.status).toBe(401);
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('rejects an invalid execute-action body', async () => {
    const executeAction = vi.fn();
    const app = createExecutorApp(deps({ executeAction }));

    const response = await app.request('/v1/execute-action', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: readRequestBody({ tenantId: 'not-a-guid' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('rejects a send arriving as tool-input action shape', async () => {
    const executeAction = vi.fn();
    const app = createExecutorApp(deps({ executeAction }));

    const response = await app.request('/v1/execute-action', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: readRequestBody({
        action: { type: 'm365.comms.mail.send', to: ['a@example.com'], subject: 's', bodyText: 'b' },
      }),
    });

    expect(response.status).toBe(400);
    expect(executeAction).not.toHaveBeenCalled();
  });
});

describe('executor HTTP app — complete-consent / retest / revoke-connection', () => {
  function retestBody(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      correlationId: CORRELATION_ID,
      connectionId: CONNECTION_ID,
      tenantId: TENANT_ID,
      expectedUserObjectId: USER_OBJECT_ID,
      consentGeneration: 1,
      ...overrides,
    });
  }

  function consentBody(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      correlationId: CORRELATION_ID,
      connectionId: CONNECTION_ID,
      consentAttemptId: '55555555-5555-4555-8555-555555555555',
      claimedConsentGeneration: 1,
      authorizationCode: 'code',
      codeVerifier: 'v'.repeat(43),
      nonce: 'nonce',
      redirectUri: 'https://console.example.test/api/v1/m365/comms-consent/callback',
      expectedTenantId: null,
      ...overrides,
    });
  }

  function revokeBody(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      correlationId: CORRELATION_ID,
      connectionId: CONNECTION_ID,
      consentAttemptId: null,
      ...overrides,
    });
  }

  it('passes the exact UTF-8 bytes and fixed operation to auth before executing retest', async () => {
    const body = retestBody();
    const verify = vi.fn().mockResolvedValue(AUTHENTICATION);
    const retest = vi.fn().mockResolvedValue({ success: false, errorCode: 'credential_unavailable' });
    const app = createExecutorApp(deps({ authenticator: { verify }, retest }));

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
    const app = createExecutorApp(deps({
      retest: vi.fn().mockRejectedValue(new Error('provider body with secret access-token')),
    }));
    const response = await app.request('/v1/retest', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: retestBody(),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal_error' });
  });

  it('serves POST /v1/complete-consent with the stubbed dependency result', async () => {
    const verify = vi.fn().mockResolvedValue(AUTHENTICATION);
    const stubbedResult = { success: false, errorCode: 'identity_token_invalid' };
    const completeConsent = vi.fn().mockResolvedValue(stubbedResult);
    const app = createExecutorApp(deps({ authenticator: { verify }, completeConsent }));

    const response = await app.request('/v1/complete-consent', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: consentBody(),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(stubbedResult);
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ operation: 'complete-consent' }));
    expect(completeConsent).toHaveBeenCalledOnce();
  });

  it('rejects a complete-consent body whose correlationId does not match the authenticated one', async () => {
    const completeConsent = vi.fn();
    const app = createExecutorApp(deps({ completeConsent }));

    const response = await app.request('/v1/complete-consent', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: consentBody({ correlationId: '99999999-9999-4999-8999-999999999999' }),
    });

    expect(response.status).toBe(401);
    expect(completeConsent).not.toHaveBeenCalled();
  });

  it('rejects an invalid complete-consent body', async () => {
    const completeConsent = vi.fn();
    const app = createExecutorApp(deps({ completeConsent }));

    const response = await app.request('/v1/complete-consent', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: consentBody({ expectedTenantId: 'not-a-guid' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
    expect(completeConsent).not.toHaveBeenCalled();
  });

  it('rejects a retest body whose correlationId does not match the authenticated one', async () => {
    const retest = vi.fn();
    const app = createExecutorApp(deps({ retest }));

    const response = await app.request('/v1/retest', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: retestBody({ correlationId: '99999999-9999-4999-8999-999999999999' }),
    });

    expect(response.status).toBe(401);
    expect(retest).not.toHaveBeenCalled();
  });

  it('rejects an invalid retest body', async () => {
    const retest = vi.fn();
    const app = createExecutorApp(deps({ retest }));

    const response = await app.request('/v1/retest', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: retestBody({ tenantId: 'not-a-guid' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
    expect(retest).not.toHaveBeenCalled();
  });

  it('serves POST /v1/revoke-connection with the stubbed dependency result', async () => {
    const verify = vi.fn().mockResolvedValue(AUTHENTICATION);
    const stubbedResult = { success: true, tombstoned: true };
    const revokeConnection = vi.fn().mockResolvedValue(stubbedResult);
    const app = createExecutorApp(deps({ authenticator: { verify }, revokeConnection }));

    const response = await app.request('/v1/revoke-connection', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: revokeBody({ consentAttemptId: '55555555-5555-4555-8555-555555555555' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(stubbedResult);
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ operation: 'revoke-connection' }));
    expect(revokeConnection).toHaveBeenCalledOnce();
  });

  it('rejects an invalid revoke-connection body and a mismatched correlationId', async () => {
    const revokeConnection = vi.fn();
    const app = createExecutorApp(deps({ revokeConnection }));

    const invalid = await app.request('/v1/revoke-connection', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: revokeBody({ connectionId: 'not-a-guid' }),
    });
    expect(invalid.status).toBe(400);

    const mismatched = await app.request('/v1/revoke-connection', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: revokeBody({ correlationId: '99999999-9999-4999-8999-999999999999' }),
    });
    expect(mismatched.status).toBe(401);
    expect(revokeConnection).not.toHaveBeenCalled();
  });
});
