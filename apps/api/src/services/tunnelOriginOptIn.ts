import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { readWithPartnerAxisVisibility } from '../db/partnerAxisRead';
import { organizations, partners } from '../db/schema';
import { tunnelOriginOptInFromSettings } from '@breeze/shared';

// The default and the settings parser live in @breeze/shared so the Partner
// Settings toggle (apps/web PartnerRemoteAccessTab) shows the same effective
// value this resolver applies.
export { TUNNEL_ORIGIN_PARTNER_DEFAULT, tunnelOriginOptInFromSettings } from '@breeze/shared';

/**
 * Resolver for the per-partner opt-in, keyed by the tunnel session's org.
 * System context: called from the ticket route (inside a request) and from
 * the tunnel host's `/__bz/enter` (no app auth context). Missing rows fail
 * closed to path mode, and so do soft-deleted orgs and partners.
 *
 * `orgId` MUST come from the verified tunnel session row (`tunnel_sessions.org_id`), never from client input — this read is not scoped by the caller's RLS.
 */
export async function isTunnelOriginEnabledForOrg(orgId: string): Promise<boolean> {
  const [row] = await readWithPartnerAxisVisibility(() =>
    db
      .select({ settings: partners.settings })
      .from(organizations)
      .innerJoin(partners, eq(organizations.partnerId, partners.id))
      .where(and(
        eq(organizations.id, orgId),
        isNull(organizations.deletedAt),
        isNull(partners.deletedAt),
      ))
      .limit(1),
  );
  return row ? tunnelOriginOptInFromSettings(row.settings) : false;
}
