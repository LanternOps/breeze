import {
  M365_COMMS_MAX_REQUEST_BODY_BYTES,
  commsCompleteConsentRequestSchema,
  commsCompleteConsentResultSchema,
  commsRetestRequestSchema,
  commsRetestResultSchema,
  commsRevokeConnectionRequestSchema,
  commsRevokeConnectionResultSchema,
  m365CommsRequestSchema,
  m365CommsResultSchema,
  type CommsCompleteConsentRequest,
  type CommsCompleteConsentResult,
  type CommsRetestRequest,
  type CommsRetestResult,
  type CommsRevokeConnectionRequest,
  type CommsRevokeConnectionResult,
  type M365CommsRequest,
  type M365CommsResult,
} from '@breeze/shared/m365';
import { Hono, type Context } from 'hono';
import type {
  ExecutorOperation,
  InternalRequestAuthentication,
  InternalRequestAuthenticator,
} from './internalAuth';

/**
 * 128 KiB from the shared constant — NOT the sibling executors' 16 KiB default.
 * A 32,000-code-point body of astral characters is ~128 KB of UTF-8 before JSON
 * escaping, so the sibling default is smaller than one legal max-size mail and
 * would silently reject it (design §2 item 1).
 */
const DEFAULT_MAX_BODY_BYTES = M365_COMMS_MAX_REQUEST_BODY_BYTES;

export interface ExecutorAppDependencies {
  authenticator: InternalRequestAuthenticator;
  completeConsent(request: CommsCompleteConsentRequest): Promise<CommsCompleteConsentResult>;
  retest(request: CommsRetestRequest): Promise<CommsRetestResult>;
  revokeConnection(request: CommsRevokeConnectionRequest): Promise<CommsRevokeConnectionResult>;
  /**
   * Takes the authenticated claim set as the second argument — unlike the
   * siblings — because the send path verifies the digest claims (design §5.2).
   */
  executeAction(
    request: M365CommsRequest,
    authentication: InternalRequestAuthentication,
  ): Promise<M365CommsResult>;
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
    let authentication: InternalRequestAuthentication;
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
      const request = commsCompleteConsentRequestSchema.safeParse(parsed);
      if (!request.success) return context.json({ error: 'invalid_request' }, 400);
      if (request.data.correlationId !== authentication.correlationId) {
        return context.json({ error: 'unauthorized' }, 401);
      }
      try {
        const result = commsCompleteConsentResultSchema.safeParse(
          await dependencies.completeConsent(request.data),
        );
        return result.success
          ? context.json(result.data)
          : context.json({ error: 'internal_error' }, 500);
      } catch {
        return context.json({ error: 'internal_error' }, 500);
      }
    }
    if (operation === 'retest') {
      const request = commsRetestRequestSchema.safeParse(parsed);
      if (!request.success) return context.json({ error: 'invalid_request' }, 400);
      if (request.data.correlationId !== authentication.correlationId) {
        return context.json({ error: 'unauthorized' }, 401);
      }
      try {
        const result = commsRetestResultSchema.safeParse(await dependencies.retest(request.data));
        return result.success
          ? context.json(result.data)
          : context.json({ error: 'internal_error' }, 500);
      } catch {
        return context.json({ error: 'internal_error' }, 500);
      }
    }
    if (operation === 'revoke-connection') {
      const request = commsRevokeConnectionRequestSchema.safeParse(parsed);
      if (!request.success) return context.json({ error: 'invalid_request' }, 400);
      if (request.data.correlationId !== authentication.correlationId) {
        return context.json({ error: 'unauthorized' }, 401);
      }
      try {
        const result = commsRevokeConnectionResultSchema.safeParse(
          await dependencies.revokeConnection(request.data),
        );
        return result.success
          ? context.json(result.data)
          : context.json({ error: 'internal_error' }, 500);
      } catch {
        return context.json({ error: 'internal_error' }, 500);
      }
    }
    const request = m365CommsRequestSchema.safeParse(parsed);
    if (!request.success) return context.json({ error: 'invalid_request' }, 400);
    if (request.data.correlationId !== authentication.correlationId) {
      return context.json({ error: 'unauthorized' }, 401);
    }
    try {
      const result = m365CommsResultSchema.safeParse(
        await dependencies.executeAction(request.data, authentication),
      );
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
  app.post('/v1/revoke-connection', (context) => execute(context, 'revoke-connection'));
  app.post('/v1/execute-action', (context) => execute(context, 'execute-action'));
  app.notFound((context) => context.json({ error: 'not_found' }, 404));
  app.onError((_error, context) => context.json({ error: 'internal_error' }, 500));
  return app;
}
