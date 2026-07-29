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

import {
  embeddedTransitionIPv4,
  parseIPv4Host,
  parseIPv6Host,
  stripTrailingHostDots,
} from '@breeze/shared/validators';

/**
 * The single bounded failure reason recorded on a denied device's deployment
 * result. Bounded (a fixed token, never interpolated with a URL/host) because
 * it is persisted, logged, and surfaced in the UI.
 */
export const AGENT_NETWORK_POLICY_UPGRADE_REQUIRED = 'agent_network_policy_upgrade_required';

/**
 * The second bounded failure reason: the destination's HOST is on the approved
 * private-origin allowlist but its full origin (scheme and/or port) is not, so
 * no agent — upgraded or not — will accept the dial. Distinct from the upgrade
 * reason because the remedy is different (fix the allowlist entry or the
 * package URL, not the agent version), and because the agent-side reason an
 * operator would otherwise see, `private_address_not_allowed`, reads as "the
 * allowlist is missing this host" when the host is in fact present.
 */
export const APPROVED_ORIGIN_SCHEME_OR_PORT_MISMATCH = 'approved_origin_scheme_or_port_mismatch';

export type ManagedSoftwareDispatchDenialReason =
  | typeof AGENT_NETWORK_POLICY_UPGRADE_REQUIRED
  | typeof APPROVED_ORIGIN_SCHEME_OR_PORT_MISMATCH;

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
// The host/IP PARSING primitives are imported from the shared policy validator
// (packages/shared/src/validators/softwareDownloadPolicy.ts) so there is one
// copy: a third re-implementation is how the trailing-dot bypass shipped in
// the first place. What stays local is the CLASSIFICATION, because the two
// modules ask different questions — the shared validator decides what an
// operator may APPROVE (forbidden vs. approvable, where RFC1918/ULA/CGNAT are
// approvable), while this decides what a URL is AIMED at (public vs.
// everything else, where those same ranges are private).
// ---------------------------------------------------------------------------

const NON_PUBLIC_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  'metadata.google.internal',
]);

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

function isPublicIPv6(bytes: number[]): boolean {
  if (bytes.every((b) => b === 0)) return false; // ::
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return false; // ::1
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return false; // fe80::/10 link-local
  if ((bytes[0]! & 0xfe) === 0xfc) return false; // fc00::/7 ULA
  if (bytes[0] === 0xff) return false; // ff00::/8 multicast

  // IPv4-mapped (::ffff:0:0/96) is checked here rather than in the shared
  // embeddedTransitionIPv4, which deliberately omits it because its caller
  // rejects every mapped literal outright. This gate cannot: a mapped PUBLIC
  // payload is a genuinely public destination, so it is classified by its
  // payload like every other transition encoding.
  const isV4Mapped =
    bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (isV4Mapped) {
    return isPublicIPv4([bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!]);
  }

  const embedded = embeddedTransitionIPv4(bytes);
  if (embedded) return isPublicIPv4(embedded);
  return true;
}

/**
 * The canonical comparison key for a host, used for BOTH sides of the
 * approved-origin check so no spelling difference can separate them:
 * lowercased, trailing dots stripped (a trailing dot names the same host to
 * every resolver, and the agent trims it too), and an IPv6 literal reduced to
 * its parsed bytes so two spellings of one address compare equal.
 *
 * Takes host text as produced by the WHATWG URL parser (`url.hostname`),
 * which has already canonicalized obfuscated IPv4 (decimal/octal/hex/short
 * form) and IPv6 (including dotted-quad tails) before this sees it.
 *
 * Deliberately keyed on the HOST only, not scheme+port: a host the operator
 * declared to be a private software source is private however it is reached.
 * Matching the full origin instead would let `http://files.corp.internal` or
 * `https://files.corp.internal:8080` slip past as "public" and be handed to a
 * capability-0 agent in compat mode. This can only ever over-classify a
 * destination as private, which costs a not-yet-upgraded device one dispatch
 * and never grants reachability to anything.
 */
function policyHostKey(rawHostname: string): string | null {
  const lowered = rawHostname.trim().toLowerCase();
  if (lowered === '') return null;

  if (lowered.startsWith('[') && lowered.endsWith(']')) {
    const bytes = parseIPv6Host(lowered.slice(1, -1));
    return bytes === null ? null : `[${bytes.join('.')}]`;
  }

  const host = stripTrailingHostDots(lowered);
  return host === '' ? null : host;
}

/**
 * The full-origin comparison key for a parsed URL: `scheme://hostkey:port`
 * with the scheme's default port filled in, mirroring the agent's
 * `netpolicy.originFromURL`. Used ONLY by the origin-mismatch diagnostic
 * below — never by the private/public classification, which is host-keyed on
 * purpose (see policyHostKey).
 */
function policyOriginKey(url: URL): string | null {
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return null;
  const hostKey = policyHostKey(url.hostname);
  if (hostKey === null) return null;
  const port = url.port === '' ? (scheme === 'https' ? '443' : '80') : url.port;
  return `${scheme}://${hostKey}:${port}`;
}

interface ApprovedKeys {
  /** Host-only keys — what the private/public classification matches on. */
  hosts: Set<string>;
  /** Full `scheme://host:port` keys — what the AGENT actually matches on. */
  origins: Set<string>;
}

/** The comparison keys of every allowlist entry that parses as a URL. */
function approvedKeys(approvedPrivateOrigins: readonly string[]): ApprovedKeys {
  const hosts = new Set<string>();
  const origins = new Set<string>();
  for (const raw of approvedPrivateOrigins) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    let url: URL;
    try {
      url = new URL(raw.trim());
    } catch {
      // Unstorable through the Zod schema; ignored rather than throwing so one
      // hand-edited settings row cannot 500 every deployment in the org.
      continue;
    }
    const key = policyHostKey(url.hostname);
    if (key !== null) hosts.add(key);
    const originKey = policyOriginKey(url);
    if (originKey !== null) origins.add(originKey);
  }
  return { hosts, origins };
}

/**
 * Whether the destination's HOST appears in the allowlist while its full
 * ORIGIN does not — i.e. the operator approved `https://files.corp.internal`
 * and the deployment points at `https://files.corp.internal:8443` (or
 * `http://…`). The agent matches the exact origin, so such a download is
 * refused at dial time with the bounded `private_address_not_allowed` while
 * the allowlist looks correct in the UI. Reporting this distinctly is the
 * whole point: the opaque agent-side reason sends operators looking for a
 * missing allowlist entry that is in fact present.
 *
 * Returns false when the host is not in the allowlist at all (nothing to
 * diagnose) and when the origin matches exactly (nothing wrong).
 */
export function approvedOriginSchemeOrPortMismatch(
  downloadUrl: string,
  approvedPrivateOrigins: readonly string[] = [],
): boolean {
  let url: URL;
  try {
    url = new URL(downloadUrl.trim());
  } catch {
    return false;
  }
  const hostKey = policyHostKey(url.hostname);
  if (hostKey === null) return false;

  const { hosts, origins } = approvedKeys(approvedPrivateOrigins);
  if (!hosts.has(hostKey)) return false;

  const originKey = policyOriginKey(url);
  // A non-http(s) destination can never match an approved origin; it is a
  // mismatch by construction, and saying so beats the opaque agent reason.
  if (originKey === null) return true;
  return !origins.has(originKey);
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
 *   - its HOST — not its full origin; the classifier is host-keyed, see
 *     policyHostKey — matches the host of an entry the operator themselves
 *     listed as an approved private software origin. This is what catches
 *     `https://files.corp.internal` — a name the API cannot resolve, but
 *     which the tenant has already declared to be private. Matching on the
 *     host alone deliberately over-classifies: `http://files.corp.internal`
 *     and `https://files.corp.internal:8080` are private here even though
 *     the agent would not accept either as an approved ORIGIN (which is what
 *     approvedOriginSchemeOrPortMismatch exists to report).
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

  if (rawHost.startsWith('[') && rawHost.endsWith(']')) {
    const bytes = parseIPv6Host(rawHost.slice(1, -1));
    // Unparseable literal: fail closed rather than fall through to the
    // hostname branch, where it would classify "public".
    return bytes === null ? true : !isPublicIPv6(bytes);
  }

  const host = stripTrailingHostDots(rawHost);
  if (host === '') return true;

  const v4 = parseIPv4Host(host);
  if (v4) return !isPublicIPv4(v4);

  if (NON_PUBLIC_HOSTNAMES.has(host) || host.endsWith('.localhost')) return true;

  const key = policyHostKey(host);
  return key !== null && approvedKeys(approvedPrivateOrigins).hosts.has(key);
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
  | { allowed: false; reason: ManagedSoftwareDispatchDenialReason };

/**
 * The dispatch decision for ONE device. Callers must apply it BEFORE
 * sendCommandToAgent: a denied device gets a failed deployment result carrying
 * `reason` and no enqueued command.
 *
 * A capability-1 device is always allowed through, origin mismatch included:
 * the API cannot resolve DNS, so an allowlisted host may still answer with a
 * public address and download fine. Denying it here would break working
 * deployments. The mismatch reason is therefore only ever substituted for a
 * denial that was already going to happen.
 */
export function evaluateManagedSoftwareDispatch(
  input: ManagedSoftwareDispatchInput,
): ManagedSoftwareDispatchDecision {
  const capable = (input.outboundNetworkPolicyVersion ?? 0) >= 1;
  if (capable) return { allowed: true };

  // Preferred over the upgrade reason wherever both apply: upgrading the agent
  // would not fix an origin mismatch, so reporting "upgrade required" sends
  // the operator down the wrong path.
  const denialReason = (): ManagedSoftwareDispatchDenialReason =>
    approvedOriginSchemeOrPortMismatch(input.downloadUrl, input.approvedPrivateOrigins)
      ? APPROVED_ORIGIN_SCHEME_OR_PORT_MISMATCH
      : AGENT_NETWORK_POLICY_UPGRADE_REQUIRED;

  const mode = input.mode ?? getManagedSoftwarePolicyMode();
  if (mode === 'enforce') {
    return { allowed: false, reason: denialReason() };
  }

  return isPrivateSoftwareDestination(input.downloadUrl, input.approvedPrivateOrigins)
    ? { allowed: false, reason: denialReason() }
    : { allowed: true };
}
