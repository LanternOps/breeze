import type { UnifiHost, UnifiSite } from './unifiClient';

export const UNKNOWN_CONSOLE_NAME = 'Unknown console';

export interface MappingHostRow {
  id: string;
  name: string;
  model: string | null;
  type: string | null;
  unknownConsole?: true;
  sites: Array<{ id: string; name: string }>;
}

export interface MappingHostList {
  hosts: MappingHostRow[];
  omitted: { hostsWithoutSites: number; sitesWithoutHostId: number };
}

/**
 * List every returned host with sites in /v1/hosts order, whatever its type:
 * console, network-server (self-hosted Network Application), ucore, unknown or null.
 * Only hosts without sites are filtered, and counted in hostsWithoutSites.
 * Append unknown non-empty host IDs in first-seen site order. Keep their real ID:
 * the UI saves row.id as unifiHostId and sync uses it to look up devices, so a
 * synthetic ID would create mappings that can never sync.
 * Empty host IDs cannot be mapped or synced; count them in sitesWithoutHostId.
 * Real host rows do not emit unknownConsole.
 */
export function buildMappingHostList(hosts: UnifiHost[], sites: UnifiSite[]): MappingHostList {
  const sitesByHost = new Map<string, MappingHostRow['sites']>();
  const omitted = { hostsWithoutSites: 0, sitesWithoutHostId: 0 };
  for (const site of sites) {
    if (!site.hostId) {
      omitted.sitesWithoutHostId++;
      continue;
    }
    const grouped = sitesByHost.get(site.hostId) ?? [];
    grouped.push({ id: site.id, name: site.name });
    sitesByHost.set(site.hostId, grouped);
  }

  const rows: MappingHostRow[] = [];
  const knownHostIds = new Set(hosts.map((host) => host.id));
  for (const host of hosts) {
    const grouped = sitesByHost.get(host.id);
    if (!grouped?.length) {
      omitted.hostsWithoutSites++;
      continue;
    }
    rows.push({ id: host.id, name: host.name, model: host.model, type: host.type, sites: grouped });
  }
  for (const [hostId, grouped] of sitesByHost) {
    if (knownHostIds.has(hostId)) continue;
    rows.push({
      id: hostId, name: UNKNOWN_CONSOLE_NAME, model: null, type: null,
      unknownConsole: true, sites: grouped,
    });
  }
  return { hosts: rows, omitted };
}

/**
 * How many listed sites have no mapping row. Keyed by host and site: a UniFi site
 * id is only unique within its host. Sites without a host id are left out, as in
 * buildMappingHostList: the mapping list cannot offer them, so counting them
 * would report work nobody can do. A site listed twice counts once.
 */
export function countUnmappedSites(
  sites: ReadonlyArray<{ hostId: string; id: string }>,
  mappings: ReadonlyArray<{ unifiHostId: string; unifiSiteId: string }>,
): number {
  const key = (hostId: string, siteId: string) => JSON.stringify([hostId, siteId]);
  const mapped = new Set(mappings.map((m) => key(m.unifiHostId, m.unifiSiteId)));
  const unmapped = new Set<string>();
  for (const site of sites) {
    if (!site.hostId) continue;
    const k = key(site.hostId, site.id);
    if (!mapped.has(k)) unmapped.add(k);
  }
  return unmapped.size;
}
