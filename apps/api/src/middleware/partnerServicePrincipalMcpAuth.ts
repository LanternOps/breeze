import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../db';
import { partnerServicePrincipalKeys } from '../db/schema';
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';
import { getTrustedClientIpOrUndefined } from '../services/clientIp';
import { runWithUncachedPermissionsFor } from '../services/permissions';
import { enforcePreLookupProbeRateLimit } from './apiKeyAuth';
import { MCP_SKIP_AMBIENT_DB_CONTEXT_KEY } from './mcpTenantToolSelfManagedContext';
import {
  authenticatePartnerServicePrincipalKey,
  hashPartnerApiKey,
  isPartnerServicePrincipalKeyFormat,
} from '../services/partnerServicePrincipalCredential';

/**
 * MCP authentication for a partner service principal key (`brz_sp_`).
 *
 * A principal granted any of the opt-in MCP scopes (ai:read / ai:write /
 * ai:execute / ai:execute_admin, see services/partnerServicePrincipalScopes.ts)
 * may call the MCP endpoint at PARTNER scope. The resulting request context is
 * the same shape a partner-scope MCP OAuth bearer produces
 * (bearerTokenAuth.ts), so mcpServer.ts's existing partner branch builds the
 * AuthContext and no route has to handle a new auth shape:
 *   - accessibleOrgIds: every org of the partner (resolvePartnerAccess, the
 *     same resolver the OAuth bearer uses, for an owner who must hold
 *     all-org access);
 *   - accessiblePartnerIds: [partnerId] (partner-axis access, as a partner
 *     admin session gets); currentPartnerId: partnerId.
 *
 * Owner = `partner_service_principals.created_by`. The owner check itself
 * lives in services/partnerServicePrincipalOwnerAuthority.ts and is run by
 * services/partnerServicePrincipalCredential.ts for both this endpoint and
 * the Partner API. Per-tool RBAC over MCP
 * resolves `getUserPermissions(auth.user.id)` (aiGuardrails), exactly as it
 * already does for org service-principal keys, so the principal's per-tool
 * authority is bounded by its owner's LIVE partner role. Only the owner issues
 * or rotates keys (routes/partnerServicePrincipals.ts), and a key issued by
 * anyone else is refused here. Every key is bound to the owner's credential
 * state (services/partnerServicePrincipalCredential.ts): the owner's password
 * change/reset, an admin status change or an MFA factor change ends it, the
 * same as a human API key; an ordinary logout does not. Off-boarding the
 * owner (status not active, partner membership removed, role reduced below
 * the principal's MCP scopes) denies the next request.
 *
 * Fail closed everywhere: an unknown, revoked or expired key, a disabled or
 * expired principal, an inactive or deleted partner, a source-CIDR mismatch,
 * no MCP scope, an inactive or non-member owner, an owner who can no longer
 * delegate the principal's MCP scopes, an owner without all-org access, or
 * any lookup error is denied before
 * the request reaches a handler. Nothing is cached: revocation and disable
 * take effect on the next request.
 *
 * Tier 3 stays approval-gated unless the principal is named in
 * MCP_UNATTENDED_TIER3_PRINCIPALS as `partner_sp:<principal id>` (see
 * mcpServer.ts mcpPrincipalRef). The ref names the PRINCIPAL, so key rotation
 * keeps the opt-in and disabling the principal ends it.
 */

const INVALID_CREDENTIALS_MESSAGE = 'Invalid partner API credentials';

export const PARTNER_SERVICE_PRINCIPAL_MCP_KEY_PREFIX = 'brz_sp_';

function settle(work: () => Promise<unknown>, message: string): void {
  work().catch(() => {
    // Never log the caught error: it can carry query parameters.
    console.error(message);
  });
}

export async function partnerServicePrincipalMcpAuthMiddleware(c: Context, next: Next): Promise<void> {
  const rawKey = c.req.header('X-API-Key');
  if (!rawKey) {
    throw new HTTPException(401, { message: 'Missing X-API-Key header' });
  }

  await enforcePreLookupProbeRateLimit(c);

  if (!isPartnerServicePrincipalKeyFormat(rawKey)) {
    throw new HTTPException(401, { message: INVALID_CREDENTIALS_MESSAGE });
  }

  // Throws for every credential failure, a key the owner did not issue, a
  // principal without MCP access, an inactive tenant, and an owner who is no
  // longer authorized (services/partnerServicePrincipalCredential.ts).
  const { credential, ownerUserId, ownerOrgIds: orgIds, mcpScopes } = await authenticatePartnerServicePrincipalKey(
    hashPartnerApiKey(rawKey),
    getTrustedClientIpOrUndefined(c),
    'mcp',
  );

  // Hourly per-key ceiling, in a bucket separate from the Partner API's so
  // MCP traffic cannot starve export jobs (or the reverse).
  const rateCheck = await rateLimiter(
    getRedis(),
    `partner_sp_mcp_rate:${credential.partnerServicePrincipalId}:${credential.keyId}`,
    credential.rateLimit,
    3600,
  );
  c.header('X-RateLimit-Limit', String(credential.rateLimit));
  c.header('X-RateLimit-Remaining', String(rateCheck.remaining));
  c.header('X-RateLimit-Reset', String(Math.ceil(rateCheck.resetAt.getTime() / 1000)));
  if (!rateCheck.allowed) {
    c.header('Retry-After', String(Math.max(1, Math.ceil((rateCheck.resetAt.getTime() - Date.now()) / 1000))));
    throw new HTTPException(429, { message: 'Rate limit exceeded' });
  }

  settle(
    () => runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        await db
          .update(partnerServicePrincipalKeys)
          .set({ lastUsedAt: new Date() })
          .where(eq(partnerServicePrincipalKeys.id, credential.keyId));
      }),
    ),
    'Failed to update partner service principal key usage timestamp',
  );

  c.set('apiKey', {
    // The KEY id: rate-limit, session-ownership and audit actor identity, and
    // a revoked key's id never authenticates again. Never an api_keys row id.
    id: credential.keyId,
    orgId: null,
    partnerId: credential.partnerId,
    name: credential.name,
    keyPrefix: PARTNER_SERVICE_PRINCIPAL_MCP_KEY_PREFIX,
    scopes: mcpScopes,
    rateLimit: credential.rateLimit,
    // The owner: the identity whose live RBAC mcpServer.ts / aiGuardrails
    // resolve for per-tool permission checks.
    createdBy: ownerUserId,
    principalType: 'partner_service_principal',
    principalId: credential.partnerServicePrincipalId,
    partnerServicePrincipalId: credential.partnerServicePrincipalId,
    // B-W02 (#6156, D-B5): partner service principal keys stay unrestricted
    // this wave. Set explicitly — an absent field fails closed to core-only.
    mcpDomains: null,
  });

  // See MCP_SKIP_AMBIENT_DB_CONTEXT_KEY's doc comment (same contract as the
  // API-key and OAuth bearer middlewares).
  // Every permission read for the owner in the rest of this request (per-tool
  // RBAC included) is uncached, matching the owner gate above.
  if (c.get(MCP_SKIP_AMBIENT_DB_CONTEXT_KEY) === true) {
    await runWithUncachedPermissionsFor(ownerUserId, () => next());
    return;
  }

  await withDbAccessContext(
    {
      scope: 'partner',
      orgId: null,
      // Resolved list (possibly []), never null: [] means "no rows match".
      accessibleOrgIds: orgIds,
      accessiblePartnerIds: [credential.partnerId],
      // A machine principal has no user-owned rows (sessions, passkeys,
      // approval requests). Like an org API key, it runs with no user id in
      // the RLS context, so it can never read its owner's private rows.
      userId: null,
      currentPartnerId: credential.partnerId,
    },
    async () => {
      await runWithUncachedPermissionsFor(ownerUserId, () => next());
    },
  );
}
