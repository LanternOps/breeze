import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createExecutorApp, type ExecutorAppDependencies } from './app';
import { createEdDsaInternalRequestAuthenticator, type InternalRequestAuthenticator } from './internalAuth';

// POST /v1/verify-identity behind the REAL EdDSA internal authenticator, so the
// operation-claim binding is exercised end to end rather than stubbed.

const AUDIENCE = 'm365-graph-actions-executor';
const OTHER_OPERATION = 'execute-action';
const CORRELATION_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_ID = '33333333-3333-4333-8333-333333333333';

const VERIFY_REQUEST = {
  correlationId: CORRELATION_ID,
  consentAttemptId: '44444444-4444-4444-8444-444444444444',
  expectedTenantId: null,
  authorizationCode: 'authorization-code',
  codeVerifier: 'v'.repeat(43),
  nonce: 'nonce',
  redirectUri: 'https://console.example.test/api/v1/m365/consent/callback',
};

const VERIFIED = {
  success: true,
  tenantId: TENANT_ID,
  administratorObjectId: ADMIN_ID,
  administratorUsername: 'admin@tenant.example',
  verifiedAt: '2026-10-03T12:00:00.000Z',
};

let privateKey: CryptoKey;
let authenticator: InternalRequestAuthenticator;

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA');
  privateKey = pair.privateKey;
  const publicJwk = { ...await exportJWK(pair.publicKey), kid: 'api-key-1' };
  authenticator = await createEdDsaInternalRequestAuthenticator({ publicJwk, kid: 'api-key-1' });
});

async function mint(operation: string, body: string, correlationId = CORRELATION_ID): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    operation,
    correlationId,
    bodySha256: Buffer.from(digest).toString('base64url'),
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'api-key-1' })
    .setIssuer('breeze-api')
    .setAudience(AUDIENCE)
    .setSubject('breeze-control-plane')
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .setJti(crypto.randomUUID())
    .sign(privateKey);
}

function app(overrides: Partial<ExecutorAppDependencies> = {}) {
  const deps = {
    authenticator,
    completeConsent: vi.fn(),
    retest: vi.fn(),
    readAction: vi.fn(),
    syncAction: vi.fn(),
    executeAction: vi.fn(),
    verifyIdentity: vi.fn().mockResolvedValue(VERIFIED),
    ...overrides,
  } as unknown as ExecutorAppDependencies;
  return { deps, app: createExecutorApp(deps) };
}

async function post(target: ReturnType<typeof app>['app'], path: string, body: string, token: string) {
  return await target.request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body,
  });
}

describe('POST /v1/verify-identity', () => {
  it('executes a verify-identity request and returns the identity-only result', async () => {
    const { app: target, deps } = app();
    const body = JSON.stringify(VERIFY_REQUEST);
    const response = await post(target, '/v1/verify-identity', body, await mint('verify-identity', body));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(VERIFIED);
    expect(deps.verifyIdentity).toHaveBeenCalledWith(VERIFY_REQUEST);
  });

  it.each(['identity_token_invalid', 'tenant_mismatch', 'admin_role_required', 'credential_unavailable'])(
    'passes the %s failure through',
    async (errorCode) => {
      const { app: target } = app({ verifyIdentity: vi.fn().mockResolvedValue({ success: false, errorCode }) });
      const body = JSON.stringify({ ...VERIFY_REQUEST, expectedTenantId: TENANT_ID });
      const response = await post(target, '/v1/verify-identity', body, await mint('verify-identity', body));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: false, errorCode });
    },
  );

  it.each(['complete-consent', 'retest', OTHER_OPERATION])(
    'rejects a token minted for %s',
    async (operation) => {
      const { app: target, deps } = app();
      const body = JSON.stringify(VERIFY_REQUEST);
      const response = await post(target, '/v1/verify-identity', body, await mint(operation, body));
      expect(response.status).toBe(401);
      expect(deps.verifyIdentity).not.toHaveBeenCalled();
    },
  );

  it('does not let a verify-identity token reach complete-consent or retest', async () => {
    const { app: target, deps } = app();
    const completeBody = JSON.stringify({
      ...VERIFY_REQUEST,
      expectedTenantId: undefined,
      tenantHint: TENANT_ID,
    });
    const complete = await post(target, '/v1/complete-consent', completeBody, await mint('verify-identity', completeBody));
    expect(complete.status).toBe(401);
    expect(deps.completeConsent).not.toHaveBeenCalled();

    const retestBody = JSON.stringify({ correlationId: CORRELATION_ID, tenantId: TENANT_ID });
    const retest = await post(target, '/v1/retest', retestBody, await mint('verify-identity', retestBody));
    expect(retest.status).toBe(401);
    expect(deps.retest).not.toHaveBeenCalled();
  });

  it('rejects a body that differs from the signed digest', async () => {
    const { app: target, deps } = app();
    const signed = JSON.stringify(VERIFY_REQUEST);
    const sent = JSON.stringify({ ...VERIFY_REQUEST, expectedTenantId: TENANT_ID });
    const response = await post(target, '/v1/verify-identity', sent, await mint('verify-identity', signed));
    expect(response.status).toBe(401);
    expect(deps.verifyIdentity).not.toHaveBeenCalled();
  });

  it('rejects a body whose correlationId differs from the authenticated one', async () => {
    const { app: target, deps } = app();
    const body = JSON.stringify(VERIFY_REQUEST);
    const token = await mint('verify-identity', body, '99999999-9999-4999-8999-999999999999');
    const response = await post(target, '/v1/verify-identity', body, token);
    expect(response.status).toBe(401);
    expect(deps.verifyIdentity).not.toHaveBeenCalled();
  });

  it.each([
    ['the legacy tenantHint field', JSON.stringify({ ...VERIFY_REQUEST, tenantHint: TENANT_ID })],
    ['the organizations literal as expected tenant', JSON.stringify({ ...VERIFY_REQUEST, expectedTenantId: 'organizations' })],
    ['a missing expectedTenantId', JSON.stringify({ ...VERIFY_REQUEST, expectedTenantId: undefined })],
    ['a short code verifier', JSON.stringify({ ...VERIFY_REQUEST, codeVerifier: 'short' })],
    ['malformed JSON', '{not-json'],
  ])('rejects %s as invalid_request', async (_label, body) => {
    const { app: target, deps } = app();
    const response = await post(target, '/v1/verify-identity', body, await mint('verify-identity', body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
    expect(deps.verifyIdentity).not.toHaveBeenCalled();
  });

  it.each([
    ['an id_token', { ...VERIFIED, idToken: 'eyJ.secret.token' }],
    ['an application failure code', { success: false, errorCode: 'application_token_invalid' }],
    ['grant fields', { ...VERIFIED, observedGrants: [] }],
  ])('refuses to return a dependency result carrying %s', async (_label, result) => {
    const { app: target } = app({ verifyIdentity: vi.fn().mockResolvedValue(result) });
    const body = JSON.stringify(VERIFY_REQUEST);
    const response = await post(target, '/v1/verify-identity', body, await mint('verify-identity', body));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'internal_error' });
    expect(text).not.toContain('secret');
  });

  it('sanitizes a thrown dependency error', async () => {
    const { app: target } = app({ verifyIdentity: vi.fn().mockRejectedValue(new Error('provider body with secret')) });
    const body = JSON.stringify(VERIFY_REQUEST);
    const response = await post(target, '/v1/verify-identity', body, await mint('verify-identity', body));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal_error' });
  });

  it('is POST-only', async () => {
    const { app: target } = app();
    expect((await target.request('/v1/verify-identity')).status).toBe(404);
  });
});
