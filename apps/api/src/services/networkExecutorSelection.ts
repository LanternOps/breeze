/**
 * THE executor picker for asset-bound network work (spec §5, SR5-08).
 *
 * Extracted verbatim from jobs/monitorWorker.ts so the monitor worker, the
 * monitors `/test` route and the manual probe cannot drift. Before this there
 * were two copies with different rules: the worker was site-strict and excluded
 * ephemeral devices, the route fell back org-wide and did not — so "Test" could
 * direct a root-level agent in another site, or a stranger's Quick Support
 * machine, to probe the target.
 *
 * QUICK SUPPORT EXCLUSION (both branches): ephemeral devices live in the hidden
 * per-partner 'quick_support' org and are a stranger's personal machine
 * borrowed for one ~20-minute session. That org stays inside technicians'
 * accessibleOrgIds for RLS reasons, so background workers are NOT filtered for
 * us. Such a device must never be conscripted to run network probes on a home
 * network.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { devices, discoveredAssets } from '../db/schema';

export type NetworkExecutorPick = { agentId: string } | { error: 'no_agent_in_site' };

export async function loadAssetSiteId(orgId: string, assetId: string): Promise<string | null> {
  const [asset] = await db
    .select({ siteId: discoveredAssets.siteId })
    .from(discoveredAssets)
    .where(and(eq(discoveredAssets.id, assetId), eq(discoveredAssets.orgId, orgId)))
    .limit(1);
  return asset?.siteId ?? null;
}

export async function selectNetworkExecutor(input: {
  orgId: string;
  /** Non-null ⇒ site-strict. Null ⇒ org-wide (unbound monitors only). */
  siteId: string | null;
  /** Optional extra allowlist for a site-restricted CALLER on the org-wide branch. */
  restrictToSiteIds?: string[] | null;
}): Promise<NetworkExecutorPick> {
  const conditions = [
    eq(devices.orgId, input.orgId),
    eq(devices.isEphemeral, false),
    eq(devices.status, 'online'),
  ];

  if (input.siteId) {
    // Site-bound: the executing agent MUST live in the target's site. There is
    // deliberately NO org-wide second attempt — crossing the boundary would
    // direct an agent in another site to probe this target (SR5-08).
    conditions.push(eq(devices.siteId, input.siteId));
  } else if (input.restrictToSiteIds) {
    // Unbound target, site-restricted CALLER: the org-wide branch narrows to
    // what the caller may see. An empty allowlist can match nothing.
    if (input.restrictToSiteIds.length === 0) return { error: 'no_agent_in_site' };
    conditions.push(inArray(devices.siteId, input.restrictToSiteIds));
  }

  const [agent] = await db
    .select({ agentId: devices.agentId })
    .from(devices)
    .where(and(...conditions))
    .limit(1);

  return agent?.agentId ? { agentId: agent.agentId } : { error: 'no_agent_in_site' };
}
