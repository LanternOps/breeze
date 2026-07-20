import { createClientAssertion } from './clientAssertion';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

declare const accessTokenBrand: unique symbol;
declare const identityTokenBrand: unique symbol;
export type OpaqueAccessToken = string & { readonly [accessTokenBrand]: true };
export type OpaqueIdentityToken = string & { readonly [identityTokenBrand]: true };

export type MicrosoftTokenClientErrorCode =
  | 'token_request_invalid'
  | 'token_request_timeout'
  | 'token_transport_failed'
  | 'token_response_too_large'
  | 'token_response_invalid'
  | 'token_provider_rejected';

export class MicrosoftTokenClientError extends Error {
  constructor(readonly code: MicrosoftTokenClientErrorCode) {
    super(code);
    this.name = 'MicrosoftTokenClientError';
  }
}

export interface MicrosoftTokenClient {
  exchangeAuthorizationCode(input: {
    tenantId: string;
    code: string;
    codeVerifier: string;
  }): Promise<OpaqueIdentityToken>;
  acquireGraphAppToken(input: { tenantId: string }): Promise<OpaqueAccessToken>;
}

interface TokenClientConfig {
  clientId: string;
  // Optional: this executor only ever calls acquireGraphAppToken (client
  // credentials), never exchangeAuthorizationCode, so there is no browser
  // redirect to configure. Defaulted rather than forcing callers to pass a
  // bogus value.
  callbackUrl?: string;
  certificatePem: string;
  privateKeyPem: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

interface TokenClientDependencies {
  fetch?: typeof fetch;
}

function failure(code: MicrosoftTokenClientErrorCode): MicrosoftTokenClientError {
  return new MicrosoftTokenClientError(code);
}

function tenantTokenEndpoint(tenantId: string): string {
  if (!CANONICAL_UUID.test(tenantId)) throw failure('token_request_invalid');
  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
}

function required(value: string): string {
  if (!value) throw failure('token_request_invalid');
  return value;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && /^(?:0|[1-9][0-9]*)$/.test(declaredLength)) {
    let declaredBytes: bigint | undefined;
    try {
      declaredBytes = BigInt(declaredLength);
    } catch {
      declaredBytes = undefined;
    }
    if (declaredBytes !== undefined && declaredBytes > BigInt(maxBytes)) {
      throw failure('token_response_too_large');
    }
  }

  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw failure('token_response_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function parseSuccessBody(body: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw failure('token_response_invalid');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof MicrosoftTokenClientError) throw error;
    throw failure('token_response_invalid');
  }
}

export function createMicrosoftTokenClient(
  config: TokenClientConfig,
  dependencies: TokenClientDependencies = {},
): MicrosoftTokenClient {
  const fetchImpl = dependencies.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  async function request(tenantId: string, body: URLSearchParams): Promise<Record<string, unknown>> {
    const endpoint = tenantTokenEndpoint(tenantId);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw failure('token_request_invalid');
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
      throw failure('token_request_invalid');
    }

    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
      });
      const responseBody = await readBoundedBody(response, maxResponseBytes);
      if (!response.ok) throw failure('token_provider_rejected');
      return parseSuccessBody(responseBody);
    } catch (error) {
      if (error instanceof MicrosoftTokenClientError) throw error;
      if (timedOut) throw failure('token_request_timeout');
      throw failure('token_transport_failed');
    } finally {
      clearTimeout(timeout);
    }
  }

  async function assertion(tenantId: string): Promise<string> {
    try {
      return await createClientAssertion({
        clientId: config.clientId,
        tenantId,
        certificatePem: config.certificatePem,
        privateKeyPem: config.privateKeyPem,
      });
    } catch {
      throw failure('token_request_invalid');
    }
  }

  return {
    async exchangeAuthorizationCode(input) {
      const body = new URLSearchParams({
        client_id: config.clientId,
        grant_type: 'authorization_code',
        code: required(input.code),
        code_verifier: required(input.codeVerifier),
        redirect_uri: config.callbackUrl ?? '',
        client_assertion_type: CLIENT_ASSERTION_TYPE,
        client_assertion: await assertion(input.tenantId),
      });
      const response = await request(input.tenantId, body);
      if (typeof response.id_token !== 'string' || !response.id_token) {
        throw failure('token_response_invalid');
      }
      return response.id_token as OpaqueIdentityToken;
    },

    async acquireGraphAppToken(input) {
      const body = new URLSearchParams({
        client_id: config.clientId,
        grant_type: 'client_credentials',
        scope: GRAPH_SCOPE,
        client_assertion_type: CLIENT_ASSERTION_TYPE,
        client_assertion: await assertion(input.tenantId),
      });
      const response = await request(input.tenantId, body);
      if (
        response.token_type !== 'Bearer'
        || typeof response.access_token !== 'string'
        || !response.access_token
      ) {
        throw failure('token_response_invalid');
      }
      return response.access_token as OpaqueAccessToken;
    },
  };
}
