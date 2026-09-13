import { createHash, randomUUID as nodeRandomUUID, type KeyObject } from 'node:crypto';
import {
  completeConsentRequestSchema,
  completeConsentResultSchema,
  m365SyncActionResponseSchema,
  readActionRequestSchema,
  readActionResultSchema,
  retestRequestSchema,
  retestResultSchema,
  syncActionRequestSchema,
  type CompleteConsentRequest,
  type CompleteConsentResult,
  type M365SyncActionResult,
  type M365SyncFailureCode,
  type ReadActionRequest,
  type ReadActionResult,
  type RetestRequest,
  type RetestResult,
  type SyncActionRequest,
} from '@breeze/shared/m365';
import { importJWK, SignJWT, type CryptoKey, type JWK } from 'jose';
import { z } from 'zod';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024;
const READ_ACTION_MAX_RESPONSE_BYTES = 256 * 1024;
const TOKEN_LIFETIME_SECONDS = 60;
const SYNC_ACTION_TIMEOUT_MS = 130_000;
const SYNC_ACTION_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_SYNC_CAPACITY_RETRY_SECONDS = 30;

type ExecutorOperation = 'complete-consent' | 'retest' | 'read-action' | 'sync-action';

/**
 * An outcome the executor reported. Distinct from GraphReadExecutorClientError,
 * which still means "we could not get an answer" and is still thrown: a caller
 * that must back off for a stated number of seconds needs the number, and
 * collapsing 503 sync_capacity into executor_unavailable throws it away.
 */
export interface GraphReadExecutorFailure {
  success: false;
  code: M365SyncFailureCode | 'sync_capacity';
  retryAfterSeconds?: number;
}

const capacityRefusalSchema = z.object({
  code: z.literal('sync_capacity'),
  retryAfterSeconds: z.number().int().min(1).max(300).optional(),
});

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

export class GraphReadExecutorClientError extends Error {
  readonly code = 'executor_unavailable' as const;

  constructor() {
    super('executor_unavailable');
    this.name = 'GraphReadExecutorClientError';
  }
}

export interface GraphReadExecutorClient {
  completeIdentityVerification(input: CompleteConsentRequest): Promise<CompleteConsentResult>;
  retestCustomerGraphRead(input: RetestRequest): Promise<RetestResult>;
  executeReadAction(input: ReadActionRequest): Promise<ReadActionResult>;
  syncAction(input: SyncActionRequest): Promise<M365SyncActionResult | GraphReadExecutorFailure>;
}

export interface GraphReadExecutorClientConfig {
  executorUrl: string;
  executorAudience: 'm365-graph-read-executor';
  signingPrivateJwk: JWK;
  signingKid: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => Date;
  randomUUID?: () => string;
}

function unavailable(): GraphReadExecutorClientError {
  return new GraphReadExecutorClientError();
}

function exactExecutorOrigin(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw unavailable();
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.pathname !== '/'
    || parsed.search !== ''
    || parsed.hash !== ''
  ) throw unavailable();
  return new URL(parsed.origin);
}

const OPERATION_ENDPOINT_PATHS: Record<ExecutorOperation, string> = {
  'complete-consent': '/v1/complete-consent',
  retest: '/v1/retest',
  'read-action': '/v1/read-action',
  'sync-action': '/v1/sync-action',
};

function operationEndpoint(origin: URL, operation: ExecutorOperation): string {
  const expectedPath = OPERATION_ENDPOINT_PATHS[operation];
  const endpoint = new URL(expectedPath, origin);
  if (
    endpoint.origin !== origin.origin
    || endpoint.pathname !== expectedPath
    || endpoint.search !== ''
    || endpoint.hash !== ''
    || endpoint.username !== ''
    || endpoint.password !== ''
  ) throw unavailable();
  return endpoint.toString();
}

function exactJsonContentType(response: Response): boolean {
  const value = response.headers.get('content-type')?.toLowerCase();
  return value === 'application/json' || value === 'application/json; charset=utf-8';
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && /^(?:0|[1-9][0-9]*)$/.test(declaredLength)) {
    try {
      if (BigInt(declaredLength) > BigInt(maxBytes)) throw unavailable();
    } catch (error) {
      if (error instanceof GraphReadExecutorClientError) throw error;
      throw unavailable();
    }
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw unavailable();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function createGraphReadExecutorClient(
  config: GraphReadExecutorClientConfig,
): GraphReadExecutorClient {
  const executorOrigin = exactExecutorOrigin(config.executorUrl);
  const request = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const now = config.now ?? (() => new Date());
  const randomUUID = config.randomUUID ?? nodeRandomUUID;
  let signingKeyPromise: Promise<CryptoKey | KeyObject | Uint8Array> | undefined;

  function signingKey(): Promise<CryptoKey | KeyObject | Uint8Array> {
    signingKeyPromise ??= importJWK(config.signingPrivateJwk, 'EdDSA');
    return signingKeyPromise;
  }

  async function dispatch(
    operation: ExecutorOperation,
    input: { correlationId: string },
    timeout: number,
  ): Promise<Response> {
    if (!Number.isSafeInteger(timeout) || timeout <= 0) throw unavailable();
    // This is the sole serialization. The exact bytes are both signed and sent.
    const rawBody = JSON.stringify(input);
    const bodySha256 = createHash('sha256').update(rawBody).digest('base64url');
    const issuedAt = Math.floor(now().getTime() / 1_000);
    const token = await new SignJWT({ operation, correlationId: input.correlationId, bodySha256 })
      .setProtectedHeader({ alg: 'EdDSA', kid: config.signingKid })
      .setIssuer('breeze-api')
      .setAudience(config.executorAudience)
      .setSubject('breeze-control-plane')
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + TOKEN_LIFETIME_SECONDS)
      .setJti(randomUUID())
      .sign(await signingKey());

    return request(operationEndpoint(executorOrigin, operation), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: rawBody,
    });
  }

  async function invoke<T>(
    operation: ExecutorOperation,
    input: CompleteConsentRequest | RetestRequest | ReadActionRequest,
    parseResponse: (value: unknown) => T,
    maxBytes: number = maxResponseBytes,
  ): Promise<T> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw unavailable();
    try {
      const response = await dispatch(operation, input, timeoutMs);
      if (!response.ok || !exactJsonContentType(response)) throw unavailable();
      const rawResponse = await readBoundedResponse(response, maxBytes);
      return parseResponse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawResponse)));
    } catch {
      throw unavailable();
    }
  }

  return {
    completeIdentityVerification(input) {
      const parsed = completeConsentRequestSchema.safeParse(input);
      if (!parsed.success) return Promise.reject(unavailable());
      return invoke('complete-consent', parsed.data, (value) => completeConsentResultSchema.parse(value));
    },
    retestCustomerGraphRead(input) {
      const parsed = retestRequestSchema.safeParse(input);
      if (!parsed.success) return Promise.reject(unavailable());
      return invoke('retest', parsed.data, (value) => retestResultSchema.parse(value));
    },
    executeReadAction(input) {
      const parsed = readActionRequestSchema.safeParse(input);
      if (!parsed.success) return Promise.reject(unavailable());
      return invoke(
        'read-action',
        parsed.data,
        (value) => readActionResultSchema.parse(value),
        READ_ACTION_MAX_RESPONSE_BYTES,
      );
    },
    async syncAction(input) {
      const parsed = syncActionRequestSchema.safeParse(input);
      if (!parsed.success) throw unavailable();
      let response: Response;
      let decoded: string;
      try {
        response = await dispatch('sync-action', parsed.data, SYNC_ACTION_TIMEOUT_MS);
        if (!exactJsonContentType(response)) throw unavailable();
        const raw = await readBoundedResponse(response, SYNC_ACTION_MAX_RESPONSE_BYTES);
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      } catch {
        throw unavailable();
      }

      if (response.status === 503) {
        const body = capacityRefusalSchema.safeParse(safeJson(decoded));
        if (!body.success) throw unavailable();
        return {
          success: false,
          code: 'sync_capacity',
          retryAfterSeconds: body.data.retryAfterSeconds ?? DEFAULT_SYNC_CAPACITY_RETRY_SECONDS,
        };
      }
      if (!response.ok) throw unavailable();

      const parsedResponse = m365SyncActionResponseSchema.safeParse(safeJson(decoded));
      if (!parsedResponse.success) throw unavailable();
      if (parsedResponse.data.success) return parsedResponse.data;
      return {
        success: false,
        code: parsedResponse.data.code,
        ...(parsedResponse.data.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: parsedResponse.data.retryAfterSeconds }),
      };
    },
  };
}
