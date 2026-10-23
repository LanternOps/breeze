import { createHash, randomUUID as nodeRandomUUID, type KeyObject } from 'node:crypto';
import {
  m365SyncActionResponseSchema,
  readActionRequestSchema,
  readActionResultSchema,
  retestRequestSchema,
  retestResultSchema,
  verifyConsentIdentityRequestSchema,
  verifyConsentIdentityResultSchema,
  syncActionRequestSchema,
  type M365SyncActionResult,
  type M365SyncFailureCode,
  type ReadActionRequest,
  type ReadActionResult,
  type RetestRequest,
  type RetestResult,
  type VerifyConsentIdentityRequest,
  type VerifyConsentIdentityResult,
  type SyncActionRequest,
} from '@breeze/shared/m365';
import { importJWK, SignJWT, type CryptoKey, type JWK } from 'jose';
import { z } from 'zod';
import {
  M365ExecutorClientError,
  decodeJson,
  exactJsonContentType,
  readBoundedResponse,
  transportFailureCause,
  type ExecutorClientFailureDetail,
} from './executorClientFailure';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024;
const READ_ACTION_MAX_RESPONSE_BYTES = 256 * 1024;
const TOKEN_LIFETIME_SECONDS = 60;
const SYNC_ACTION_TIMEOUT_MS = 130_000;
const SYNC_ACTION_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_SYNC_CAPACITY_RETRY_SECONDS = 30;

export type GraphReadExecutorOperation = 'verify-identity' | 'retest' | 'read-action' | 'sync-action';
type ExecutorOperation = GraphReadExecutorOperation;

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

/**
 * The read client's only error type. `code` is always `executor_unavailable`
 * (the only thing a caller may surface); `cause`, `httpStatus` and
 * `operation` are bounded internal diagnostics (#9322).
 */
export class GraphReadExecutorClientError extends M365ExecutorClientError<ExecutorOperation> {
  constructor(detail: ExecutorClientFailureDetail<ExecutorOperation>) {
    super(detail);
    this.name = 'GraphReadExecutorClientError';
  }
}

export interface GraphReadExecutorClient {
  /** Identity-first consent, phase 1 (#7910). */
  verifyConsentIdentity(input: VerifyConsentIdentityRequest): Promise<VerifyConsentIdentityResult>;
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

function unavailable(detail: ExecutorClientFailureDetail<ExecutorOperation>): GraphReadExecutorClientError {
  return new GraphReadExecutorClientError(detail);
}

function exactExecutorOrigin(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw unavailable({ cause: 'request_invalid' });
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.pathname !== '/'
    || parsed.search !== ''
    || parsed.hash !== ''
  ) throw unavailable({ cause: 'request_invalid' });
  return new URL(parsed.origin);
}

const OPERATION_ENDPOINT_PATHS: Record<ExecutorOperation, string> = {
  'verify-identity': '/v1/verify-identity',
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
  ) throw unavailable({ cause: 'request_invalid', operation });
  return endpoint.toString();
}

/**
 * Keeps the client's contract — it only ever throws its own error — for the
 * local serialization/hashing steps, the only ones left unclassified. They run
 * before anything is sent.
 */
async function classified<T>(operation: ExecutorOperation, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GraphReadExecutorClientError) throw error;
    throw unavailable({ cause: 'request_invalid', operation });
  }
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
    if (!Number.isSafeInteger(timeout) || timeout <= 0) throw unavailable({ cause: 'request_invalid', operation });
    const endpoint = operationEndpoint(executorOrigin, operation);
    // This is the sole serialization. The exact bytes are both signed and sent.
    const rawBody = JSON.stringify(input);
    const bodySha256 = createHash('sha256').update(rawBody).digest('base64url');
    const issuedAt = Math.floor(now().getTime() / 1_000);
    let token: string;
    try {
      token = await new SignJWT({ operation, correlationId: input.correlationId, bodySha256 })
        .setProtectedHeader({ alg: 'EdDSA', kid: config.signingKid })
        .setIssuer('breeze-api')
        .setAudience(config.executorAudience)
        .setSubject('breeze-control-plane')
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + TOKEN_LIFETIME_SECONDS)
        .setJti(randomUUID())
        .sign(await signingKey());
    } catch {
      throw unavailable({ cause: 'signing_failed', operation });
    }

    try {
      return await request(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(timeout),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: rawBody,
      });
    } catch (error) {
      throw unavailable({ cause: transportFailureCause(error), operation });
    }
  }

  function invoke<T>(
    operation: ExecutorOperation,
    input: VerifyConsentIdentityRequest | RetestRequest | ReadActionRequest,
    parseResponse: (value: unknown) => T,
    maxBytes: number = maxResponseBytes,
  ): Promise<T> {
    return classified(operation, async () => {
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw unavailable({ cause: 'request_invalid', operation });
      const response = await dispatch(operation, input, timeoutMs);
      if (!response.ok) throw unavailable({ cause: 'http_status', httpStatus: response.status, operation });
      if (!exactJsonContentType(response)) throw unavailable({ cause: 'content_type', operation });
      const value = decodeJson(await readBoundedResponse(response, maxBytes, unavailable, operation), unavailable, operation);
      try {
        return parseResponse(value);
      } catch {
        throw unavailable({ cause: 'schema_mismatch', operation });
      }
    });
  }

  return {
    verifyConsentIdentity(input) {
      const parsed = verifyConsentIdentityRequestSchema.safeParse(input);
      if (!parsed.success) return Promise.reject(unavailable({ cause: 'request_invalid', operation: 'verify-identity' }));
      return invoke('verify-identity', parsed.data, (value) => verifyConsentIdentityResultSchema.parse(value));
    },
    retestCustomerGraphRead(input) {
      const parsed = retestRequestSchema.safeParse(input);
      if (!parsed.success) return Promise.reject(unavailable({ cause: 'request_invalid', operation: 'retest' }));
      return invoke('retest', parsed.data, (value) => retestResultSchema.parse(value));
    },
    executeReadAction(input) {
      const parsed = readActionRequestSchema.safeParse(input);
      if (!parsed.success) return Promise.reject(unavailable({ cause: 'request_invalid', operation: 'read-action' }));
      return invoke(
        'read-action',
        parsed.data,
        (value) => readActionResultSchema.parse(value),
        READ_ACTION_MAX_RESPONSE_BYTES,
      );
    },
    async syncAction(input) {
      const operation = 'sync-action' as const;
      const parsed = syncActionRequestSchema.safeParse(input);
      if (!parsed.success) throw unavailable({ cause: 'request_invalid', operation });
      return classified(operation, async () => {
        const response = await dispatch(operation, parsed.data, SYNC_ACTION_TIMEOUT_MS);
        const isCapacityRefusal = response.status === 503;
        const httpFailure = () => unavailable({ cause: 'http_status', httpStatus: response.status, operation });
        if (!response.ok && !isCapacityRefusal) throw httpFailure();
        // A 503 that is not a well-formed capacity refusal is reported as the
        // 503 it was, not as a body problem.
        if (!exactJsonContentType(response)) throw isCapacityRefusal ? httpFailure() : unavailable({ cause: 'content_type', operation });
        const raw = await readBoundedResponse(response, SYNC_ACTION_MAX_RESPONSE_BYTES, unavailable, operation);

        if (isCapacityRefusal) {
          let body: unknown;
          try {
            body = decodeJson(raw, unavailable, operation);
          } catch {
            throw httpFailure();
          }
          const refusal = capacityRefusalSchema.safeParse(body);
          if (!refusal.success) throw httpFailure();
          return {
            success: false,
            code: 'sync_capacity',
            retryAfterSeconds: refusal.data.retryAfterSeconds ?? DEFAULT_SYNC_CAPACITY_RETRY_SECONDS,
          } satisfies GraphReadExecutorFailure;
        }

        const parsedResponse = m365SyncActionResponseSchema.safeParse(decodeJson(raw, unavailable, operation));
        if (!parsedResponse.success) throw unavailable({ cause: 'schema_mismatch', operation });
        if (parsedResponse.data.success) return parsedResponse.data;
        return {
          success: false,
          code: parsedResponse.data.code,
          ...(parsedResponse.data.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: parsedResponse.data.retryAfterSeconds }),
        } satisfies GraphReadExecutorFailure;
      });
    },
  };
}
