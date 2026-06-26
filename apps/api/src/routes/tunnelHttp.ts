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

// Request headers we forward to the LAN device. ALLOWLIST, not denylist — the
// device is untrusted and must never receive the user's Breeze credentials
// (`cookie`, `authorization`). Device session cookies are handled separately via
// the prefixed jar below so they round-trip without leaking app cookies.
const FORWARDABLE_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'accept-encoding',
  'user-agent',
  'content-type',
  'content-length',
  'range',
  'if-modified-since',
  'if-none-match',
  'cache-control',
]);

// The device's own cookies are stored in the browser under this prefix so they
// are namespaced away from (and never confused with) Breeze app cookies. We
// de-prefix on the way to the device and re-prefix on the way back.
const DEVICE_COOKIE_PREFIX = 'bzdev_';

// Restrictive CSP applied to every proxied response: sandbox the device content
// (null origin — can't read app cookies/storage or reach the parent) while still
// letting the device's own scripts/forms run, and forbid third-party framing.
const PROXY_RESPONSE_CSP = "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox; frame-ancestors 'self'";

/** Rebuild a Cookie header containing only the device's own (prefixed) cookies, de-prefixed. */
function extractDeviceCookies(cookieHeader: string): string {
  return cookieHeader
    .split(';')
    .map((s) => s.trim())
    .filter((c) => c.startsWith(DEVICE_COOKIE_PREFIX))
    .map((c) => c.slice(DEVICE_COOKIE_PREFIX.length))
    .join('; ');
}

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
  scheme: string | null;
  skipTlsVerify: boolean;
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
      scheme: session.scheme ?? null,
      skipTlsVerify: session.skipTlsVerify ?? false,
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

/**
 * Rewrite an upstream Set-Cookie so it (a) is namespaced under the device-cookie
 * prefix and (b) scopes to the proxy base path. Namespacing keeps device cookies
 * from colliding with — or being mistaken for — Breeze app cookies, and lets the
 * forward path send ONLY device cookies to the device.
 */
function prefixAndScopeDeviceCookie(value: string, basePath: string): string {
  // Prefix the cookie name (everything before the first '=').
  const eq = value.indexOf('=');
  let out = eq > 0 ? `${DEVICE_COOKIE_PREFIX}${value}` : value;
  // Force Path onto the proxy base.
  if (/;\s*path=/i.test(out)) {
    out = out.replace(/;\s*path=[^;]*/i, `; Path=${basePath}`);
  } else {
    out = `${out}; Path=${basePath}`;
  }
  return out;
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

  // Forward ONLY allowlisted content-negotiation headers — never the user's
  // `cookie`/`authorization` (which would leak Breeze session credentials to the
  // untrusted device). The device's own cookies are reconstructed from the
  // prefixed jar so its session round-trips without exposing app cookies.
  const headers: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(c.req.header())) {
    if (FORWARDABLE_REQUEST_HEADERS.has(k.toLowerCase())) {
      headers[k] = [v];
    }
  }
  const deviceCookies = extractDeviceCookies(c.req.header('cookie') ?? '');
  if (deviceCookies) {
    headers['cookie'] = [deviceCookies];
  }

  const method = c.req.method.toUpperCase();
  let bodyB64 = '';
  if (method !== 'GET' && method !== 'HEAD') {
    const buf = Buffer.from(await c.req.arrayBuffer());
    bodyB64 = buf.toString('base64');
  }

  const scheme: 'http' | 'https' = (session.scheme as 'http' | 'https' | null) ?? (session.targetPort === 443 ? 'https' : 'http');

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
        skipTlsVerify: session.skipTlsVerify,
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
    if (err === 'tls_cert_untrusted') {
      // Surface via the session row so ProxyTunnelPage's existing poll renders
      // the "recreate with self-signed allowed" banner. A cert failure on load
      // is terminal for the session — the cert won't become trusted on retry.
      //
      // Must run under system DB context: this route mounts before auth
      // middleware so there is no request-scoped RLS context. Without system
      // context this becomes a silent 0-row write once tunnel_sessions gains
      // RLS, causing the recreate banner to never appear (#1916 follow-up).
      await withSystemDbAccessContext(async () => {
        await db.update(tunnelSessions)
          .set({ status: 'failed', errorMessage: 'tls_cert_untrusted', endedAt: new Date() })
          .where(eq(tunnelSessions.id, tunnelId));
      });
      return c.text('Untrusted upstream certificate', 502);
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
    // content-length is recomputed by the runtime. We drop the device's CSP and
    // x-frame-options and impose our own restrictive sandbox CSP below — the
    // device's policy must not govern content rendered on our origin.
    if (
      lk === 'content-length' ||
      lk === 'content-security-policy' ||
      lk === 'content-security-policy-report-only' ||
      lk === 'x-frame-options'
    ) {
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
      for (const v of values) respHeaders.append('set-cookie', prefixAndScopeDeviceCookie(v, basePath));
      continue;
    }
    for (const v of values) respHeaders.append(k, v);
  }

  // Sandbox the proxied (untrusted) device content so its scripts run in a null
  // origin and cannot read app cookies/storage or reach the parent frame.
  respHeaders.set('content-security-policy', PROXY_RESPONSE_CSP);

  if (contentType.toLowerCase().includes('text/html')) {
    body = injectBaseTag(body.toString('utf8'), basePath);
  }

  // Buffer isn't a DOM `BodyInit`; hand the runtime a Uint8Array for binary
  // responses and the string as-is for rewritten HTML.
  const responseBody: BodyInit = typeof body === 'string' ? body : new Uint8Array(body);
  return new Response(responseBody, { status: upstream.status, headers: respHeaders });
});
