// apps/api/src/config/tunnelOrigin.ts
/**
 * Network Proxy host mode (spec 2026-10-06 §2): the tunnel origin template.
 * Pure parsing + a cached runtime getter. config/validate.ts refuses boot on
 * any issue returned here, so the runtime getter's error branch is defensive.
 * The tunnel domain itself is NEVER written in code — only derived from env.
 */
import { getDomain } from 'tldts';
import { UUID_REGEX } from '../utils/uuid';

export type TunnelCookieContext = 'frame' | 'tab';

export interface TunnelOriginConfig {
  scheme: 'https' | 'http';
  /** Lowercase, no leading dot, e.g. `us.breezetunnel.test`. */
  suffix: string;
  /** '' for the scheme default; only ever non-empty for *.localhost dev stacks. */
  port: string;
  /** Exact origin allowed in `frame-ancestors`. */
  frameAncestor: string;
}

export interface TunnelOriginEnv {
  NODE_ENV?: string;
  TUNNEL_ORIGIN_TEMPLATE?: string;
  TUNNEL_FRAME_ANCESTOR?: string;
  PUBLIC_APP_URL?: string;
  DASHBOARD_URL?: string;
  PUBLIC_API_URL?: string;
  CORS_ALLOWED_ORIGINS?: string;
}

export interface TunnelOriginIssue {
  path: 'TUNNEL_ORIGIN_TEMPLATE' | 'TUNNEL_FRAME_ANCESTOR';
  message: string;
}

const TEMPLATE_RE = /^(https?):\/\/\{id\}\.([a-z0-9.-]+?)(?::(\d{1,5}))?$/;
const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const TEMPLATE_SHAPE =
  'must be exactly https://{id}.<suffix> — lowercase, {id} as the whole leftmost label, no userinfo, path, query, fragment or port';

function isLocalhostName(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost');
}

function safeUrl(raw: string | undefined): URL | null {
  if (!raw?.trim()) return null;
  try {
    return new URL(raw.trim());
  } catch {
    return null;
  }
}

/** Every origin that authenticates Breeze users or serves the app. */
function appOrigins(env: TunnelOriginEnv, frameAncestor: string | null): URL[] {
  const raws = [
    env.PUBLIC_APP_URL, env.DASHBOARD_URL, env.PUBLIC_API_URL, frameAncestor ?? undefined,
    ...(env.CORS_ALLOWED_ORIGINS ?? '').split(','),
  ];
  return raws.map((r) => (r && r.trim() !== '*' ? safeUrl(r) : null)).filter((u): u is URL => u !== null);
}

function registrableDomains(host: string): Set<string> {
  const out = new Set<string>();
  for (const allowPrivateDomains of [true, false]) {
    const d = getDomain(host, { allowPrivateDomains });
    if (d) out.add(d);
  }
  return out;
}

export function parseTunnelOriginConfig(
  env: TunnelOriginEnv,
): { ok: true; config: TunnelOriginConfig | null } | { ok: false; issues: TunnelOriginIssue[] } {
  const raw = env.TUNNEL_ORIGIN_TEMPLATE?.trim();
  if (!raw) return { ok: true, config: null };
  const production = env.NODE_ENV === 'production';
  const issues: TunnelOriginIssue[] = [];

  const match = TEMPLATE_RE.exec(raw);
  if (!match || raw.split('{id}').length !== 2) {
    return { ok: false, issues: [{ path: 'TUNNEL_ORIGIN_TEMPLATE', message: TEMPLATE_SHAPE }] };
  }
  const scheme = match[1] as 'https' | 'http';
  const suffix = match[2]!;
  const port = match[3] ?? '';
  const labels = suffix.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) {
    issues.push({ path: 'TUNNEL_ORIGIN_TEMPLATE', message: `${TEMPLATE_SHAPE} (invalid suffix "${suffix}")` });
  }
  const devLocal = !production && isLocalhostName(suffix);
  if (scheme !== 'https' && !devLocal) {
    issues.push({ path: 'TUNNEL_ORIGIN_TEMPLATE', message: 'must use https:// (http is accepted only for *.localhost outside production)' });
  }
  if (port && !devLocal) {
    issues.push({ path: 'TUNNEL_ORIGIN_TEMPLATE', message: 'must not contain a port (accepted only for *.localhost outside production)' });
  }

  // Frame ancestor: explicit, else the public app origin; missing config fails closed.
  const ancestorRaw = env.TUNNEL_FRAME_ANCESTOR?.trim()
    || safeUrl(env.PUBLIC_APP_URL)?.origin
    || safeUrl(env.DASHBOARD_URL)?.origin
    || '';
  let frameAncestor: string | null = null;
  if (!ancestorRaw) {
    issues.push({ path: 'TUNNEL_FRAME_ANCESTOR', message: 'is required when TUNNEL_ORIGIN_TEMPLATE is set (no PUBLIC_APP_URL/DASHBOARD_URL to default from)' });
  } else {
    const parsed = safeUrl(ancestorRaw);
    const localAncestor = !production && parsed !== null && isLocalhostName(parsed.hostname) && parsed.protocol === 'http:';
    if (!parsed || parsed.origin !== ancestorRaw || (parsed.protocol !== 'https:' && !localAncestor)) {
      issues.push({ path: 'TUNNEL_FRAME_ANCESTOR', message: `must be an exact https origin such as https://app.example.com (got "${ancestorRaw}")` });
    } else {
      frameAncestor = parsed.origin;
    }
  }

  // Registrable-domain separation from every authenticated app/API origin,
  // compared with allowPrivateDomains in BOTH directions (spec §2).
  const tunnelDomains = registrableDomains(`x.${suffix}`);
  if (tunnelDomains.size === 0 && !devLocal) {
    issues.push({ path: 'TUNNEL_ORIGIN_TEMPLATE', message: `suffix "${suffix}" has no registrable domain` });
  }
  for (const origin of appOrigins(env, frameAncestor)) {
    const host = origin.hostname;
    const shared = [...registrableDomains(host)].some((d) => tunnelDomains.has(d));
    if (shared || host === suffix) {
      issues.push({
        path: 'TUNNEL_ORIGIN_TEMPLATE',
        message: `suffix "${suffix}" shares a registrable domain with app origin ${origin.origin}; tunnel content must live on a separate registrable domain`,
      });
    }
  }

  if (issues.length > 0 || !frameAncestor) return { ok: false, issues };
  return { ok: true, config: { scheme, suffix, port, frameAncestor } };
}

let cached: { value: TunnelOriginConfig | null } | null = null;

export function getTunnelOriginConfig(): TunnelOriginConfig | null {
  if (cached) return cached.value;
  const parsed = parseTunnelOriginConfig(process.env);
  if (!parsed.ok) {
    console.error('[tunnel-origin] invalid tunnel origin config; host mode disabled:',
      parsed.issues.map((i) => `${i.path} ${i.message}`).join('; '));
    cached = { value: null };
    return null;
  }
  cached = { value: parsed.config };
  return parsed.config;
}

export function __resetTunnelOriginConfigForTests(): void {
  cached = null;
}

export function buildTunnelOrigin(config: TunnelOriginConfig, tunnelId: string): string {
  return `${config.scheme}://${tunnelId.toLowerCase()}.${config.suffix}${config.port ? `:${config.port}` : ''}`;
}

export function buildTunnelEnterUrl(
  config: TunnelOriginConfig,
  tunnelId: string,
  ticket: string,
  context: TunnelCookieContext = 'frame',
): string {
  const url = new URL('/__bz/enter', buildTunnelOrigin(config, tunnelId));
  url.searchParams.set('t', ticket);
  if (context === 'tab') url.searchParams.set('mode', 'tab');
  return url.toString();
}

export function buildPathModeTicketUrl(tunnelId: string, ticket: string): string {
  return `/api/v1/tunnel-http/${tunnelId}/?__bzt=${encodeURIComponent(ticket)}`;
}

function parseHost(hostHeader: string | undefined): { hostname: string; port: string } | null {
  if (!hostHeader) return null;
  try {
    const u = new URL(`http://${hostHeader}`);
    return { hostname: u.hostname.replace(/\.$/, ''), port: u.port };
  } catch {
    return null;
  }
}

/** True for the bare suffix and ANY depth under it — all of it is tunnel surface (G10). Port is ignored. */
export function isTunnelDomainHost(hostHeader: string | undefined, config: TunnelOriginConfig): boolean {
  const host = parseHost(hostHeader);
  if (!host) return false;
  return host.hostname === config.suffix || host.hostname.endsWith(`.${config.suffix}`);
}

/** The tunnel id for `<uuid>.<suffix>[:<configured port>]`, else null. */
export function matchTunnelHost(hostHeader: string | undefined, config: TunnelOriginConfig): string | null {
  const host = parseHost(hostHeader);
  if (!host || !host.hostname.endsWith(`.${config.suffix}`)) return null;
  const portOk = config.port ? host.port === config.port : host.port === '' || host.port === '443';
  if (!portOk) return null;
  const label = host.hostname.slice(0, -(config.suffix.length + 1));
  return UUID_REGEX.test(label) ? label.toLowerCase() : null;
}
