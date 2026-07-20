import { createHash, randomUUID as nodeRandomUUID, type KeyObject } from 'node:crypto';
import {
  writeActionRequestSchema,
  writeActionResultSchema,
  type WriteActionRequest,
  type WriteActionResult,
} from '@breeze/shared/m365';
import { importJWK, SignJWT, type CryptoKey, type JWK } from 'jose';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const TOKEN_LIFETIME_SECONDS = 60;

type ExecutorOperation = 'execute-action';

export class GraphActionsExecutorClientError extends Error {
  readonly code = 'executor_unavailable' as const;

  constructor() {
    super('executor_unavailable');
    this.name = 'GraphActionsExecutorClientError';
  }
}

export interface GraphActionsExecutorClient {
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

function unavailable(): GraphActionsExecutorClientError {
  return new GraphActionsExecutorClientError();
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
      if (error instanceof GraphActionsExecutorClientError) throw error;
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
    input: WriteActionRequest,
    parseResponse: (value: unknown) => T,
    maxBytes: number = maxResponseBytes,
  ): Promise<T> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
      || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw unavailable();
    }

    try {
      // This is the sole serialization. The exact bytes are both signed and sent.
      const rawBody = JSON.stringify(input);
      const bodySha256 = createHash('sha256').update(rawBody).digest('base64url');
      const issuedAt = Math.floor(now().getTime() / 1_000);
      const token = await new SignJWT({
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

      const response = await request(operationEndpoint(executorOrigin, operation), {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: rawBody,
      });
      if (!response.ok || !exactJsonContentType(response)) throw unavailable();
      const rawResponse = await readBoundedResponse(response, maxBytes);
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(rawResponse);
      return parseResponse(JSON.parse(decoded));
    } catch {
      throw unavailable();
    }
  }

  return {
    executeWriteAction(input) {
      const parsed = writeActionRequestSchema.safeParse(input);
      if (!parsed.success) return Promise.reject(unavailable());
      return invoke('execute-action', parsed.data, (value) => writeActionResultSchema.parse(value));
    },
  };
}
