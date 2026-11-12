import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { users } from '../db/schema';
import { resolvePartnerAccess } from '../middleware/bearerTokenAuth';
import { validateApiKeyScopeDelegation } from './apiKeyScopes';
import { getUserPermissions, type UserPermissions } from './permissions';
import { validatePartnerServicePrincipalScopeDelegation } from './partnerServicePrincipalDelegation';

/**
 * The live authority of a partner service principal's owner
 * (`partner_service_principals.created_by`), re-checked on every request by
 * services/partnerServicePrincipalCredential.ts for both surfaces that accept
 * the principal's keys. Nothing here is cached.
 */

const OWNER_NOT_AUTHORIZED_MESSAGE = 'Partner service principal owner is no longer authorized';

/**
 * The surface a key is presented to. Each surface re-checks the owner against
 * the scopes that surface honours:
 *   - `partner_api`: every non-MCP scope (the ai:* scopes grant nothing there);
 *   - `mcp`: the MCP (ai:*) scopes, and only keys the owner issued.
 */
export type PartnerServicePrincipalSurface = 'partner_api' | 'mcp';

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
 * The owner's authority through their partner membership, or null when it
 * does not hold. A thrown lookup propagates (the caller denies).
 */
async function ownerPartnerAuthority(
  ownerUserId: string,
  partnerId: string,
): Promise<{ permissions: UserPermissions; orgIds: string[] } | null> {
  const access = await resolvePartnerAccess(partnerId, ownerUserId);
  if (!access.isMember) return null;
  // bypassCache: the owner gate must see a demotion on the very next request
  // even if a cross-process cache invalidation was lost; a cached entry can
  // otherwise outlive a downgrade by up to the 5-minute TTL.
  const permissions = await getUserPermissions(ownerUserId, { partnerId }, { bypassCache: true });
  if (!permissions) return null;
  // The partner role must be the one that resolved: a principal is partner
  // scoped by construction and must never borrow an org-only role.
  if (permissions.scope !== 'partner' || permissions.partnerId !== partnerId) return null;
  // A partner principal is partner-WIDE by construction (minting one already
  // requires all-org access, routes/partnerServicePrincipals.ts). Its reach is
  // never silently narrowed to a subset: if the owner no longer holds
  // all-org access, the principal is denied outright, so it can neither
  // exceed the owner nor degrade into a partial view of the partner.
  if (permissions.orgAccess !== 'all') return null;
  return { permissions, orgIds: access.orgIds };
}

/**
 * Live owner authorization, run on every request for every surface. The
 * principal's scopes for that surface must still be fully backed by the
 * owner's CURRENT permissions (the same policy tables used when the scopes
 * were granted), so a reduction in the owner's role, membership or org access
 * cannot be out-run by the principal. Every failure, including a thrown
 * lookup, denies.
 *
 * A platform admin can also create a principal for a partner they are not a
 * member of (routes/partnerServicePrincipals.ts). On the Partner API that
 * principal is accepted while its owner is still an active platform admin
 * whose platform grants back its scopes; MCP keeps requiring a partner owner.
 */
export async function authorizePartnerServicePrincipalOwner(input: {
  ownerUserId: string;
  partnerId: string;
  surface: PartnerServicePrincipalSurface;
  scopes: readonly string[];
}): Promise<{ orgIds: string[] }> {
  const backs = (permissions: UserPermissions): boolean => (input.surface === 'mcp'
    ? validateApiKeyScopeDelegation([...input.scopes], permissions).ok
    : validatePartnerServicePrincipalScopeDelegation(input.scopes, permissions).ok);

  try {
    if ((await loadOwnerStatus(input.ownerUserId)) !== 'active') {
      throw ownerNotAuthorized();
    }

    const partner = await ownerPartnerAuthority(input.ownerUserId, input.partnerId);
    if (partner && backs(partner.permissions)) {
      return { orgIds: partner.orgIds };
    }

    if (input.surface === 'partner_api') {
      // Not cached: re-derived from the live users row on every call.
      const platform = await getUserPermissions(input.ownerUserId, { scope: 'system' });
      if (platform?.scope === 'system' && backs(platform)) {
        return { orgIds: [] };
      }
    }
  } catch {
    throw ownerNotAuthorized();
  }
  throw ownerNotAuthorized();
}
