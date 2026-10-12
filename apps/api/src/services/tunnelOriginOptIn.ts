import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { organizations, partners } from '../db/schema';

/**
 * Whether a partner's Network Proxy sessions use the dedicated tunnel origin
 * when the region offers one (TUNNEL_ORIGIN_TEMPLATE). Flips to `true` only
 * after the tunnel domain's Public Suffix List inclusion is verified in
 * shipped browsers (plan W04 Task 19); until then it is opt-in per partner.
 */
export const TUNNEL_ORIGIN_PARTNER_DEFAULT = false;

export function tunnelOriginOptInFromSettings(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object') return TUNNEL_ORIGIN_PARTNER_DEFAULT;
  const networkProxy = (settings as Record<string, unknown>).networkProxy;
  if (!networkProxy || typeof networkProxy !== 'object') return TUNNEL_ORIGIN_PARTNER_DEFAULT;
  const value = (networkProxy as Record<string, unknown>).dedicatedTunnelOrigin;
  return typeof value === 'boolean' ? value : TUNNEL_ORIGIN_PARTNER_DEFAULT;
}

/**
 * Resolver for the per-partner opt-in, keyed by the tunnel session's org.
 * System context: called from the ticket route (inside a request) and from
 * the tunnel host's `/__bz/enter` (no app auth context). Missing rows fail
 * closed to path mode.
 */
export async function isTunnelOriginEnabledForOrg(orgId: string): Promise<boolean> {
  const [row] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ settings: partners.settings })
        .from(organizations)
        .innerJoin(partners, eq(organizations.partnerId, partners.id))
        .where(eq(organizations.id, orgId))
        .limit(1),
    ),
  );
  return row ? tunnelOriginOptInFromSettings(row.settings) : false;
}
