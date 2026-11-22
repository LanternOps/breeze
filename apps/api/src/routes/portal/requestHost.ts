/**
 * The portal host a request was served on, and the org it binds to (portal
 * registration W4 plan D5; shared with W6 self-registration, plan D6).
 * Moved unchanged from ./oidc.ts so both route modules use one definition.
 */
import type { Context } from 'hono';
import { resolvePortalHostOrgId } from './branding';

const HOST_NAME = /^[a-z0-9.-]+$/;

/**
 * The request's `Host`, port stripped and lowercased (D5). The portal calls
 * the API same-origin and the proxy keeps `Host`, so this is the portal host
 * the browser used. Never a body or query value. Anything that is not a plain
 * DNS name (an IPv6 literal, garbage) is treated as the shared host.
 */
export function requestHost(c: Context): string | null {
  const raw = c.req.header('host')?.trim().toLowerCase();
  if (!raw) return null;
  const host = raw.replace(/:\d+$/, '').replace(/\.$/, '');
  return host && HOST_NAME.test(host) ? host : null;
}

/** The org whose verified custom domain served this request, or null on the shared host. Opens its own system context. */
export async function hostOrgIdFor(c: Context): Promise<string | null> {
  const host = requestHost(c);
  return host ? resolvePortalHostOrgId(host) : null;
}
