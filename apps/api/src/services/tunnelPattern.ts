import { isIP } from 'node:net';

/**
 * Tunnel allowlist grammar, shared by every API reader and writer of
 * `tunnel_allowlists` and matching the agent's parser
 * (agent/internal/tunnel/allowlist.go):
 *
 * - source rules: an IPv4 or IPv6 address or CIDR, e.g. `198.51.100.0/24`,
 *   `2001:db8::/48`;
 * - destination rules: `address-or-CIDR:port-range`, split at the LAST colon so
 *   IPv6 addresses keep their own colons, e.g. `192.168.1.0/24:80-443`,
 *   `2001:db8::/32:443`, `2001:db8::1:*`.
 *
 * An IPv6 CIDR must be written as its network address (`2001:db8::/32`, not
 * `2001:db8::5/32`), so a host address with a short prefix is never widened to
 * the whole prefix. IPv4 keeps its historical behaviour of masking host bits.
 *
 * Address families follow Go's net.IPNet: an IPv4-mapped address
 * (`::ffff:a.b.c.d`) is an IPv4 address, an IPv4-mapped rule of /96 or longer
 * is an IPv4 rule, and an address only matches a rule of its own family.
 */

type Family = 4 | 6;

function ipv6ToBigInt(address: string): bigint {
  let text = address;
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  const last = text.slice(lastColon + 1);
  if (last.includes('.')) {
    const octets = last.split('.').map(Number);
    tail = [(octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!];
    text = text.slice(0, lastColon + 1) + '0:0';
  }
  const [head = '', rest] = text.split('::');
  const headGroups = head ? head.split(':') : [];
  const restGroups = rest === undefined ? [] : (rest ? rest.split(':') : []);
  const groups = rest === undefined
    ? headGroups
    : [...headGroups, ...Array(8 - headGroups.length - restGroups.length).fill('0'), ...restGroups];
  const words = groups.map((g) => parseInt(g, 16));
  if (tail.length === 2) {
    words[6] = tail[0]!;
    words[7] = tail[1]!;
  }
  return words.reduce((acc, word) => (acc << 16n) | BigInt(word), 0n);
}

type Address = { family: Family; value: bigint };
type Network = Address & { length: number };

const IPV4_MAPPED_PREFIX = 0xffffn;

function ipv4ToBigInt(address: string): bigint {
  return address.split('.').reduce((acc, octet) => (acc << 8n) | BigInt(Number(octet)), 0n);
}

function bitsOf(family: Family): number {
  return family === 4 ? 32 : 128;
}

/** Parses an IP literal; an IPv4-mapped IPv6 address is returned as IPv4. */
function parseAddress(text: string): Address | null {
  if (text.includes('%')) return null;
  const family = isIP(text);
  if (family === 4) return { family: 4, value: ipv4ToBigInt(text) };
  if (family !== 6) return null;
  const value = ipv6ToBigInt(text);
  if (value >> 32n === IPV4_MAPPED_PREFIX) return { family: 4, value: value & 0xffffffffn };
  return { family: 6, value };
}

function parseNetwork(prefix: string): Network | null {
  if (prefix !== prefix.trim() || prefix.includes('%')) return null;
  const parts = prefix.split('/');
  if (parts.length > 2) return null;
  const [base = '', lengthText] = parts;
  const family = isIP(base);
  if (family !== 4 && family !== 6) return null;
  const maxLength = bitsOf(family);
  let length = maxLength;
  if (lengthText !== undefined) {
    if (!/^\d{1,3}$/.test(lengthText)) return null;
    length = Number(lengthText);
    if (length > maxLength) return null;
  }
  if (family === 4) return { family: 4, value: ipv4ToBigInt(base), length };
  const value = ipv6ToBigInt(base);
  if (length < 128 && (value & ((1n << BigInt(128 - length)) - 1n)) !== 0n) return null;
  if (length >= 96 && value >> 32n === IPV4_MAPPED_PREFIX) {
    return { family: 4, value: value & 0xffffffffn, length: length - 96 };
  }
  return { family: 6, value, length };
}

export function validTunnelNetwork(prefix: string): boolean {
  return parseNetwork(prefix) !== null;
}

/** Whether `host` (an IP literal) is inside `prefix`. Non-IP hosts never match. */
export function tunnelNetworkContains(prefix: string, host: string): boolean {
  const network = parseNetwork(prefix);
  const address = parseAddress(host);
  if (!network || !address || network.family !== address.family) return false;
  const shift = BigInt(bitsOf(network.family) - network.length);
  return (address.value >> shift) === (network.value >> shift);
}

export function parseTunnelDestinationPattern(
  pattern: string,
): { network: string; min: number; max: number } | null {
  const separator = pattern.lastIndexOf(':');
  if (separator <= 0 || separator === pattern.length - 1) return null;
  const network = pattern.slice(0, separator);
  const ports = pattern.slice(separator + 1);
  if (!validTunnelNetwork(network)) return null;
  if (ports === '*') return { network, min: 1, max: 65535 };
  if (!/^\d{1,5}(?:-\d{1,5})?$/.test(ports)) return null;
  const [min = 0, max = min] = ports.split('-').map(Number);
  if (min < 1 || max > 65535 || min > max) return null;
  return { network, min, max };
}

export function validTunnelPattern(direction: string, pattern: string): boolean {
  return direction === 'source'
    ? validTunnelNetwork(pattern)
    : parseTunnelDestinationPattern(pattern) !== null;
}

export function tunnelDestinationMatches(pattern: string, host: string, port: number): boolean {
  const rule = parseTunnelDestinationPattern(pattern);
  return rule !== null && port >= rule.min && port <= rule.max && tunnelNetworkContains(rule.network, host);
}

// Hardcoded deny list (mirrors blockedNetworks in agent/internal/tunnel/allowlist.go).
// No allowlist rule can permit these.
const BLOCKED_NETWORKS = [
  { cidr: '127.0.0.0/8', reason: 'localhost' },
  { cidr: '::1/128', reason: 'localhost' },
  { cidr: '169.254.0.0/16', reason: 'link-local / cloud metadata (SSRF prevention)' },
  { cidr: 'fe80::/10', reason: 'link-local' },
  { cidr: 'fd00:ec2::254/128', reason: 'cloud metadata' },
  { cidr: 'fd20:ce::254/128', reason: 'cloud metadata' },
] as const;

/**
 * Reason a tunnel target is refused regardless of allowlist rules, or null.
 * The local VNC endpoint (127.0.0.1:5900 for a VNC tunnel) is the only
 * exception. Host names are not resolved here: the destination allowlist only
 * matches IP literals, and the agent re-checks every resolved address.
 */
export function tunnelTargetBlockReason(host: string, port: number, isVNC: boolean): string | null {
  const family = isIP(host);
  if (family === 0) return null;
  if (tunnelNetworkContains('0.0.0.0/32', host) || tunnelNetworkContains('::/128', host)) return 'Wildcard bind address';
  if (isVNC && host === '127.0.0.1' && port === 5900) return null;
  for (const { cidr, reason } of BLOCKED_NETWORKS) {
    if (tunnelNetworkContains(cidr, host)) return reason;
  }
  return null;
}
