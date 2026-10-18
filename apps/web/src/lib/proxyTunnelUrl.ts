/**
 * Exact validation of the server-built Network Proxy URL before it is rendered
 * (spec 2026-10-06 §6/§7, plan Task 12).
 *
 * The web image has no runtime copy of TUNNEL_ORIGIN_TEMPLATE (plan G3), so
 * this checks STRUCTURE only:
 *   - host mode: this tunnel's id as the leftmost label, exactly `/__bz/enter`,
 *     a lone ticket (plus `mode=tab` in the tab context), https (http only on
 *     `*.localhost`), and nothing on, under or above the app / API host;
 *   - path mode: the relative `/api/v1/tunnel-http/<id>/?__bzt=<ticket>` URL
 *     for this tunnel, resolved against the API base.
 * The server validator (apps/api/src/config/tunnelOrigin.ts) guarantees the
 * tunnel domain is a separate registrable domain; this cannot re-derive that
 * without a public-suffix list. `allow-same-origin` is only ever granted to a
 * URL that passed here.
 */
export type ProxyTicketContext = 'frame' | 'tab';
export type ProxyTarget = { mode: 'host'; src: string; origin: string } | { mode: 'path'; src: string };

/** Host mode: the device page runs on its own tunnel origin, so it may keep that origin. */
export const HOST_MODE_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads';
/** Path mode: the device page shares the API origin, so it is forced to an opaque origin. */
export const PATH_MODE_SANDBOX = 'allow-scripts allow-forms allow-popups';

const TUNNEL_ENTER_PATH = '/__bz/enter';
// encodeURIComponent output of an opaque ticket: unreserved chars + %XX.
const TICKET_CHARS = /^[A-Za-z0-9._~%-]+$/;

function hostnameOf(raw: string): string | null {
  try {
    return new URL(raw).hostname;
  } catch {
    return null;
  }
}

function originOf(raw: string): string | null {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function isSameOrDescendant(host: string, ancestor: string): boolean {
  return host === ancestor || host.endsWith(`.${ancestor}`);
}

function resolvePathTarget(url: string, tunnelId: string, apiBase: string): ProxyTarget | null {
  const prefix = `/api/v1/tunnel-http/${tunnelId}/?__bzt=`;
  if (!url.startsWith(prefix)) return null;
  const ticket = url.slice(prefix.length);
  if (!TICKET_CHARS.test(ticket)) return null;
  return { mode: 'path', src: `${apiBase.replace(/\/+$/, '')}${url}` };
}

export function resolveProxyTarget(input: {
  url: unknown;
  tunnelId: string;
  context: ProxyTicketContext;
  appOrigin: string;
  apiBase: string;
}): ProxyTarget | null {
  const { url, tunnelId, context, appOrigin, apiBase } = input;
  if (typeof url !== 'string' || url.length === 0) return null;

  // Path mode is the only relative form. `//host/...` is protocol-relative and
  // would fail the prefix check anyway.
  if (url.startsWith('/')) return resolvePathTarget(url, tunnelId, apiBase);

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const hostname = parsed.hostname;
  const devLocal = parsed.protocol === 'http:' && hostname.endsWith('.localhost');
  if (parsed.protocol !== 'https:' && !devLocal) return null;
  // `parsed.hash` is '' for a bare trailing '#', so check the raw string too.
  if (parsed.username || parsed.password || parsed.hash || url.includes('#')) return null;
  if (parsed.pathname !== TUNNEL_ENTER_PATH) return null;

  const labels = hostname.split('.');
  if (labels.length < 3 || labels[0] !== tunnelId.toLowerCase()) return null;
  const tunnelSuffix = labels.slice(1).join('.');

  // Never on the app or API origin, never under their hosts, and the tunnel
  // suffix never a parent of them (each would make the frame same-site with
  // the app, and allow-same-origin would then be unsafe). A dot-less app host
  // (`localhost`) is its own site, so `*.localhost` tunnels stay allowed in dev.
  for (const raw of [appOrigin, apiBase]) {
    if (originOf(raw) === parsed.origin) return null;
    const appHost = hostnameOf(raw);
    if (!appHost || !appHost.includes('.')) continue;
    if (isSameOrDescendant(hostname, appHost) || isSameOrDescendant(appHost, tunnelSuffix)) return null;
  }

  const params = parsed.searchParams;
  const keys = [...params.keys()].sort().join(',');
  const ticket = params.get('t');
  if (!ticket) return null;
  if (context === 'frame' && keys !== 't') return null;
  if (context === 'tab' && (keys !== 'mode,t' || params.get('mode') !== 'tab')) return null;
  return { mode: 'host', src: parsed.toString(), origin: parsed.origin };
}
