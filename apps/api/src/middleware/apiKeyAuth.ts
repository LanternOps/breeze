import { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createHash } from 'crypto';
import { eq, and } from 'drizzle-orm';
import { db, withDbAccessContext } from '../db';
import { apiKeys, organizations } from '../db/schema';
import { getRedis, rateLimiter } from '../services';

export interface ApiKeyContext {
  apiKey: {
    id: string;
    orgId: string;
    name: string;
    keyPrefix: string;
    scopes: string[];
    rateLimit: number;
    createdBy: string;
  };
  orgId: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    apiKey: ApiKeyContext['apiKey'];
    apiKeyOrgId: string;
  }
}

function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Middleware to authenticate requests via X-API-Key header.
 *
 * This middleware:
 * 1. Extracts the API key from the X-API-Key header
 * 2. Validates the key format (must start with "brz_")
 * 3. Hashes the key and looks it up in the database
 * 4. Checks if the key is active and not expired
 * 5. Enforces rate limiting (requests per hour)
 * 6. Updates lastUsedAt and usageCount
 * 7. Sets the API key context for route handlers
 */
export async function apiKeyAuthMiddleware(c: Context, next: Next) {
  const apiKeyHeader = c.req.header('X-API-Key');

  if (!apiKeyHeader) {
    throw new HTTPException(401, { message: 'Missing X-API-Key header' });
  }

  // Validate key format
  if (!apiKeyHeader.startsWith('brz_')) {
    throw new HTTPException(401, { message: 'Invalid API key format' });
  }

  // Hash the key and look it up
  const keyHash = hashApiKey(apiKeyHeader);

  const [apiKey] = await db
    .select({
      id: apiKeys.id,
      orgId: apiKeys.orgId,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      keyHash: apiKeys.keyHash,
      scopes: apiKeys.scopes,
      expiresAt: apiKeys.expiresAt,
      rateLimit: apiKeys.rateLimit,
      usageCount: apiKeys.usageCount,
      status: apiKeys.status,
      createdBy: apiKeys.createdBy
    })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1);

  if (!apiKey) {
    throw new HTTPException(401, { message: 'Invalid API key' });
  }

  // Check if key is active
  if (apiKey.status !== 'active') {
    throw new HTTPException(401, { message: `API key is ${apiKey.status}` });
  }

  // Check if key is expired
  if (apiKey.expiresAt && new Date(apiKey.expiresAt) < new Date()) {
    // Update status to expired
    await db
      .update(apiKeys)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(eq(apiKeys.id, apiKey.id));

    throw new HTTPException(401, { message: 'API key has expired' });
  }

  // Check rate limits (requests per hour)
  const redis = getRedis();
  const rateLimitKey = `api_key_rate:${apiKey.id}`;
  const rateCheck = await rateLimiter(redis, rateLimitKey, apiKey.rateLimit, 3600); // 1 hour window

  if (!rateCheck.allowed) {
    // Set rate limit headers
    c.header('X-RateLimit-Limit', String(apiKey.rateLimit));
    c.header('X-RateLimit-Remaining', '0');
    c.header('X-RateLimit-Reset', String(Math.ceil(rateCheck.resetAt.getTime() / 1000)));
    c.header('Retry-After', String(Math.ceil((rateCheck.resetAt.getTime() - Date.now()) / 1000)));

    throw new HTTPException(429, {
      message: 'Rate limit exceeded',
      cause: {
        limit: apiKey.rateLimit,
        remaining: 0,
        resetAt: rateCheck.resetAt.toISOString()
      }
    });
  }

  // Set rate limit headers for successful requests
  c.header('X-RateLimit-Limit', String(apiKey.rateLimit));
  c.header('X-RateLimit-Remaining', String(rateCheck.remaining));
  c.header('X-RateLimit-Reset', String(Math.ceil(rateCheck.resetAt.getTime() / 1000)));

  // Update lastUsedAt and usageCount (async, don't wait)
  db.update(apiKeys)
    .set({
      lastUsedAt: new Date(),
      usageCount: apiKey.usageCount !== undefined ? apiKey.usageCount + 1 : 1
    })
    .where(eq(apiKeys.id, apiKey.id))
    .execute()
    .catch(err => {
      console.error('Failed to update API key usage stats:', err);
    });

  // Set API key context for route handlers
  c.set('apiKey', {
    id: apiKey.id,
    orgId: apiKey.orgId,
    name: apiKey.name,
    keyPrefix: apiKey.keyPrefix,
    scopes: apiKey.scopes || [],
    rateLimit: apiKey.rateLimit,
    createdBy: apiKey.createdBy
  });
  c.set('apiKeyOrgId', apiKey.orgId);

  await withDbAccessContext(
    {
      scope: 'organization',
      orgId: apiKey.orgId,
      accessibleOrgIds: [apiKey.orgId]
    },
    async () => {
      await next();
    }
  );
}

/**
 * Middleware to require specific scopes for API key access.
 * Must be used after apiKeyAuthMiddleware.
 */
export function requireApiKeyScope(...requiredScopes: string[]) {
  return async (c: Context, next: Next) => {
    const apiKey = c.get('apiKey');

    if (!apiKey) {
      throw new HTTPException(401, { message: 'API key authentication required' });
    }

    // If no scopes are required, allow access
    if (requiredScopes.length === 0) {
      return next();
    }

    // If API key has no scopes defined, deny access to scoped endpoints
    if (!apiKey.scopes || apiKey.scopes.length === 0) {
      throw new HTTPException(403, {
        message: 'API key does not have required permissions',
        cause: { required: requiredScopes, available: [] }
      });
    }

    // Check if API key has any of the required scopes
    // Also check for wildcard scope '*' which grants all access
    const hasWildcard = apiKey.scopes.includes('*');
    const hasRequiredScope = hasWildcard || requiredScopes.some(scope => apiKey.scopes.includes(scope));

    if (!hasRequiredScope) {
      throw new HTTPException(403, {
        message: 'API key does not have required permissions',
        cause: { required: requiredScopes, available: apiKey.scopes }
      });
    }

    await next();
  };
}

/**
 * Middleware that accepts either JWT auth or API key auth.
 * Useful for endpoints that can be accessed by both users and automated systems.
 *
 * Usage: Use with authMiddleware for combined auth:
 *   app.use('*', eitherAuth)
 *
 * After this middleware, check c.get('auth') for user auth or c.get('apiKey') for API key auth.
 */
export async function eitherAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  const apiKeyHeader = c.req.header('X-API-Key');

  if (!authHeader && !apiKeyHeader) {
    throw new HTTPException(401, { message: 'Authentication required. Provide either Authorization header or X-API-Key header.' });
  }

  // Prefer API key if both are provided (API keys are more specific)
  if (apiKeyHeader) {
    return apiKeyAuthMiddleware(c, next);
  }

  // Fall through to the next middleware (should be authMiddleware for JWT)
  await next();
}
