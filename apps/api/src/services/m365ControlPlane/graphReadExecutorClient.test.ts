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

function identityResult() {
  return {
    success: true as const,
    tenantId: TENANT_ID,
    administratorObjectId: ADMIN_ID,
    administratorUsername: 'admin@tenant.example',
    verifiedAt: '2026-07-14T16:00:00.000Z',
  };
}

describe('Graph-read executor client', () => {
  it('serializes once and signs the exact verify-identity body and operation', async () => {
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
        operation: 'verify-identity',
        bodySha256: createHash('sha256').update(body).digest('base64url'),
      });
      expect((verified.payload.exp as number) - (verified.payload.iat as number)).toBeLessThanOrEqual(60);
      return new Response(JSON.stringify(identityResult()), {
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
      expectedTenantId: TENANT_ID,
      authorizationCode: 'authorization-code',
      codeVerifier: 'v'.repeat(43),
      nonce: 'nonce',
      redirectUri: 'https://console.example.test/api/v1/m365/consent/callback',
    };

    await expect(client.verifyConsentIdentity(input)).resolves.toEqual(identityResult());
    // #7910 W04: the legacy single-call consent method is gone.
    expect(client).not.toHaveProperty('completeIdentityVerification');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://executor.internal.example.test/v1/verify-identity',
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

const SYNC_RESULT = {
  success: true as const,
  kind: 'sync' as const,
  items: [{ id: TENANT_ID, lastSuccessfulSignInAt: null }],
  truncated: false,
  fetchedAt: '2026-09-08T00:00:00.000Z',
  sources: { signInActivity: 'ok' as const },
};

function syncInput() {
  return {
    correlationId: CORRELATION_ID,
    tenantId: TENANT_ID,
    action: { type: 'm365.sync.signin_activity' as const },
  };
}

async function syncClient(fetchMock: typeof globalThis.fetch) {
  const { privateJwk } = await signingFixture();
  return createGraphReadExecutorClient({
    executorUrl: 'https://executor.internal.example.test',
    executorAudience: 'm365-graph-read-executor',
    signingPrivateJwk: privateJwk,
    signingKid: 'api-key-1',
    fetch: fetchMock,
  });
}

describe('Graph-read executor client — sync-action', () => {
  it('signs the sync-action operation, hits /v1/sync-action, and parses the result', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const token = String(new Headers(init?.headers).get('authorization')).slice('Bearer '.length);
      expect(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).operation).toBe('sync-action');
      return new Response(JSON.stringify(SYNC_RESULT), { headers: { 'content-type': 'application/json' } });
    });
    const client = await syncClient(fetchMock as unknown as typeof globalThis.fetch);
    await expect(client.syncAction(syncInput())).resolves.toEqual(SYNC_RESULT);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://executor.internal.example.test/v1/sync-action');
  });

  it('returns a typed sync_capacity failure on 503 rather than executor_unavailable', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: 'sync_capacity', code: 'sync_capacity', retryAfterSeconds: 30 }),
      { status: 503, headers: { 'content-type': 'application/json', 'retry-after': '30' } },
    ));
    const client = await syncClient(fetchMock as unknown as typeof globalThis.fetch);
    await expect(client.syncAction(syncInput()))
      .resolves.toEqual({ success: false, code: 'sync_capacity', retryAfterSeconds: 30 });
  });

  it('returns a typed graph_throttled failure carrying retryAfterSeconds', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ success: false, code: 'graph_throttled', retryAfterSeconds: 45 }),
      { headers: { 'content-type': 'application/json' } },
    ));
    const client = await syncClient(fetchMock as unknown as typeof globalThis.fetch);
    await expect(client.syncAction(syncInput()))
      .resolves.toEqual({ success: false, code: 'graph_throttled', retryAfterSeconds: 45 });
  });

  it('returns continuation_invalid so the caller can restart the walk', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ success: false, code: 'continuation_invalid' }),
      { headers: { 'content-type': 'application/json' } },
    ));
    const client = await syncClient(fetchMock as unknown as typeof globalThis.fetch);
    await expect(client.syncAction(syncInput()))
      .resolves.toEqual({ success: false, code: 'continuation_invalid' });
  });

  it('still THROWS executor_unavailable for a 504, a wrong content type, and a bad body', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":"sync_timeout"}', { status: 504, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(SYNC_RESULT), { headers: { 'content-type': 'text/html' } }))
      .mockResolvedValueOnce(new Response('{"success":true,"kind":"collection","items":[]}', { headers: { 'content-type': 'application/json' } }));
    const client = await syncClient(fetchMock as unknown as typeof globalThis.fetch);
    const expected = [
      { cause: 'http_status', httpStatus: 504 },
      { cause: 'content_type' },
      { cause: 'schema_mismatch' },
    ];
    for (const shape of expected) {
      const error = await client.syncAction(syncInput()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(GraphReadExecutorClientError);
      expect(error).toMatchObject({ code: 'executor_unavailable', operation: 'sync-action', ...shape });
    }
  });

  it('refuses an interactive action id without calling the executor', async () => {
    const fetchMock = vi.fn();
    const client = await syncClient(fetchMock as unknown as typeof globalThis.fetch);
    await expect(client.syncAction({
      correlationId: CORRELATION_ID, tenantId: TENANT_ID, action: { type: 'm365.org.get' },
    } as never)).rejects.toBeInstanceOf(GraphReadExecutorClientError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gives sync-action its own 130 s timeout, not the client-wide one', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return new Response(JSON.stringify(SYNC_RESULT), { headers: { 'content-type': 'application/json' } });
    });
    const { privateJwk } = await signingFixture();
    const client = createGraphReadExecutorClient({
      executorUrl: 'https://executor.internal.example.test',
      executorAudience: 'm365-graph-read-executor',
      signingPrivateJwk: privateJwk,
      signingKid: 'api-key-1',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      timeoutMs: 10,   // the interactive timeout must NOT apply here
    });
    await expect(client.syncAction(syncInput())).resolves.toEqual(SYNC_RESULT);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]!.aborted).toBe(false);
  });
});

describe('Graph-read executor client: verify-identity', () => {
  function verifyInput(overrides: Record<string, unknown> = {}) {
    return {
      correlationId: CORRELATION_ID,
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
    tenantId: TENANT_ID,
    administratorObjectId: ADMIN_ID,
    administratorUsername: null,
    verifiedAt: '2026-10-03T12:00:00.000Z',
  };

  function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  it('posts verify-identity with a verify-identity operation claim and parses the result', async () => {
    const { privateJwk, publicKey } = await signingFixture();
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body);
      const token = String(new Headers(init?.headers).get('authorization')).slice('Bearer '.length);
      const claims = await jwtVerify(token, publicKey, {
        algorithms: ['EdDSA'],
        issuer: 'breeze-api',
        audience: 'm365-graph-read-executor',
        subject: 'breeze-control-plane',
      });
      expect(claims.payload).toMatchObject({
        correlationId: CORRELATION_ID,
        operation: 'verify-identity',
        bodySha256: createHash('sha256').update(body).digest('base64url'),
      });
      return jsonResponse(verified);
    });
    const client = createGraphReadExecutorClient({ executorUrl: 'https://executor.internal.example.test', executorAudience: 'm365-graph-read-executor', signingPrivateJwk: privateJwk, signingKid: 'api-key-1', fetch: fetchMock as never });

    await expect(client.verifyConsentIdentity(verifyInput())).resolves.toEqual(verified);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://executor.internal.example.test/v1/verify-identity');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(verifyInput());
  });

  it('passes a pinned expected tenant and an identity failure through', async () => {
    const { privateJwk } = await signingFixture();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: false, errorCode: 'tenant_mismatch' }));
    const client = createGraphReadExecutorClient({ executorUrl: 'https://executor.internal.example.test', executorAudience: 'm365-graph-read-executor', signingPrivateJwk: privateJwk, signingKid: 'api-key-1', fetch: fetchMock as never });

    await expect(client.verifyConsentIdentity(verifyInput({ expectedTenantId: TENANT_ID })))
      .resolves.toEqual({ success: false, errorCode: 'tenant_mismatch' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).expectedTenantId).toBe(TENANT_ID);
  });

  it.each([
    ['the legacy tenantHint field', { tenantHint: TENANT_ID }],
    ['the organizations literal', { expectedTenantId: 'organizations' }],
    ['a missing expectedTenantId', { expectedTenantId: undefined }],
  ])('rejects a request carrying %s before any network call', async (_label, overrides) => {
    const { privateJwk } = await signingFixture();
    const fetchMock = vi.fn();
    const client = createGraphReadExecutorClient({ executorUrl: 'https://executor.internal.example.test', executorAudience: 'm365-graph-read-executor', signingPrivateJwk: privateJwk, signingKid: 'api-key-1', fetch: fetchMock as never });

    await expect(client.verifyConsentIdentity(verifyInput(overrides) as never))
      .rejects.toBeInstanceOf(GraphReadExecutorClientError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a pre-W1 executor 404', () => jsonResponse({ error: 'not_found' }, 404)],
    ['an id_token in the result', () => jsonResponse({ ...verified, idToken: 'eyJ.leak.token' })],
    ['an application-proof failure code', () => jsonResponse({ success: false, errorCode: 'application_token_invalid' })],
    ['a non-JSON body', () => new Response('provider body secret', { headers: { 'content-type': 'text/plain' } })],
  ])('maps %s to one sanitized executor_unavailable error', async (_label, makeResponse) => {
    const { privateJwk } = await signingFixture();
    const fetchMock = vi.fn().mockResolvedValue(makeResponse());
    const client = createGraphReadExecutorClient({ executorUrl: 'https://executor.internal.example.test', executorAudience: 'm365-graph-read-executor', signingPrivateJwk: privateJwk, signingKid: 'api-key-1', fetch: fetchMock as never });

    const error = await client.verifyConsentIdentity(verifyInput()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GraphReadExecutorClientError);
    expect(error).toMatchObject({ code: 'executor_unavailable', message: 'executor_unavailable' });
    expect(String(error)).not.toContain('leak');
  });
});

describe('Graph-read executor client: failure classification (#9322)', () => {
  const verifyInput = {
    correlationId: CORRELATION_ID,
    consentAttemptId: ATTEMPT_ID,
    expectedTenantId: null,
    authorizationCode: 'authorization-code-secret',
    codeVerifier: 'v'.repeat(43),
    nonce: 'nonce-secret',
    redirectUri: 'https://console.example.test/api/v1/m365/consent/callback',
  };

  async function clientFor(fetchMock: unknown, maxResponseBytes?: number) {
    const { privateJwk } = await signingFixture();
    return createGraphReadExecutorClient({
      executorUrl: 'https://executor.internal.example.test',
      executorAudience: 'm365-graph-read-executor',
      signingPrivateJwk: privateJwk,
      signingKid: 'api-key-1',
      fetch: fetchMock as typeof globalThis.fetch,
      ...(maxResponseBytes ? { maxResponseBytes } : {}),
    });
  }

  const json = (body: string, status = 200, contentType = 'application/json') =>
    new Response(body, { status, headers: { 'content-type': contentType } });

  it.each([
    ['fetch reject', () => Promise.reject(new TypeError('fetch failed')), { cause: 'network' }],
    ['abort', () => Promise.reject(new DOMException('The operation was aborted.', 'AbortError')), { cause: 'timeout' }],
    ['signal timeout', () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')), { cause: 'timeout' }],
    ['404', () => Promise.resolve(json('{"error":"not_found"}', 404)), { cause: 'http_status', httpStatus: 404 }],
    ['401', () => Promise.resolve(json('{"error":"unauthorized"}', 401)), { cause: 'http_status', httpStatus: 401 }],
    ['500', () => Promise.resolve(json('{"error":"internal_error"}', 500)), { cause: 'http_status', httpStatus: 500 }],
    ['200 text/html', () => Promise.resolve(json('<html></html>', 200, 'text/html')), { cause: 'content_type' }],
    ['200 malformed JSON', () => Promise.resolve(json('{not-json')), { cause: 'malformed_json' }],
    ['200 extra JSON field', () => Promise.resolve(json(JSON.stringify({ ...identityResult(), extra: 'x' }))), { cause: 'schema_mismatch' }],
  ] as const)('%s → executor_unavailable with its cause', async (_label, respond, expected) => {
    const client = await clientFor(vi.fn(respond));
    const error = await client.verifyConsentIdentity(verifyInput).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GraphReadExecutorClientError);
    expect(error).toMatchObject({
      code: 'executor_unavailable',
      message: 'executor_unavailable',
      operation: 'verify-identity',
      ...expected,
    });
    if (!('httpStatus' in expected)) expect((error as GraphReadExecutorClientError).httpStatus).toBeUndefined();
    // Nothing from the request (code, verifier, nonce) rides on the error.
    const serialized = JSON.stringify(error) + String(error);
    for (const secret of ['authorization-code-secret', 'nonce-secret', 'v'.repeat(43)]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('an oversized response is response_too_large', async () => {
    const client = await clientFor(vi.fn().mockResolvedValue(json('x'.repeat(64))), 16);
    await expect(client.retestCustomerGraphRead({ correlationId: CORRELATION_ID, tenantId: TENANT_ID }))
      .rejects.toMatchObject({ code: 'executor_unavailable', cause: 'response_too_large', operation: 'retest' });
  });

  it('a signing key that cannot sign is signing_failed and never reaches the executor', async () => {
    const fetchMock = vi.fn();
    const client = createGraphReadExecutorClient({
      executorUrl: 'https://executor.internal.example.test',
      executorAudience: 'm365-graph-read-executor',
      signingPrivateJwk: { kty: 'OKP', crv: 'Ed25519', x: 'not-a-key' },
      signingKid: 'api-key-1',
      fetch: fetchMock,
    });
    await expect(client.verifyConsentIdentity(verifyInput))
      .rejects.toMatchObject({ code: 'executor_unavailable', cause: 'signing_failed', operation: 'verify-identity' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a body stream that fails mid-read is network, still the client error', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"success":'));
      },
      pull(controller) {
        controller.error(new TypeError('socket hang up'));
      },
    });
    const client = await clientFor(vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': 'application/json' } })));
    const error = await client.verifyConsentIdentity(verifyInput).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GraphReadExecutorClientError);
    expect(error).toMatchObject({ cause: 'network', operation: 'verify-identity' });
  });

  it.each([
    ['a non-JSON 503', () => new Response('<html>busy</html>', { status: 503, headers: { 'content-type': 'text/html' } })],
    ['a malformed JSON 503', () => json('{not-json', 503)],
    ['a 503 that is not a capacity refusal', () => json('{"error":"unavailable"}', 503)],
  ])('sync-action: %s is http_status 503, not a body problem', async (_label, respond) => {
    const client = await clientFor(vi.fn().mockImplementation(async () => respond()));
    await expect(client.syncAction(syncInput()))
      .rejects.toMatchObject({ code: 'executor_unavailable', cause: 'http_status', httpStatus: 503, operation: 'sync-action' });
  });

  it('a body read aborted by the request timeout is timeout, not network', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new DOMException('The operation timed out.', 'TimeoutError'));
      },
    });
    const client = await clientFor(vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': 'application/json' } })));
    await expect(client.verifyConsentIdentity(verifyInput))
      .rejects.toMatchObject({ cause: 'timeout', operation: 'verify-identity' });
  });

  it('a request that fails its own schema is request_invalid and never reaches the executor', async () => {
    const fetchMock = vi.fn();
    const client = await clientFor(fetchMock);
    await expect(client.verifyConsentIdentity({ ...verifyInput, correlationId: 'not-a-uuid' }))
      .rejects.toMatchObject({ code: 'executor_unavailable', cause: 'request_invalid', operation: 'verify-identity' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
