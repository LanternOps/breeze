/**
 * ipRanges — the single table of non-routable IP ranges, and the classifiers
 * derived from it.
 *
 * Every guard in this repo that has to decide whether an address may be dialed
 * from the server classifies through this module. It is deliberately a leaf: no
 * DNS, no sockets, no imports, so the table can be shared by a synchronous
 * config-time check (`ssrfGuard.ts`) and by the connect-time resolve-and-pin
 * path (`urlSafety.ts`) without either pulling the other in. Before this module
 * existed each carried its own hand-rolled prefix matchers, and the two lists
 * had drifted apart in both directions.
 *
 * Adding or narrowing a range means editing ONE table here. `ssrfGuard.ranges.test.ts`
 * pins the whole table, for every mode, against both classifiers.
 *
 * Documented exception: `routes/tunnels.ts` keeps its own, deliberately narrower
 * list for device-tunnel targets. Reaching a LAN address is the point of that
 * feature, its list mirrors the agent-side `allowlist.go`, and it carries an
 * explicit loopback exception for local VNC — so it is not a URL validator and
 * cannot simply adopt this table. Broadening it (it has no IPv6 handling) needs
 * the agent side moved in step, and is tracked separately.
 */

/**
 * Why an address is not dialable from the server.
 *
 * `'private'` is the one category an on-prem appliance integration may opt into
 * reaching (`allowPrivateNetwork`); every other category stays blocked in every
 * mode. Keeping the reason next to the range is what lets the guards in this
 * repo share ONE table while still reporting a specific message.
 */
export type BlockedIpCategory =
  | 'loopback'
  | 'link-local'
  | 'private'
  | 'carrier-nat'
  | 'unspecified'
  | 'multicast-or-reserved'
  | 'documentation';

/** Message fragment used when reporting a blocked address to a caller. */
export const BLOCKED_IP_CATEGORY_LABEL: Record<BlockedIpCategory, string> = {
  loopback: 'loopback',
  'link-local': 'link-local / cloud-metadata',
  private: 'private/RFC1918 or ULA',
  'carrier-nat': 'carrier-grade NAT',
  unspecified: 'unspecified',
  'multicast-or-reserved': 'multicast or reserved',
  documentation: 'documentation / benchmarking'
};

interface V4Range {
  /** Human-readable CIDR — doubles as this table's documentation. */
  cidr: string;
  category: BlockedIpCategory;
  match: (o: number[]) => boolean;
}

// The single table of IPv4 ranges that must never be dialed from the server.
// Ordered roughly by how commonly they appear.
const BLOCKED_V4_RANGES: readonly V4Range[] = [
  { cidr: '10.0.0.0/8', category: 'private', match: (o) => o[0] === 10 },
  { cidr: '127.0.0.0/8', category: 'loopback', match: (o) => o[0] === 127 },
  { cidr: '192.168.0.0/16', category: 'private', match: (o) => o[0] === 192 && o[1] === 168 },
  {
    cidr: '172.16.0.0/12',
    category: 'private',
    match: (o) => o[0] === 172 && o[1]! >= 16 && o[1]! <= 31
  },
  // 169.254.0.0/16 also carries the cloud instance-metadata endpoints.
  { cidr: '169.254.0.0/16', category: 'link-local', match: (o) => o[0] === 169 && o[1] === 254 },
  {
    cidr: '100.64.0.0/10',
    category: 'carrier-nat',
    match: (o) => o[0] === 100 && o[1]! >= 64 && o[1]! <= 127
  },
  // The whole /8 is unroutable, not only the all-zeroes address.
  { cidr: '0.0.0.0/8', category: 'unspecified', match: (o) => o[0] === 0 },
  { cidr: '224.0.0.0/3', category: 'multicast-or-reserved', match: (o) => o[0]! >= 224 },
  // Documentation / TEST-NET ranges — outbound to these is never legitimate.
  {
    cidr: '192.0.0.0/24',
    category: 'documentation',
    match: (o) => o[0] === 192 && o[1] === 0 && o[2] === 0
  },
  {
    cidr: '192.0.2.0/24',
    category: 'documentation',
    match: (o) => o[0] === 192 && o[1] === 0 && o[2] === 2
  },
  {
    cidr: '198.18.0.0/15',
    category: 'documentation',
    match: (o) => o[0] === 198 && (o[1] === 18 || o[1] === 19)
  },
  {
    cidr: '198.51.100.0/24',
    category: 'documentation',
    match: (o) => o[0] === 198 && o[1] === 51 && o[2] === 100
  },
  {
    cidr: '203.0.113.0/24',
    category: 'documentation',
    match: (o) => o[0] === 203 && o[1] === 0 && o[2] === 113
  }
];

/** RFC1918 is the subset of `'private'` IPv4 ranges — derived, never re-listed. */
const RFC1918_CIDRS = new Set(['10.0.0.0/8', '192.168.0.0/16', '172.16.0.0/12']);

/** Strict dotted-quad parse — four decimal octets, nothing else. */
function parseV4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return octets;
}

/**
 * Parse one `inet_aton` part: decimal, `0`-prefixed octal, or `0x`-prefixed hex.
 * Returns null when the text is not a valid numeric part in any of those bases.
 */
function parseAtonPart(part: string): number | null {
  if (part.length === 0) return null;
  let value: number;
  if (/^0[xX][0-9a-fA-F]{1,8}$/.test(part)) {
    value = parseInt(part.slice(2), 16);
  } else if (/^0[0-7]{1,11}$/.test(part)) {
    value = parseInt(part.slice(1), 8);
  } else if (/^\d{1,10}$/.test(part)) {
    value = Number(part);
  } else {
    return null;
  }
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Canonicalise an IPv4 host literal to dotted-quad, accepting every form
 * `getaddrinfo()` accepts — not only `a.b.c.d`.
 *
 * `inet_aton` semantics allow one to four parts in decimal, octal or hex, with
 * the final part filling all remaining low-order bytes: `2130706433`, `127.1`,
 * `0177.0.0.1` and `0x7f.0.0.1` all name the same address. A guard that only
 * understands dotted-quad classifies none of them and hands the raw text to the
 * resolver, which does understand them — so the range table never sees the
 * address it is meant to be deciding about. Canonicalising first is what keeps
 * the table authoritative.
 *
 * Returns null when `host` is not an IPv4 literal in any accepted form (an
 * ordinary DNS hostname, or an IPv6 literal).
 */
export function canonicalizeIpv4Literal(host: string): string | null {
  if (!host || host.includes(':')) return null;
  const parts = host.split('.');
  if (parts.length > 4) return null;

  const values: number[] = [];
  for (const part of parts) {
    const value = parseAtonPart(part);
    if (value === null) return null;
    values.push(value);
  }

  // Every part but the last must fit in one byte; the last fills the remainder.
  for (let i = 0; i < values.length - 1; i++) {
    if (values[i]! > 0xff) return null;
  }
  const last = values[values.length - 1]!;
  const trailingBytes = 4 - values.length;
  if (last > 256 ** (trailingBytes + 1) - 1) return null;

  let addr = 0;
  for (let i = 0; i < values.length - 1; i++) {
    addr = (addr | (values[i]! << (8 * (3 - i)))) >>> 0;
  }
  addr = (addr | last) >>> 0;

  return [(addr >>> 24) & 0xff, (addr >>> 16) & 0xff, (addr >>> 8) & 0xff, addr & 0xff].join('.');
}

function v4RangeFor(ip: string): V4Range | null {
  const canonical = canonicalizeIpv4Literal(ip) ?? ip;
  const octets = parseV4(canonical);
  if (!octets) return null;
  return BLOCKED_V4_RANGES.find((r) => r.match(octets)) ?? null;
}

/**
 * If `ip` is an IPv4-mapped IPv6 literal (`::ffff:…`), return the embedded IPv4
 * address as a dotted-decimal string; otherwise return null. Handles BOTH the
 * dotted-decimal form (`::ffff:169.254.169.254`) AND the hex-pair form
 * (`::ffff:a9fe:a9fe`), case-insensitively.
 *
 * The hex-pair form is the one that is easy to miss: `::ffff:a9fe:a9fe` decodes
 * to 169.254.169.254, yet it still contains a `:` after the prefix is stripped,
 * so a check that branches on "contains a colon" routes it down the IPv6
 * path and never reaches the IPv4 table.
 */
function mappedV4(ip: string): string | null {
  const lower = ip.toLowerCase();
  if (!lower.startsWith('::ffff:')) return null;
  const rest = lower.slice('::ffff:'.length);
  // Dotted-decimal embedded form: ::ffff:a.b.c.d
  if (rest.includes('.')) {
    return parseV4(rest) ? rest : null;
  }
  // Hex-pair embedded form: ::ffff:HHHH:HHHH
  const groups = rest.split(':');
  if (groups.length !== 2) return null;
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const hi = parseInt(groups[0]!, 16);
  const lo = parseInt(groups[1]!, 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/** IPv6 ranges that must never be dialed, in the same shape as the IPv4 table. */
const BLOCKED_V6_RANGES: ReadonlyArray<{
  cidr: string;
  category: BlockedIpCategory;
  match: (lower: string) => boolean;
}> = [
  { cidr: '::/128', category: 'unspecified', match: (v) => v === '::' || /^(0:){7}0$/.test(v) },
  { cidr: '::1/128', category: 'loopback', match: (v) => v === '::1' || /^(0:){7}1$/.test(v) },
  // Unique Local Addresses — first byte 0xfc or 0xfd.
  { cidr: 'fc00::/7', category: 'private', match: (v) => /^f[cd]/.test(v) },
  // Link-local, fe80 .. febf.
  { cidr: 'fe80::/10', category: 'link-local', match: (v) => /^fe[89ab]/.test(v) },
  { cidr: 'ff00::/8', category: 'multicast-or-reserved', match: (v) => v.startsWith('ff') }
];

/**
 * Classify a literal IP address against the single blocklist table, returning
 * WHY it is blocked, or null when it is a routable public address (or not an IP
 * literal at all — a DNS hostname has to be resolved before it can be judged).
 *
 * This is the one entry point every guard in the repo should classify through,
 * so a range can only be added or narrowed in one place. It accepts IPv4
 * dotted-quad, the `inet_aton` short/octal/hex forms, IPv6, and IPv4-mapped
 * IPv6 in both the dotted and hex-pair spellings.
 */
export function classifyBlockedIp(ip: string): BlockedIpCategory | null {
  if (!ip) return 'unspecified';
  const lower = ip.toLowerCase();

  // Normalise any IPv4-mapped IPv6 literal (dotted OR hex-pair) to its embedded
  // IPv4 first, so both spellings route through the IPv4 table.
  const mapped = mappedV4(lower);
  if (mapped !== null) return v4RangeFor(mapped)?.category ?? null;

  if (lower.includes(':')) {
    return BLOCKED_V6_RANGES.find((r) => r.match(lower))?.category ?? null;
  }
  return v4RangeFor(lower)?.category ?? null;
}

/**
 * Returns true if `ip` is a literal address in a range that must not be
 * contacted from the server. Accepts both IPv4 and IPv6 literals (including
 * IPv4-mapped IPv6 like `::ffff:10.0.0.1`).
 */
export function isPrivateIp(ip: string): boolean {
  if (!ip) return true;
  return classifyBlockedIp(ip) !== null;
}

/**
 * True only for RFC1918 IPv4 or ULA IPv6 (fc00::/7) addresses — the ranges an
 * on-prem appliance integration may opt into reaching (e.g. a Pi-hole / AdGuard
 * Home box on the LAN). Loopback (127/8, ::1), link-local and instance metadata
 * (169.254/16, fe80::/10), CGNAT (100.64/10), unspecified (0/8),
 * multicast/reserved and documentation ranges are deliberately NOT included —
 * they are never a legitimate appliance target and stay blocked even when
 * private networking is opted in (see `isAlwaysBlockedIp`).
 *
 * Derived from the one range table rather than re-listing the CIDRs, so the two
 * cannot disagree: it is exactly the `'private'` category.
 */
export function isRfc1918OrUla(ip: string): boolean {
  if (!ip) return false;
  const lower = ip.toLowerCase();
  const mapped = mappedV4(lower);
  if (mapped !== null) {
    // Embedded RFC1918 counts as RFC1918; embedded metadata does not, so it
    // stays always-blocked.
    const range = v4RangeFor(mapped);
    return range !== null && RFC1918_CIDRS.has(range.cidr);
  }
  if (lower.includes(':')) {
    return classifyBlockedIp(lower) === 'private';
  }
  const range = v4RangeFor(lower);
  return range !== null && RFC1918_CIDRS.has(range.cidr);
}

/**
 * IPs that must NEVER be dialed even when `allowPrivateNetwork` is set: any
 * blocked range that is NOT a plain RFC1918/ULA appliance address. Public IPs
 * return false (allowed).
 */
export function isAlwaysBlockedIp(ip: string): boolean {
  return isPrivateIp(ip) ? !isRfc1918OrUla(ip) : false;
}

/**
 * A hostname that is already an IP literal needs no DNS work.
 *
 * Uses `canonicalizeIpv4Literal` rather than a `[\d.]+` shape test so the
 * `inet_aton` short/octal/hex spellings are recognised as literals too — those
 * are exactly the hosts that must be classified here rather than handed to the
 * resolver unexamined.
 */
export function isIpLiteralHost(hostname: string): boolean {
  return canonicalizeIpv4Literal(hostname) !== null || hostname.includes(':');
}

/**
 * The address form to classify and dial for an IP-literal host: the canonical
 * dotted-quad for IPv4 (in any spelling), the address as given for IPv6.
 */
export function canonicalIpLiteral(hostname: string): string {
  return canonicalizeIpv4Literal(hostname) ?? hostname;
}

/**
 * Why a hostname names something non-routable without being an IP literal.
 *
 * A hostname cannot be classified against the range table above — it has to be
 * resolved first. These are the names that need no resolution to be refused, so
 * a config-time check can reject them with an actionable message. Callers pick
 * which categories they refuse, because the answer is not the same for all of
 * them: a self-hosted integration may legitimately name an appliance in a
 * corporate `.internal` zone, while a cloud-only vendor endpoint never can.
 *
 * Returns null for an ordinary hostname (which still has to be resolved and its
 * addresses classified) and for an IP literal (use `classifyBlockedIp`).
 */
export type NonRoutableHostnameKind = 'loopback' | 'mdns-local' | 'internal-tld' | 'metadata';

/** Names that resolve to a loopback address on essentially every host. */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback'
]);

/**
 * Instance-metadata endpoints named by hostname, plus the two provider metadata
 * addresses that sit outside 169.254/16 and so are not in the range table.
 */
const METADATA_HOSTNAMES: ReadonlySet<string> = new Set([
  'metadata.google.internal',
  'metadata.azure.com',
  // Alibaba Cloud / Oracle Cloud.
  '100.100.100.200'
]);

export function classifyNonRoutableHostname(host: string): NonRoutableHostnameKind | null {
  const lower = host.toLowerCase();
  if (METADATA_HOSTNAMES.has(lower)) return 'metadata';
  // `.localhost` is reserved for loopback by RFC 6761.
  if (LOOPBACK_HOSTNAMES.has(lower) || lower.endsWith('.localhost')) return 'loopback';
  if (lower.endsWith('.local')) return 'mdns-local';
  if (lower.endsWith('.internal')) return 'internal-tld';
  return null;
}
