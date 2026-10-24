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
import { Hono, type Context } from 'hono';
import type { ExecutorOperation, InternalRequestAuthenticator } from './internalAuth';

const DEFAULT_MAX_BODY_BYTES = 16 * 1024;

/** Build identity served by `GET /version`; never configuration or secrets. */
export interface ExecutorBuildInfo {
  version: string;
  gitSha: string;
}

/** A bounded label from a build arg; anything else is reported as `unknown`. */
function buildLabel(value: string | undefined): string {
  const v = value?.trim() ?? '';
  return /^[A-Za-z0-9._+-]{1,64}$/.test(v) ? v : 'unknown';
}

function buildInfoFromEnv(env: NodeJS.ProcessEnv = process.env): ExecutorBuildInfo {
  return { version: buildLabel(env.APP_VERSION), gitSha: buildLabel(env.GIT_SHA) };
}

export interface ExecutorAppDependencies {
  /** Served by `GET /version`. Defaults to the image's baked APP_VERSION / GIT_SHA. */
  buildInfo?: ExecutorBuildInfo;
  authenticator: InternalRequestAuthenticator;
  verifyIdentity(request: VerifyConsentIdentityRequest): Promise<VerifyConsentIdentityResult>;
  retest(request: RetestRequest): Promise<RetestResult>;
  executeAction(request: WriteActionRequest): Promise<WriteActionResult>;
  maxBodyBytes?: number;
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

const FAILURE_LOG_MESSAGE = '[m365-graph-actions-executor] request failed';

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

  /** Runs one operation and logs it if it ends non-2xx. */
  async function logged(context: Context, operation: ExecutorOperation): Promise<Response> {
    const state: RequestFailureState = {};
    const response = await execute(context, operation, state);
    if (!response.ok) {
      logRequestFailure({
        operation,
        status: response.status,
        error: await responseErrorCode(response),
        ...state,
      });
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
    if (operation === 'retest') {
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
    const request = writeActionRequestSchema.safeParse(parsed);
    if (!request.success) return context.json({ error: 'invalid_request' }, 400);
    if (request.data.correlationId !== authentication.correlationId) {
      return context.json({ error: 'unauthorized' }, 401);
    }
    try {
      const result = writeActionResultSchema.safeParse(await dependencies.executeAction(request.data));
      return result.success ? context.json(result.data) : context.json({ error: 'internal_error' }, 500);
    } catch (error) {
      state.errorName = boundedErrorName(error);
      return context.json({ error: 'internal_error' }, 500);
    }
  }

  app.get('/healthz', (context) => context.json({ status: 'ok' }));
  // Unauthenticated, like /healthz.
  app.get('/version', (context) => context.json(dependencies.buildInfo ?? buildInfoFromEnv()));
  app.post('/v1/verify-identity', (context) => logged(context, 'verify-identity'));
  app.post('/v1/retest', (context) => logged(context, 'retest'));
  app.post('/v1/execute-action', (context) => logged(context, 'execute-action'));
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
