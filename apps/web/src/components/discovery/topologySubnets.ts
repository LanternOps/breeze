// Honest subnet grouping for the network topology view.
//
// Issue #1325 (Tier 1): the topology map must NOT fabricate adjacency edges.
// Instead it groups discovered assets into the subnet they actually belong to,
// derived from the discovery profile CIDRs (correct mask, not a hard-coded /24).
//
// This module is pure (no D3, no React) so it can be unit-tested in isolation.

export type SubnetCidr = {
  /** Network base address as an unsigned 32-bit integer. */
  network: number;
  /** Prefix length, e.g. 24 for a /24. */
  prefix: number;
  /** Canonical label, e.g. "10.0.2.0/24". */
  label: string;
};

const UNGROUPED_LABEL = 'Ungrouped';

/** Parse a dotted-quad IPv4 address into an unsigned 32-bit integer, or null. */
export function ipv4ToInt(ip: string): number | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  // Coerce to unsigned 32-bit.
  return value >>> 0;
}

/** Convert an unsigned 32-bit integer back to a dotted-quad IPv4 string. */
export function intToIpv4(value: number): string {
  const v = value >>> 0;
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff].join('.');
}

/**
 * Parse a CIDR string ("10.0.0.0/24") into a normalized {@link SubnetCidr}.
 * A bare IP (no "/") is treated as a /32. Invalid input returns null.
 */
export function parseCidr(cidr: string): SubnetCidr | null {
  const trimmed = cidr.trim();
  if (!trimmed) return null;

  const slashIndex = trimmed.indexOf('/');
  const ipPart = slashIndex === -1 ? trimmed : trimmed.slice(0, slashIndex);
  const prefixPart = slashIndex === -1 ? '32' : trimmed.slice(slashIndex + 1);

  const ipInt = ipv4ToInt(ipPart);
  if (ipInt === null) return null;

  if (!/^\d{1,2}$/.test(prefixPart)) return null;
  const prefix = Number(prefixPart);
  if (prefix < 0 || prefix > 32) return null;

  // Mask the host bits off so the network base is canonical.
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ipInt & mask) >>> 0;

  return {
    network,
    prefix,
    label: `${intToIpv4(network)}/${prefix}`
  };
}

/** True when `ip` falls inside the given subnet. */
export function ipInSubnet(ip: string, subnet: SubnetCidr): boolean {
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return false;
  const mask = subnet.prefix === 0 ? 0 : (0xffffffff << (32 - subnet.prefix)) >>> 0;
  return ((ipInt & mask) >>> 0) === subnet.network;
}

/**
 * Parse and de-duplicate a list of profile CIDR strings into canonical subnets,
 * sorted by network address then most-specific prefix first.
 */
export function parseProfileSubnets(cidrs: readonly string[]): SubnetCidr[] {
  const seen = new Map<string, SubnetCidr>();
  for (const cidr of cidrs) {
    const parsed = parseCidr(cidr);
    if (!parsed) continue;
    if (!seen.has(parsed.label)) seen.set(parsed.label, parsed);
  }
  return Array.from(seen.values()).sort((a, b) =>
    a.network === b.network ? b.prefix - a.prefix : a.network - b.network
  );
}

export type SubnetMember<T> = T & { ipAddress?: string };

export type SubnetGroup<T> = {
  /** Canonical subnet label, or "Ungrouped" / a synthesized /24 fallback. */
  label: string;
  /** The matched profile CIDR, when grouping came from a real definition. */
  cidr: SubnetCidr | null;
  nodes: SubnetMember<T>[];
};

/**
 * Synthesize a /24-labelled group from a node's IP. This is ONLY used as a
 * last-resort fallback when no discovery-profile CIDRs are available — it is
 * not adjacency, just a coarse bucket so the view is never one global hairball.
 */
function fallbackSubnetLabel(ip: string): string | null {
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return null;
  const network = (ipInt & 0xffffff00) >>> 0;
  return `${intToIpv4(network)}/24`;
}

/**
 * Group nodes into subnets.
 *
 * Preference order per node:
 *  1. The most-specific profile CIDR that contains its IP.
 *  2. A synthesized /24 bucket from its IP (fallback only).
 *  3. The "Ungrouped" bucket (no/invalid IP).
 *
 * Profile subnets must be pre-parsed (see {@link parseProfileSubnets}) and are
 * expected to be sorted most-specific-first within equal network addresses so
 * the first containing match wins.
 */
export function groupNodesBySubnet<T extends { ipAddress?: string }>(
  nodes: readonly T[],
  profileSubnets: readonly SubnetCidr[]
): SubnetGroup<T>[] {
  // Sort candidate subnets most-specific-first so a /28 wins over an enclosing /24.
  const candidates = [...profileSubnets].sort((a, b) => b.prefix - a.prefix);

  const groups = new Map<string, SubnetGroup<T>>();
  const ensure = (label: string, cidr: SubnetCidr | null): SubnetGroup<T> => {
    let group = groups.get(label);
    if (!group) {
      group = { label, cidr, nodes: [] };
      groups.set(label, group);
    }
    return group;
  };

  for (const node of nodes) {
    const ip = node.ipAddress;
    let placed = false;

    if (ip) {
      for (const subnet of candidates) {
        if (ipInSubnet(ip, subnet)) {
          ensure(subnet.label, subnet).nodes.push(node);
          placed = true;
          break;
        }
      }

      if (!placed) {
        const fallback = fallbackSubnetLabel(ip);
        if (fallback) {
          ensure(fallback, null).nodes.push(node);
          placed = true;
        }
      }
    }

    if (!placed) {
      ensure(UNGROUPED_LABEL, null).nodes.push(node);
    }
  }

  // Stable, readable ordering: real CIDRs first (by network/prefix), then
  // fallback /24s, then "Ungrouped" last.
  return Array.from(groups.values()).sort((a, b) => {
    if (a.label === UNGROUPED_LABEL) return 1;
    if (b.label === UNGROUPED_LABEL) return -1;
    if (a.cidr && b.cidr) {
      return a.cidr.network === b.cidr.network
        ? a.cidr.prefix - b.cidr.prefix
        : a.cidr.network - b.cidr.network;
    }
    if (a.cidr) return -1;
    if (b.cidr) return 1;
    return a.label.localeCompare(b.label);
  });
}

export { UNGROUPED_LABEL };
