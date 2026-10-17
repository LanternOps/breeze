// Leaf module: the SQL predicate shared by the live resolve and the serving-set
// refresh. Imports nothing from resolve.ts / servingSet.ts (no cycle).
import { and, eq, isNotNull, type SQL } from 'drizzle-orm';
import { partners, trustPages } from '../../db/schema';
import { buildPublicLinkLiveOrgPredicate } from '../publicLinkOrgGate';
import { partnerTrustMode } from '../../config/partnerTrustMode';

/** published + live org/partner + (hosted) trusted partner. Spec §7 "Serve", §19.11. */
export function livePublicationPredicate(): SQL {
  const parts: SQL[] = [isNotNull(trustPages.publishedAt), buildPublicLinkLiveOrgPredicate(trustPages.orgId)];
  if (partnerTrustMode() !== 'off') parts.push(eq(partners.trustState, 'trusted'));
  return and(...parts)!;
}
