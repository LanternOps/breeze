import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../db';
import { partnerServicePrincipalKeys, users } from '../db/schema';
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';
import { validateApiKeyScopeDelegation } from '../services/apiKeyScopes';
import { getTrustedClientIpOrUndefined } from '../services/clientIp';
import { getUserPermissions, type UserPermissions } from '../services/permissions';
import { partnerServicePrincipalMcpScopes } from '../services/partnerServicePrincipalScopes';
import { assertActiveTenantContext, TenantInactiveError } from '../services/tenantStatus';
import { enforcePreLookupProbeRateLimit } from './apiKeyAuth';
import { resolvePartnerAccess } from './bearerTokenAuth';
import { MCP_SKIP_AMBIENT_DB_CONTEXT_KEY } from './mcpTenantToolSelfManagedContext';
import {
  hashPartnerApiKey,
  isPartnerServicePrincipalKeyFormat,
  loadPartnerServicePrincipalCredential,
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
 * Owner = `partner_service_principals.created_by`. Per-tool RBAC over MCP
 * resolves `getUserPermissions(auth.user.id)` (aiGuardrails), exactly as it
 * already does for org service-principal keys, so the principal's per-tool
 * authority is bounded by its owner's LIVE partner role. The owner never logs
 * in through this credential: a password change, logout or MFA change does
 * not affect it. Off-boarding the owner (status not active, partner
 * membership removed, role reduced below the principal's MCP scopes) denies
 * the next request.
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
const OWNER_NOT_AUTHORIZED_MESSAGE = 'Partner service principal owner is no longer authorized';

export const PARTNER_SERVICE_PRINCIPAL_MCP_KEY_PREFIX = 'brz_sp_';

async function loadOwnerStatus(ownerUserId: string): Promise<string | null> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, ownerUserId))
      .limit(1);
    return row?.status ?? null;
  });
}

function ownerNotAuthorized(): HTTPException {
  return new HTTPException(401, { message: OWNER_NOT_AUTHORIZED_MESSAGE });
}

/**
 * Live owner authorization. Every failure, including a thrown lookup, denies.
 */
async function authorizeOwner(input: {
  ownerUserId: string;
  partnerId: string;
  mcpScopes: string[];
}): Promise<{ orgIds: string[] }> {
  let status: string | null;
  let access: Awaited<ReturnType<typeof resolvePartnerAccess>>;
  let permissions: UserPermissions | null;
  try {
    status = await loadOwnerStatus(input.ownerUserId);
    access = await resolvePartnerAccess(input.partnerId, input.ownerUserId);
    permissions = await getUserPermissions(input.ownerUserId, { partnerId: input.partnerId });
  } catch {
    throw ownerNotAuthorized();
  }

  if (status !== 'active' || !access.isMember || !permissions) {
    throw ownerNotAuthorized();
  }
  // The partner role must be the one that resolved: a principal is partner
  // scoped by construction and must never borrow an org-only role.
  if (permissions.scope !== 'partner' || permissions.partnerId !== input.partnerId) {
    throw ownerNotAuthorized();
  }
  // A partner principal is partner-WIDE by construction (minting one already
  // requires all-org access, routes/partnerServicePrincipals.ts). Its reach is
  // never silently narrowed to a subset: if the owner no longer holds
  // all-org access, the principal is denied outright, so it can neither
  // exceed the owner nor degrade into a partial view of the partner.
  if (permissions.orgAccess !== 'all') {
    throw ownerNotAuthorized();
  }

  // Re-clamp: the principal's MCP scopes must still be fully backed by the
  // owner's CURRENT permissions (same policy table an org API key uses), so a
  // reduction in the owner's role cannot be out-run by the principal.
  const delegation = validateApiKeyScopeDelegation(input.mcpScopes, permissions);
  if (!delegation.ok) {
    throw ownerNotAuthorized();
  }

  return { orgIds: access.orgIds };
}

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

  // Throws a generic 401 for every credential failure (see the loader).
  const { credential, ownerUserId } = await loadPartnerServicePrincipalCredential(
    hashPartnerApiKey(rawKey),
    getTrustedClientIpOrUndefined(c),
  );

  const mcpScopes = partnerServicePrincipalMcpScopes(credential.scopes);
  if (mcpScopes.length === 0) {
    throw new HTTPException(403, { message: 'Partner service principal is not granted MCP access' });
  }

  try {
    // Same strict tenant gate a partner-scope OAuth bearer passes.
    await assertActiveTenantContext(
      { scope: 'partner', partnerId: credential.partnerId, orgId: null },
      { strictForOauth: true },
    );
  } catch (err) {
    if (err instanceof TenantInactiveError) {
      throw new HTTPException(401, { message: 'tenant inactive' });
    }
    throw err;
  }

  const { orgIds } = await authorizeOwner({
    ownerUserId,
    partnerId: credential.partnerId,
    mcpScopes,
  });

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
  });

  // See MCP_SKIP_AMBIENT_DB_CONTEXT_KEY's doc comment (same contract as the
  // API-key and OAuth bearer middlewares).
  if (c.get(MCP_SKIP_AMBIENT_DB_CONTEXT_KEY) === true) {
    await next();
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
      await next();
    },
  );
}
