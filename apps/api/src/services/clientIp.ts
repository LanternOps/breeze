import type { RequestLike } from './auditEvents';
import { isIP } from 'net';

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

export function getTrustedClientIp(c: RequestLike, fallback = 'unknown'): string {
  if (!shouldTrustProxyHeaders()) {
    return fallback;
  }

  const forwarded = firstValidIpFromCsv(c.req.header('x-forwarded-for') ?? c.req.header('X-Forwarded-For'));
  if (forwarded) {
    return forwarded;
  }

  const realIp = normalizeIpCandidate(c.req.header('x-real-ip') ?? c.req.header('X-Real-IP') ?? '');
  if (realIp) {
    return realIp;
  }

  const cloudflare = normalizeIpCandidate(c.req.header('cf-connecting-ip') ?? c.req.header('CF-Connecting-IP') ?? '');
  if (cloudflare) {
    return cloudflare;
  }

  return fallback;
}

export function getTrustedClientIpOrUndefined(c: RequestLike): string | undefined {
  const ip = getTrustedClientIp(c, '');
  return ip || undefined;
}
