import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { createGraphActionsExecutorClient, GraphActionsExecutorClientError } from './graphActionsExecutorClient';
import { generateKeyPair, exportJWK, jwtVerify } from 'jose';

const UUID = '00000000-0000-4000-8000-000000000001';
const TENANT = '22222222-2222-4222-8222-222222222222';
const USER = '11111111-1111-4111-8111-111111111111';
const APPLICATION_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_ID = '44444444-4444-4444-8444-444444444444';
const ATTEMPT_ID = '55555555-5555-4555-8555-555555555555';

async function signingConfig() {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const jwk = await exportJWK(privateKey);
  return {
    signingPrivateJwk: { ...jwk, kty: 'OKP', crv: 'Ed25519' },
    signingKid: 'kid-1',
    publicKey,
  };
}

function completeResult() {
  return {
    success: true as const,
    tenantId: TENANT,
    applicationId: APPLICATION_ID,
    administratorObjectId: ADMIN_ID,
    organizationDisplayName: 'Contoso',
    manifestVersion: 2,
    verifiedAt: '2026-07-14T16:00:00.000Z',
    grantReconciliation: 'complete' as const,
    observedGrants: [],
    missingGrants: [],
    unexpectedGrants: [],
    grantsVerifiedAt: '2026-07-14T16:00:00.000Z',
  };
}

function retestResultFixture() {
  return {
    success: true as const,
    tenantId: TENANT,
    applicationId: APPLICATION_ID,
    organizationDisplayName: 'Contoso',
    manifestVersion: 2,
    verifiedAt: '2026-07-14T16:00:00.000Z',
    grantReconciliation: 'complete' as const,
    observedGrants: [],
    missingGrants: [],
    unexpectedGrants: [],
    grantsVerifiedAt: '2026-07-14T16:00:00.000Z',
  };
}

function req() {
  return {
    correlationId: UUID, tenantId: TENANT, idempotencyKey: 'intent-1',
    action: { type: 'm365.user.disable' as const, userIdentifier: 'a@b.com', reason: 'x' },
  };
}

describe('createGraphActionsExecutorClient', () => {
  it('POSTs a signed request and parses a success result', async () => {
    const { signingPrivateJwk, signingKid } = await signingConfig();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ success: true, action: 'm365.user.disable', userId: USER }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const client = createGraphActionsExecutorClient({
      executorUrl: 'https://actions.internal/', executorAudience: 'm365-graph-actions-executor',
      signingPrivateJwk, signingKid, fetch: fetchImpl as never,
    });
    const result = await client.executeWriteAction(req());
    expect(result).toEqual({ success: true, action: 'm365.user.disable', userId: USER });
    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toBe('https://actions.internal/v1/execute-action');
    expect(call[1].headers.authorization).toMatch(/^Bearer /);
  });

  it('throws executor_unavailable on a non-200', async () => {
    const { signingPrivateJwk, signingKid } = await signingConfig();
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 502 }));
    const client = createGraphActionsExecutorClient({
      executorUrl: 'https://actions.internal/', executorAudience: 'm365-graph-actions-executor',
      signingPrivateJwk, signingKid, fetch: fetchImpl as never,
    });
    await expect(client.executeWriteAction(req())).rejects.toBeInstanceOf(GraphActionsExecutorClientError);
  });

  it('serializes once and signs the exact complete-consent body against the actions audience', async () => {
    const { signingPrivateJwk, signingKid, publicKey } = await signingConfig();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body);
      const token = String(new Headers(init?.headers).get('authorization')).slice('Bearer '.length);
      const verified = await jwtVerify(token, publicKey, {
        algorithms: ['EdDSA'],
        issuer: 'breeze-api',
        audience: 'm365-graph-actions-executor',
        subject: 'breeze-control-plane',
      });
      expect(verified.protectedHeader).toMatchObject({ alg: 'EdDSA', kid: signingKid });
      expect(verified.payload).toMatchObject({
        correlationId: UUID,
        operation: 'complete-consent',
        bodySha256: createHash('sha256').update(body).digest('base64url'),
      });
      return new Response(JSON.stringify(completeResult()), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = createGraphActionsExecutorClient({
      executorUrl: 'https://actions.internal/', executorAudience: 'm365-graph-actions-executor',
      signingPrivateJwk, signingKid, fetch: fetchImpl as never,
    });
    const input = {
      correlationId: UUID,
      consentAttemptId: ATTEMPT_ID,
      tenantHint: TENANT,
      authorizationCode: 'authorization-code',
      codeVerifier: 'v'.repeat(43),
      nonce: 'nonce',
      redirectUri: 'https://console.example.test/api/v1/m365/consent/callback',
    };

    await expect(client.completeIdentityVerification(input)).resolves.toEqual(completeResult());
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://actions.internal/v1/complete-consent');
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual(input);
  });

  it('POSTs retest to the fixed retest endpoint against the actions audience', async () => {
    const { signingPrivateJwk, signingKid, publicKey } = await signingConfig();
    const retestResult = retestResultFixture();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const token = String(new Headers(init?.headers).get('authorization')).slice('Bearer '.length);
      const verified = await jwtVerify(token, publicKey, {
        algorithms: ['EdDSA'],
        issuer: 'breeze-api',
        audience: 'm365-graph-actions-executor',
        subject: 'breeze-control-plane',
      });
      expect(verified.payload).toMatchObject({ correlationId: UUID, operation: 'retest' });
      return new Response(JSON.stringify(retestResult), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = createGraphActionsExecutorClient({
      executorUrl: 'https://actions.internal/', executorAudience: 'm365-graph-actions-executor',
      signingPrivateJwk, signingKid, fetch: fetchImpl as never,
    });

    await expect(client.retestCustomerGraphActions({
      correlationId: UUID,
      tenantId: TENANT,
    })).resolves.toEqual(retestResult);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://actions.internal/v1/retest');
  });

  it('maps a retest HTTP failure to one sanitized executor_unavailable code', async () => {
    const { signingPrivateJwk, signingKid } = await signingConfig();
    const fetchImpl = vi.fn().mockResolvedValue(new Response('provider body secret', { status: 500 }));
    const client = createGraphActionsExecutorClient({
      executorUrl: 'https://actions.internal/', executorAudience: 'm365-graph-actions-executor',
      signingPrivateJwk, signingKid, fetch: fetchImpl as never,
    });

    const error = await client.retestCustomerGraphActions({
      correlationId: UUID,
      tenantId: TENANT,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GraphActionsExecutorClientError);
    expect(error).toMatchObject({ code: 'executor_unavailable', message: 'executor_unavailable' });
    expect(String(error)).not.toContain('provider body secret');
  });
});

describe('Graph-actions executor client: verify-identity', () => {
  function verifyInput(overrides: Record<string, unknown> = {}) {
    return {
      correlationId: UUID,
      consentAttemptId: ATTEMPT_ID,
      expectedTenantId: null,
      authorizationCode: 'authorization-code',
      codeVerifier: 'v'.repeat(43),
      nonce: 'nonce',
      redirectUri: 'https://console.example.test/api/v1/m365/consent/callback',
      ...overrides,
    };
  }

  const verified = {
    success: true as const,
    tenantId: TENANT,
    administratorObjectId: ADMIN_ID,
    administratorUsername: null,
    verifiedAt: '2026-10-03T12:00:00.000Z',
  };

  function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  it('posts verify-identity with a verify-identity operation claim and parses the result', async () => {
    const { signingPrivateJwk, signingKid, publicKey } = await signingConfig();
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body);
      const token = String(new Headers(init?.headers).get('authorization')).slice('Bearer '.length);
      const claims = await jwtVerify(token, publicKey, {
        algorithms: ['EdDSA'],
        issuer: 'breeze-api',
        audience: 'm365-graph-actions-executor',
        subject: 'breeze-control-plane',
      });
      expect(claims.payload).toMatchObject({
        correlationId: UUID,
        operation: 'verify-identity',
        bodySha256: createHash('sha256').update(body).digest('base64url'),
      });
      return jsonResponse(verified);
    });
    const client = createGraphActionsExecutorClient({ executorUrl: 'https://actions.internal/', executorAudience: 'm365-graph-actions-executor', signingPrivateJwk, signingKid, fetch: fetchMock as never });

    await expect(client.verifyConsentIdentity(verifyInput())).resolves.toEqual(verified);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://actions.internal/v1/verify-identity');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(verifyInput());
  });

  it('passes a pinned expected tenant and an identity failure through', async () => {
    const { signingPrivateJwk, signingKid } = await signingConfig();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: false, errorCode: 'tenant_mismatch' }));
    const client = createGraphActionsExecutorClient({ executorUrl: 'https://actions.internal/', executorAudience: 'm365-graph-actions-executor', signingPrivateJwk, signingKid, fetch: fetchMock as never });

    await expect(client.verifyConsentIdentity(verifyInput({ expectedTenantId: TENANT })))
      .resolves.toEqual({ success: false, errorCode: 'tenant_mismatch' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).expectedTenantId).toBe(TENANT);
  });

  it.each([
    ['the legacy tenantHint field', { tenantHint: TENANT }],
    ['the organizations literal', { expectedTenantId: 'organizations' }],
    ['a missing expectedTenantId', { expectedTenantId: undefined }],
  ])('rejects a request carrying %s before any network call', async (_label, overrides) => {
    const { signingPrivateJwk, signingKid } = await signingConfig();
    const fetchMock = vi.fn();
    const client = createGraphActionsExecutorClient({ executorUrl: 'https://actions.internal/', executorAudience: 'm365-graph-actions-executor', signingPrivateJwk, signingKid, fetch: fetchMock as never });

    await expect(client.verifyConsentIdentity(verifyInput(overrides) as never))
      .rejects.toBeInstanceOf(GraphActionsExecutorClientError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a pre-W1 executor 404', () => jsonResponse({ error: 'not_found' }, 404)],
    ['an id_token in the result', () => jsonResponse({ ...verified, idToken: 'eyJ.leak.token' })],
    ['an application-proof failure code', () => jsonResponse({ success: false, errorCode: 'application_token_invalid' })],
    ['a non-JSON body', () => new Response('provider body secret', { headers: { 'content-type': 'text/plain' } })],
  ])('maps %s to one sanitized executor_unavailable error', async (_label, makeResponse) => {
    const { signingPrivateJwk, signingKid } = await signingConfig();
    const fetchMock = vi.fn().mockResolvedValue(makeResponse());
    const client = createGraphActionsExecutorClient({ executorUrl: 'https://actions.internal/', executorAudience: 'm365-graph-actions-executor', signingPrivateJwk, signingKid, fetch: fetchMock as never });

    const error = await client.verifyConsentIdentity(verifyInput()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GraphActionsExecutorClientError);
    expect(error).toMatchObject({ code: 'executor_unavailable', message: 'executor_unavailable' });
    expect(String(error)).not.toContain('leak');
  });
});
