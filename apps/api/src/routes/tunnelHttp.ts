import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { tunnelSessions, devices } from '../db/schema';
import { consumeWsTicket } from '../services/remoteSessionAuth';
import { sendCommandToAgentAwaitResult } from '../services/agentCommandAwait';
import { getActiveAllowlistPatterns } from '../services/tunnelAllowlist';
import { isAgentConnected } from './agentWs';
import { checkRemoteAccess } from '../services/remoteAccessPolicy';
import { getTrustedClientIp } from '../services/clientIp';
import { getSignKey, getVerifyKey, buildHeader } from '../services/jwt';

/**
 * HTTP reverse-proxy route for the Network Proxy feature.
 *
 * Proxies a discovered LAN device's web UI (e.g. a printer/switch admin page)
 * to the browser by issuing `http_request` commands to the bridging agent.
 * The proxy target is ALWAYS taken from the owning `tunnel_sessions` row —
 * NEVER from the request — so the browser can only control method/path/headers/
 * body, never which internal host is reached (SSRF guard, defense-in-depth with
 * the agent's own blocked-CIDR + allowlist re-validation).
 *
 * Auth model (mirrors tunnel-ws — NOT behind the global Bearer authMiddleware):
 *   1. First navigation carries `?__bzt=<ticket>` (minted by POST
 *      /tunnels/:id/http-ticket). We consume the one-time ticket, own-check the
 *      session, set a short-lived signed HttpOnly cookie scoped to this
 *      tunnel's proxy base, and 302-redirect to the same URL without `__bzt`
 *      (so the ticket isn't re-used or leaked via Referer).
 *   2. Sub-resource requests authenticate via that cookie.
 *   EVERY request re-checks owner + device-online + agent-connected + policy.
 *
 * Known gaps (documented, not bugs): `<base href>` injection fixes relative
 * URLs in most printer UIs, but absolute-URL or JS-constructed URLs that point
 * straight at the LAN host won't be rewritten and will 404 through the proxy.
 * Per-user rate limiting is intentionally deferred to the Task 8 security pass.
 */
export const tunnelHttpRoutes = new Hono();

const HTTP_REQUEST_TIMEOUT_MS = 25_000;
const COOKIE_TTL_SECONDS = 300; // ~5 min
const COOKIE_AUDIENCE = 'breeze-tunnel-http';
const CONNECTABLE_TUNNEL_STATUSES = ['pending', 'connecting', 'active'];

// Hop-by-hop headers (RFC 7230 §6.1) plus `host` — never forwarded in either
// direction. Lowercased for case-insensitive matching.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

// ---------------------------------------------------------------------------
// Cookie signing (reuses the JWT keyring from services/jwt.ts — no bespoke
// crypto). Distinct audience so a tunnel cookie can never be replayed as an API
// access/viewer token, and vice-versa.
// ---------------------------------------------------------------------------

async function signTunnelCookie(userId: string, tunnelId: string): Promise<string> {
  const { key, kid } = getSignKey();
  return new SignJWT({ tunnelId })
    .setProtectedHeader(buildHeader(kid))
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${COOKIE_TTL_SECONDS}s`)
    .setIssuer('breeze')
    .setAudience(COOKIE_AUDIENCE)
    .sign(key);
}

async function verifyTunnelCookie(token: string | undefined, tunnelId: string): Promise<string | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getVerifyKey, {
      issuer: 'breeze',
      audience: COOKIE_AUDIENCE,
      algorithms: ['HS256'],
    });
    if (payload.tunnelId !== tunnelId) return null;
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session ownership + reachability lookup (fail-closed).
// ---------------------------------------------------------------------------

interface UsableTunnel {
  agentId: string | null;
  deviceId: string;
  deviceStatus: string;
  targetHost: string;
  targetPort: number;
  orgId: string;
  type: string;
}

/**
 * Load a tunnel session and confirm the cookie/ticket user owns it and it's in
 * a connectable state. Runs in system DB context because this route mounts
 * before auth middleware (no request-scoped RLS context); ownership is enforced
 * in app code by the `session.userId === userId` check. Returns null (→ 404)
 * when the session is missing, owned by someone else, or in a terminal state.
 */
async function loadOwnedTunnelSession(tunnelId: string, userId: string): Promise<UsableTunnel | null> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({ session: tunnelSessions, device: devices })
      .from(tunnelSessions)
      .innerJoin(devices, eq(tunnelSessions.deviceId, devices.id))
      .where(eq(tunnelSessions.id, tunnelId))
      .limit(1);

    if (!row) return null;
    const { session, device } = row;
    if (session.userId !== userId) return null;
    if (!CONNECTABLE_TUNNEL_STATUSES.includes(session.status)) return null;

    return {
      agentId: device.agentId ?? null,
      deviceId: device.id,
      deviceStatus: device.status,
      targetHost: session.targetHost,
      targetPort: session.targetPort,
      orgId: session.orgId,
      type: session.type,
    };
  });
}

// ---------------------------------------------------------------------------
// Response-rewriting helpers.
// ---------------------------------------------------------------------------

/** Rewrite an upstream Location (3xx) so the browser stays inside the proxy. */
function rewriteLocation(loc: string, basePath: string): string {
  try {
    const u = new URL(loc); // absolute URL → keep only path-and-after
    return basePath + u.pathname.replace(/^\//, '') + u.search + u.hash;
  } catch {
    // Relative URL.
    if (loc.startsWith('/')) return basePath + loc.replace(/^\//, '');
    return basePath + loc;
  }
}

/** Force an upstream Set-Cookie's Path onto the proxy base so it scopes here. */
function scopeCookiePath(value: string, basePath: string): string {
  if (/;\s*path=/i.test(value)) {
    return value.replace(/;\s*path=[^;]*/i, `; Path=${basePath}`);
  }
  return `${value}; Path=${basePath}`;
}

/** Inject `<base href>` so relative URLs in the framed page resolve via proxy. */
function injectBaseTag(html: string, basePath: string): string {
  const tag = `<base href="${basePath}">`;
  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch && headMatch.index !== undefined) {
    const idx = headMatch.index + headMatch[0].length;
    return html.slice(0, idx) + tag + html.slice(idx);
  }
  return tag + html;
}

/** Drop our own auth cookie from a forwarded Cookie header; keep the rest. */
function stripAuthCookie(cookieHeader: string, authCookieName: string): string {
  return cookieHeader
    .split(';')
    .map((s) => s.trim())
    .filter((c) => c.length > 0 && !c.startsWith(`${authCookieName}=`))
    .join('; ');
}

// ---------------------------------------------------------------------------
// The proxy route.
// ---------------------------------------------------------------------------

tunnelHttpRoutes.all('/:tunnelId/*', async (c) => {
  const tunnelId = c.req.param('tunnelId');
  const basePath = `/api/v1/tunnel-http/${tunnelId}/`;
  const authCookieName = `bz_tunnel_${tunnelId}`;

  // 1. Authn: cookie first; else one-time ticket → set cookie → redirect.
  let userId = await verifyTunnelCookie(getCookie(c, authCookieName), tunnelId);
  if (!userId) {
    const ticket = c.req.query('__bzt');
    if (!ticket) {
      return c.text('Unauthorized', 401);
    }
    const consumed = await consumeWsTicket(ticket, {
      ip: getTrustedClientIp(c),
      userAgent: c.req.header('user-agent') ?? '',
    });
    if (
      !consumed.ok ||
      consumed.sessionId !== tunnelId ||
      consumed.sessionType !== 'tunnel-http'
    ) {
      return c.text('Unauthorized', 401);
    }

    // Confirm the ticket-bearer actually owns a usable session before minting
    // the cookie (fail-closed — don't hand out a 5-min cookie for a dead/
    // foreign session).
    const ownedAtMint = await loadOwnedTunnelSession(tunnelId, consumed.userId);
    if (!ownedAtMint) {
      return c.text('Not found', 404);
    }

    setCookie(c, authCookieName, await signTunnelCookie(consumed.userId, tunnelId), {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: basePath,
      maxAge: COOKIE_TTL_SECONDS,
    });

    const url = new URL(c.req.url);
    url.searchParams.delete('__bzt');
    return c.redirect(url.pathname + url.search, 302);
  }

  // 2. Authz: owner + device online + agent connected + policy (fail-closed).
  const session = await loadOwnedTunnelSession(tunnelId, userId);
  if (!session) {
    return c.text('Not found', 404);
  }
  if (session.deviceStatus !== 'online' || !session.agentId || !isAgentConnected(session.agentId)) {
    return c.text('Bridge agent offline', 502);
  }
  const policy = await checkRemoteAccess(session.deviceId, 'proxy');
  if (!policy.allowed) {
    return c.text(policy.reason ?? 'Proxy access disabled by policy', 403);
  }

  // 3. Build + dispatch the http_request command.
  const wildcard = c.req.path.startsWith(basePath) ? c.req.path.slice(basePath.length) : '';
  const qs = new URL(c.req.url).search;
  const path = '/' + wildcard + qs;

  const headers: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(c.req.header())) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    if (lk === 'cookie') {
      const stripped = stripAuthCookie(v, authCookieName);
      if (stripped.length > 0) headers[k] = [stripped];
      continue;
    }
    headers[k] = [v];
  }

  const method = c.req.method.toUpperCase();
  let bodyB64 = '';
  if (method !== 'GET' && method !== 'HEAD') {
    const buf = Buffer.from(await c.req.arrayBuffer());
    bodyB64 = buf.toString('base64');
  }

  const scheme: 'http' | 'https' = session.targetPort === 443 ? 'https' : 'http';

  const awaitResult = await sendCommandToAgentAwaitResult(
    session.agentId,
    {
      id: `http-req-${tunnelId}-${randomUUID()}`,
      type: 'http_request',
      payload: {
        tunnelId,
        targetHost: session.targetHost,
        targetPort: session.targetPort,
        scheme,
        method,
        path,
        headers,
        bodyB64,
        allowlistRules: await getActiveAllowlistPatterns(session.orgId),
      },
    },
    HTTP_REQUEST_TIMEOUT_MS,
  );

  if (awaitResult.status !== 'completed') {
    const err = awaitResult.error ?? '';
    if (/timeout/i.test(err)) {
      return c.text('Upstream timeout', 504);
    }
    return c.text('Bridge agent error', 502);
  }

  // 4. Parse the agent's structured HTTP response (carried in stdout).
  let upstream: { status: number; headers: Record<string, string[]>; bodyB64: string; truncated?: boolean };
  try {
    upstream = JSON.parse(awaitResult.stdout ?? '');
  } catch {
    return c.text('Malformed upstream response', 502);
  }

  // 5. Rewrite headers + body, then return.
  let body: Buffer | string = Buffer.from(upstream.bodyB64 ?? '', 'base64');
  const respHeaders = new Headers();
  let contentType = '';

  for (const [k, values] of Object.entries(upstream.headers ?? {})) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    // content-length is recomputed by the runtime; CSP would block the framed
    // page from rendering, so both are stripped.
    if (lk === 'content-length' || lk === 'content-security-policy' || lk === 'content-security-policy-report-only') {
      continue;
    }
    if (lk === 'content-type') {
      contentType = values[0] ?? '';
      respHeaders.set('content-type', contentType);
      continue;
    }
    if (lk === 'location') {
      if (values[0]) respHeaders.set('location', rewriteLocation(values[0], basePath));
      continue;
    }
    if (lk === 'set-cookie') {
      for (const v of values) respHeaders.append('set-cookie', scopeCookiePath(v, basePath));
      continue;
    }
    for (const v of values) respHeaders.append(k, v);
  }

  if (contentType.toLowerCase().includes('text/html')) {
    body = injectBaseTag(body.toString('utf8'), basePath);
  }

  // Buffer isn't a DOM `BodyInit`; hand the runtime a Uint8Array for binary
  // responses and the string as-is for rewritten HTML.
  const responseBody: BodyInit = typeof body === 'string' ? body : new Uint8Array(body);
  return new Response(responseBody, { status: upstream.status, headers: respHeaders });
});
