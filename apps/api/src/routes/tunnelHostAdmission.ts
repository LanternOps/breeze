/**
 * Cross-tunnel request admission (spec 2026-10-06 §4a), enforced before any
 * auth, gate or dispatch. All tunnel iframes share the app's cookie partition
 * (and sibling tunnel hosts are same-site until PSL inclusion), so a page on
 * tunnel A can send a request to tunnel B that carries B's partitioned cookie
 * (W00 confirmed this in every engine). Rules apply to GET too: device GET
 * endpoints often have side effects (reboot links, config toggles). Also home
 * to `isReservedTunnelPath`, shared by the router and the Referer rewrite. Pure.
 */
export interface TunnelAdmissionInput {
  method: string;
  /** Raw (still percent-encoded) URL pathname. */
  path: string;
  secFetchSite?: string;
  secFetchDest?: string;
  origin?: string;
  serviceWorker?: string;
  /** This tunnel's own origin, e.g. `https://<id>.us.<tunnel-domain>`. */
  tunnelOrigin: string;
}

export type TunnelAdmissionRefusal =
  | 'service_worker' | 'cross_site' | 'foreign_origin' | 'missing_origin' | 'enter_not_navigation';

export type TunnelAdmissionResult =
  | { ok: true }
  | { ok: false; status: 403 | 404; reason: TunnelAdmissionRefusal };

export const TUNNEL_ENTER_PATH = '/__bz/enter';

const ASCII_ESCAPE = /%([0-7][0-9a-f])/gi;
/**
 * `/__bz` and everything under it, however it is spelled: case, ASCII
 * percent-escapes (decoded repeatedly — `_`, `b`, `z` and `/` are all ASCII),
 * backslashes, repeated slashes and dot segments. Non-ASCII or stray `%`
 * sequences are left alone so a device path like `/100%` still works. A path
 * that keeps changing after a few rounds is treated as reserved.
 */
export function isReservedTunnelPath(rawPathname: string): boolean {
  let current = rawPathname;
  for (let round = 0; round < 4; round += 1) {
    // Collapse `\` and `//` first: `new URL('//__bz/x', base)` would read
    // `__bz` as a HOST, not a path segment.
    const flattened = current.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    let normalized: string;
    try {
      normalized = new URL(`http://tunnel.invalid${flattened.startsWith('/') ? '' : '/'}${flattened}`).pathname.toLowerCase();
    } catch {
      return true;
    }
    if (normalized === '/__bz' || normalized.startsWith('/__bz/')) return true;
    const decoded = current.replace(ASCII_ESCAPE, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (decoded === current) return false;
    current = decoded;
  }
  return true;
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);
const NAVIGATION_DESTS = new Set(['iframe', 'document']);
const norm = (v: string | undefined) => (v === undefined ? undefined : v.trim().toLowerCase());

export function admitTunnelHostRequest(input: TunnelAdmissionInput): TunnelAdmissionResult {
  // A device-registered service worker would persist on the tunnel origin and
  // intercept later sessions (spec §6). Checked first, on every path.
  if (norm(input.serviceWorker) === 'script' || norm(input.secFetchDest) === 'serviceworker') {
    return { ok: false, status: 404, reason: 'service_worker' };
  }
  const method = input.method.toUpperCase();

  // The one cross-site entry point: the app's iframe or new-tab navigation,
  // protected by the one-time ticket. Exact raw path only — an encoded or
  // cased variant is not the entry point (and is never forwarded either).
  if (input.path === TUNNEL_ENTER_PATH) {
    const dest = norm(input.secFetchDest);
    if (method !== 'GET' || (dest !== undefined && !NAVIGATION_DESTS.has(dest))) {
      return { ok: false, status: 403, reason: 'enter_not_navigation' };
    }
    return { ok: true };
  }

  const site = norm(input.secFetchSite);
  // Any Origin other than this tunnel's own is refused outright, whatever
  // Sec-Fetch-Site claims, with one exception: `Origin: null` together with
  // `Sec-Fetch-Site: same-origin`. Every tunnel-host response carries
  // `Referrer-Policy: no-referrer`, and under that policy a browser sends
  // `Origin: null` on a same-origin form POST (#11458). Sec-Fetch-Site is
  // computed by the browser and page script cannot set it; `same-origin`
  // means the initiating page and every redirect hop were this tunnel's
  // origin. A sibling tunnel, the app, or an opaque (sandboxed, data:)
  // context gets `same-site`/`cross-site` there, so `null` from any of them
  // is still refused, as is `null` with Sec-Fetch-Site absent.
  const sameOriginNull = input.origin === 'null' && site === 'same-origin';
  if (input.origin !== undefined && input.origin !== input.tunnelOrigin && !sameOriginNull) {
    return { ok: false, status: 403, reason: 'foreign_origin' };
  }
  if (site !== undefined) {
    return site === 'same-origin' || site === 'none' ? { ok: true } : { ok: false, status: 403, reason: 'cross_site' };
  }
  // Sec-Fetch-Site absent (older browsers): unsafe methods need a matching Origin.
  if (!SAFE_METHODS.has(method) && input.origin === undefined) {
    return { ok: false, status: 403, reason: 'missing_origin' };
  }
  return { ok: true };
}
