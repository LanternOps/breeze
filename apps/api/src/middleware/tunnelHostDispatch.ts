/**
 * Network Proxy host mode (spec 2026-10-06 §3). Tunnel hosts and app hosts
 * share api:3001, so the Caddy-set `X-Breeze-Tunnel-Site` assertion is the
 * only ingress signal: every Caddy site block strips it, only the tunnel block
 * sets it. A tunnel-domain Host without it, or an app Host with it, is 421.
 * X-Forwarded-Host is never consulted.
 *
 * "Tunnel domain" is the bare suffix and any depth under it (trailing dot and
 * port ignored). W00 (#8418) showed trailing-dot, deeper and bare-suffix hosts
 * miss Caddy's wildcard block and land in the app block, so this classifier is
 * the backstop: such hosts never reach app routes (421 without the assertion,
 * the fail-closed tunnel app with it).
 */
import type { Context, MiddlewareHandler } from 'hono';
import { getTunnelOriginConfig, isTunnelDomainHost, type TunnelOriginConfig } from '../config/tunnelOrigin';

export const TUNNEL_SITE_ASSERTION_HEADER = 'x-breeze-tunnel-site';
export const TUNNEL_SITE_ASSERTION_VALUE = '1';

declare module 'hono' {
  interface ContextVariableMap {
    tunnelSurface: boolean;
  }
}

export type TunnelHostDecision =
  | { kind: 'app' }
  | { kind: 'tunnel' }
  | { kind: 'reject'; reason: 'tunnel_host_without_assertion' | 'unparsable_host' | 'tunnel_assertion_on_app_host' | 'tunnel_assertion_while_disabled' };

function isParsableHost(host: string): boolean {
  try {
    return new URL(`http://${host}`).hostname !== '';
  } catch {
    return false;
  }
}

export function decideTunnelHost(
  hostHeader: string | undefined,
  assertion: string | undefined,
  config: TunnelOriginConfig | null,
): TunnelHostDecision {
  const asserted = assertion !== undefined;
  if (!config) return asserted ? { kind: 'reject', reason: 'tunnel_assertion_while_disabled' } : { kind: 'app' };
  // Feature on: a Host we cannot parse might be a tunnel host in disguise, so
  // it never falls through to app routing.
  if (!hostHeader || !isParsableHost(hostHeader)) return { kind: 'reject', reason: 'unparsable_host' };
  if (isTunnelDomainHost(hostHeader, config)) {
    return assertion === TUNNEL_SITE_ASSERTION_VALUE
      ? { kind: 'tunnel' }
      : { kind: 'reject', reason: 'tunnel_host_without_assertion' };
  }
  return asserted ? { kind: 'reject', reason: 'tunnel_assertion_on_app_host' } : { kind: 'app' };
}

export function tunnelHostClassifier(getConfig: () => TunnelOriginConfig | null = getTunnelOriginConfig): MiddlewareHandler {
  return async (c, next) => {
    const decision = decideTunnelHost(c.req.header('host'), c.req.header(TUNNEL_SITE_ASSERTION_HEADER), getConfig());
    if (decision.kind === 'reject') {
      c.set('rejectReason', decision.reason);
      return c.text('Misdirected request', 421);
    }
    if (decision.kind === 'tunnel') c.set('tunnelSurface', true);
    return next();
  };
}

export function isTunnelSurface(c: Context): boolean {
  return c.get('tunnelSurface') === true;
}

/** Skip `mw` entirely on tunnel surfaces (app CSP/XFO/CORS must never merge into device responses). */
export function exceptTunnelSurface(mw: MiddlewareHandler): MiddlewareHandler {
  return async (c, next) => (isTunnelSurface(c) ? next() : mw(c, next));
}

/** Terminal for tunnel surfaces: no app route, auth middleware, CORS or static handler runs after this. */
export function tunnelHostDispatch(
  tunnelApp: { fetch: (req: Request, env?: unknown) => Response | Promise<Response> },
): MiddlewareHandler {
  return async (c, next) => {
    if (!isTunnelSurface(c)) return next();
    return tunnelApp.fetch(c.req.raw, c.env);
  };
}
