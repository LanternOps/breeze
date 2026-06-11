// Block tenant-controlled URLs from reaching internal/metadata addresses.
//
// Tenants can configure external integrations (DNS providers, SentinelOne)
// with their own API endpoints. Without validation, a partner-scope user
// could point an integration at http://169.254.169.254/ (cloud metadata)
// or other internal services and exfiltrate via stored response bodies.
//
// Three modes:
//   - 'strict-https'  — require HTTPS; reject loopback/link-local/private/
//                       metadata hosts. For cloud-only vendors like
//                       SentinelOne and DNSFilter.
//   - 'on-prem-http'  — allow HTTP (some on-prem appliances ship http-only
//                       admin interfaces); still reject loopback/link-local/
//                       metadata. RFC1918 allowed by default; can be locked
//                       down further in hosted-saas mode.
//   - 'on-prem-strict'— same as on-prem-http but reject RFC1918 too. Used
//                       when the API host is hosted SaaS and an on-prem
//                       address can't possibly be reachable from us anyway.

import { isIP } from 'node:net';

export type SsrfMode = 'strict-https' | 'on-prem-http' | 'on-prem-strict';

export interface SsrfGuardOptions {
  mode: SsrfMode;
  /** Optional hostname allowlist suffix (e.g. ['.sentinelone.net']). When set, hostname must end with one of these. */
  hostnameAllowlist?: readonly string[];
}

const METADATA_HOSTS = new Set([
  // AWS / OpenStack / DigitalOcean (alternate)
  '169.254.169.254',
  '169.254.170.2',
  // Alibaba / Oracle Cloud
  '100.100.100.200',
  // GCP / Azure (resolve to 169.254 but tenants may try direct names)
  'metadata.google.internal',
  'metadata.azure.com',
]);

const LOOPBACK_HOSTNAMES = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
]);

function isLoopbackIp(addr: string): boolean {
  // IPv4 loopback: 127.0.0.0/8
  if (addr.startsWith('127.')) return true;
  // IPv6 loopback ::1 and various textual forms
  if (addr === '::1' || addr === '0:0:0:0:0:0:0:1') return true;
  // IPv4-mapped IPv6 loopback ::ffff:127.0.0.1 (and Node-normalized ::ffff:7f00:0/24)
  if (/^::ffff:127\./i.test(addr)) return true;
  if (/^::ffff:7f[0-9a-f]{2}:/i.test(addr)) return true;
  return false;
}

function isLinkLocalIp(addr: string): boolean {
  // IPv4 link-local 169.254.0.0/16
  if (addr.startsWith('169.254.')) return true;
  // IPv6 link-local fe80::/10
  if (/^fe[89ab][0-9a-f]?:/i.test(addr)) return true;
  return false;
}

function isPrivateIp(addr: string): boolean {
  // IPv4 private: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10 (CGNAT)
  if (addr.startsWith('10.')) return true;
  if (addr.startsWith('192.168.')) return true;
  const m172 = addr.match(/^172\.(\d+)\./);
  if (m172) {
    const o = Number(m172[1]);
    if (o >= 16 && o <= 31) return true;
  }
  const m100 = addr.match(/^100\.(\d+)\./);
  if (m100) {
    const o = Number(m100[1]);
    if (o >= 64 && o <= 127) return true;
  }
  // IPv6 unique-local fc00::/7
  if (/^f[cd][0-9a-f]{2}:/i.test(addr)) return true;
  // IPv4-mapped IPv6 private (textual form)
  if (/^::ffff:(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/i.test(addr)) return true;
  // IPv4-mapped IPv6 private (Node-normalized hex form)
  if (/^::ffff:0a[0-9a-f]{2}:/i.test(addr)) return true; // 10.0.0.0/8 -> ::ffff:0a__:__
  if (/^::ffff:c0a8:/i.test(addr)) return true; // 192.168.0.0/16 -> ::ffff:c0a8:____
  if (/^::ffff:ac1[0-9a-f]:/i.test(addr)) return true; // 172.16.0.0/12 -> ::ffff:ac10-ac1f:__
  return false;
}

function isUnspecifiedIp(addr: string): boolean {
  if (addr === '0.0.0.0') return true;
  if (addr === '::' || addr === '0:0:0:0:0:0:0:0') return true;
  return false;
}

export interface SsrfGuardResult {
  ok: boolean;
  reason?: string;
}

/**
 * Validate that a tenant-supplied URL is safe to reach from inside the API.
 *
 * This is a STATIC check on the URL string. It does NOT resolve DNS — a
 * sufficiently motivated attacker can still bind a public hostname to an
 * internal IP (DNS rebinding) or use an HTTP redirect to bounce to one.
 * We accept that limitation here: a future hardening pass should add
 * pre-fetch DNS resolution + same-host re-validation in the HTTP client.
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

  if (LOOPBACK_HOSTNAMES.has(hostnameLower)) {
    return { ok: false, reason: `hostname ${hostnameLower} is a loopback alias` };
  }

  if (METADATA_HOSTS.has(hostnameLower)) {
    return { ok: false, reason: `hostname ${hostnameLower} is a cloud-metadata address` };
  }

  if (isIP(hostnameLower) > 0) {
    if (isLoopbackIp(hostnameLower)) {
      return { ok: false, reason: `hostname ${hostnameLower} is a loopback IP` };
    }
    if (isLinkLocalIp(hostnameLower)) {
      return { ok: false, reason: `hostname ${hostnameLower} is a link-local IP (cloud metadata range)` };
    }
    if (isUnspecifiedIp(hostnameLower)) {
      return { ok: false, reason: `hostname ${hostnameLower} is the unspecified address` };
    }
    if (opts.mode === 'strict-https' || opts.mode === 'on-prem-strict') {
      if (isPrivateIp(hostnameLower)) {
        return { ok: false, reason: `hostname ${hostnameLower} is a private/RFC1918 IP` };
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
