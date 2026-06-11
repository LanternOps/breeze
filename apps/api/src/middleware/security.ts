import type { Context, MiddlewareHandler, Next } from 'hono';

/**
 * Security middleware for Breeze API.
 *
 * Provides:
 *  - HTTP -> HTTPS redirect (when FORCE_HTTPS=true)
 *  - Content Security Policy header
 *  - Permissions-Policy header
 *
 * Designed to complement hono/secure-headers (which already sets
 * X-Content-Type-Options, X-Frame-Options, Referrer-Policy,
 * Cross-Origin isolation headers, and HSTS).
 * This middleware adds headers that secureHeaders does NOT set by default.
 */

const HEALTH_CHECK_PATHS = new Set(['/health', '/ready']);

interface SecurityMiddlewareOptions {
  /** Override NODE_ENV for testing. Defaults to process.env.NODE_ENV */
  nodeEnv?: string;
  /** Override FORCE_HTTPS for testing. Defaults to process.env.FORCE_HTTPS */
  forceHttps?: string;
  /** Override CSP_REPORT_URI for testing. Defaults to process.env.CSP_REPORT_URI */
  cspReportUri?: string;
  /** Override CSP_ALLOW_UNSAFE_INLINE for testing. Defaults to process.env.CSP_ALLOW_UNSAFE_INLINE */
  allowUnsafeInline?: string;
  /** Override CSP_CONNECT_HOSTS (comma-separated) for testing. */
  cspConnectHosts?: string;
}

/**
 * Builds the `connect-src` directive value.
 *
 * In production: tightens to same-origin plus an explicit allowlist of WSS
 * hosts. An XSS in the dashboard cannot exfiltrate to `ws://attacker.com/`.
 * Hosts come from `CSP_CONNECT_HOSTS` (comma-separated, e.g.
 * `wss://*.2breeze.app,wss://us.2breeze.app`). If not configured, falls back
 * to `wss://*.2breeze.app` — known production wildcard for Breeze regions.
 *
 * In non-production: keeps `ws: wss:` open so localhost / docker dev origins
 * keep working.
 */
function buildConnectSrc(
  nodeEnv: string | undefined,
  cspConnectHosts: string | undefined,
): string {
  const isProd = nodeEnv === 'production';
  if (!isProd) {
    return "connect-src 'self' ws: wss:";
  }
  const configured = (cspConnectHosts ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  const hosts = configured.length > 0 ? configured : ['wss://*.2breeze.app'];
  return `connect-src 'self' ${hosts.join(' ')}`;
}

export function securityMiddleware(options?: SecurityMiddlewareOptions): MiddlewareHandler {
  const nodeEnv = options?.nodeEnv ?? process.env.NODE_ENV;
  const forceHttps = options?.forceHttps ?? process.env.FORCE_HTTPS;
  const cspReportUri = options?.cspReportUri ?? process.env.CSP_REPORT_URI;
  const allowUnsafeInlineRaw = options?.allowUnsafeInline ?? process.env.CSP_ALLOW_UNSAFE_INLINE;
  const cspConnectHosts = options?.cspConnectHosts ?? process.env.CSP_CONNECT_HOSTS;
  const normalized = forceHttps?.trim().toLowerCase();
  const isForceHttps = normalized === 'true' || normalized === '1';
  // Strict by default; only allow inline script/style when explicitly enabled.
  // CSP_ALLOW_UNSAFE_INLINE has NO effect in production — refusing to
  // weaken CSP in prod even if the env var is mis-set.
  const unsafeInlineNormalized = allowUnsafeInlineRaw?.trim().toLowerCase();
  const isUnsafeInlineRequested = unsafeInlineNormalized === 'true' || unsafeInlineNormalized === '1';
  const isUnsafeInlineAllowed = nodeEnv !== 'production' && isUnsafeInlineRequested;

  // Pre-build the CSP header value (it doesn't change per-request)
  const cspDirectives = [
    "default-src 'self'",
    isUnsafeInlineAllowed ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    isUnsafeInlineAllowed ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    buildConnectSrc(nodeEnv, cspConnectHosts),
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];

  if (cspReportUri) {
    cspDirectives.push(`report-uri ${cspReportUri}`);
    cspDirectives.push(`report-to csp-endpoint`);
  }

  const cspValue = cspDirectives.join('; ');

  // Build Report-To header if CSP_REPORT_URI is set
  const reportToValue = cspReportUri
    ? JSON.stringify({
        group: 'csp-endpoint',
        max_age: 86400,
        endpoints: [{ url: cspReportUri }],
      })
    : null;

  // Permissions-Policy header value
  const permissionsPolicyValue = 'camera=(), microphone=(), geolocation=()';

  return async (c: Context, next: Next) => {
    const path = c.req.path;

    // --- HTTP -> HTTPS redirect ---
    if (isForceHttps && !HEALTH_CHECK_PATHS.has(path)) {
      const proto = c.req.header('x-forwarded-proto');
      if (proto === 'http') {
        try {
          const url = new URL(c.req.url);
          url.protocol = 'https:';
          return c.redirect(url.toString(), 308);
        } catch {
          // Malformed URL — fall through to normal processing
        }
      }
    }

    // --- Content Security Policy ---
    c.header('Content-Security-Policy', cspValue);

    // --- Report-To (for CSP reporting) ---
    if (reportToValue) {
      c.header('Report-To', reportToValue);
    }

    // --- Permissions-Policy ---
    c.header('Permissions-Policy', permissionsPolicyValue);

    await next();
  };
}
