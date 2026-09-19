// Validate tenant-supplied integration URLs before they are stored.
//
// Tenants can configure external integrations (DNS providers, SentinelOne,
// distributor APIs) with their own API endpoints. This module is the
// config-time check that gives the user an actionable error at save time,
// rather than an opaque socket failure on the first sync.
//
// Three modes:
//   - 'strict-https'  — require HTTPS; reject every non-routable range. For
//                       cloud-only vendors like SentinelOne and DNSFilter.
//   - 'on-prem-http'  — allow HTTP (some on-prem appliances ship http-only
//                       admin interfaces) and allow RFC1918/ULA appliance
//                       addresses; every other non-routable range stays
//                       rejected. Note this now includes CGNAT (100.64/10),
//                       which this check used to accept in this mode while the
//                       connect-time policy refused it — the endpoint saved and
//                       then failed on first sync. The two now agree.
//   - 'on-prem-strict'— same as on-prem-http but reject RFC1918/ULA too. Used
//                       when the API host is hosted SaaS and an on-prem
//                       address can't possibly be reachable from us anyway.
//
// The address ranges themselves are NOT defined here. They live in exactly one
// table, in `ipRanges.ts`, which is also what `urlSafety.ts` classifies through
// when it resolves and pins an address at connect time (`safeFetch` /
// `createGuardedLookup`). This module classifies through that same table, so a
// config-time verdict and a connect-time verdict cannot disagree — each
// previously carried its own hand-rolled prefix matchers, and the two lists had
// drifted apart in both directions.

import {
  BLOCKED_IP_CATEGORY_LABEL,
  canonicalIpLiteral,
  classifyBlockedIp,
  classifyNonRoutableHostname,
  isIpLiteralHost,
  isRfc1918OrUla,
  type NonRoutableHostnameKind
} from './ipRanges';

export type SsrfMode = 'strict-https' | 'on-prem-http' | 'on-prem-strict';

export interface SsrfGuardOptions {
  mode: SsrfMode;
  /** Optional hostname allowlist suffix (e.g. ['.sentinelone.net']). When set, hostname must end with one of these. */
  hostnameAllowlist?: readonly string[];
}

// Hostname categories (from the shared table in `ipRanges.ts`) that each mode
// refuses. 'loopback' and 'metadata' are never legitimate. The local-network
// naming suffixes are refused only in 'strict-https' mode, where the endpoint
// belongs to a cloud-only vendor and a LAN name cannot be right; the on-prem
// modes exist precisely to reach appliances that may carry one.
const REFUSED_HOSTNAME_KINDS: Record<SsrfMode, readonly NonRoutableHostnameKind[]> = {
  'strict-https': ['loopback', 'metadata', 'mdns-local', 'internal-tld'],
  'on-prem-http': ['loopback', 'metadata'],
  'on-prem-strict': ['loopback', 'metadata']
};

const HOSTNAME_KIND_REASON: Record<NonRoutableHostnameKind, string> = {
  loopback: 'a loopback alias',
  metadata: 'an instance-metadata endpoint',
  'mdns-local': 'a local-network-only name',
  'internal-tld': 'a local-network-only name'
};

export interface SsrfGuardResult {
  ok: boolean;
  reason?: string;
}

/**
 * Validate that a tenant-supplied URL is safe to store and later fetch.
 *
 * This is a synchronous check on the URL string: it performs no DNS work, so a
 * hostname that resolves into a blocked range is not caught here. That is
 * deliberate — resolution belongs at connect time, where `urlSafety.safeFetch`
 * and `createGuardedLookup` resolve once and pin the validated address for the
 * socket, leaving no window between the check and the connection. Every
 * integration whose endpoint is validated here dials through one of those, so a
 * hostname pointing into a blocked range is refused at request time against
 * this same range table.
 */
export function checkSsrfSafe(rawUrl: string, opts: SsrfGuardOptions): SsrfGuardResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'URL is malformed' };
  }

  if (opts.mode === 'strict-https' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'URL must use https://' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `URL protocol ${parsed.protocol} is not allowed (must be http or https)` };
  }

  // Strip IPv6 brackets if present.
  const hostnameLower = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostnameLower) {
    return { ok: false, reason: 'URL has no hostname' };
  }

  const hostnameKind = classifyNonRoutableHostname(hostnameLower);
  if (hostnameKind !== null && REFUSED_HOSTNAME_KINDS[opts.mode].includes(hostnameKind)) {
    return { ok: false, reason: `hostname ${hostnameLower} is ${HOSTNAME_KIND_REASON[hostnameKind]}` };
  }

  if (isIpLiteralHost(hostnameLower)) {
    const literal = canonicalIpLiteral(hostnameLower);
    const category = classifyBlockedIp(literal);
    if (category !== null) {
      // A plain RFC1918/ULA appliance address is the one thing an on-prem
      // integration may reach; everything else is blocked in every mode. Gated
      // on `isRfc1918OrUla` rather than the category, because an IPv6 transition
      // prefix carrying an embedded RFC1918 address (`64:ff9b::10.0.0.5`) is
      // categorised 'private' by destination but is not an appliance address.
      const allowedHere = opts.mode === 'on-prem-http' && isRfc1918OrUla(literal);
      if (!allowedHere) {
        const shown = literal === hostnameLower ? hostnameLower : `${hostnameLower} (${literal})`;
        return {
          ok: false,
          reason: `hostname ${shown} is a ${BLOCKED_IP_CATEGORY_LABEL[category]} address`
        };
      }
    }
  }

  if (opts.hostnameAllowlist && opts.hostnameAllowlist.length > 0) {
    const ok = opts.hostnameAllowlist.some((suffix) => hostnameLower.endsWith(suffix.toLowerCase()));
    if (!ok) {
      return { ok: false, reason: `hostname must end with one of: ${opts.hostnameAllowlist.join(', ')}` };
    }
  }

  return { ok: true };
}

/**
 * Zod `.refine` compatible predicate that throws nothing; returns boolean.
 * Use checkSsrfSafe() directly if you need the rejection reason.
 */
export function isSsrfSafe(rawUrl: string, opts: SsrfGuardOptions): boolean {
  return checkSsrfSafe(rawUrl, opts).ok;
}
