import type { DbAccessContext } from '../../db';

/**
 * The DB access context of a portal request: the portal user's organization and
 * nothing else. The portal auth middleware wraps every request in it; a route
 * that opts out of that request transaction (selfManagedDbContextRoutes.ts) and
 * opens its own org transaction uses this same context, so its RLS scope stays
 * exactly the middleware's.
 */
export function portalOrgDbAccessContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    // Generic portal routes intentionally do not receive the partner-wide
    // SELECT branch. Self-managed routes that explicitly need it (for
    // example Network Visibility) opt in with the validated owning partner.
    currentPartnerId: null,
  };
}
