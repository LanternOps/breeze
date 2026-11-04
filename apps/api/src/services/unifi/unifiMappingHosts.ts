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
