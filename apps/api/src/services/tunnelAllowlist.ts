import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { tunnelAllowlists } from '../db/schema';

/**
 * Active destination allowlist patterns for an org.
 *
 * Returned to the bridging agent so it can re-validate the proxy target
 * (defense-in-depth — the agent is the final authority on which LAN hosts a
 * tunnel may reach). Shared by the tunnel-create path (`tunnels.ts`) and the
 * HTTP reverse-proxy route (`tunnelHttp.ts`).
 */
export async function getActiveAllowlistPatterns(orgId: string): Promise<string[]> {
  const rules = await db
    .select({ pattern: tunnelAllowlists.pattern })
    .from(tunnelAllowlists)
    .where(
      and(
        eq(tunnelAllowlists.orgId, orgId),
        eq(tunnelAllowlists.direction, 'destination'),
        eq(tunnelAllowlists.enabled, true),
      ),
    );
  return rules.map((r) => r.pattern);
}
