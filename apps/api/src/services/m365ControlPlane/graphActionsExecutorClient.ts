import { createHash, randomUUID as nodeRandomUUID, type KeyObject } from 'node:crypto';
import {
  retestRequestSchema,
  retestResultSchema,
  verifyConsentIdentityRequestSchema,
  verifyConsentIdentityResultSchema,
  writeActionRequestSchema,
  writeActionResultSchema,
  type RetestRequest,
  type RetestResult,
  type VerifyConsentIdentityRequest,
  type VerifyConsentIdentityResult,
  type WriteActionRequest,
  type WriteActionResult,
} from '@breeze/shared/m365';
import { importJWK, SignJWT, type CryptoKey, type JWK } from 'jose';
import {
  M365ExecutorClientError,
  decodeJson,
  exactJsonContentType,
  readBoundedResponse,
  transportFailureCause,
  type ExecutorClientFailureDetail,
} from './executorClientFailure';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const TOKEN_LIFETIME_SECONDS = 60;

export type GraphActionsExecutorOperation = 'verify-identity' | 'retest' | 'execute-action';
type ExecutorOperation = GraphActionsExecutorOperation;

/**
 * The actions client's only error type. `code` is always
 * `executor_unavailable`; `cause`, `httpStatus` and `operation` are bounded
 * internal diagnostics (#9322).
 */
export class GraphActionsExecutorClientError extends M365ExecutorClientError<ExecutorOperation> {
  constructor(detail: ExecutorClientFailureDetail<ExecutorOperation>) {
    super(detail);
    this.name = 'GraphActionsExecutorClientError';
  }
}

export interface GraphActionsExecutorClient {
  /** Identity-first consent, phase 1 (#7910). */
  verifyConsentIdentity(input: VerifyConsentIdentityRequest): Promise<VerifyConsentIdentityResult>;
  retestCustomerGraphActions(input: RetestRequest): Promise<RetestResult>;
  executeWriteAction(input: WriteActionRequest): Promise<WriteActionResult>;
}

export interface GraphActionsExecutorClientConfig {
  executorUrl: string;
  executorAudience: 'm365-graph-actions-executor';
  signingPrivateJwk: JWK;
  signingKid: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => Date;
  randomUUID?: () => string;
}

function unavailable(detail: ExecutorClientFailureDetail<ExecutorOperation>): GraphActionsExecutorClientError {
  return new GraphActionsExecutorClientError(detail);
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
  'execute-action': '/v1/execute-action',
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

export function createGraphActionsExecutorClient(
  config: GraphActionsExecutorClientConfig,
): GraphActionsExecutorClient {
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

  async function invoke<T>(
    operation: ExecutorOperation,
    input: VerifyConsentIdentityRequest | RetestRequest | WriteActionRequest,
    parseResponse: (value: unknown) => T,
    maxBytes: number = maxResponseBytes,
  ): Promise<T> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
      || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw unavailable({ cause: 'request_invalid', operation });
    }

    try {
      const endpoint = operationEndpoint(executorOrigin, operation);
      // This is the sole serialization. The exact bytes are both signed and sent.
      const rawBody = JSON.stringify(input);
      const bodySha256 = createHash('sha256').update(rawBody).digest('base64url');
      const issuedAt = Math.floor(now().getTime() / 1_000);
      let token: string;
      try {
        token = await new SignJWT({
          operation,
          correlationId: input.correlationId,
          bodySha256,
        })
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

      let response: Response;
      try {
        response = await request(endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: rawBody,
        });
      } catch (error) {
        throw unavailable({ cause: transportFailureCause(error), operation });
      }
      if (!response.ok) throw unavailable({ cause: 'http_status', httpStatus: response.status, operation });
      if (!exactJsonContentType(response)) throw unavailable({ cause: 'content_type', operation });
      const value = decodeJson(await readBoundedResponse(response, maxBytes, unavailable, operation), unavailable, operation);
      try {
        return parseResponse(value);
      } catch {
        throw unavailable({ cause: 'schema_mismatch', operation });
      }
    } catch (error) {
      if (error instanceof GraphActionsExecutorClientError) throw error;
      // Only the local serialization/hashing steps reach here; nothing was sent.
      throw unavailable({ cause: 'request_invalid', operation });
    }
  }

  return {
    verifyConsentIdentity(input) {
      const parsed = verifyConsentIdentityRequestSchema.safeParse(input);
      if (!parsed.success) return Promise.reject(unavailable({ cause: 'request_invalid', operation: 'verify-identity' }));
      return invoke('verify-identity', parsed.data, (value) => verifyConsentIdentityResultSchema.parse(value));
    },
    retestCustomerGraphActions(input) {
      const parsed = retestRequestSchema.safeParse(input);
      if (!parsed.success) return Promise.reject(unavailable({ cause: 'request_invalid', operation: 'retest' }));
      return invoke('retest', parsed.data, (value) => retestResultSchema.parse(value));
    },
    executeWriteAction(input) {
      const parsed = writeActionRequestSchema.safeParse(input);
      if (!parsed.success) return Promise.reject(unavailable({ cause: 'request_invalid', operation: 'execute-action' }));
      return invoke('execute-action', parsed.data, (value) => writeActionResultSchema.parse(value));
    },
  };
}
