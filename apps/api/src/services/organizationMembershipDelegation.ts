import { and, eq, inArray } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db';
import { organizationUsers, sites } from '../db/schema';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ResolveDelegatedSiteIdsInput {
  inviterUserId: string;
  orgId: string;
  requestedSiteIds?: string[];
}

/**
 * Resolve an invited organization member's site ceiling while holding the
 * inviter membership row lock. `NULL` is the persisted unrestricted sentinel;
 * a restricted inviter can never delegate it.
 */
export async function resolveDelegatedSiteIds(
  tx: Transaction,
  input: ResolveDelegatedSiteIdsInput,
): Promise<string[] | null> {
  const [inviterMembership] = await tx
    .select({ siteIds: organizationUsers.siteIds })
    .from(organizationUsers)
    .where(and(
      eq(organizationUsers.userId, input.inviterUserId),
      eq(organizationUsers.orgId, input.orgId),
    ))
    .limit(1)
    .for('update');

  if (!inviterMembership) {
    throw new HTTPException(403, { message: 'Current organization membership required' });
  }

  const inviterSiteIds = inviterMembership.siteIds;
  const requested = input.requestedSiteIds === undefined
    ? (inviterSiteIds === null ? null : [...new Set(inviterSiteIds)])
    : [...new Set(input.requestedSiteIds)];

  if (requested === null) return null;

  if (inviterSiteIds !== null) {
    const allowed = new Set(inviterSiteIds);
    if (requested.some((siteId) => !allowed.has(siteId))) {
      throw new HTTPException(403, { message: 'Cannot grant site access beyond the inviter scope' });
    }
  }

  if (requested.length === 0) return [];

  // Hold key-share locks through membership insertion so validation and the
  // delegated array refer to the same live organization/site relationship.
  const validSites = await tx
    .select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.orgId, input.orgId), inArray(sites.id, requested)))
    .for('key share');
  if (validSites.length !== requested.length) {
    throw new HTTPException(400, { message: 'Every delegated site must belong to the organization' });
  }

  return requested;
}
