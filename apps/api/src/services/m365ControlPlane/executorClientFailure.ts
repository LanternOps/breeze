/**
 * Why an M365 executor call failed (#9322). Internal diagnostics only: the
 * public code on every executor client error stays `executor_unavailable`,
 * and nothing here is ever shown to a customer. Each value is a fixed label,
 * so it is safe to log, audit, and use as a metric label.
 */
export type ExecutorClientFailureCause =
  /** The request never got an HTTP response (DNS, connect, TLS, reset). */
  | 'network'
  /** The request was aborted by its timeout. */
  | 'timeout'
  /** The executor answered with a non-2xx status (see `httpStatus`). */
  | 'http_status'
  /** A 2xx response that is not exactly `application/json`. */
  | 'content_type'
  /** The response exceeded the byte cap. */
  | 'response_too_large'
  /** The response body is not UTF-8 JSON. */
  | 'malformed_json'
  /** The JSON does not match the operation's result contract. */
  | 'schema_mismatch'
  /** The API built a request (or holds a configuration) that fails its own contract; nothing was sent. */
  | 'request_invalid'
  /** The API could not sign the internal request token; nothing was sent. */
  | 'signing_failed';

export interface ExecutorClientFailureDetail<Operation extends string = string> {
  cause: ExecutorClientFailureCause;
  /** Set only for `http_status`. */
  httpStatus?: number;
  /** Absent only when the failure precedes any operation (client construction). */
  operation?: Operation;
}

/**
 * Base for both executor client errors. `message` and `code` are fixed so a
 * caught error can never echo an executor body, a request field, or a token;
 * the diagnostic fields are bounded labels.
 */
export class M365ExecutorClientError<Operation extends string = string> extends Error {
  readonly code = 'executor_unavailable' as const;
  override readonly cause: ExecutorClientFailureCause;
  readonly httpStatus?: number;
  readonly operation?: Operation;

  constructor(detail: ExecutorClientFailureDetail<Operation>) {
    super('executor_unavailable');
    this.name = 'M365ExecutorClientError';
    this.cause = detail.cause;
    if (detail.cause === 'http_status' && detail.httpStatus !== undefined) this.httpStatus = detail.httpStatus;
    if (detail.operation !== undefined) this.operation = detail.operation;
  }

  /** Only the bounded fields — keeps `JSON.stringify(error)` and loggers safe. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      cause: this.cause,
      ...(this.httpStatus === undefined ? {} : { httpStatus: this.httpStatus }),
      ...(this.operation === undefined ? {} : { operation: this.operation }),
    };
  }
}

/** A fetch rejection: an abort from the request's own timeout signal, or a transport failure. */
export function transportFailureCause(error: unknown): 'timeout' | 'network' {
  const name = error && typeof error === 'object' && 'name' in error ? (error as { name?: unknown }).name : undefined;
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network';
}

/** The JSON media types the executors send; anything else is `content_type`. */
export function exactJsonContentType(response: Response): boolean {
  const value = response.headers.get('content-type')?.toLowerCase();
  return value === 'application/json' || value === 'application/json; charset=utf-8';
}

/**
 * Reads at most `maxBytes` of the body. Throws `response_too_large` past the
 * cap, and `timeout` or `network` when the stream itself fails mid-read (the
 * request's timeout signal also aborts the body).
 */
export async function readBoundedResponse<Operation extends string>(
  response: Response,
  maxBytes: number,
  fail: (detail: ExecutorClientFailureDetail<Operation>) => M365ExecutorClientError<Operation>,
  operation: Operation,
): Promise<Uint8Array> {
  const tooLarge = () => fail({ cause: 'response_too_large', operation });
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && /^(?:0|[1-9][0-9]*)$/.test(declaredLength)
    && BigInt(declaredLength) > BigInt(maxBytes)) {
    throw tooLarge();
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw fail({ cause: transportFailureCause(error), operation });
      }
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(chunk.value);
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

/** Strict UTF-8 JSON decode; any failure is `malformed_json`. */
export function decodeJson<Operation extends string>(
  raw: Uint8Array,
  fail: (detail: ExecutorClientFailureDetail<Operation>) => M365ExecutorClientError<Operation>,
  operation: Operation,
): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as unknown;
  } catch {
    throw fail({ cause: 'malformed_json', operation });
  }
}
