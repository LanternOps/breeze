import { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createHash } from 'crypto';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../db';
import { apiKeys, users } from '../db/schema';
import { getRedis, rateLimiter } from '../services';
import { getActiveOrgTenant } from '../services/tenantStatus';
import { getTrustedClientIp } from '../services/clientIp';
import { authorizeHumanApiKeyCreator, authorizeServicePrincipalKey } from '../services/apiKeyAuthorization';

export interface ApiKeyContext {
  apiKey: {
    id: string;
    orgId: string | null;
    partnerId: string | null;
    name: string;
    keyPrefix: string;
    scopes: string[];
    rateLimit: number;
    createdBy: string;
    allowedSiteIds?: string[];
    // SR2-15: 'human' (default) | 'service'. Service-principal keys carry a
    // non-null principalId and are authorized against the PRINCIPAL, never
    // a human creator's permissions.
    principalType?: string;
    principalId?: string | null;
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
  // API keys are high-entropy random tokens (not user-chosen passwords). We store only a SHA-256 hash
  // for one-way lookup and never persist the plaintext key.
  // lgtm[js/insufficient-password-hash]
  return createHash('sha256').update(key).digest('hex');
}

function envInt(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export async function enforcePreLookupProbeRateLimit(c: Context): Promise<void> {
  const limit = envInt('API_KEY_PRELOOKUP_RATE_LIMIT', 300);
  const windowSeconds = envInt('API_KEY_PRELOOKUP_RATE_WINDOW_SECONDS', 60);
  const clientIp = getTrustedClientIp(c, 'unknown');
  const rateCheck = await rateLimiter(getRedis(), `api_key_probe:${clientIp}`, limit, windowSeconds);

  if (!rateCheck.allowed) {
    c.header('X-RateLimit-Limit', String(limit));
    c.header('X-RateLimit-Remaining', '0');
    c.header('X-RateLimit-Reset', String(Math.ceil(rateCheck.resetAt.getTime() / 1000)));
    c.header('Retry-After', String(Math.max(1, Math.ceil((rateCheck.resetAt.getTime() - Date.now()) / 1000))));

    throw new HTTPException(429, {
      message: 'Too many API key authentication attempts',
      cause: {
        limit,
        remaining: 0,
        resetAt: rateCheck.resetAt.toISOString()
      }
    });
  }
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

  await enforcePreLookupProbeRateLimit(c);

  // Validate key format after the probe limiter so malformed brute-force
  // attempts cannot bypass the pre-lookup throttle.
  if (!apiKeyHeader.startsWith('brz_')) {
    throw new HTTPException(401, { message: 'Invalid API key format' });
  }

  // Hash the key and look it up
  const keyHash = hashApiKey(apiKeyHeader);

  // Authentication must work even when tenant RLS is deny-by-default.
  // Use system DB context for lookup, then scope all downstream queries to the key's org.
  const apiKey = await withSystemDbAccessContext(async () => {
    const [row] = await db
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
        createdBy: apiKeys.createdBy,
        source: apiKeys.source,
        principalType: apiKeys.principalType,
        principalId: apiKeys.principalId
      })
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, keyHash))
      .limit(1);
    return row ?? null;
  });

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
    await withSystemDbAccessContext(async () => {
      await db
        .update(apiKeys)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(eq(apiKeys.id, apiKey.id));
    });

    throw new HTTPException(401, { message: 'API key has expired' });
  }

  const ownerTenant = await getActiveOrgTenant(apiKey.orgId);
  if (!ownerTenant) {
    throw new HTTPException(401, { message: 'API key owner is not active' });
  }

  // SR2-15 (PR 5): service-principal keys (principalType === 'service') skip
  // the human creator-status/liveness checks entirely — they are authorized
  // against the PRINCIPAL, not a human. A service principal has no
  // interactive login, so there is no "creator active" status to check; its
  // liveness gate is the principal's own `status` column (see
  // authorizeServicePrincipalKey). Human keys (the default, principalType
  // undefined or 'human') take the existing creator-status + live-permission
  // path below, unchanged.
  const isServicePrincipalKey = apiKey.principalType === 'service' && !!apiKey.principalId;

  if (!isServicePrincipalKey) {
    // SR2-15 (PR 1 subset): a delegated human API key must not outlive its
    // creator's active status. The full membership/permission-ceiling resolver
    // and service principals land in PR 5; here we fail closed on a
    // disabled/absent creator. (The MCP path's fail-OPEN null-perms bug is fixed
    // in PR 5 — do not build on that behavior.)
    const creator = await withSystemDbAccessContext(async () => {
      const [row] = await db
        .select({ status: users.status })
        .from(users)
        .where(eq(users.id, apiKey.createdBy))
        .limit(1);
      return row ?? null;
    });
    if (!creator || creator.status !== 'active') {
      throw new HTTPException(401, { message: 'API key creator is not active' });
    }
  }

  // SR2-15 (PR 5): a human-delegated key's authority is LIVE-bound to its
  // creator. Beyond the status check above, the creator must (a) still hold a
  // membership/role on this key's tenant (off-boarding gate) and (b) not have
  // had their permissions reduced below the key's stored scopes since mint.
  // We resolve the creator's CURRENT permissions on BOTH axes (org + the org's
  // owning partner, since a Partner Admin has no organization_users row) and
  // re-clamp. FAIL CLOSED: the resolver returns ok:false for a null/errored
  // permission read, and we reject before opening the org context. This adds one
  // getUserPermissions call (Redis-version-cached, 5-min TTL — a cache hit is an
  // mget + in-proc lookup, no Postgres round-trip) to the hot path; correctness
  // over cost per the PR 5 plan (Q1: live re-resolution, not an epoch).
  //
  // A service-principal key branches to authorizeServicePrincipalKey instead:
  // it re-clamps against the PRINCIPAL's own current scopes (never a human's
  // permissions) and denies on a disabled/missing principal.
  const authz = isServicePrincipalKey
    ? await authorizeServicePrincipalKey({
        principalId: apiKey.principalId as string,
        scopes: apiKey.scopes ?? [],
      })
    : await authorizeHumanApiKeyCreator({
        createdBy: apiKey.createdBy,
        orgId: apiKey.orgId,
        partnerId: ownerTenant.partnerId,
        scopes: apiKey.scopes ?? [],
      });
  if (!authz.ok) {
    throw new HTTPException(401, { message: 'API key creator is no longer authorized' });
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

  // Update lastUsedAt and usageCount (async, don't wait).
  // Wrapped in system context so it runs regardless of RLS scope.
  withSystemDbAccessContext(async () => {
    await db
      .update(apiKeys)
      .set({
        lastUsedAt: new Date(),
        usageCount: apiKey.usageCount !== undefined ? apiKey.usageCount + 1 : 1
      })
      .where(eq(apiKeys.id, apiKey.id));
  }).catch(err => {
    console.error('Failed to update API key usage stats:', err);
  });

  // Resolve the owning partner for MCP-provisioning keys only. These keys
  // operate in the partner-axis RLS context (e.g. reading partner rows during
  // OAuth bearer token flows). Without the partner ID in accessiblePartnerIds,
  // breeze_has_partner_access() short-circuits to false and the caller sees
  // zero rows from partner-scoped tables.
  //
  // Every other API key type has no legitimate need to read partner rows, so
  // we skip the round-trip and keep accessiblePartnerIds empty. This also
  // avoids a per-request DB hit on the hot agent-authed path.
  const isMcpProvisioningKey = apiKey.source === 'mcp_provisioning';
  const resolvedPartnerId = isMcpProvisioningKey ? ownerTenant.partnerId : null;

  // Set API key context for route handlers
  c.set('apiKey', {
    id: apiKey.id,
    orgId: apiKey.orgId,
    partnerId: resolvedPartnerId,
    name: apiKey.name,
    keyPrefix: apiKey.keyPrefix,
    scopes: authz.clampedScopes,
    allowedSiteIds: authz.allowedSiteIds,
    rateLimit: apiKey.rateLimit,
    createdBy: apiKey.createdBy,
    // SR2-15: threaded through so the MCP path (mcpServer.ts's
    // buildAuthFromApiKey, which reads this same c.get('apiKey')) can branch
    // on principal type too, without a second DB read.
    principalType: apiKey.principalType,
    principalId: apiKey.principalId,
  });
  c.set('apiKeyOrgId', apiKey.orgId);

  await withDbAccessContext(
    {
      scope: 'organization',
      orgId: apiKey.orgId,
      accessibleOrgIds: [apiKey.orgId],
      // The API key is scoped to a single org, but that org belongs to a
      // partner. We include the owning partner in the allowlist so the key can
      // read its own partner row (billing gate, MCP provisioning). If the org
      // somehow has no partner link, fall back to an empty allowlist.
      accessiblePartnerIds: resolvedPartnerId ? [resolvedPartnerId] : [],
      // Own partner — read-visibility of partner-wide catalog rows.
      currentPartnerId: resolvedPartnerId ?? null
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

    // Check if API key has any of the required scopes. Wildcard scopes are
    // intentionally not honored; create/update rejects them and old rows should
    // not retain blanket access.
    const hasRequiredScope = requiredScopes.some(scope => apiKey.scopes.includes(scope));

    if (!hasRequiredScope) {
      throw new HTTPException(403, {
        message: 'API key does not have required permissions',
        cause: { required: requiredScopes, available: apiKey.scopes }
      });
    }

    await next();
  };
}
