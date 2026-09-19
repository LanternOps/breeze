import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { tunnelAllowlists } from '../db/schema';

/**
 * Whether a rule is effective for the bridge device's current site. Null rules
 * are deliberately organization-wide; site-bound rules never bleed into a
 * bridge at another site.
 */
export function tunnelAllowlistRuleAppliesToSite(
  ruleSiteId: string | null,
  bridgeSiteId: string | null,
): boolean {
  return ruleSiteId === null || ruleSiteId === bridgeSiteId;
}

/**
 * Active destination allowlist patterns for an org and bridge site.
 *
 * Returned to the bridging agent so it can re-validate the proxy target
 * (defense-in-depth — the agent is the final authority on which LAN hosts a
 * tunnel may reach). Shared by the tunnel-create path (`tunnels.ts`) and the
 * HTTP reverse-proxy route (`tunnelHttp.ts`).
 */
export async function getActiveAllowlistPatterns(orgId: string, bridgeSiteId: string | null): Promise<string[]> {
  const rules = await db
    .select({ pattern: tunnelAllowlists.pattern, siteId: tunnelAllowlists.siteId })
    .from(tunnelAllowlists)
    .where(
      and(
        eq(tunnelAllowlists.orgId, orgId),
        eq(tunnelAllowlists.direction, 'destination'),
        eq(tunnelAllowlists.enabled, true),
      ),
    );
  return rules
    .filter((rule) => tunnelAllowlistRuleAppliesToSite(rule.siteId ?? null, bridgeSiteId))
    .map((rule) => rule.pattern);
}
