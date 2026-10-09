import { withDbAccessContext, type DbAccessContext } from '../../db';
import type { PartnerApiPrincipalContext } from '../../middleware/partnerApiAuth';

/**
 * The bounded database context a Partner API WRITE handler opens.
 *
 * Non-GET requests reach their handler with NO ambient context (see
 * partnerApiAuth.ts: the held read transaction takes the partner discovery
 * lock shared, which a tenancy write must take exclusive). Each handler
 * therefore opens exactly this: partner scope, the principal's accessible
 * org set, no user. Never system scope — RLS is the isolation boundary.
 */
export function partnerScopedDbContext(principal: PartnerApiPrincipalContext): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: principal.accessibleOrgIds,
    accessiblePartnerIds: [principal.partnerId],
    currentPartnerId: principal.partnerId,
    userId: null,
  };
}

export async function inPartnerContext<T>(principal: PartnerApiPrincipalContext, fn: () => Promise<T>): Promise<T> {
  return withDbAccessContext(partnerScopedDbContext(principal), fn);
}
