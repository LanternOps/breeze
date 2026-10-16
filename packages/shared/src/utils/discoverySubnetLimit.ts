/**
 * Largest IPv4 subnet (in host addresses) the agent will scan without DeepScan.
 *
 * Mirrors agent/internal/discovery/scanner.go `expandTargets`: for every
 * configured subnet it computes `hosts = 1 << (32 - prefix)` and, when
 * `hosts > 65536 && !deepScan`, logs "Subnet too large" and SKIPS that subnet
 * (the profile then discovers nothing for it). The limit is per subnet entry,
 * not a sum across entries; a /16 (65,536 hosts) is the largest accepted.
 * Keep this constant in sync with the Go source.
 */
export const MAX_DISCOVERY_SUBNET_HOSTS = 65_536;

/**
 * Number of host addresses the agent would expand for one subnet entry, or
 * null when the entry is not an IPv4 CIDR/address we can size (bare IPs are
 * /32; malformed input is left to the callers' own format validation).
 */
export function discoverySubnetHostCount(entry: string): number | null {
  const value = entry.trim();
  const match = /^(\d{1,3}\.){3}\d{1,3}(?:\/(\d{1,3}))?$/.exec(value);
  if (!match) return null;
  if (match[2] === undefined) return 1;
  const prefix = Number(match[2]);
  if (prefix > 32) return null;
  return 2 ** (32 - prefix);
}

/** First entry whose size exceeds the no-DeepScan limit, or null if all fit. */
export function findOversizedDiscoverySubnet(entries: readonly string[]): string | null {
  for (const entry of entries) {
    const hosts = discoverySubnetHostCount(entry);
    if (hosts !== null && hosts > MAX_DISCOVERY_SUBNET_HOSTS) return entry.trim();
  }
  return null;
}

/** Readable API/UI message naming the limit. */
export function discoverySubnetTooLargeMessage(entry: string): string {
  return `Subnet "${entry}" is too large: the agent skips subnets over ${MAX_DISCOVERY_SUBNET_HOSTS.toLocaleString('en-US')} addresses (larger than a /16). Split it into smaller ranges.`;
}
