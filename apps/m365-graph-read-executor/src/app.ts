import {
  isM365SyncAction,
  m365SyncActionResponseSchema,
  readActionRequestSchema,
  readActionResultSchema,
  retestRequestSchema,
  retestResultSchema,
  verifyConsentIdentityRequestSchema,
  verifyConsentIdentityResultSchema,
  syncActionRequestSchema,
  type M365SyncActionResponse,
  type ReadActionRequest,
  type ReadActionResult,
  type RetestRequest,
  type RetestResult,
  type VerifyConsentIdentityRequest,
  type VerifyConsentIdentityResult,
  type SyncActionRequest,
} from '@breeze/shared/m365';
import { Hono, type Context } from 'hono';
import { createInFlightGate, type InFlightGate } from './inFlight';
import type { ExecutorOperation, InternalRequestAuthenticator } from './internalAuth';
import { renderMetrics } from './metrics';

const DEFAULT_MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_SYNC_TIMEOUT_MS = 120_000;
const SYNC_CAPACITY_RETRY_AFTER_SECONDS = 30;
const INTERACTIVE_CAPACITY_RETRY_AFTER_SECONDS = 5;

export interface ExecutorAppDependencies {
  authenticator: InternalRequestAuthenticator;
  verifyIdentity(request: VerifyConsentIdentityRequest): Promise<VerifyConsentIdentityResult>;
  retest(request: RetestRequest): Promise<RetestResult>;
  readAction(request: ReadActionRequest): Promise<ReadActionResult>;
  syncAction(request: SyncActionRequest): Promise<M365SyncActionResponse>;
  maxBodyBytes?: number;
  /** Defaults to an unbounded-enough gate so existing callers keep working. */
  gate?: InFlightGate;
  syncTimeoutMs?: number;
}

class RequestTooLarge extends Error {}

async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && /^(?:0|[1-9][0-9]*)$/.test(declaredLength)) {
    try {
      if (BigInt(declaredLength) > BigInt(maxBytes)) throw new RequestTooLarge();
    } catch (error) {
      if (error instanceof RequestTooLarge) throw error;
    }
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RequestTooLarge();
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

function jsonContentType(contentType: string | undefined): boolean {
  return contentType === 'application/json' || contentType === 'application/json; charset=utf-8';
}

const FAILURE_LOG_MESSAGE = '[m365-graph-read-executor] request failed';

/** What a failed request may log: bounded labels only (#9322). */
interface RequestFailureState {
  /** Only from a token that verified — never from the unauthenticated body. */
  correlationId?: string;
  errorName?: string;
}

/** The `/v1/<operation>` segment, when it is a plausible operation name. */
function pathOperation(path: string): string | null {
  return /^\/v1\/([a-z][a-z-]{0,39})$/.exec(path)?.[1] ?? null;
}

/** An error's class name, never its message (which may carry provider text). */
function boundedErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : 'Error';
}

/** Our own JSON envelopes always carry a fixed `error` code; read only that. */
async function responseErrorCode(response: Response): Promise<string | null> {
  try {
    const body = await response.clone().json() as { error?: unknown };
    return typeof body.error === 'string' && /^[a-z_]{1,64}$/.test(body.error) ? body.error : null;
  } catch {
    return null;
  }
}

/**
 * One line per non-2xx response so an API-side `executor_unavailable` can be
 * matched to its cause by correlation ID. Never logs the request body, the
 * Authorization header, or an error message.
 */
function logRequestFailure(fields: {
  operation: string | null;
  status: number;
  error: string | null;
  correlationId?: string;
  errorName?: string;
}): void {
  const line = {
    operation: fields.operation,
    ...(fields.correlationId === undefined ? {} : { correlationId: fields.correlationId }),
    status: fields.status,
    error: fields.error,
    ...(fields.errorName === undefined ? {} : { errorName: fields.errorName }),
  };
  if (fields.status >= 500) console.error(FAILURE_LOG_MESSAGE, line);
  else console.warn(FAILURE_LOG_MESSAGE, line);
}

export function createExecutorApp(dependencies: ExecutorAppDependencies): Hono {
  const app = new Hono();
  const maxBodyBytes = dependencies.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const gate = dependencies.gate ?? createInFlightGate({ syncMaxInFlight: 4, maxInFlight: 32 });
  const syncTimeoutMs = dependencies.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;

  function capacityRefusal(context: Context, kind: 'sync' | 'interactive') {
    const [code, retryAfterSeconds] = kind === 'sync'
      ? ['sync_capacity' as const, SYNC_CAPACITY_RETRY_AFTER_SECONDS]
      : ['capacity' as const, INTERACTIVE_CAPACITY_RETRY_AFTER_SECONDS];
    context.header('Retry-After', String(retryAfterSeconds));
    // `error` keeps the executor's envelope; `code` satisfies the wave contract.
    return context.json({ error: code, code, retryAfterSeconds }, 503);
  }

  /** Bounds one operation so a wedged Graph call cannot hold a slot forever. */
  async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | 'timed-out'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<'timed-out'>((resolve) => { timer = setTimeout(() => resolve('timed-out'), ms); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Runs one operation and logs it if it ends non-2xx. */
  async function logged(context: Context, operation: ExecutorOperation): Promise<Response> {
    const state: RequestFailureState = {};
    const response = await execute(context, operation, state);
    if (!response.ok) {
      const error = await responseErrorCode(response);
      // A sync capacity refusal is expected backpressure the API handles as a
      // typed back-off, not a failure; logging each one would bury real ones.
      if (error !== 'sync_capacity') {
        logRequestFailure({ operation, status: response.status, error, ...state });
      }
    }
    return response;
  }

  async function execute(
    context: Context,
    operation: ExecutorOperation,
    state: RequestFailureState,
  ) {
    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
      return context.json({ error: 'unavailable' }, 503);
    }
    if (!jsonContentType(context.req.header('content-type'))) {
      return context.json({ error: 'unsupported_content_type' }, 415);
    }
    let rawBody: Uint8Array;
    try {
      rawBody = await readBoundedBody(context.req.raw, maxBodyBytes);
    } catch {
      return context.json({ error: 'request_too_large' }, 413);
    }
    let authentication: { correlationId: string };
    try {
      authentication = await dependencies.authenticator.verify({
        authorization: context.req.header('authorization'),
        operation,
        rawBody,
      });
    } catch {
      return context.json({ error: 'unauthorized' }, 401);
    }
    state.correlationId = authentication.correlationId;
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody));
    } catch {
      return context.json({ error: 'invalid_request' }, 400);
    }
    if (operation === 'verify-identity') {
      const request = verifyConsentIdentityRequestSchema.safeParse(parsed);
      if (!request.success) return context.json({ error: 'invalid_request' }, 400);
      if (request.data.correlationId !== authentication.correlationId) {
        return context.json({ error: 'unauthorized' }, 401);
      }
      try {
        const result = verifyConsentIdentityResultSchema.safeParse(
          await dependencies.verifyIdentity(request.data),
        );
        return result.success
          ? context.json(result.data)
          : context.json({ error: 'internal_error' }, 500);
      } catch (error) {
        state.errorName = boundedErrorName(error);
        return context.json({ error: 'internal_error' }, 500);
      }
    }
    if (operation === 'read-action') {
      const request = readActionRequestSchema.safeParse(parsed);
      if (!request.success) return context.json({ error: 'invalid_request' }, 400);
      if (request.data.correlationId !== authentication.correlationId) {
        return context.json({ error: 'unauthorized' }, 401);
      }
      if (isM365SyncAction(request.data.action)) {
        return context.json({ error: 'action_not_allowed', code: 'action_not_allowed' }, 400);
      }
      const lease = gate.acquire('interactive');
      if (lease === null) return capacityRefusal(context, 'interactive');
      try {
        const result = readActionResultSchema.safeParse(await dependencies.readAction(request.data));
        return result.success ? context.json(result.data) : context.json({ error: 'internal_error' }, 500);
      } catch (error) {
        state.errorName = boundedErrorName(error);
        return context.json({ error: 'internal_error' }, 500);
      } finally {
        lease.release();
      }
    }
    if (operation === 'sync-action') {
      const request = syncActionRequestSchema.safeParse(parsed);
      if (!request.success) {
        // A well-formed request naming an interactive action is a routing
        // mistake, not malformed input — say so.
        const readShaped = readActionRequestSchema.safeParse(parsed);
        return readShaped.success
          ? context.json({ error: 'action_not_allowed', code: 'action_not_allowed' }, 400)
          : context.json({ error: 'invalid_request' }, 400);
      }
      if (request.data.correlationId !== authentication.correlationId) {
        return context.json({ error: 'unauthorized' }, 401);
      }
      const lease = gate.acquire('sync');
      if (lease === null) return capacityRefusal(context, 'sync');
      try {
        const outcome = await withTimeout(dependencies.syncAction(request.data), syncTimeoutMs);
        if (outcome === 'timed-out') return context.json({ error: 'sync_timeout' }, 504);
        const result = m365SyncActionResponseSchema.safeParse(outcome);
        return result.success ? context.json(result.data) : context.json({ error: 'internal_error' }, 500);
      } catch (error) {
        state.errorName = boundedErrorName(error);
        return context.json({ error: 'internal_error' }, 500);
      } finally {
        lease.release();
      }
    }
    const request = retestRequestSchema.safeParse(parsed);
    if (!request.success) return context.json({ error: 'invalid_request' }, 400);
    if (request.data.correlationId !== authentication.correlationId) {
      return context.json({ error: 'unauthorized' }, 401);
    }
    try {
      const result = retestResultSchema.safeParse(await dependencies.retest(request.data));
      return result.success
        ? context.json(result.data)
        : context.json({ error: 'internal_error' }, 500);
    } catch (error) {
      state.errorName = boundedErrorName(error);
      return context.json({ error: 'internal_error' }, 500);
    }
  }

  app.get('/healthz', (context) => context.json({ status: 'ok' }));
  app.get('/metrics', (context) => context.text(renderMetrics(), 200, {
    'content-type': 'text/plain; version=0.0.4; charset=utf-8',
  }));
  app.post('/v1/verify-identity', (context) => logged(context, 'verify-identity'));
  app.post('/v1/retest', (context) => logged(context, 'retest'));
  app.post('/v1/read-action', (context) => logged(context, 'read-action'));
  app.post('/v1/sync-action', (context) => logged(context, 'sync-action'));
  // A 404 here is how an API newer than this executor shows up (version skew).
  app.notFound((context) => {
    logRequestFailure({ operation: pathOperation(context.req.path), status: 404, error: 'not_found' });
    return context.json({ error: 'not_found' }, 404);
  });
  app.onError((error, context) => {
    logRequestFailure({
      operation: pathOperation(context.req.path),
      status: 500,
      error: 'internal_error',
      errorName: boundedErrorName(error),
    });
    return context.json({ error: 'internal_error' }, 500);
  });
  return app;
}
