import { z } from 'zod';

// ============================================
// Private Software Download Origin Policy (Wave 6 Task 4, security remediation)
// ============================================
//
// Task 1-3 hardened the Go agent (agent/internal/netpolicy) to refuse to dial
// loopback/link-local/metadata/CGNAT/reserved destinations outright, and to
// refuse RFC1918/ULA private destinations UNLESS the exact request origin is
// an approved private origin. This file is the server-side counterpart: the
// Zod shape + normalizer for the per-org/per-site allowlist of approved
// private origins that Task 5 will hand to the agent alongside managed-
// software commands.
//
// The validation rules here MUST reject everything the Go classifier would
// refuse to dial (loopback, link-local, unspecified, multicast, metadata,
// and the IETF-reserved ranges in agent/internal/netpolicy/address.go's
// reservedForbiddenPrefixes) — divergence would let an operator save a
// policy that silently never works. RFC1918 / ULA / CGNAT addresses are
// deliberately NOT forbidden here: those are exactly the private ranges this
// allowlist exists to approve (Go's classPrivate, gated on exact-origin
// match rather than banned outright).
//
// Unlike the general netpolicy origin parser (which accepts http:// for a
// configured control-plane origin), THIS schema is HTTPS-only per the task
// brief: an approved private software-download origin must be an exact
// HTTPS origin with hostname and optional port, no path other than "/", no
// query, no fragment, no userinfo, no wildcard, and no IP literal in the
// universally unsafe classes.
//
// Normalization note: the WHATWG URL parser (`new URL(...)`) that this
// module relies on already canonicalizes IPv4 host text (hex/octal/decimal/
// short-form shorthand all resolve to canonical dotted-quad) and IPv6 host
// text (lowercase, RFC 5952-style "::" compression, embedded IPv4-mapped
// forms rendered in hex) BEFORE this module inspects `url.hostname`. That
// means an obfuscated encoding of a forbidden address (e.g. the decimal
// form of 127.0.0.1) still resolves to its canonical text and is still
// correctly rejected by the forbidden-range check below — the parser's
// leniency here is permissive-but-safe, not permissive-and-unsafe.
//
// This does NOT mean the origin stored here is the canonical form Go's own
// `originFromURL` would produce: Go always renders an explicit port
// (`https://files.corp.internal:443`), while this module omits the default
// port. Do not string-compare a value stored here against a Go-normalized
// origin — the agent's own `netpolicy.NewClient` -> `newOriginSet` path
// re-normalizes every configured origin on ingest (Task 5), so the two
// representations round-trip correctly through THAT path without matching
// byte-for-byte.

// Metadata endpoints that must never be approved as software-download
// origins, mirroring agent/internal/netpolicy/address.go's
// metadataAddresses list. 169.254.169.254 and 169.254.170.2 are already
// caught by the general 169.254.0.0/16 link-local rule below; listed here
// too so the deny set survives any future change to that rule, exactly as
// the Go comment explains. 100.100.100.200 (Alibaba) sits inside the
// otherwise-allowed 100.64.0.0/10 CGNAT range and needs its own carve-out.
const FORBIDDEN_METADATA_IPV4: ReadonlySet<string> = new Set([
  '169.254.169.254',
  '169.254.170.2',
  '100.100.100.200',
]);

// Hostnames that must never be dialed regardless of what they resolve to —
// mirrors agent/internal/netpolicy/address.go's forbiddenHostnames map.
const FORBIDDEN_HOSTNAMES: ReadonlySet<string> = new Set(['metadata.google.internal']);

const MAX_ORIGIN_LENGTH = 2048;

/**
 * Strips the trailing dot(s) of a fully-qualified host. A trailing dot names
 * the same host to every resolver, and the Go classifier trims it too
 * (agent/internal/netpolicy/address.go's normalizeHostname), so any policy
 * decision keyed on host text MUST normalize it away first — comparing raw
 * host text against a normalized allowlist is a bypass.
 */
export function stripTrailingHostDots(host: string): string {
  let end = host.length;
  while (end > 0 && host[end - 1] === '.') end--;
  return host.slice(0, end);
}

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Parses a canonical dotted-quad string into its four octets. Only called on
 * host text already produced by the WHATWG URL host parser, which has
 * already resolved hex/octal/decimal/short-form IPv4 shorthand into this
 * canonical form — so no leading-zero/ambiguous-encoding handling is needed
 * here (unlike agent/internal/netpolicy's checkHostShape, which sees raw
 * operator-typed text and must reject those forms outright).
 */
export function parseIPv4Host(host: string): [number, number, number, number] | null {
  const m = IPV4_PATTERN.exec(host);
  if (!m) return null;
  const octets = [m[1]!, m[2]!, m[3]!, m[4]!].map((part) => Number(part));
  if (octets.some((octet) => octet < 0 || octet > 255)) return null;
  return octets as [number, number, number, number];
}

/**
 * Classifies a parsed IPv4 address as universally unsafe, mirroring the
 * union of `!IsGlobalUnicast()`, `metadataAddresses`, and
 * `reservedForbiddenPrefixes` from agent/internal/netpolicy/address.go.
 * RFC1918 (10/8, 172.16/12, 192.168/16) and CGNAT (100.64.0.0/10, apart
 * from the metadata carve-out) are deliberately NOT forbidden — those are
 * classPrivate on the Go side, exactly what this allowlist exists to approve.
 */
function isForbiddenIPv4([a, b, c, d]: [number, number, number, number]): boolean {
  if (FORBIDDEN_METADATA_IPV4.has(`${a}.${b}.${c}.${d}`)) return true;
  if (a === 0) return true; // 0.0.0.0/8 — "this network"
  if (a === 127) return true; // 127.0.0.0/8 — loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 — link-local (incl. metadata)
  if (a >= 224 && a <= 239) return true; // 224.0.0.0/4 — multicast
  if (a >= 240) return true; // 240.0.0.0/4 — reserved, incl. 255.255.255.255
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 — IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 — benchmarking
  return false;
}

/**
 * Parses IPv6 host text (bracket-stripped, as produced by the WHATWG URL
 * host parser) into 16 bytes. Deliberately lenient about compressed vs.
 * fully-expanded text — the parser output is always already-canonical, but
 * being forgiving here costs nothing since forbidden-range classification
 * runs on the parsed BYTES, not the text form.
 */
export function parseIPv6Host(host: string): number[] | null {
  if (host === '' || host.includes('%')) return null;
  let head = host;
  let tail = '';
  let hasDoubleColon = false;
  const dcIndex = host.indexOf('::');
  if (dcIndex !== -1) {
    if (host.indexOf('::', dcIndex + 1) !== -1) return null; // more than one '::'
    hasDoubleColon = true;
    head = host.slice(0, dcIndex);
    tail = host.slice(dcIndex + 2);
  }
  const headParts = head === '' ? [] : head.split(':');
  const tailParts = tail === '' ? [] : tail.split(':');
  const total = headParts.length + tailParts.length;
  if (hasDoubleColon ? total > 8 : total !== 8) return null;
  const zerosNeeded = hasDoubleColon ? 8 - total : 0;
  const allGroups = [...headParts, ...Array(zerosNeeded).fill('0'), ...tailParts];
  if (allGroups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of allGroups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    const value = parseInt(group, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes;
}

/**
 * Extracts the IPv4 address carried inside an IPv6 transition encoding, if
 * any, mirroring agent/internal/netpolicy/address.go's embeddedIPv4. An
 * attacker (or an operator copy-pasting a "clever" address) who can't get a
 * raw forbidden literal past this validator could otherwise wrap the same
 * destination in 6to4, Teredo, NAT64, or one of the two IPv4-in-IPv6
 * historical forms. IPv4-mapped (::ffff:a.b.c.d) is handled by the caller
 * (isV4Mapped in isForbiddenIPv6) and deliberately not repeated here.
 */
export function embeddedTransitionIPv4(bytes: number[]): [number, number, number, number] | null {
  // 6to4 (RFC 3056): 2002::/16 — embedded v4 is the next two groups.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return [bytes[2]!, bytes[3]!, bytes[4]!, bytes[5]!];
  }
  // Teredo (RFC 4380): 2001::/32 — embedded v4 is the bitwise NOT of the
  // last two groups.
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0 && bytes[3] === 0) {
    return [
      (~bytes[12]! & 0xff),
      (~bytes[13]! & 0xff),
      (~bytes[14]! & 0xff),
      (~bytes[15]! & 0xff),
    ];
  }
  // NAT64 well-known prefix (RFC 6052): 64:ff9b::/96 — embedded v4 is the
  // last two groups.
  if (
    bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((b) => b === 0)
  ) {
    return [bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!];
  }
  // IPv4-translated (RFC 6145): ::ffff:0:0:0/96 — embedded v4 is the last
  // two groups. Distinguished from IPv4-mapped by the 0xffff marker sitting
  // one group EARLIER (group 4, not group 5).
  if (
    bytes.slice(0, 8).every((b) => b === 0) &&
    bytes[8] === 0xff && bytes[9] === 0xff &&
    bytes[10] === 0 && bytes[11] === 0
  ) {
    return [bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!];
  }
  // IPv4-compatible (RFC 4291, deprecated): ::/96 — embedded v4 is the last
  // two groups. Checked last since it is the broadest of these prefixes
  // (bytes[0..11] all zero); the unspecified/loopback checks in
  // isForbiddenIPv6 already ran before this function is reached, and the
  // IPv4-mapped check (bytes[10..11] == 0xff,0xff) is mutually exclusive
  // with "all zero".
  if (bytes.slice(0, 12).every((b) => b === 0)) {
    return [bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!];
  }
  return null;
}

/**
 * Classifies parsed IPv6 bytes as universally unsafe: unspecified (::),
 * loopback (::1), link-local (fe80::/10), multicast (ff00::/8), ANY
 * IPv4-mapped address (::ffff:0:0/96, regardless of the embedded payload),
 * or any transition encoding (6to4, Teredo, NAT64, IPv4-compatible,
 * IPv4-translated) whose embedded IPv4 is itself forbidden. ULA (fc00::/7)
 * is deliberately NOT forbidden — classPrivate on the Go side.
 *
 * IPv4-mapped is rejected UNCONDITIONALLY — not just when the embedded
 * payload is itself forbidden — to match
 * agent/internal/netpolicy/address.go's checkHostShape, which rejects EVERY
 * IPv4-mapped literal via `a.Is4In6()` regardless of payload
 * (ReasonAmbiguousIPEncoding), pinned by that package's own tests for both a
 * forbidden payload (::ffff:127.0.0.1) and a benign one (::ffff:8.8.8.8).
 * Go's own client construction (netpolicy.NewClient -> newOriginSet) returns
 * an error on the FIRST unparseable configured origin, so accepting a
 * validator-blessed IPv4-mapped origin here (e.g. https://[::ffff:10.0.0.5],
 * which IS a legitimate RFC1918 destination) would not merely fail to work —
 * it would fail agent policy-client construction outright for every device
 * receiving that policy. There is no loss of coverage: an operator who wants
 * to approve 10.0.0.5 writes https://10.0.0.5, not its IPv4-mapped IPv6
 * spelling.
 */
function isForbiddenIPv6(bytes: number[]): boolean {
  if (bytes.every((b) => b === 0)) return true; // ::
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true; // ::1
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true; // fe80::/10
  if (bytes[0] === 0xff) return true; // ff00::/8

  const isV4Mapped =
    bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (isV4Mapped) return true;

  const transitionEmbedded = embeddedTransitionIPv4(bytes);
  if (transitionEmbedded && isForbiddenIPv4(transitionEmbedded)) return true;

  return false;
}

/**
 * Whether a host that is NOT a parseable IP literal is nonetheless an attempt
 * at writing an IPv4 address — a partially-typed subnet (`192.168.1.x`,
 * `172.16.x.x`), or hex shorthand whose last label kept the WHATWG parser from
 * treating the whole thing as an address (`0xdead.beef`, `0x1.0x2.ba.be`).
 *
 * Byte-for-byte mirror of `isNumericLookingHost` in
 * agent/internal/netpolicy/address.go, INCLUDING the "hex letters only count
 * when a 0x marker is present" rule that keeps real names like `beef.cafe`
 * from being mistaken for shorthand.
 *
 * This is the load-bearing half of the accept-set parity contract. Without it
 * `https://192.168.1.x` — exactly how a tech writes a subnet — validates and
 * persists, and then every managed-software install for that org/site fails:
 * the agent's `netpolicy.NewClient` aborts on the FIRST unparseable origin,
 * so one bad allowlist row takes down public-CDN installs that needed no
 * allowlist entry at all. Pinned by the shared Go/TS fixture list in
 * `agent/internal/netpolicy/testdata/origin_accept_parity.json`.
 */
export function isNumericLookingHost(host: string): boolean {
  // Hex letters are only treated as part of a numeric host when the string
  // actually carries a "0x" marker, so real names like "beef.cafe" are not
  // mistaken for IPv4 shorthand.
  const hexMarker = host.includes('0x') || host.includes('0X');
  let hasDigit = false;
  for (const ch of host) {
    if (ch >= '0' && ch <= '9') {
      hasDigit = true;
    } else if (ch === '.' || ch === 'x' || ch === 'X') {
      // separator or the hex marker itself
    } else if (
      hexMarker &&
      ((ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F'))
    ) {
      // hex digit
    } else {
      return false;
    }
  }
  return hasDigit;
}

/**
 * Normalizes and validates a single approved-private-software-origin string.
 * Returns the canonical origin (no trailing slash, lowercase host, default
 * port omitted) or null when the input fails any rule.
 */
export function normalizePrivateSoftwareOrigin(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.length > MAX_ORIGIN_LENGTH) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.search !== '') return null;
  if (url.hash !== '') return null;
  if (url.pathname !== '' && url.pathname !== '/') return null;

  const rawHost = url.hostname;
  if (rawHost === '') return null;
  if (rawHost.includes('*')) return null; // no wildcard

  const isBracketedV6 = rawHost.startsWith('[') && rawHost.endsWith(']');
  const hostText = isBracketedV6
    ? rawHost.slice(1, -1)
    : stripTrailingHostDots(rawHost);
  if (hostText === '') return null;

  if (isBracketedV6) {
    const bytes = parseIPv6Host(hostText);
    if (!bytes) return null;
    if (isForbiddenIPv6(bytes)) return null;
  } else {
    const v4 = parseIPv4Host(hostText);
    if (v4) {
      if (isForbiddenIPv4(v4)) return null;
    } else {
      if (FORBIDDEN_HOSTNAMES.has(hostText)) return null;
      // Empty-label hostnames ("host..example", ".host") are not valid DNS
      // names and would otherwise be a trivial forbidden-hostname bypass
      // spelling (mirrors Go's checkHostShape).
      if (hostText.startsWith('.') || hostText.includes('..')) return null;
      // A host that failed IP parsing but is still an attempt at writing an
      // IPv4 address must be refused HERE, at the write, because the agent
      // refuses it at read: Go's checkHostShape returns
      // ambiguous_ip_encoding, parseOrigin collapses that to invalid_origin,
      // and netpolicy.NewClient fails on the FIRST such entry. See
      // isNumericLookingHost below for why this is not optional.
      if (isNumericLookingHost(hostText)) return null;
    }
  }

  const port = url.port;
  if (port !== '') {
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return null;
  }

  const hostForOutput = isBracketedV6 ? `[${hostText}]` : hostText;
  return port === '' ? `https://${hostForOutput}` : `https://${hostForOutput}:${port}`;
}

export const privateSoftwareOriginSchema = z.string().transform((value, ctx) => {
  const normalized = normalizePrivateSoftwareOrigin(value);
  if (normalized === null) {
    ctx.addIssue({
      code: 'custom',
      message:
        'Must be an exact HTTPS origin (hostname or IP literal, optional port) with no path other than "/", ' +
        'no query, fragment, userinfo, or wildcard, no partially-written or shorthand IP form ' +
        '(e.g. "192.168.1.x", "0x7f.0.0.1"), and no loopback/link-local/unspecified/multicast/metadata/' +
        'reserved IP literal.',
    });
    return z.NEVER;
  }
  return normalized;
});

export const softwareDownloadPolicySchema = z.object({
  version: z.literal(1),
  approvedPrivateOrigins: z.array(privateSoftwareOriginSchema).max(32),
}).strict();

export type SoftwareDownloadPolicy = z.infer<typeof softwareDownloadPolicySchema>;
