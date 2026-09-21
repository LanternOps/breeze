/**
 * THE executor picker for asset-bound network work (spec §5, SR5-08).
 *
 * Shared by the monitor worker, the monitors `/test` route and the manual
 * probe so their selection rules cannot drift. Before this there
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

import { and, eq, inArray, isNull } from 'drizzle-orm';
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
  /** Pin a previous selection when revalidating immediately before dispatch. */
  agentId?: string;
}): Promise<NetworkExecutorPick> {
  const conditions = [
    eq(devices.orgId, input.orgId),
    eq(devices.isEphemeral, false),
    eq(devices.status, 'online'),
    isNull(devices.agentTokenSuspendedAt),
  ];

  if (input.agentId) conditions.push(eq(devices.agentId, input.agentId));

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

/** A bound asset with a missing site is unavailable, never implicitly unbound. */
export async function selectMonitorExecutor(
  monitor: { orgId: string; assetId: string | null; siteId?: string | null },
  options: { allowedSiteIds?: string[] | null; agentId?: string } = {},
): Promise<NetworkExecutorPick | { error: 'site_access_denied' }> {
  const assetSiteId = monitor.assetId ? await loadAssetSiteId(monitor.orgId, monitor.assetId) : null;
  if (monitor.assetId && monitor.siteId && assetSiteId !== monitor.siteId) return { error: 'no_agent_in_site' };
  const siteId = monitor.siteId ?? assetSiteId;
  if (monitor.assetId && !assetSiteId) return { error: 'no_agent_in_site' };
  if (options.allowedSiteIds && (!siteId || !options.allowedSiteIds.includes(siteId))) {
    return { error: 'site_access_denied' };
  }
  return selectNetworkExecutor({ orgId: monitor.orgId, siteId, agentId: options.agentId });
}
