import { eq, inArray } from 'drizzle-orm';
import { unifiControllerSites, unifiCollectors, unifiSiteMappings } from '../../db/schema';
import type { DbExecutor } from './unifiConnectionService';

export interface ReportedSite { id: string; name?: string | null }

// Upsert the agent-reported local sites for a self-hosted controller. Keyed on
// (collector_id, local_site_id). org comes from the collector (caller resolves it).
export async function upsertControllerSites(
  db: DbExecutor,
  collectorId: string,
  orgId: string,
  sites: ReportedSite[],
): Promise<void> {
  const now = new Date();
  for (const s of sites) {
    await db.insert(unifiControllerSites).values({
      collectorId, orgId, localSiteId: s.id, name: s.name ?? null, lastSeenAt: now,
    }).onConflictDoUpdate({
      target: [unifiControllerSites.collectorId, unifiControllerSites.localSiteId],
      set: { name: s.name ?? null, lastSeenAt: now, updatedAt: now },
    });
  }
}

// List discovered sites for a self-hosted integration's collectors, flagging which
// already have a Phase-1-style mapping row (unifi_host_id = collectorId sentinel).
export async function listControllerSitesForIntegration(
  db: DbExecutor,
  integrationId: string,
): Promise<Array<{ collectorId: string; localSiteId: string; name: string | null; mapped: boolean }>> {
  const collectors = await db.select({ id: unifiCollectors.id })
    .from(unifiCollectors).where(eq(unifiCollectors.integrationId, integrationId));
  const collectorIds = collectors.map((c: any) => c.id);
  if (collectorIds.length === 0) return [];
  const rows = await db.select({
    collectorId: unifiControllerSites.collectorId,
    localSiteId: unifiControllerSites.localSiteId,
    name: unifiControllerSites.name,
  }).from(unifiControllerSites).where(inArray(unifiControllerSites.collectorId, collectorIds));
  const mappings = await db.select({
    unifiHostId: unifiSiteMappings.unifiHostId, unifiSiteId: unifiSiteMappings.unifiSiteId,
  }).from(unifiSiteMappings).where(eq(unifiSiteMappings.integrationId, integrationId));
  const mappedKeys = new Set(mappings.map((m: any) => `${m.unifiHostId}::${m.unifiSiteId}`));
  return rows.map((r: any) => ({
    collectorId: r.collectorId, localSiteId: r.localSiteId, name: r.name,
    mapped: mappedKeys.has(`${r.collectorId}::${r.localSiteId}`),
  }));
}
