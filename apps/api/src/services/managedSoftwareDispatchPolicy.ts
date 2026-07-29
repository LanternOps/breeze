/**
 * Managed software dispatch gate (Wave 6 Task 5, security remediation)
 *
 * Every managed-software command carries the device's effective
 * `downloadPolicy` (org ∪ site approved private origins) so the agent's
 * dial-time policy can decide whether a private destination is reachable.
 * An agent that predates Wave 6 has NO such policy: it will happily follow a
 * download URL to a LAN host, a cloud metadata endpoint, or a public hostname
 * that resolves/redirects private. This module decides, per device, whether a
 * managed-software command may be enqueued at all.
 *
 * The agent's dial-time enforcement (agent/internal/netpolicy) is the
 * AUTHORITATIVE defense. What lives here is defense in depth plus a
 * capability gate — it must never be read as a substitute, and it deliberately
 * does not re-implement the agent's classification (no DNS, no redirect
 * following: the API cannot see either).
 *
 * Modes (approved deviation D1 of the wave plan):
 *
 *   compat (DEFAULT, and what any unset/unrecognized value means)
 *     A destination that is private — an IP literal in a private/unsafe range,
 *     a loopback-ish name, or an origin the operator themselves declared as an
 *     approved PRIVATE software origin — requires capability >= 1 and fails
 *     closed. An apparently-public destination is still permitted to a
 *     capability-0 device, so a fleet that has not yet upgraded keeps working.
 *
 *   enforce
 *     Every managed-software command requires capability >= 1, public
 *     destinations included. This closes the residual capability-0 exposure
 *     (DNS rebinding, public-to-private redirect) that compat leaves to the
 *     agent, and is the end state once the fleet has upgraded.
 *
 * Task 9 owns the operational side of MANAGED_SOFTWARE_POLICY_MODE (boot-time
 * validation, .env.example, compose mappings, runbook). This module only reads
 * it, and reads it in exactly one place.
 */

/**
 * The single bounded failure reason recorded on a denied device's deployment
 * result. Bounded (a fixed token, never interpolated with a URL/host) because
 * it is persisted, logged, and surfaced in the UI.
 */
export const AGENT_NETWORK_POLICY_UPGRADE_REQUIRED = 'agent_network_policy_upgrade_required';

export type ManagedSoftwarePolicyMode = 'compat' | 'enforce';

/**
 * Reads the dispatch mode. Anything other than the exact string `enforce`
 * (unset, empty, misspelled, wrong case handled by normalization) is compat —
 * a misconfiguration must never silently switch the fleet into the stricter
 * mode and take software deployment down.
 */
export function getManagedSoftwarePolicyMode(): ManagedSoftwarePolicyMode {
  return process.env.MANAGED_SOFTWARE_POLICY_MODE?.trim().toLowerCase() === 'enforce'
    ? 'enforce'
    : 'compat';
}

// ---------------------------------------------------------------------------
// Destination classification
//
// Mirrors the private/forbidden split in agent/internal/netpolicy/address.go
// and packages/shared/src/validators/softwareDownloadPolicy.ts, kept local
// (rather than imported) because neither exposes the "is this destination
// private?" question this gate asks: the shared validator classifies what an
// operator may APPROVE (forbidden vs. approvable), while this classifies what
// a URL is AIMED at (public vs. everything else).
// ---------------------------------------------------------------------------

const NON_PUBLIC_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  'metadata.google.internal',
]);

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIPv4(host: string): [number, number, number, number] | null {
  const m = IPV4_PATTERN.exec(host);
  if (!m) return null;
  const octets = [m[1]!, m[2]!, m[3]!, m[4]!].map(Number);
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
  return octets as [number, number, number, number];
}

/**
 * True only for addresses that are global-unicast and not private/reserved —
 * the same positive test the Go classifier uses (`IsGlobalUnicast() &&
 * !IsPrivate()` plus the reserved-prefix table), so RFC1918, CGNAT, loopback,
 * link-local, multicast and the IETF-reserved ranges all classify non-public.
 */
function isPublicIPv4([a, b, c]: [number, number, number, number]): boolean {
  if (a === 0) return false; // 0.0.0.0/8
  if (a === 10) return false; // RFC1918
  if (a === 127) return false; // loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return false; // link-local incl. metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC1918
  if (a === 192 && b === 168) return false; // RFC1918
  if (a === 192 && b === 0 && c === 0) return false; // 192.0.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return false; // 198.18.0.0/15
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** Parses IPv6 host text (brackets already stripped) into 16 bytes. */
function parseIPv6(host: string): number[] | null {
  if (host === '' || host.includes('%')) return null;

  // A trailing dotted-quad (::ffff:10.0.0.1) is expanded into two groups first.
  let text = host;
  const lastColon = text.lastIndexOf(':');
  const tailText = lastColon === -1 ? '' : text.slice(lastColon + 1);
  if (tailText.includes('.')) {
    const v4 = parseIPv4(tailText);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  let head = text;
  let tail = '';
  let hasDoubleColon = false;
  const dc = text.indexOf('::');
  if (dc !== -1) {
    if (text.indexOf('::', dc + 1) !== -1) return null;
    hasDoubleColon = true;
    head = text.slice(0, dc);
    tail = text.slice(dc + 2);
  }
  const headParts = head === '' ? [] : head.split(':');
  const tailParts = tail === '' ? [] : tail.split(':');
  const total = headParts.length + tailParts.length;
  if (hasDoubleColon ? total > 8 : total !== 8) return null;
  const groups = [
    ...headParts,
    ...Array<string>(hasDoubleColon ? 8 - total : 0).fill('0'),
    ...tailParts,
  ];
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return bytes;
}

/**
 * Extracts the IPv4 address carried inside an IPv6 transition encoding —
 * IPv4-mapped/compatible/translated, 6to4, Teredo and NAT64 — so a private
 * destination cannot be smuggled past this gate in its IPv6 spelling. Mirrors
 * embeddedIPv4 in agent/internal/netpolicy/address.go.
 */
function embeddedIPv4(bytes: number[]): [number, number, number, number] | null {
  const quad = (): [number, number, number, number] => [
    bytes[12]!,
    bytes[13]!,
    bytes[14]!,
    bytes[15]!,
  ];
  // ::ffff:a.b.c.d (mapped) and ::/96 (compatible) and ::ffff:0:a.b.c.d (translated)
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return quad();
  if (bytes.slice(0, 8).every((b) => b === 0) && bytes[8] === 0xff && bytes[9] === 0xff && bytes[10] === 0 && bytes[11] === 0) return quad();
  if (bytes.slice(0, 12).every((b) => b === 0)) return quad();
  // 2002::/16 (6to4)
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return [bytes[2]!, bytes[3]!, bytes[4]!, bytes[5]!];
  // 2001::/32 (Teredo) — embedded v4 is the bitwise NOT of the last two groups
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0 && bytes[3] === 0) {
    return [~bytes[12]! & 0xff, ~bytes[13]! & 0xff, ~bytes[14]! & 0xff, ~bytes[15]! & 0xff];
  }
  // 64:ff9b::/96 (NAT64 well-known prefix)
  if (
    bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((b) => b === 0)
  ) {
    return quad();
  }
  return null;
}

function isPublicIPv6(bytes: number[]): boolean {
  if (bytes.every((b) => b === 0)) return false; // ::
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return false; // ::1
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return false; // fe80::/10 link-local
  if ((bytes[0]! & 0xfe) === 0xfc) return false; // fc00::/7 ULA
  if (bytes[0] === 0xff) return false; // ff00::/8 multicast

  const embedded = embeddedIPv4(bytes);
  if (embedded) return isPublicIPv4(embedded);
  return true;
}

function stripTrailingDots(host: string): string {
  let end = host.length;
  while (end > 0 && host[end - 1] === '.') end--;
  return host.slice(0, end);
}

/**
 * The origin of `url` in the same spelling the shared policy validator
 * produces (lowercase host, default port omitted, no trailing slash), so a
 * destination can be compared against the stored allowlist entries.
 */
function originOf(url: URL): string {
  const host = url.hostname.toLowerCase();
  return url.port === ''
    ? `${url.protocol}//${host}`
    : `${url.protocol}//${host}:${url.port}`;
}

/**
 * Whether a managed-software destination must be treated as PRIVATE, i.e. as a
 * destination only a capability-1 agent may be handed.
 *
 * A destination is private when:
 *   - the URL does not parse or carries no host (fails closed — such a URL
 *     could never have completed a download anyway);
 *   - its host is an IP literal outside the public global-unicast space,
 *     including every IPv6 transition spelling of such an address;
 *   - its host is a loopback-ish or metadata name; or
 *   - its ORIGIN is one the operator themselves listed as an approved private
 *     software origin. This is what catches `https://files.corp.internal` —
 *     a name the API cannot resolve, but which the tenant has already
 *     declared to be private.
 *
 * Everything else is "apparently public". The API cannot resolve DNS or
 * follow redirects, so an apparently-public name that pivots private is
 * caught by the agent's dial-time policy (capability-1) or by `enforce` mode
 * (capability-0) — never by this function.
 */
export function isPrivateSoftwareDestination(
  downloadUrl: string,
  approvedPrivateOrigins: readonly string[] = [],
): boolean {
  let url: URL;
  try {
    url = new URL(downloadUrl.trim());
  } catch {
    return true;
  }

  const rawHost = url.hostname.toLowerCase();
  if (rawHost === '') return true;

  const isBracketedV6 = rawHost.startsWith('[') && rawHost.endsWith(']');
  const host = isBracketedV6 ? rawHost.slice(1, -1) : stripTrailingDots(rawHost);
  if (host === '') return true;

  if (isBracketedV6) {
    const bytes = parseIPv6(host);
    // Unparseable literal: fail closed rather than fall through to the
    // hostname branch, where it would classify "public".
    return bytes === null ? true : !isPublicIPv6(bytes);
  }

  const v4 = parseIPv4(host);
  if (v4) return !isPublicIPv4(v4);

  if (NON_PUBLIC_HOSTNAMES.has(host) || host.endsWith('.localhost')) return true;

  const origin = originOf(url);
  return approvedPrivateOrigins.some((approved) => approved.trim().toLowerCase() === origin);
}

export interface ManagedSoftwareDispatchInput {
  /** The exact URL that would be sent to the agent (post variable substitution). */
  downloadUrl: string;
  /** The device's effective org ∪ site approved private origins. */
  approvedPrivateOrigins: readonly string[];
  /** `devices.outbound_network_policy_version`; anything below 1 is "no policy". */
  outboundNetworkPolicyVersion: number | null | undefined;
  /** Defaults to the process mode; passed explicitly so a batch reads env once. */
  mode?: ManagedSoftwarePolicyMode;
}

export type ManagedSoftwareDispatchDecision =
  | { allowed: true }
  | { allowed: false; reason: typeof AGENT_NETWORK_POLICY_UPGRADE_REQUIRED };

/**
 * The dispatch decision for ONE device. Callers must apply it BEFORE
 * sendCommandToAgent: a denied device gets a failed deployment result carrying
 * `reason` and no enqueued command.
 */
export function evaluateManagedSoftwareDispatch(
  input: ManagedSoftwareDispatchInput,
): ManagedSoftwareDispatchDecision {
  const capable = (input.outboundNetworkPolicyVersion ?? 0) >= 1;
  if (capable) return { allowed: true };

  const mode = input.mode ?? getManagedSoftwarePolicyMode();
  if (mode === 'enforce') {
    return { allowed: false, reason: AGENT_NETWORK_POLICY_UPGRADE_REQUIRED };
  }

  return isPrivateSoftwareDestination(input.downloadUrl, input.approvedPrivateOrigins)
    ? { allowed: false, reason: AGENT_NETWORK_POLICY_UPGRADE_REQUIRED }
    : { allowed: true };
}
