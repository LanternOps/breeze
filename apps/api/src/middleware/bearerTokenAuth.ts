import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyResult } from 'jose';
import { OAUTH_ISSUER, OAUTH_RESOURCE_URL } from '../config/env';
import { withDbAccessContext } from '../db';
import { isJtiRevoked } from '../oauth/revocationCache';

interface OAuthApiKeyContext {
  id: string;
  orgId: string | null;
  name: string;
  keyPrefix: string;
  scopes: string[];
  rateLimit: number;
  createdBy: string;
  scopeState: 'full';
}

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (!cachedJwks) cachedJwks = createRemoteJWKSet(new URL(`${OAUTH_ISSUER}/.well-known/jwks.json`));
  return cachedJwks;
}

export function _resetJwksCacheForTests() {
  cachedJwks = null;
}

export async function bearerTokenAuthMiddleware(c: Context, next: Next) {
  if (!OAUTH_ISSUER || !OAUTH_RESOURCE_URL) {
    throw new HTTPException(500, { message: 'OAuth not configured: OAUTH_ISSUER and OAUTH_RESOURCE_URL must be set' });
  }

  const auth = c.req.header('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) throw new HTTPException(401, { message: 'missing bearer token' });

  const token = auth.slice(7);
  let payload: JWTPayload & { partner_id?: string | null; org_id?: string | null; scope?: string };

  try {
    const result: JWTVerifyResult = await jwtVerify(token, getJwks(), {
      issuer: OAUTH_ISSUER,
      audience: OAUTH_RESOURCE_URL,
      algorithms: ['EdDSA'],
    });
    payload = result.payload as typeof payload;
  } catch (e) {
    const code = (e as { code?: string }).code;
    // jose throws errors with codes like ERR_JWS_*, ERR_JWT_*, ERR_JWKS_NO_MATCHING_KEY.
    // Anything else (no code, or non-jose code) is almost certainly a network/IO problem
    // talking to the JWKS endpoint - fail loud (503) rather than silently 401-ing every request.
    const isJoseError = typeof code === 'string' && code.startsWith('ERR_');
    if (!isJoseError) {
      console.error('[oauth] jwt verification failed for non-token reason (jwks fetch?)', e);
      throw new HTTPException(503, { message: 'oauth verification temporarily unavailable' });
    }
    throw new HTTPException(401, { message: `invalid token: ${code ?? (e as Error).message}` });
  }

  if (typeof payload.jti === 'string' && await isJtiRevoked(payload.jti)) {
    throw new HTTPException(401, { message: 'token revoked' });
  }
  if (!payload.partner_id || !payload.sub) {
    throw new HTTPException(401, { message: 'token missing required claims' });
  }

  (c.set as (key: 'apiKey', value: OAuthApiKeyContext) => void)('apiKey', {
    id: `oauth:${typeof payload.jti === 'string' ? payload.jti : 'no-jti'}`,
    orgId: payload.org_id ?? null,
    name: 'OAuth bearer',
    keyPrefix: 'oauth',
    scopes: (payload.scope ?? '').split(' ').filter(Boolean),
    rateLimit: 1000,
    createdBy: payload.sub,
    scopeState: 'full' as const,
  });
  if (payload.org_id) c.set('apiKeyOrgId', payload.org_id);

  await withDbAccessContext(
    payload.org_id
      ? {
          scope: 'organization',
          orgId: payload.org_id,
          accessibleOrgIds: [payload.org_id],
          accessiblePartnerIds: [payload.partner_id],
          userId: payload.sub,
        }
      : {
          scope: 'partner',
          orgId: null,
          accessibleOrgIds: null,
          accessiblePartnerIds: [payload.partner_id],
          userId: payload.sub,
        },
    async () => {
      await next();
    }
  );
}
