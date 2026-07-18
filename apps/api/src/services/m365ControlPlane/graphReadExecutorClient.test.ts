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

  it.each([
    'https://executor.internal.example.test/internal',
    'https://executor.internal.example.test/v1/',
    'https://executor.internal.example.test//',
    'https://executor.internal.example.test/?route=other',
    'https://executor.internal.example.test/#other',
    'https://user:password@executor.internal.example.test/',
  ])('rejects non-origin executor configuration before sending to %s', async (executorUrl) => {
    const { privateJwk } = await signingFixture();
    const fetchMock = vi.fn();

    expect(() => createGraphReadExecutorClient({
      executorUrl,
      executorAudience: 'm365-graph-read-executor',
      signingPrivateJwk: privateJwk,
      signingKid: 'api-key-1',
      fetch: fetchMock,
    })).toThrowError(GraphReadExecutorClientError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('strict-rejects caller-selected fields before any executor request', async () => {
    const { privateJwk } = await signingFixture();
    const fetchMock = vi.fn();
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
      graphUrl: 'https://attacker.example.test',
    } as never).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'executor_unavailable', message: 'executor_unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(String(error)).not.toContain('attacker');
  });

  it('rejects an oversized declared response without reading or leaking its body', async () => {
    const { privateJwk } = await signingFixture();
    const fetchMock = vi.fn(async () => new Response('provider-body-secret', {
      headers: { 'content-type': 'application/json', 'content-length': '4096' },
    }));
    const client = createGraphReadExecutorClient({
      executorUrl: 'https://executor.internal.example.test',
      executorAudience: 'm365-graph-read-executor',
      signingPrivateJwk: privateJwk,
      signingKid: 'api-key-1',
      fetch: fetchMock,
      maxResponseBytes: 16,
    });

    const error = await client.retestCustomerGraphRead({ correlationId: CORRELATION_ID, tenantId: TENANT_ID })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'executor_unavailable', message: 'executor_unavailable' });
    expect(String(error)).not.toContain('provider-body-secret');
  });

  it('enforces cumulative streamed bytes when a smaller Content-Length lies', async () => {
    const { privateJwk } = await signingFixture();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('12345678'));
        controller.enqueue(new TextEncoder().encode('901234567'));
        controller.close();
      },
    });
    const fetchMock = vi.fn(async () => new Response(stream, {
      headers: { 'content-type': 'application/json', 'content-length': '2' },
    }));
    const client = createGraphReadExecutorClient({
      executorUrl: 'https://executor.internal.example.test',
      executorAudience: 'm365-graph-read-executor',
      signingPrivateJwk: privateJwk,
      signingKid: 'api-key-1',
      fetch: fetchMock,
      maxResponseBytes: 16,
    });

    await expect(client.retestCustomerGraphRead({ correlationId: CORRELATION_ID, tenantId: TENANT_ID }))
      .rejects.toMatchObject({ code: 'executor_unavailable' });
  });

  it('serializes once and signs the exact read-action body and operation', async () => {
    const { privateJwk, publicKey } = await signingFixture();
    const readActionResult = {
      success: true as const,
      kind: 'resource' as const,
      resource: { id: TENANT_ID, displayName: 'Contoso' },
    };
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
        operation: 'read-action',
        bodySha256: createHash('sha256').update(body).digest('base64url'),
      });
      return new Response(JSON.stringify(readActionResult), {
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
      tenantId: TENANT_ID,
      action: { type: 'm365.org.get' as const },
    };

    await expect(client.executeReadAction(input)).resolves.toEqual(readActionResult);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://executor.internal.example.test/v1/read-action',
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(input);
  });

  it('parses a valid executor read-action failure body through', async () => {
    const { privateJwk } = await signingFixture();
    const failureResult = {
      success: false as const,
      errorCode: 'graph_not_found' as const,
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(failureResult), {
      headers: { 'content-type': 'application/json' },
    }));
    const client = createGraphReadExecutorClient({
      executorUrl: 'https://executor.internal.example.test',
      executorAudience: 'm365-graph-read-executor',
      signingPrivateJwk: privateJwk,
      signingKid: 'api-key-1',
      fetch: fetchMock,
    });

    await expect(client.executeReadAction({
      correlationId: CORRELATION_ID,
      tenantId: TENANT_ID,
      action: { type: 'm365.org.get' },
    })).resolves.toEqual(failureResult);
  });

  it('rejects a read-action 404 from an old executor with executor_unavailable', async () => {
    const { privateJwk } = await signingFixture();
    const fetchMock = vi.fn(async () => new Response('not found', { status: 404 }));
    const client = createGraphReadExecutorClient({
      executorUrl: 'https://executor.internal.example.test',
      executorAudience: 'm365-graph-read-executor',
      signingPrivateJwk: privateJwk,
      signingKid: 'api-key-1',
      fetch: fetchMock,
    });

    const error = await client.executeReadAction({
      correlationId: CORRELATION_ID,
      tenantId: TENANT_ID,
      action: { type: 'm365.org.get' },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GraphReadExecutorClientError);
    expect(error).toMatchObject({ code: 'executor_unavailable' });
  });

  it('accepts a read-action response larger than the 32 KiB default but under the 256 KiB cap', async () => {
    const { privateJwk } = await signingFixture();
    const readActionResult = {
      success: true as const,
      kind: 'collection' as const,
      items: [{ padding: 'x'.repeat(40 * 1024) }],
      truncated: false,
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(readActionResult), {
      headers: { 'content-type': 'application/json' },
    }));
    const client = createGraphReadExecutorClient({
      executorUrl: 'https://executor.internal.example.test',
      executorAudience: 'm365-graph-read-executor',
      signingPrivateJwk: privateJwk,
      signingKid: 'api-key-1',
      fetch: fetchMock,
    });

    await expect(client.executeReadAction({
      correlationId: CORRELATION_ID,
      tenantId: TENANT_ID,
      action: { type: 'm365.org.get' },
    })).resolves.toEqual(readActionResult);
  });

  it('aborts a genuinely stalled executor request at the configured timeout', async () => {
    const { privateJwk } = await signingFixture();
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }));
    const client = createGraphReadExecutorClient({
      executorUrl: 'https://executor.internal.example.test',
      executorAudience: 'm365-graph-read-executor',
      signingPrivateJwk: privateJwk,
      signingKid: 'api-key-1',
      fetch: fetchMock,
      timeoutMs: 5,
    });

    await expect(client.retestCustomerGraphRead({ correlationId: CORRELATION_ID, tenantId: TENANT_ID }))
      .rejects.toMatchObject({ code: 'executor_unavailable', message: 'executor_unavailable' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
