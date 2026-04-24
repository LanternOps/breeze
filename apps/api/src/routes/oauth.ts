import { Hono } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import { createLocalJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { getProvider } from '../oauth/provider';
import { MCP_OAUTH_ENABLED, OAUTH_ISSUER, OAUTH_RESOURCE_URL } from '../config/env';
import { loadPublicJwks } from '../oauth/keys';
import { revokeGrant, revokeJti } from '../oauth/revocationCache';
import { ERROR_IDS, logOauthError } from '../oauth/log';
// Import getRedis/rateLimiter from their specific modules (NOT the services
// barrel) to avoid pulling in the rest of services/index.ts at module load —
// barrel re-exports include modules with side effects (eventBus,
// commandQueue, etc.) that hang in unit-test sandboxes lacking Redis. The
// rate-limit middleware itself only ever runs at request time.
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';

export const oauthRoutes = new Hono<{ Bindings: HttpBindings }>();

if (MCP_OAUTH_ENABLED) {
  const REVOCATION_BODY_MAX_BYTES = 64 * 1024;
  let cachedRevocationJwks: ReturnType<typeof createLocalJWKSet> | null = null;

  async function getRevocationJwks() {
    if (!cachedRevocationJwks) {
      cachedRevocationJwks = createLocalJWKSet(await loadPublicJwks());
    }
    return cachedRevocationJwks;
  }

  oauthRoutes.use('*', async (c, next) => {
    const ip =
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
      c.env?.incoming?.socket?.remoteAddress ??
      'unknown';
    const sub = c.req.path.replace(/^\/oauth/, '');

    let limit = 0;
    let windowSeconds = 0;
    let key = '';

    if (c.req.method === 'POST' && sub === '/reg') {
      limit = 10;
      windowSeconds = 3600;
      key = `oauth:register:${ip}`;
    } else if (c.req.method === 'POST' && sub === '/token') {
      // Key by IP only. We could key by client_id but that requires reading the
      // request body, which would drain the underlying Node IncomingMessage
      // stream and prevent oidc-provider's callback() from parsing the body.
      // 60/min/IP is sufficient for MVP - burst protection is the goal here,
      // not per-client granularity.
      limit = 60;
      windowSeconds = 60;
      key = `oauth:token:ip:${ip}`;
    } else if (c.req.method === 'POST' && sub === '/token/revocation') {
      limit = 60;
      windowSeconds = 60;
      key = `oauth:revocation:ip:${ip}`;
    } else if ((c.req.method === 'GET' || c.req.method === 'POST') && sub === '/auth') {
      limit = 20;
      windowSeconds = 60;
      key = `oauth:authorize:${ip}`;
    }

    if (limit) {
      const result = await rateLimiter(getRedis(), key, limit, windowSeconds);
      if (!result.allowed) return c.json({ error: 'rate_limited' }, 429);
    }

    return next();
  });

  async function readClonedBodyWithLimit(req: Request, maxBytes: number): Promise<string | null> {
    const contentLength = req.headers.get('content-length');
    if (contentLength) {
      const parsed = Number.parseInt(contentLength, 10);
      if (Number.isFinite(parsed) && parsed > maxBytes) {
        return null;
      }
    }

    const clone = req.clone();
    if (!clone.body) {
      return '';
    }

    const reader = clone.body.getReader();
    const decoder = new TextDecoder();
    let bytesRead = 0;
    let out = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesRead += value.byteLength;
        if (bytesRead > maxBytes) {
          return null;
        }
        out += decoder.decode(value, { stream: true });
      }
      out += decoder.decode();
      return out;
    } finally {
      reader.releaseLock();
    }
  }

  // JWT access-token revocation pre-handler.
  //
  // oidc-provider 8.x's revocation endpoint calls AccessToken.find(rawToken).
  // For JWT-format access tokens the raw token IS NOT the jti, so the lookup
  // fails, the adapter's destroy() never fires, and the Redis revocation
  // cache stays empty — revoked JWTs keep working until natural expiry.
  //
  // We sniff the request body BEFORE the oidc-provider bridge runs, verify
  // JWT access tokens locally, and write the revocation cache ourselves.
  // The bridge then runs normally for opaque refresh tokens.
  //
  // We read via `c.req.raw.clone()` so the underlying Node IncomingMessage
  // stream isn't drained — the bridge needs to re-read the body in callback()
  // when we fall through for non-JWT tokens.
  //
  // For successfully cached JWTs we short-circuit with 200: RFC 7009 says
  // the endpoint MUST respond 200 for any well-formed request including
  // unknown tokens (clients shouldn't be able to probe token validity).
  // Letting the bridge run after we've cached would yield a 400 because
  // oidc-provider can't `find()` the JWT in its store — non-spec-compliant
  // and confusing for clients that follow up with the cache check above.
  oauthRoutes.use('/token/revocation', async (c, next) => {
    if (c.req.method !== 'POST') return next();
    let params: URLSearchParams;
    let token: string | null;
    try {
      const raw = await readClonedBodyWithLimit(c.req.raw, REVOCATION_BODY_MAX_BYTES);
      if (raw === null) {
        return c.json({ error: 'invalid_request', error_description: 'revocation request body too large' }, 413);
      }
      params = new URLSearchParams(raw);
      token = params.get('token');
    } catch (err) {
      // Body unreadable (rare; malformed transfer-encoding etc). Let the
      // bridge respond — it will produce the spec-compliant error.
      logOauthError({
        errorId: ERROR_IDS.OAUTH_REVOCATION_BODY_PARSE,
        message: 'Revocation body parse failed; falling through to bridge',
        err,
      });
      return next();
    }
    if (!token) return next();
    // Skip non-JWTs (opaque refresh tokens) — those go through the adapter's
    // destroy() path correctly.
    if (token.split('.').length !== 3) return next();

    let payload: JWTPayload & { client_id?: string; azp?: string; grant_id?: unknown };
    try {
      const result = await jwtVerify(token, await getRevocationJwks(), {
        issuer: OAUTH_ISSUER,
        audience: OAUTH_RESOURCE_URL,
        algorithms: ['EdDSA'],
      });
      payload = result.payload as typeof payload;
    } catch (err) {
      // Signature / claim verification failed. CRITICAL: do NOT write the
      // revocation cache here — otherwise an attacker could revoke any
      // user's token by forging unsigned JWTs with their jti/grant_id.
      // Fall through to the oidc-provider bridge which will produce the
      // spec-compliant unauthenticated response without leaking which
      // tokens exist.
      logOauthError({
        errorId: ERROR_IDS.OAUTH_REVOCATION_VERIFY_FAILED,
        message: 'Revocation JWT verify failed; falling through to bridge',
        err,
      });
      return next();
    }

    // Client binding: a client may only revoke its own tokens. Without this,
    // any DCR client could revoke any other client's tokens just by knowing
    // (or guessing) the jti / grant_id. Since DCR clients are public
    // (token_endpoint_auth_method=none), this binding via the JWT's own
    // client_id claim is the strongest authorization available here.
    const requestClientId = params.get('client_id');
    const tokenClientId = typeof payload.client_id === 'string' ? payload.client_id
      : typeof payload.azp === 'string' ? payload.azp
      : null;
    if (!requestClientId || !tokenClientId || tokenClientId !== requestClientId) {
      logOauthError({
        errorId: ERROR_IDS.OAUTH_REVOCATION_CLIENT_BINDING,
        message: 'Revocation client_id mismatch; falling through to bridge',
        context: {
          requestClientId,
          tokenClientIdPresent: Boolean(tokenClientId),
        },
      });
      return next();
    }

    const jti = typeof payload.jti === 'string' ? payload.jti : null;
    const exp = typeof payload.exp === 'number' ? payload.exp : null;
    if (!jti || !exp) return next();
    const ttl = Math.max(exp - Math.floor(Date.now() / 1000), 1);

    // Cache writes MUST propagate failures as 5xx — silently swallowing a
    // Redis-down condition would tell the client "revoked" while the bearer
    // middleware (which fails closed on Redis error) would still accept the
    // token until natural expiry, defeating revocation. Better to surface
    // the outage so the caller retries.
    try {
      await revokeJti(jti, ttl);
    } catch (err) {
      logOauthError({
        errorId: ERROR_IDS.OAUTH_REVOCATION_CACHE_WRITE_FAILED,
        message: 'Revocation jti cache write failed in pre-handler',
        err,
        context: { jti },
      });
      return c.json({ error: 'server_error', error_description: 'revocation cache unavailable' }, 503);
    }
    // Revoking an access JWT should also kill every sibling access token
    // minted from the same grant. Without this, a client that holds two
    // active access tokens for the same grant (e.g. one in the helper,
    // one in a worker) could continue using the un-revoked one.
    const grantId = (payload as { grant_id?: unknown }).grant_id;
    if (typeof grantId === 'string' && grantId.length > 0) {
      try {
        await revokeGrant(grantId, ttl);
      } catch (err) {
        logOauthError({
          errorId: ERROR_IDS.OAUTH_REVOCATION_CACHE_WRITE_FAILED,
          message: 'Revocation grant cache write failed in pre-handler',
          err,
          context: { grantId },
        });
        return c.json({ error: 'server_error', error_description: 'revocation cache unavailable' }, 503);
      }
    }
    return c.body(null, 200);
  });

  oauthRoutes.all('/*', async (c) => {
    const provider = await getProvider();
    const callback = provider.callback();
    const req = c.env.incoming;
    const res = c.env.outgoing;

    // The provider is configured with `routes` that already include the
    // `/oauth` prefix (see provider.ts), so we pass req.url through as-is.
    // Stripping the prefix here would cause oidc-provider to set Set-Cookie
    // paths like `/auth/<uid>` that the browser would never send back to our
    // mounted `/oauth/auth/<uid>` endpoint.
    const originalUrl = req.url ?? '/';

    // The `x-hono-already-sent` header is @hono/node-server's escape hatch:
    // when present on the returned Response, the runtime skips its own
    // writeHead/end on the underlying ServerResponse. Without it we hit
    // ERR_HTTP_HEADERS_SENT because oidc-provider already wrote the response.
    const alreadySent = (status: number) =>
      new Response(null, { status, headers: { 'x-hono-already-sent': '1' } });

    return new Promise<Response>((resolve) => {
      const cleanup = () => {
        res.removeListener('finish', onFinish);
        res.removeListener('close', onClose);
        res.removeListener('error', onError);
      };
      const onFinish = () => {
        cleanup();
        resolve(alreadySent(res.statusCode));
      };
      const onClose = () => {
        cleanup();
        resolve(alreadySent(res.statusCode || 499));
      };
      const onError = (err: unknown) => {
        cleanup();
        logOauthError({
          errorId: ERROR_IDS.OAUTH_BRIDGE_RESPONSE_ERROR,
          message: 'oidc-provider bridge response error',
          err,
          context: { path: originalUrl },
        });
        resolve(alreadySent(res.statusCode || 500));
      };
      res.on('finish', onFinish);
      res.on('close', onClose);
      res.on('error', onError);
      try {
        callback(req, res);
      } catch (err) {
        cleanup();
        logOauthError({
          errorId: ERROR_IDS.OAUTH_BRIDGE_CALLBACK_THREW,
          message: 'oidc-provider bridge callback threw synchronously',
          err,
          context: { path: originalUrl },
        });
        resolve(alreadySent(res.statusCode || 500));
      }
    });
  });
}
