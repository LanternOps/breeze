import { readFileSync } from 'node:fs';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  createMicrosoftTokenClient,
  type OpaqueAccessToken,
  type OpaqueIdentityToken,
} from './tokenClient';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-2222222222ab';
const CALLBACK_URL = 'https://breeze.example.com/api/integrations/m365/customer-graph-read/callback';
const TOKEN_ENDPOINT = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
const certificatePem = readFileSync(
  new URL('../test/fixtures/client-cert.pem', import.meta.url),
  'utf8',
);
const privateKeyPem = readFileSync(
  new URL('../test/fixtures/client-key.pem', import.meta.url),
  'utf8',
);

function success(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function client(fetchImpl: typeof fetch, overrides: { timeoutMs?: number; maxResponseBytes?: number } = {}) {
  return createMicrosoftTokenClient({
    clientId: CLIENT_ID,
    callbackUrl: CALLBACK_URL,
    certificatePem,
    privateKeyPem,
    ...overrides,
  }, { fetch: fetchImpl });
}

describe('Microsoft token client', () => {
  it('exchanges an authorization code with PKCE and a certificate assertion', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => success({
      token_type: 'Bearer',
      access_token: 'delegated-token-that-is-discarded',
      id_token: 'opaque.identity.token',
      expires_in: 3600,
    }));

    const identityToken = await client(fetchImpl).exchangeAuthorizationCode({
      tenantId: TENANT_ID,
      code: 'authorization-code',
      codeVerifier: 'pkce-code-verifier',
    });

    expect(identityToken).toBe('opaque.identity.token');
    expectTypeOf(identityToken).toEqualTypeOf<OpaqueIdentityToken>();
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(TOKEN_ENDPOINT);
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    const body = new URLSearchParams(String(init?.body));
    expect(Object.fromEntries(body)).toMatchObject({
      client_id: CLIENT_ID,
      grant_type: 'authorization_code',
      code: 'authorization-code',
      code_verifier: 'pkce-code-verifier',
      redirect_uri: CALLBACK_URL,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    });
    expect(body.has('client_secret')).toBe(false);
    expect(decodeProtectedHeader(body.get('client_assertion')!).alg).toBe('RS256');
    expect(decodeJwt(body.get('client_assertion')!).aud).toBe(TOKEN_ENDPOINT);
  });

  it('acquires only the fixed Microsoft Graph app scope and keeps the token opaque', async () => {
    const graphToken = 'not-a-jwt-and-never-decoded';
    const fetchImpl = vi.fn<typeof fetch>(async () => success({
      token_type: 'Bearer',
      access_token: graphToken,
      expires_in: 3600,
      provider_extension: { mustNotEscape: true },
    }));

    const accessToken = await client(fetchImpl).acquireGraphAppToken({ tenantId: TENANT_ID });

    expect(accessToken).toBe(graphToken);
    expectTypeOf(accessToken).toEqualTypeOf<OpaqueAccessToken>();
    const body = new URLSearchParams(String(fetchImpl.mock.calls[0]![1]?.body));
    expect(Object.fromEntries(body)).toMatchObject({
      client_id: CLIENT_ID,
      grant_type: 'client_credentials',
      scope: 'https://graph.microsoft.com/.default',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    });
    expect(body.getAll('scope')).toEqual(['https://graph.microsoft.com/.default']);
    expect(body.has('client_secret')).toBe(false);
  });

  it.each([
    ['tenant aliases', 'organizations'],
    ['upper-case tenant IDs', TENANT_ID.toUpperCase()],
    ['tenant IDs with a path', `${TENANT_ID}/oauth2`],
    ['tenant IDs with a query', `${TENANT_ID}?redirect=https://attacker.example`],
  ])('rejects %s without making a request', async (_label, tenantId) => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(client(fetchImpl).acquireGraphAppToken({ tenantId })).rejects.toMatchObject({
      code: 'token_request_invalid',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('aborts a request after the configured timeout', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'AbortError')));
    }));

    await expect(client(fetchImpl, { timeoutMs: 5 }).acquireGraphAppToken({
      tenantId: TENANT_ID,
    })).rejects.toMatchObject({
      code: 'token_request_timeout',
      message: 'token_request_timeout',
    });
  });

  it('rejects a declared Content-Length over the bound before reading the body', async () => {
    let bodyRead = false;
    const response = {
      ok: true,
      headers: new Headers({ 'content-length': '33' }),
      body: {
        getReader() {
          bodyRead = true;
          throw new Error('oversized provider body must not be read');
        },
      },
    } as unknown as Response;
    const fetchImpl = vi.fn<typeof fetch>(async () => response);

    await expect(client(fetchImpl, { maxResponseBytes: 32 }).acquireGraphAppToken({
      tenantId: TENANT_ID,
    })).rejects.toMatchObject({
      code: 'token_response_too_large',
      message: 'token_response_too_large',
    });
    expect(bodyRead).toBe(false);
  });

  it('rejects cumulative multi-chunk overflow without a Content-Length header', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(20)));
        controller.enqueue(new TextEncoder().encode('x'.repeat(13)));
        controller.close();
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body, { status: 200 }));

    await expect(client(fetchImpl, { maxResponseBytes: 32 }).acquireGraphAppToken({
      tenantId: TENANT_ID,
    })).rejects.toMatchObject({
      code: 'token_response_too_large',
      message: 'token_response_too_large',
    });
  });

  it('does not trust a smaller declared Content-Length over actual streamed bytes', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('x'.repeat(33), {
      status: 200,
      headers: { 'content-length': '8' },
    }));

    await expect(client(fetchImpl, { maxResponseBytes: 32 }).acquireGraphAppToken({
      tenantId: TENANT_ID,
    })).rejects.toMatchObject({
      code: 'token_response_too_large',
      message: 'token_response_too_large',
    });
  });

  it.each(['not-a-number', '-1', '1.5'])('does not let malformed Content-Length %s weaken the stream bound', async (contentLength) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('x'.repeat(33), {
      status: 200,
      headers: { 'content-length': contentLength },
    }));

    await expect(client(fetchImpl, { maxResponseBytes: 32 }).acquireGraphAppToken({
      tenantId: TENANT_ID,
    })).rejects.toMatchObject({
      code: 'token_response_too_large',
      message: 'token_response_too_large',
    });
  });

  it('rejects malformed JSON with a stable response code', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{malformed', { status: 200 }));

    await expect(client(fetchImpl).acquireGraphAppToken({ tenantId: TENANT_ID })).rejects.toMatchObject({
      code: 'token_response_invalid',
      message: 'token_response_invalid',
    });
  });

  it('replaces provider and transport failures without logging or exposing details', async () => {
    const sentinel = 'SENTINEL-MICROSOFT-PROVIDER-BODY';
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const providerFailure = await client(vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: 'invalid_client',
      error_description: sentinel,
    }), { status: 401 }))).acquireGraphAppToken({ tenantId: TENANT_ID }).catch((failure: unknown) => failure);

    expect(providerFailure).toMatchObject({
      code: 'token_provider_rejected',
      message: 'token_provider_rejected',
    });
    expect(providerFailure).not.toHaveProperty('cause');
    expect(providerFailure).not.toHaveProperty('response');
    expect(String(providerFailure)).not.toContain(sentinel);

    const transportFailure = await client(vi.fn<typeof fetch>(async () => {
      throw Object.assign(new Error(`${sentinel} ${TOKEN_ENDPOINT}?code=SECRET`), {
        cause: sentinel,
        response: { body: sentinel },
      });
    })).acquireGraphAppToken({ tenantId: TENANT_ID }).catch((failure: unknown) => failure);

    expect(transportFailure).toMatchObject({
      code: 'token_transport_failed',
      message: 'token_transport_failed',
    });
    expect(transportFailure).not.toHaveProperty('cause');
    expect(String(transportFailure)).not.toContain(sentinel);
    expect(String(transportFailure)).not.toContain('?code=');
    expect([log, warn, error].flatMap(spy => spy.mock.calls).join(' ')).not.toContain(sentinel);
  });
});
