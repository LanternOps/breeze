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
  isCarrierNatAddress,
  isIpLiteralHost,
  isRfc1918OrUla,
  type NonRoutableHostnameKind
} from './ipRanges';

export type SsrfMode = 'strict-https' | 'on-prem-http' | 'on-prem-strict';

export interface SsrfGuardOptions {
  mode: SsrfMode;
  /** Optional hostname allowlist suffix (e.g. ['.sentinelone.net']). When set, hostname must end with one of these. */
  hostnameAllowlist?: readonly string[];
  /**
   * Permit a carrier-grade-NAT (100.64.0.0/10) target — the range an overlay
   * network such as Tailscale assigns. Only honoured in `on-prem-http` mode
   * (which is itself self-host-only), so it cannot widen validation on the
   * hosted platform. Default off; the connect-time `safeFetch` must be given the
   * matching `allowCarrierNat` for the endpoint to actually be reachable.
   */
  allowCarrierNat?: boolean;
}

// Hostname categories (from the shared table in `ipRanges.ts`) that this
// config-time check refuses, in every mode. Kept to exactly the two the guard
// refused before this consolidation — loopback aliases and instance-metadata
// names — so no integration that used to validate stops validating. Notably
// NOT included: the `.local` / `.internal` naming suffixes. A self-hosted PSA
// or appliance legitimately lives on a corporate `.internal`/`.local` domain,
// the guard never rejected those, and the connect-time policy still classifies
// whatever such a name resolves to. (`webhookSender.ts` keeps its own,
// longer-standing `.local` rejection for webhook targets; that is a
// webhook-specific rule, not this guard's.)
const REFUSED_HOSTNAME_KINDS: readonly NonRoutableHostnameKind[] = ['loopback', 'metadata'];

const HOSTNAME_KIND_REASON: Partial<Record<NonRoutableHostnameKind, string>> = {
  loopback: 'a loopback alias',
  metadata: 'an instance-metadata endpoint'
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
  if (hostnameKind !== null && REFUSED_HOSTNAME_KINDS.includes(hostnameKind)) {
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
      // With the explicit carrier-NAT opt-in, a plain CGNAT (Tailscale) address
      // is additionally permitted in on-prem-http mode.
      const allowedHere =
        opts.mode === 'on-prem-http' &&
        (isRfc1918OrUla(literal) || (opts.allowCarrierNat === true && isCarrierNatAddress(literal)));
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
