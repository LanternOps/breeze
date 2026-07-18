import {
  completeConsentRequestSchema,
  completeConsentResultSchema,
  retestRequestSchema,
  retestResultSchema,
  type CompleteConsentRequest,
  type CompleteConsentResult,
  type RetestRequest,
  type RetestResult,
} from '@breeze/shared/m365';
import { Hono, type Context } from 'hono';
import type { ExecutorOperation, InternalRequestAuthenticator } from './internalAuth';

const DEFAULT_MAX_BODY_BYTES = 16 * 1024;

export interface ExecutorAppDependencies {
  authenticator: InternalRequestAuthenticator;
  completeConsent(request: CompleteConsentRequest): Promise<CompleteConsentResult>;
  retest(request: RetestRequest): Promise<RetestResult>;
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

export function createExecutorApp(dependencies: ExecutorAppDependencies): Hono {
  const app = new Hono();
  const maxBodyBytes = dependencies.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  async function execute(
    context: Context,
    operation: ExecutorOperation,
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody));
    } catch {
      return context.json({ error: 'invalid_request' }, 400);
    }
    if (operation === 'complete-consent') {
      const request = completeConsentRequestSchema.safeParse(parsed);
      if (!request.success) return context.json({ error: 'invalid_request' }, 400);
      if (request.data.correlationId !== authentication.correlationId) {
        return context.json({ error: 'unauthorized' }, 401);
      }
      try {
        const result = completeConsentResultSchema.safeParse(
          await dependencies.completeConsent(request.data),
        );
        return result.success
          ? context.json(result.data)
          : context.json({ error: 'internal_error' }, 500);
      } catch {
        return context.json({ error: 'internal_error' }, 500);
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
    } catch {
      return context.json({ error: 'internal_error' }, 500);
    }
  }

  app.get('/healthz', (context) => context.json({ status: 'ok' }));
  app.post('/v1/complete-consent', (context) => execute(context, 'complete-consent'));
  app.post('/v1/retest', (context) => execute(context, 'retest'));
  app.notFound((context) => context.json({ error: 'not_found' }, 404));
  app.onError((_error, context) => context.json({ error: 'internal_error' }, 500));
  return app;
}
