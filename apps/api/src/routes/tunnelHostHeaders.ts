/**
 * Host-mode request/response header and cookie rules (spec 2026-10-06 §5–§6). Pure.
 *
 * The device owns the whole tunnel origin, so its cookies keep their names;
 * only the proxy's own two cookie names are reserved. Everything the device
 * says about framing, caching, CORS, referrers and service workers is replaced
 * by the proxy's policy.
 */
import type { TunnelCookieContext } from '../config/tunnelOrigin';
import { HOP_BY_HOP, collectForwardableHeaders } from './tunnelHttpCore';
import { rewriteTunnelUrl } from './tunnelHttpRewrite';
import { applyHostModeBaseHeaders, hostModeCsp } from '../services/tunnelHostBaseHeaders';

/** Iframe context: `SameSite=None; Partitioned` (CHIPS, keyed to the app's top-level site). */
export const TUNNEL_FRAME_COOKIE = '__Host-bzt';
/** New-tab context: first-party, unpartitioned `SameSite=Lax`. */
export const TUNNEL_TAB_COOKIE = '__Host-bzt-top';
/** Lowercase. Matched case-insensitively in both directions. */
export const RESERVED_PROXY_COOKIE_NAMES: ReadonlySet<string> = new Set([
  TUNNEL_FRAME_COOKIE.toLowerCase(),
  TUNNEL_TAB_COOKIE.toLowerCase(),
]);

// Attributes the proxy decides for every device cookie. `Domain` is dropped so
// a device cookie stays host-only (it can never reach a sibling tunnel host).
const PROXY_OWNED_COOKIE_ATTRIBUTE = /^(domain|samesite|secure|partitioned)\s*(=|$)/i;

/**
 * Rewrite one device `Set-Cookie` for the tunnel origin, or null to drop it.
 * Dropped: the proxy's reserved names (any case) and nameless cookies — a
 * browser stores `x` / `=x` with an EMPTY name, which could otherwise shadow a
 * reserved name in the Cookie header (`__Host-bzt` with no `=`).
 */
export function rewriteHostModeDeviceCookie(setCookie: string, context: TunnelCookieContext): string | null {
  const parts = setCookie.split(';');
  const pair = parts[0]?.trim() ?? '';
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  const name = pair.slice(0, eq).trim();
  if (!name || RESERVED_PROXY_COOKIE_NAMES.has(name.toLowerCase())) return null;
  const kept = parts.slice(1)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !PROXY_OWNED_COOKIE_ATTRIBUTE.test(p));
  const forced = context === 'tab' ? ['Secure', 'SameSite=Lax'] : ['Secure', 'SameSite=None', 'Partitioned'];
  return [pair, ...kept, ...forced].join('; ');
}

/** Remove the proxy's cookies (any case, with or without `=`) from a request `Cookie` header. */
export function stripProxyCookies(cookieHeader: string): string {
  return cookieHeader
    .split(';')
    .map((s) => s.trim())
    .filter((s) => {
      if (!s) return false;
      const eq = s.indexOf('=');
      const name = (eq === -1 ? s : s.slice(0, eq)).trim().toLowerCase();
      return !RESERVED_PROXY_COOKIE_NAMES.has(name);
    })
    .join('; ');
}

/**
 * Headers forwarded to the device. Starts from the shared allowlist (never
 * `cookie`, `authorization`, `referer`, `origin` or any forwarding header),
 * then adds the device's own cookies and — only when the request came from
 * this tunnel's own origin — `Origin` rewritten to the device's origin so
 * device-side CSRF checks pass. The app origin is never forwarded.
 */
export function buildHostModeUpstreamHeaders(
  reqHeaders: Record<string, string>,
  opts: { tunnelOrigin: string; targetOrigin: string },
): Record<string, string[]> {
  const headers = collectForwardableHeaders(reqHeaders);
  const cookies = stripProxyCookies(reqHeaders['cookie'] ?? '');
  if (cookies) headers['cookie'] = [cookies];
  if (reqHeaders['origin'] === opts.tunnelOrigin) headers['origin'] = [new URL(opts.targetOrigin).origin];
  return headers;
}

export { applyHostModeBaseHeaders, hostModeCsp } from '../services/tunnelHostBaseHeaders';

// Device response headers the proxy never passes on. `access-control-*` and
// hop-by-hop headers are dropped separately. Beyond the policy headers the
// proxy owns: `alt-svc` would advertise an alternative endpoint for the
// tunnel origin; `clear-site-data` would wipe the proxy's own cookie;
// `report-to` / `reporting-endpoints` / `nel` would register origin-scoped
// reporting that outlives the session; HSTS on the tunnel origin is the
// edge's call (Caddy sets it), not the device's.
const DROPPED_RESPONSE_HEADERS = new Set([
  'content-length',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'cache-control',
  'referrer-policy',
  'x-content-type-options',
  'service-worker-allowed',
  'alt-svc',
  'clear-site-data',
  'report-to',
  'reporting-endpoints',
  'nel',
  'strict-transport-security',
]);

export function buildHostModeResponseHeaders(
  upstream: Record<string, string[]>,
  opts: { context: TunnelCookieContext; targetOrigin: string; frameAncestor: string },
): { headers: Headers; contentType: string } {
  const headers = new Headers();
  let contentType = '';
  for (const [k, values] of Object.entries(upstream)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || lk.startsWith('access-control-') || DROPPED_RESPONSE_HEADERS.has(lk)) continue;
    if (lk === 'content-type') {
      contentType = values[0] ?? '';
      if (contentType) headers.set('content-type', contentType);
      continue;
    }
    if (lk === 'location') {
      // Only an absolute URL naming the device's own origin is mapped; the
      // device owns the tunnel origin, so relative Locations already resolve.
      if (values[0]) headers.set('location', rewriteTunnelUrl(values[0], { basePath: '/', targetOrigin: opts.targetOrigin }));
      continue;
    }
    if (lk === 'set-cookie') {
      for (const v of values) {
        const rewritten = rewriteHostModeDeviceCookie(v, opts.context);
        if (rewritten) headers.append('set-cookie', rewritten);
      }
      continue;
    }
    for (const v of values) headers.append(k, v);
  }
  headers.set('content-security-policy', hostModeCsp(opts.frameAncestor));
  applyHostModeBaseHeaders(headers, opts.frameAncestor);
  return { headers, contentType };
}
