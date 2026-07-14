import { createHash, generateKeyPairSync } from 'node:crypto';
import { exportJWK, jwtVerify } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import {
  createGraphReadExecutorClient,
  GraphReadExecutorClientError,
} from './graphReadExecutorClient';

const CORRELATION_ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const APPLICATION_ID = '44444444-4444-4444-8444-444444444444';
const ADMIN_ID = '55555555-5555-4555-8555-555555555555';

async function signingFixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateJwk: await exportJWK(privateKey),
    publicKey,
  };
}

function completeResult() {
  return {
    success: true as const,
    tenantId: TENANT_ID,
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

describe('Graph-read executor client', () => {
  it('serializes once and signs the exact complete-consent body and operation', async () => {
    const { privateJwk, publicKey } = await signingFixture();
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body);
      const token = String(new Headers(init?.headers).get('authorization')).slice('Bearer '.length);
      const verified = await jwtVerify(token, publicKey, {
        algorithms: ['EdDSA'],
        issuer: 'breeze-api',
        audience: 'm365-graph-read-executor',
        subject: 'breeze-control-plane',
        currentDate: new Date('2026-07-14T16:00:00.000Z'),
      });
      expect(verified.protectedHeader).toMatchObject({ alg: 'EdDSA', kid: 'api-key-1' });
      expect(verified.payload).toMatchObject({
        correlationId: CORRELATION_ID,
        operation: 'complete-consent',
        bodySha256: createHash('sha256').update(body).digest('base64url'),
      });
      expect((verified.payload.exp as number) - (verified.payload.iat as number)).toBeLessThanOrEqual(60);
      return new Response(JSON.stringify(completeResult()), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = createGraphReadExecutorClient({
      executorUrl: 'https://executor.internal.example.test',
      executorAudience: 'm365-graph-read-executor',
      signingPrivateJwk: privateJwk,
      signingKid: 'api-key-1',
      fetch: fetchMock,
      now: () => new Date('2026-07-14T16:00:00.000Z'),
      randomUUID: () => '66666666-6666-4666-8666-666666666666',
    });
    const input = {
      correlationId: CORRELATION_ID,
      consentAttemptId: ATTEMPT_ID,
      tenantHint: TENANT_ID,
      authorizationCode: 'authorization-code',
      codeVerifier: 'v'.repeat(43),
      nonce: 'nonce',
      redirectUri: 'https://console.example.test/api/v1/m365/consent/callback',
    };

    await expect(client.completeIdentityVerification(input)).resolves.toEqual(completeResult());
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://executor.internal.example.test/v1/complete-consent',
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(input);
  });

  it('uses the fixed retest operation and rejects malformed or oversized responses', async () => {
    const { privateJwk } = await signingFixture();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"success":true,"token":"leak"}', {
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('x'.repeat(17), {
        headers: { 'content-type': 'application/json' },
      }));
    const client = createGraphReadExecutorClient({
      executorUrl: 'https://executor.internal.example.test',
      executorAudience: 'm365-graph-read-executor',
      signingPrivateJwk: privateJwk,
      signingKid: 'api-key-1',
      fetch: fetchMock,
      maxResponseBytes: 16,
    });

    await expect(client.retestCustomerGraphRead({
      correlationId: CORRELATION_ID,
      tenantId: TENANT_ID,
    })).rejects.toMatchObject({ code: 'executor_unavailable' });
    await expect(client.retestCustomerGraphRead({
      correlationId: CORRELATION_ID,
      tenantId: TENANT_ID,
    })).rejects.toBeInstanceOf(GraphReadExecutorClientError);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://executor.internal.example.test/v1/retest');
  });

  it('maps HTTP, timeout, and invalid input failures to one sanitized code', async () => {
    const { privateJwk } = await signingFixture();
    const fetchMock = vi.fn().mockResolvedValue(new Response('provider body secret', { status: 500 }));
    const client = createGraphReadExecutorClient({
      executorUrl: 'https://executor.internal.example.test',
      executorAudience: 'm365-graph-read-executor',
      signingPrivateJwk: privateJwk,
      signingKid: 'api-key-1',
      fetch: fetchMock,
    });

    const error = await client.retestCustomerGraphRead({
      correlationId: CORRELATION_ID,
      tenantId: TENANT_ID,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'executor_unavailable', message: 'executor_unavailable' });
    expect(String(error)).not.toContain('provider body secret');
  });
});
