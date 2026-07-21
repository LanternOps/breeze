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

function trustCloudflareConnectingIp(): boolean {
  // CF-Connecting-IP is only trustworthy when the deployment is genuinely
  // behind Cloudflare: CF's edge overwrites the header on every request, but a
  // reverse proxy like the bundled Caddy does NOT strip it. A self-hoster not
  // behind Cloudflare who trusts it lets a client spoof CF-Connecting-IP to
  // choose its own per-IP rate-limit bucket and defeat IP allowlists. Off
  // unless the operator explicitly declares a Cloudflare front.
  return isTruthy(process.env.TRUST_CF_CONNECTING_IP);
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

// --- Proxy-trust misconfiguration detection (#2364) -------------------------
// When proxy-header trust is enabled but the immediate TCP peer is NOT in
// TRUSTED_PROXY_CIDRS, we (correctly, fail-closed) ignore forwarded headers and
// fall back to the socket address. In production that combination almost
// always means the pinned proxy IP went stale (proxy container recreated
// without a static `ipv4_address`) — every per-IP rate limit then pools onto
// the proxy IP and audit-log IP attribution silently records the proxy as the
// client. Detect it and warn LOUDLY, rate-limited per peer so a burst can't
// flood logs. Pure in-memory — no I/O on the hot path. Observability only:
// the returned IP is unchanged.

const UNTRUSTED_PEER_WARN_INTERVAL_MS = 15 * 60 * 1000;
// Hard cap on tracked peers so a rotating set of source IPs can't grow the
// map unboundedly. When full, expired entries are pruned; if still full the
// warning is emitted without being tracked (louder, never unbounded).
const UNTRUSTED_PEER_WARN_MAX_TRACKED = 1024;
const untrustedPeerLastWarnAt = new Map<string, number>();

type ProxyTrustMetricsRecorder = {
  onForwardedHeadersFromUntrustedPeer: () => void;
};

const noopRecorder: ProxyTrustMetricsRecorder = { onForwardedHeadersFromUntrustedPeer: () => {} };
let proxyTrustMetricsRecorder: ProxyTrustMetricsRecorder = noopRecorder;

// `routes/metrics.ts` registers the real Prometheus recorder at startup
// (same thin-indirection pattern as `abuseMetrics.ts` / `anomalyMetrics.ts` —
// services must not import routes). Until then this is a no-op.
export function setProxyTrustMetricsRecorder(next: Partial<ProxyTrustMetricsRecorder> | null | undefined): void {
  proxyTrustMetricsRecorder = {
    onForwardedHeadersFromUntrustedPeer:
      next?.onForwardedHeadersFromUntrustedPeer ?? noopRecorder.onForwardedHeadersFromUntrustedPeer,
  };
}

export function _resetProxyTrustWarnStateForTests(): void {
  untrustedPeerLastWarnAt.clear();
  proxyTrustMetricsRecorder = noopRecorder;
}

function hasForwardedIpHeaders(c: RequestLike): boolean {
  return Boolean(
    (c.req.header('cf-connecting-ip') ?? c.req.header('CF-Connecting-IP'))
    || (c.req.header('x-forwarded-for') ?? c.req.header('X-Forwarded-For'))
    || (c.req.header('x-real-ip') ?? c.req.header('X-Real-IP')),
  );
}

function warnForwardedHeadersFromUntrustedPeer(peerIp: string | undefined): void {
  // Count every occurrence — Prometheus rates are only useful unsampled.
  proxyTrustMetricsRecorder.onForwardedHeadersFromUntrustedPeer();

  const key = peerIp ?? 'unknown';
  const now = Date.now();
  const lastWarnAt = untrustedPeerLastWarnAt.get(key);
  if (lastWarnAt !== undefined && now - lastWarnAt < UNTRUSTED_PEER_WARN_INTERVAL_MS) {
    return;
  }

  if (!untrustedPeerLastWarnAt.has(key) && untrustedPeerLastWarnAt.size >= UNTRUSTED_PEER_WARN_MAX_TRACKED) {
    for (const [trackedPeer, at] of untrustedPeerLastWarnAt) {
      if (now - at >= UNTRUSTED_PEER_WARN_INTERVAL_MS) untrustedPeerLastWarnAt.delete(trackedPeer);
    }
  }
  if (untrustedPeerLastWarnAt.has(key) || untrustedPeerLastWarnAt.size < UNTRUSTED_PEER_WARN_MAX_TRACKED) {
    untrustedPeerLastWarnAt.set(key, now);
  }

  console.warn(
    `[proxy-trust] MISCONFIGURATION: request carried forwarded-ip headers (CF-Connecting-IP/X-Forwarded-For/X-Real-IP) `
    + `from untrusted peer ${key}, which is not in TRUSTED_PROXY_CIDRS — falling back to the socket address. `
    + `If this peer is your reverse proxy, TRUSTED_PROXY_CIDRS is likely STALE (proxy container recreated without a `
    + `static ipv4_address): all per-IP rate limits are pooling onto the proxy IP and audit-log IP attribution is `
    + `recording the proxy as every client. Fix TRUSTED_PROXY_CIDRS or pin the proxy IP (see docs/operations/DEPLOY_PRODUCTION.md). `
    + `Suppressed for this peer for ${UNTRUSTED_PEER_WARN_INTERVAL_MS / 60000} minutes.`,
  );
}
// ---------------------------------------------------------------------------

export function getTrustedClientIp(c: RequestLike, fallback = 'unknown'): string {
  if (!shouldTrustProxyHeaders()) {
    return fallback;
  }

  const peerIp = getImmediatePeerIp(c, fallback);
  if (!isTrustedProxySource(peerIp)) {
    if (hasForwardedIpHeaders(c)) {
      warnForwardedHeadersFromUntrustedPeer(peerIp);
    }
    return fallback;
  }

  // Precedence rationale:
  // 1. CF-Connecting-IP — set directly by Cloudflare's edge for every tunneled
  //    request; a single canonical IP that intermediaries cannot append to the
  //    way they can XFF. Trusted ONLY when TRUST_CF_CONNECTING_IP is set,
  //    because a reverse proxy that is not Cloudflare does not strip this
  //    header, so trusting it unconditionally would let a client spoof it.
  //    Enable only when the deployment is genuinely fronted by Cloudflare.
  // 2. X-Forwarded-For — emitted by Caddy with the real client at the head of
  //    the chain (now that `trusted_proxies` + `client_ip_headers` is set,
  //    see docker/Caddyfile.prod). Fallback for non-CF deployments / dev.
  // 3. X-Real-IP — single-IP variant some proxies emit instead of XFF.
  if (trustCloudflareConnectingIp()) {
    const cloudflare = normalizeIpCandidate(c.req.header('cf-connecting-ip') ?? c.req.header('CF-Connecting-IP') ?? '');
    if (cloudflare) {
      return cloudflare;
    }
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

// Whether forwarded metadata headers (X-Forwarded-Proto, X-Forwarded-For, …)
// from this request may be honored: proxy-header trust is enabled AND the
// immediate TCP peer is in TRUSTED_PROXY_CIDRS. This is the same gate
// getTrustedClientIp applies before reading forwarded-ip headers — use it for
// any other forwarded header whose value must not be client-controllable
// (e.g. the auth-cookie Secure flag derives from X-Forwarded-Proto).
export function trustsForwardedHeadersFrom(c: RequestLike): boolean {
  if (!shouldTrustProxyHeaders()) {
    return false;
  }
  return isTrustedProxySource(getImmediatePeerIp(c, ''));
}

// The immediate TCP peer, socket-only — NEVER consults forwarded headers, so
// it cannot be spoofed at L7. Used as a rate-limit key of last resort when no
// trusted client IP is available. Unlike getTrustedClientIp this does NOT gate
// on TRUST_PROXY_HEADERS: the socket address is always the real peer.
export function getImmediatePeerIpOrUndefined(c: RequestLike): string | undefined {
  const ctx = c as RequestLike & { env?: { incoming?: { socket?: { remoteAddress?: string } } } };
  return normalizeIpCandidate(ctx.env?.incoming?.socket?.remoteAddress ?? '') ?? undefined;
}
