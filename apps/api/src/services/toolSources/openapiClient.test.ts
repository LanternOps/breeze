import { describe, expect, it, vi } from 'vitest';
import {
  buildOperationRequest,
  OPENAPI_ERROR_BODY_CHARS,
  OPENAPI_MAX_RESPONSE_BYTES,
  OPENAPI_TIMEOUT_MS,
  OpenApiClient,
  OpenApiRequestError,
} from './openapiClient';
import type { OperationBinding } from './openapiProjection';
import { ResponseTooLargeError, safeFetch } from '../urlSafety';

vi.mock('../urlSafety', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../urlSafety')>();
  return { ...actual, safeFetch: vi.fn() };
});

const BASE = 'https://api.example.com/v1';
const ORIGIN = 'https://api.example.com';

const showPet: OperationBinding = {
  method: 'get', path: '/pets/{petId}', operationId: 'showPetById',
  params: [
    { name: 'petId', in: 'path', property: 'petId', required: true },
    { name: 'fields', in: 'query', property: 'fields', required: false },
    { name: 'X-Trace', in: 'header', property: 'X_Trace', required: false },
  ],
  body: null, declaredServer: null,
};
const createPet: OperationBinding = {
  method: 'post', path: '/pets', operationId: 'createPets', params: [],
  body: { property: 'body', required: true }, declaredServer: null,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function requestError(fn: () => unknown): OpenApiRequestError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(OpenApiRequestError);
    return err as OpenApiRequestError;
  }
  throw new Error('expected OpenApiRequestError');
}

describe('buildOperationRequest', () => {
  it('substitutes and encodes path params, and appends repeated query params', () => {
    const { url } = buildOperationRequest(BASE, showPet, { petId: 'a/b', fields: ['name', 'age'] });
    expect(url).toBe('https://api.example.com/v1/pets/a%2Fb?fields=name&fields=age');
  });

  it('omits undefined and null query values entirely', () => {
    expect(buildOperationRequest(BASE, showPet, { petId: '1', fields: undefined }).url).toBe('https://api.example.com/v1/pets/1');
    expect(buildOperationRequest(BASE, showPet, { petId: '1', fields: null }).url).toBe('https://api.example.com/v1/pets/1');
  });

  it('keeps the base URL query and drops a trailing slash on the base', () => {
    expect(buildOperationRequest('https://api.example.com/v1/?tenant=t1', showPet, { petId: '7', fields: 'x' }).url)
      .toBe('https://api.example.com/v1/pets/7?tenant=t1&fields=x');
  });

  it('never carries base-URL userinfo into the request URL', () => {
    expect(buildOperationRequest('https://user:pass@api.example.com/v1', showPet, { petId: '1' }).url)
      .toBe('https://api.example.com/v1/pets/1');
  });

  it('expands a form-explode object query value into its own keys', () => {
    const binding: OperationBinding = { ...showPet, params: [{ name: 'filter', in: 'query', property: 'filter', required: false }], path: '/pets' };
    expect(buildOperationRequest(BASE, binding, { filter: { status: 'open', n: 2 } }).url)
      .toBe('https://api.example.com/v1/pets?status=open&n=2');
  });

  it('serialises a JSON body and the header parameters', () => {
    const r = buildOperationRequest(BASE, createPet, { body: { name: 'Rex' } });
    expect(r.body).toBe('{"name":"Rex"}');
    expect(buildOperationRequest(BASE, showPet, { petId: '1', X_Trace: ['a', 'b'] }).headers).toEqual({ 'X-Trace': 'a,b' });
  });

  it('refuses a missing required path parameter or body', () => {
    expect(requestError(() => buildOperationRequest(BASE, showPet, {})).message).toBe('missing required path parameter: petId');
    expect(requestError(() => buildOperationRequest(BASE, createPet, {})).message).toBe('missing required request body');
  });

  it.each(['.', '..', ''])('refuses a dot-segment or empty path parameter value (%j)', (value) => {
    expect(requestError(() => buildOperationRequest(BASE, showPet, { petId: value })).message).toMatch(/path parameter petId/);
  });

  it('refuses a non-scalar path parameter', () => {
    expect(requestError(() => buildOperationRequest(BASE, showPet, { petId: { a: 1 } })).message).toMatch(/path parameter petId/);
  });

  it('refuses a header value carrying CR/LF', () => {
    expect(requestError(() => buildOperationRequest(BASE, showPet, { petId: '1', X_Trace: 'a\r\nX-Evil: 1' })).message)
      .toMatch(/header parameter X-Trace/);
  });

  it('reads only own input properties (no prototype values)', () => {
    const input = JSON.parse('{"petId":"1"}') as Record<string, unknown>;
    const binding: OperationBinding = { ...showPet, params: [...showPet.params, { name: 'toString', in: 'query', property: 'toString', required: false }] };
    expect(buildOperationRequest(BASE, binding, input).url).toBe('https://api.example.com/v1/pets/1');
  });

  it('does not send a body on GET', () => {
    const binding: OperationBinding = { ...showPet, body: { property: 'body', required: false } };
    expect(buildOperationRequest(BASE, binding, { petId: '1', body: { a: 1 } }).body).toBeUndefined();
  });
});

describe('OpenApiClient.callOperation', () => {
  const client = (fetchImpl: any, auth: any = { authKind: 'bearer', token: 'tok' }) =>
    new OpenApiClient({ baseUrl: BASE, credentialOrigin: ORIGIN, auth, fetchImpl });

  it('sends the method, credential, headers and the safeFetch bounds', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ id: '1' }));
    const result = await client(fetchImpl).callOperation(showPet, { petId: '1', X_Trace: 'abc' });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v1/pets/1');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.headers['X-Trace']).toBe('abc');
    expect(init.headers.Accept).toBe('application/json');
    expect(init.headers['Content-Type']).toBeUndefined();
    expect(init.timeoutMs).toBe(OPENAPI_TIMEOUT_MS);
    expect(init.maxBytes).toBe(OPENAPI_MAX_RESPONSE_BYTES);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBeUndefined();
    expect(result).toEqual({ isError: false, text: '{"id":"1"}' });
  });

  it('sends Content-Type and the JSON body for a write', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ id: '2' }, 201));
    await client(fetchImpl).callOperation(createPet, { body: { name: 'Rex' } });
    const init = fetchImpl.mock.calls[0]![1];
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe('{"name":"Rex"}');
  });

  it('never lets a header parameter shadow or duplicate the configured credential header', async () => {
    const binding: OperationBinding = { ...showPet, params: [...showPet.params, { name: 'x-api-key', in: 'header', property: 'k', required: false }] };
    const fetchImpl = vi.fn().mockResolvedValue(json({}));
    await client(fetchImpl, { authKind: 'api_key_header', headerName: 'X-Api-Key', value: 'real-key' })
      .callOperation(binding, { petId: '1', k: 'model-supplied' });
    const headers = fetchImpl.mock.calls[0]![1].headers as Record<string, string>;
    const keyHeaders = Object.entries(headers).filter(([k]) => k.toLowerCase() === 'x-api-key');
    expect(keyHeaders).toEqual([['X-Api-Key', 'real-key']]);
  });

  it('reports a non-2xx as isError with the status and a truncated body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('x'.repeat(5000), { status: 422 }));
    const result = await client(fetchImpl).callOperation(showPet, { petId: '1' });
    expect(result.isError).toBe(true);
    expect(result.text).toBe(`HTTP 422: ${'x'.repeat(OPENAPI_ERROR_BODY_CHARS)}`);
  });

  it('redacts the access token it sent out of an error body echoing it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('bad token s3cr3t-at-value, sorry', { status: 401 }));
    const result = await client(fetchImpl, { authKind: 'bearer', token: 's3cr3t-at-value' }).callOperation(showPet, { petId: '1' });
    expect(result.text).toBe('HTTP 401: bad token [REDACTED], sorry');
  });

  it('reports a redirect as an error rather than following it, without echoing Location', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }));
    const result = await client(fetchImpl).callOperation(showPet, { petId: '1' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('HTTP 302');
    expect(result.text).not.toContain('evil.example');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses to call when the base URL has drifted off the pinned origin', async () => {
    const fetchImpl = vi.fn();
    const drifted = new OpenApiClient({ baseUrl: 'https://other.example/v1', credentialOrigin: ORIGIN, auth: { authKind: 'bearer', token: 'tok' }, fetchImpl });
    const result = await drifted.callOperation(showPet, { petId: '1' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/origin/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a missing required path parameter without calling out', async () => {
    const fetchImpl = vi.fn();
    const result = await client(fetchImpl).callOperation(showPet, {});
    expect(result).toEqual({ isError: true, text: 'missing required path parameter: petId' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('turns a transport throw, an oversize body and a timeout into error results, never rejections', async () => {
    await expect(client(vi.fn().mockRejectedValue(new Error('socket hang up'))).callOperation(showPet, { petId: '1' }))
      .resolves.toEqual({ isError: true, text: 'request failed: socket hang up' });
    await expect(client(vi.fn().mockRejectedValue(new ResponseTooLargeError(OPENAPI_MAX_RESPONSE_BYTES))).callOperation(showPet, { petId: '1' }))
      .resolves.toEqual({ isError: true, text: `response exceeded the ${OPENAPI_MAX_RESPONSE_BYTES}-byte limit` });
    const abort = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    await expect(client(vi.fn().mockRejectedValue(abort)).callOperation(showPet, { petId: '1' }))
      .resolves.toEqual({ isError: true, text: `request timed out after ${OPENAPI_TIMEOUT_MS}ms` });
  });

  it('describes an empty 2xx body instead of returning nothing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(client(fetchImpl).callOperation(showPet, { petId: '1' })).resolves.toEqual({ isError: false, text: 'HTTP 204 (no content)' });
  });

  it('uses safeFetch by default and passes the private-egress flag through', async () => {
    vi.mocked(safeFetch).mockResolvedValue(json({ ok: true }));
    const viaDefault = new OpenApiClient({ baseUrl: BASE, credentialOrigin: ORIGIN, auth: { authKind: 'none' }, allowPrivateNetwork: true });
    await viaDefault.callOperation(showPet, { petId: '1' });
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(safeFetch).mock.calls[0]![1]).toMatchObject({ allowPrivateNetwork: true, method: 'GET' });
  });

  it('keeps the documented per-call limits', () => {
    expect(OPENAPI_TIMEOUT_MS).toBe(30_000);
    expect(OPENAPI_MAX_RESPONSE_BYTES).toBe(1_048_576);
    expect(OPENAPI_ERROR_BODY_CHARS).toBe(2_048);
  });

  it('never mints an oauth2 token when the base URL has drifted off the pinned origin', async () => {
    const fetchImpl = vi.fn();
    const drifted = new OpenApiClient({
      baseUrl: 'https://other.example/v1', credentialOrigin: ORIGIN, fetchImpl,
      auth: { authKind: 'oauth2_client_credentials', tokenUrl: 'https://id.example/token', clientId: 'drift-1', clientSecret: 's' },
    });
    const result = await drifted.callOperation(showPet, { petId: '1' });
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('enforces the response cap itself even when a transport ignores maxBytes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('x'.repeat(OPENAPI_MAX_RESPONSE_BYTES + 1), { status: 200 }));
    await expect(client(fetchImpl).callOperation(showPet, { petId: '1' }))
      .resolves.toEqual({ isError: true, text: `response exceeded the ${OPENAPI_MAX_RESPONSE_BYTES}-byte limit` });
  });

  it.each([
    ['api_key_header', { authKind: 'api_key_header', headerName: 'X-Api-Key', value: 'k3y-val-778' }, ['k3y-val-778']],
    ['basic', { authKind: 'basic', username: 'usr-1', password: 'pw-secret-55' }, [Buffer.from('usr-1:pw-secret-55').toString('base64')]],
  ])('redacts a %s credential echoed in an error body', async (_l, auth, secrets) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(`echo ${(secrets as string[]).join(' ')} done`, { status: 400 }));
    const result = await client(fetchImpl, auth).callOperation(showPet, { petId: '1' });
    for (const secret of secrets as string[]) expect(result.text).not.toContain(secret);
    expect(result.text).toContain('[REDACTED]');
  });

  it('redacts before cutting the error body, so a secret straddling the cut leaves no prefix', async () => {
    const token = 'straddling-secret-token-0123456789';
    const body = `${'x'.repeat(OPENAPI_ERROR_BODY_CHARS - 10)}${token}`;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(body, { status: 500 }));
    const result = await client(fetchImpl, { authKind: 'bearer', token }).callOperation(showPet, { petId: '1' });
    expect(result.text).not.toContain(token.slice(0, 10));
  });

  it('calls without credentials for authKind none even off the pinned origin', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({}));
    const anon = new OpenApiClient({ baseUrl: BASE, credentialOrigin: ORIGIN, auth: { authKind: 'none' }, fetchImpl });
    await anon.callOperation(showPet, { petId: '1' });
    expect(fetchImpl.mock.calls[0]![1].headers.Authorization).toBeUndefined();
  });
});
