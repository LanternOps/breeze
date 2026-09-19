/**
 * The `/metrics` scrape gate, shared by both roles (#4143).
 *
 * A LEAF module (`node:crypto` only) for the same reason as
 * `services/metricsRegistry.ts`: `worker.ts` statically imports it, and
 * `services/workerEntrypointClosure.contract.test.ts` forbids that file's
 * closure from reaching `routes/`.
 *
 * Why share it at all rather than let the worker grow its own check: the
 * api-role `/api/metrics/scrape` gate is three rules — a configured token, an
 * optional source-IP allowlist, and a constant-time bearer comparison — and a
 * second, independently written copy of those three rules is exactly how one
 * container ends up quietly weaker than the other. The decision lives here
 * once; each role supplies its own inputs, because they read the peer address
 * differently (see `clientIp` below).
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/** HTTP status + body for a REFUSED scrape. `null` from the evaluator = allow. */
export interface MetricsScrapeDenial {
  status: 401 | 403 | 503;
  error: string;
}

export interface MetricsScrapeAuthInput {
  /** Resolved scrape token; `undefined`/empty means the endpoint is disabled. */
  token: string | undefined;
  /** Empty set = no source-IP restriction. */
  ipAllowlist: Set<string>;
  /** Raw `Authorization` header value, if any. */
  authHeader: string | undefined;
  /**
   * Peer address, already resolved by the caller. Only consulted when
   * `ipAllowlist` is non-empty, so a caller may skip the (potentially costly)
   * resolution entirely when the allowlist is unset.
   */
  clientIp: string | undefined;
}

/**
 * Production hardening: an unset token, or the shipped dev placeholder, means
 * "not configured" in production and the endpoint refuses rather than serving
 * unauthenticated. Outside production the raw value is honoured as-is so a
 * local stack can scrape itself.
 */
export function resolveMetricsScrapeToken(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const rawToken = env.METRICS_SCRAPE_TOKEN?.trim();
  return (env.NODE_ENV ?? 'development') === 'production' &&
    (!rawToken || rawToken === 'REDACTED_DEV_TOKEN')
    ? undefined
    : rawToken;
}

/** `METRICS_SCRAPE_IP_ALLOWLIST` as a set; empty set = unrestricted. */
export function parseMetricsScrapeIpAllowlist(
  raw: string | undefined = process.env.METRICS_SCRAPE_IP_ALLOWLIST,
): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/**
 * Constant-time string comparison.
 *
 * Hashed first so `timingSafeEqual` always receives equal-length buffers — it
 * THROWS on a length mismatch, and a thrown comparison would both leak the
 * token length and turn a wrong-token 401 into a 500.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * The gate. Returns `null` to ALLOW, or the denial to render.
 *
 * Order matters and matches the api-role handler exactly: configuration first
 * (503 — the operator has not enabled scraping, which is not the caller's
 * fault), then the source-IP allowlist (403), then the bearer token (401). The
 * IP check runs BEFORE the token comparison so an off-allowlist prober cannot
 * use response timing on the token compare at all.
 */
export function evaluateMetricsScrapeAuth(
  input: MetricsScrapeAuthInput,
): MetricsScrapeDenial | null {
  if (!input.token) {
    return { status: 503, error: 'Metrics scrape token is not configured' };
  }

  if (input.ipAllowlist.size > 0) {
    if (!input.clientIp || !input.ipAllowlist.has(input.clientIp)) {
      return { status: 403, error: 'Forbidden' };
    }
  }

  if (!safeEqual(input.authHeader ?? '', `Bearer ${input.token}`)) {
    return { status: 401, error: 'Unauthorized' };
  }

  return null;
}

/**
 * Peer address for a raw `node:http` request, for the worker's slim server.
 *
 * DIRECT PEER ONLY — `X-Forwarded-For` and friends are deliberately ignored.
 * The api-role handler runs `getTrustedClientIpOrUndefined`, which consults
 * forwarded headers because the API genuinely sits behind a configured trusted
 * proxy; the worker's health/metrics port has no trusted-proxy configuration
 * at all, so honouring a forwarded header there would let any caller name its
 * own source IP and walk straight through the allowlist. Refusing to read them
 * is the strictly safer default, and the cost is explicit: if a proxy is ever
 * put in front of this port, `METRICS_SCRAPE_IP_ALLOWLIST` must list the
 * PROXY's address, not the scraper's.
 *
 * IPv4-mapped IPv6 peers (`::ffff:10.0.0.5`) are normalised to their dotted
 * form so an allowlist written as plain IPv4 matches on a dual-stack listener.
 */
export function directPeerAddress(socket: { remoteAddress?: string | undefined }): string | undefined {
  const raw = socket.remoteAddress?.trim();
  if (!raw) return undefined;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw);
  return mapped ? mapped[1] : raw;
}
