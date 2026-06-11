import type { RequestLike } from './auditEvents';
import { isIP } from 'net';
import { ipMatchesAny } from './ipMatch';

const TRUST_PROXY_AUTO = 'auto';

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function shouldTrustProxyHeaders(): boolean {
  const mode = (process.env.TRUST_PROXY_HEADERS ?? TRUST_PROXY_AUTO).trim().toLowerCase();
  if (mode === TRUST_PROXY_AUTO) {
    // Secure-by-default in production unless explicitly enabled.
    return process.env.NODE_ENV !== 'production';
  }

  return isTruthy(mode);
}

function trustedProxyCidrs(): string[] {
  const configured = (process.env.TRUSTED_PROXY_CIDRS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  // In production, when proxy-header trust is enabled but no CIDRs are
  // configured, fall back to loopback-only so we never silently honor
  // X-Forwarded-For from arbitrary upstreams. Pairs with the config validator's
  // loopback-default warning. In dev/test, an empty list keeps the legacy
  // "trust headers from any source" behavior (handled in isTrustedProxySource).
  if (
    configured.length === 0
    && shouldTrustProxyHeaders()
    && process.env.NODE_ENV === 'production'
  ) {
    return ['127.0.0.1/32', '::1/128'];
  }

  return configured;
}

function normalizeIpCandidate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  // [2001:db8::1]:443 -> 2001:db8::1
  if (trimmed.startsWith('[')) {
    const closing = trimmed.indexOf(']');
    if (closing > 1) {
      const ip = trimmed.slice(1, closing);
      return isIP(ip) ? ip : null;
    }
  }

  // 10.0.0.1:443 -> 10.0.0.1
  if (trimmed.includes(':') && isIP(trimmed) !== 6) {
    const [host, port] = trimmed.split(':');
    if (host && port && /^\d+$/.test(port) && isIP(host) === 4) {
      return host;
    }
  }

  return isIP(trimmed) ? trimmed : null;
}

function firstValidIpFromCsv(value: string | undefined): string | null {
  if (!value) return null;
  const candidates = value.split(',');
  for (const candidate of candidates) {
    const normalized = normalizeIpCandidate(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

// ::ffff:a.b.c.d -> a.b.c.d (IPv4-mapped IPv6); null when not in mapped form.
function ipv4MappedToV4(ip: string): string | null {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (!match || !match[1]) return null;
  return isIP(match[1]) === 4 ? match[1] : null;
}

export function isTrustedProxySource(sourceIp: string | undefined): boolean {
  const cidrs = trustedProxyCidrs();
  if (cidrs.length === 0) {
    return process.env.NODE_ENV !== 'production';
  }

  const normalizedSource = sourceIp ? normalizeIpCandidate(sourceIp) : null;
  if (!normalizedSource) {
    return false;
  }

  // IPv4-mapped IPv6 peers (::ffff:a.b.c.d — common on dual-stack listeners)
  // should match whether the operator wrote the trusted-proxy entry in IPv4
  // form (127.0.0.1/32) or IPv6 form (::ffff:0:0/96), so check both shapes.
  const candidates = [normalizedSource];
  const mapped = ipv4MappedToV4(normalizedSource);
  if (mapped) candidates.push(mapped);

  for (const cidr of cidrs) {
    // Bare-IP entries may use bracketed/port forms; normalize them first.
    // CIDR math for both families is delegated to the shared BigInt matcher
    // (services/ipMatch.ts) — malformed entries never match and never throw.
    const entry = cidr.includes('/') ? cidr : normalizeIpCandidate(cidr);
    if (!entry) continue;
    if (candidates.some((ip) => ipMatchesAny(ip, [entry]))) return true;
  }

  return false;
}

function getImmediatePeerIp(c: RequestLike, fallback: string): string | undefined {
  const contextWithEnv = c as RequestLike & {
    env?: { incoming?: { socket?: { remoteAddress?: string } } };
  };
  return normalizeIpCandidate(contextWithEnv.env?.incoming?.socket?.remoteAddress ?? '')
    ?? normalizeIpCandidate(fallback)
    ?? undefined;
}

export function getTrustedClientIp(c: RequestLike, fallback = 'unknown'): string {
  if (!shouldTrustProxyHeaders()) {
    return fallback;
  }

  if (!isTrustedProxySource(getImmediatePeerIp(c, fallback))) {
    return fallback;
  }

  // Precedence rationale:
  // 1. CF-Connecting-IP — set directly by Cloudflare's edge for every tunneled
  //    request. It is a single canonical IP (not a chain) and cannot be
  //    appended-to by intermediaries the way XFF can, so when present it is
  //    the most trustworthy source. Our prod stack is always behind CF.
  // 2. X-Forwarded-For — emitted by Caddy with the real client at the head of
  //    the chain (now that `trusted_proxies` + `client_ip_headers` is set,
  //    see docker/Caddyfile.prod). Fallback for non-CF deployments / dev.
  // 3. X-Real-IP — single-IP variant some proxies emit instead of XFF.
  const cloudflare = normalizeIpCandidate(c.req.header('cf-connecting-ip') ?? c.req.header('CF-Connecting-IP') ?? '');
  if (cloudflare) {
    return cloudflare;
  }

  const forwarded = firstValidIpFromCsv(c.req.header('x-forwarded-for') ?? c.req.header('X-Forwarded-For'));
  if (forwarded) {
    return forwarded;
  }

  const realIp = normalizeIpCandidate(c.req.header('x-real-ip') ?? c.req.header('X-Real-IP') ?? '');
  if (realIp) {
    return realIp;
  }

  return fallback;
}

export function getTrustedClientIpOrUndefined(c: RequestLike): string | undefined {
  const ip = getTrustedClientIp(c, '');
  return ip || undefined;
}
