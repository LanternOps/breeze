import { Hono } from 'hono';
import type { Context } from 'hono';
import { getCookie, setCookie, generateCookie } from 'hono/cookie';
import { SignJWT, jwtVerify } from 'jose';
import { randomUUID, createHmac, timingSafeEqual } from 'crypto';
import { brotliDecompress, gunzip, inflate } from 'node:zlib';
import { promisify } from 'node:util';
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
import { authorizeRemoteSessionContinuation } from '../services/remoteWsAuthorization';
import { PERMISSIONS } from '../services/permissions';
import { rewriteTunnelCss, rewriteTunnelHtml } from './tunnelHttpRewrite';
import { createCorsOriginResolver } from '../services/corsOrigins';
import { isSameOriginRequest } from '../services/requestTransport';
import { UUID_REGEX } from '../utils/uuid';
import { getRedis } from '../services/redis';

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
 *   EVERY request re-checks the active user and organization, current tenant
 *   membership, site scope, role grants, session ownership, device state,
 *   agent connectivity, and policy.
 *
 * HTML/CSS URLs and common browser request APIs are rewritten to the tunnel.
 * Direct JavaScript location assignments and WebSocket upgrades remain unsupported.
 * Per-user rate limiting is intentionally deferred to the Task 8 security pass.
 */
export const tunnelHttpRoutes = new Hono();

const HTTP_REQUEST_TIMEOUT_MS = 25_000;
export const HTTP_TUNNEL_COOKIE_TTL_SECONDS = 300;
export const HTTP_TUNNEL_COOKIE_CLOCK_TOLERANCE_SECONDS = 0;
// Absolute session cap, independent of the sliding cookie refresh. Enforced
// here (before forwarding to the agent) AND in POST /tunnels/:id/http-ticket
// (tunnels.ts) so an already-capped session can't even mint a fresh ticket.
export const HTTP_TUNNEL_MAX_SESSION_HOURS = 12;
// Cookie-less path-token auth is only honoured while the owner's own Breeze
// proxy page is open: its authenticated 5s poll of GET /tunnels/:id refreshes
// this marker (see markTunnelViewerPresent). Generous enough to survive
// background-tab timer throttling (Chrome clamps hidden tabs to ~1/min).
export const TUNNEL_VIEWER_PRESENCE_TTL_SECONDS = 90;
const HTTP_TUNNEL_MAX_SESSION_MS = HTTP_TUNNEL_MAX_SESSION_HOURS * 60 * 60 * 1000;
// Throttle for the lastActivityAt bump — avoid a write on every single
// sub-resource request while a page is actively loading.
const ACTIVITY_BUMP_THROTTLE_MS = 30_000;
const COOKIE_AUDIENCE = 'breeze-tunnel-http';
const CONNECTABLE_TUNNEL_STATUSES = ['pending', 'connecting', 'active'];
const TUNNEL_CONTINUATION_PERMISSIONS = [PERMISSIONS.REMOTE_ACCESS, PERMISSIONS.DEVICES_EXECUTE];

async function authorizeTunnelContinuation(tunnelId: string, userId: string) {
  return authorizeRemoteSessionContinuation(
    { sessionId: tunnelId, sessionType: 'tunnel', userId },
    TUNNEL_CONTINUATION_PERMISSIONS,
  );
}

// GET/HEAD are the only methods a cross-site page can send without the
// browser signaling it in a way this check relies on (a state-changing
// method sent from another site is never legitimate traffic here).
const CROSS_SITE_SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * Refuse a cross-site state-changing request the way `validateCookieCsrfRequest`
 * (`routes/auth/helpers.ts`) refuses one for the main app — but this route
 * cannot use that helper's double-submit cookie: the auth cookie here proves
 * ownership of the tunnel, not of a CSRF token pair, and the thing rendered
 * through the proxy is an arbitrary device web UI that cannot be made to echo
 * one back.
 *
 * Every proxied response carries a CSP `sandbox` directive (`PROXY_RESPONSE_CSP`
 * below), so the browsing context that renders it — and every follow-up
 * request that context issues — has an OPAQUE origin: `Origin` arrives as the
 * literal string `"null"`, or is omitted, on legitimate traffic. That is let
 * through unchanged here; the per-request path token below (not this check)
 * is what closes the opaque-origin gap. A state-changing request carrying a
 * REAL foreign `Origin` — an ordinary cross-site fetch/form POST from another
 * page — is never legitimate on this route and is refused outright.
 */
function tunnelHttpCrossSiteDenialReason(c: Context): string | null {
  if (CROSS_SITE_SAFE_METHODS.has(c.req.method.toUpperCase())) return null;

  const origin = c.req.header('origin');
  if (!origin || origin === 'null') return null;

  const resolveOrigin = createCorsOriginResolver({
    configuredOriginsRaw: process.env.CORS_ALLOWED_ORIGINS,
    nodeEnv: process.env.NODE_ENV,
  });
  if (resolveOrigin(origin) !== null) return null;
  if (isSameOriginRequest(c, origin)) return null;

  return 'Cross-site request blocked';
}

// ---------------------------------------------------------------------------
// Per-request path credential (covers the Origin:null traffic the check
// above has to accept).
//
// A cookie alone cannot fully gate this route: subresource/fetch/XHR/form
// traffic issued by the sandboxed document this route serves originates from
// an OPAQUE origin (no `allow-same-origin` in `PROXY_RESPONSE_CSP`), which the
// Fetch/cookie "same-site" algorithm always treats as cross-site — so the
// cookie has to be `SameSite=None` for that legitimate traffic to work at
// all, and `Origin: null` has to be accepted for the same reason. Origin
// alone therefore cannot tell this route's own sandboxed traffic from a
// request made by another page's sandboxed iframe/`srcdoc` (also
// opaque-origin, also `Origin: null`).
//
// So the route also requires a second, non-cookie secret that only the browser which actually
// completed this tunnel's ticket exchange ever learns: a per-(tunnel,user)
// token folded into `basePath`, so `tunnelHttpRewrite.ts` embeds it in every
// rewritten `src`/`href`/`action`/`formaction`/fetch/XHR URL automatically —
// including form actions, which covers the sandboxed-form-POST case a
// pure Origin check cannot. It is delivered to the browser only via the
// redirect `Location` after ticket consumption and via those rewritten
// in-document URLs; it is never sent to, or derivable by, a page that has not
// already completed that exchange. Derived (HMAC over the JWT signing key),
// not stored, so no schema/persistence change and no separate revocation
// path is needed — it's invalidated the instant `verifyTunnelCookie` would
// also start failing (userId no longer resolvable), and rotates whenever the
// JWT signing key rotates.
//
// This is the smallest of three options:
//   - a fully separate isolated origin for tunnel content is the strongest
//     answer but needs a new domain/deployment change (recorded as a design
//     follow-up, not implemented here);
//   - this is exactly the third option ("cookie scoped to the per-session
//     path together with a non-cookie per-request credential in the path"),
//     reusing the existing per-tunnel path structure and the rewriter's
//     existing `basePath` prefixing with no new moving parts.
const TUNNEL_PATH_TOKEN_HEX_LENGTH = 32; // 128 bits — HMAC truncation, not brute-forceable

// Exported for tests only (to precompute the expected path token given a
// known tunnelId/userId) — not used by any other route or service.
export function computeTunnelPathToken(tunnelId: string, userId: string): string {
  const { key } = getSignKey();
  return createHmac('sha256', Buffer.from(key))
    .update(`tunnel-http-path-token:${tunnelId}:${userId}`)
    .digest('hex')
    .slice(0, TUNNEL_PATH_TOKEN_HEX_LENGTH);
}

function tunnelPathTokenMatches(candidate: string, tunnelId: string, userId: string): boolean {
  const expected = computeTunnelPathToken(tunnelId, userId);
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}

/** Absolute 12h cap off the tunnel row's createdAt, independent of activity. */
function isPastSessionCap(createdAt: Date): boolean {
  return Date.now() - createdAt.getTime() > HTTP_TUNNEL_MAX_SESSION_MS;
}

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

// Promise-based (worker-pool) zlib, not the *Sync forms — decompressing a
// compressed device response off the event loop keeps one slow or oversized
// upstream from stalling every other tenant's request on this process while
// it runs. `maxOutputLength` bounds the decoded size regardless: a small
// compressed body can still expand enormously (a few MB of gzip-of-zeros
// decodes to gigabytes), and the cap turns that into a clean 502 instead of
// an unbounded allocation.
const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);
const brotliDecompressAsync = promisify(brotliDecompress);
// Generous for any real device admin-UI page/stylesheet; far below what a
// compression bomb would otherwise be allowed to decode to.
const TUNNEL_DECOMPRESSED_BODY_MAX_BYTES = 32 * 1024 * 1024;

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
    .setExpirationTime(`${HTTP_TUNNEL_COOKIE_TTL_SECONDS}s`)
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
      clockTolerance: HTTP_TUNNEL_COOKIE_CLOCK_TOLERANCE_SECONDS,
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
  deviceSiteId: string | null;
  targetHost: string;
  targetPort: number;
  scheme: string | null;
  skipTlsVerify: boolean;
  orgId: string;
  type: string;
  createdAt: Date;
  startedAt: Date | null;
  lastActivityAt: Date | null;
}

// System DB context: this route mounts before auth middleware (no
// request-scoped RLS context); every caller enforces ownership in app code.
async function loadTunnelRow(tunnelId: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({ session: tunnelSessions, device: devices })
      .from(tunnelSessions)
      .innerJoin(devices, eq(tunnelSessions.deviceId, devices.id))
      .where(eq(tunnelSessions.id, tunnelId))
      .limit(1);
    return row ?? null;
  });
}

/**
 * Cookie-less authentication by path token alone. Subresource requests from
 * the sandboxed (opaque-origin) proxied document do not reliably carry the
 * SameSite=None tunnel cookie — Firefox's Total Cookie Protection (its
 * default) puts the sandbox in a separate cookie partition, and every browser
 * omits it on `crossorigin` loads — so the device page's own CSS/JS would 401. The token is a 128-bit HMAC delivered only to the browser
 * that completed the ticket exchange (redirect Location + rewritten URLs);
 * it never leaves via Referer (`Referrer-Policy: no-referrer` on every
 * response). The sliding cookie's idle expiry is reproduced from the row's
 * activity timestamp, so a token stops working after the same idle window a
 * cookie would — and it stops within TUNNEL_VIEWER_PRESENCE_TTL_SECONDS of the
 * owner closing their Breeze proxy page, whatever traffic the token carries.
 * It is never exchanged for a cookie (no sliding refresh on these responses).
 * Every later gate (live authority, ownership, 12h cap, device
 * online, policy) still runs for the returned user.
 */
function tunnelViewerPresenceKey(tunnelId: string): string {
  return `tunnel-http:viewer:${tunnelId}`;
}

/**
 * Called ONLY from the owner's JWT-authenticated poll of GET /tunnels/:id —
 * never from proxied traffic, so a leaked path token cannot keep itself alive.
 */
export async function markTunnelViewerPresent(tunnelId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(tunnelViewerPresenceKey(tunnelId), '1', 'EX', TUNNEL_VIEWER_PRESENCE_TTL_SECONDS);
  } catch (err) {
    console.warn('[tunnel-http] failed to mark viewer presence:', err);
  }
}

// Fails closed: without Redis, cookie-less requests are refused exactly as
// they were before path-token auth existed.
async function isTunnelViewerPresent(tunnelId: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    return (await redis.exists(tunnelViewerPresenceKey(tunnelId))) > 0;
  } catch {
    return false;
  }
}

async function authenticateByPathToken(
  candidateToken: string,
  tunnelId: string,
): Promise<string | null> {
  if (!UUID_REGEX.test(tunnelId) || !/^[0-9a-f]+$/.test(candidateToken)) return null;
  if (candidateToken.length !== TUNNEL_PATH_TOKEN_HEX_LENGTH) return null;
  // Cheap Redis check first, so unauthenticated floods never reach the DB.
  if (!(await isTunnelViewerPresent(tunnelId))) return null;
  const row = await loadTunnelRow(tunnelId);
  if (!row) return null;
  const { session } = row;
  if (!CONNECTABLE_TUNNEL_STATUSES.includes(session.status)) return null;
  const lastSeen = session.lastActivityAt ?? session.startedAt;
  if (!lastSeen || Date.now() - lastSeen.getTime() > HTTP_TUNNEL_COOKIE_TTL_SECONDS * 1000) return null;
  return tunnelPathTokenMatches(candidateToken, tunnelId, session.userId) ? session.userId : null;
}

/**
 * Load a tunnel session and confirm the cookie/ticket user owns it and it's in
 * a connectable state (`session.userId === userId`). Returns null (→ 404)
 * when the session is missing, owned by someone else, or in a terminal state.
 */
async function loadOwnedTunnelSession(tunnelId: string, userId: string): Promise<UsableTunnel | null> {
  const row = await loadTunnelRow(tunnelId);
  if (!row) return null;
  const { session, device } = row;
  if (session.userId !== userId) return null;
  if (!CONNECTABLE_TUNNEL_STATUSES.includes(session.status)) return null;

  return {
    agentId: device.agentId ?? null,
    deviceId: device.id,
    deviceStatus: device.status,
    deviceSiteId: device.siteId ?? null,
    targetHost: session.targetHost,
    targetPort: session.targetPort,
    scheme: session.scheme ?? null,
    skipTlsVerify: session.skipTlsVerify ?? false,
    orgId: session.orgId,
    type: session.type,
    createdAt: session.createdAt,
    startedAt: session.startedAt ?? null,
    lastActivityAt: session.lastActivityAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Response-rewriting helpers.
// ---------------------------------------------------------------------------

function upstreamHeaderValue(headers: Record<string, string[]> | undefined, name: string): string | null {
  for (const [k, values] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === name) return values.join(', ');
  }
  return null;
}

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
  // The device page runs in an opaque origin, so every request it makes is
  // cross-site: a Lax/Strict (or browser-default Lax) device session cookie
  // would never be sent back. The path scope above keeps it to this tunnel.
  out = out.replace(/;\s*(samesite=[^;]*|secure)(?=;|$)/gi, '');
  return `${out}; SameSite=None; Secure`;
}

/**
 * The sandboxed device document has an opaque origin, so its CORS-mode loads
 * (`crossorigin` tags, fetch, XHR) arrive with `Origin: null` and are only
 * readable if the response admits that origin. Admitting it is safe here only
 * because every request already had to present this tunnel's path token — a
 * foreign sandboxed page cannot name a URL this route will serve.
 */
function isSandboxOrigin(c: Context): boolean {
  return c.req.header('origin') === 'null';
}

function sandboxCorsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': 'null',
    'access-control-allow-credentials': 'true',
  };
}

/** Never let a device response be stored by a shared cache (CDN): its URL carries the path token. */
function privateCacheControl(value: string | null): string {
  const kept = (value ?? '')
    .split(',')
    .map((directive) => directive.trim())
    .filter((directive) => directive && !/^(public|private|s-maxage\s*=.*)$/i.test(directive));
  return ['private', ...kept].join(', ');
}

// ---------------------------------------------------------------------------
// Response headers, applied to EVERY response this router returns.
//
// The app-wide security-header middleware (index.ts) exempts this whole path
// prefix because the 200 proxied-content response needs its own sandboxed CSP
// to win instead of the app-wide `frame-ancestors 'none'`. That exemption
// must not leave the route's own early-return error responses (401/403/404/
// 410/502/504, ...) with no framing protection at all — a request that never
// reaches the proxied-content branch still deserves a restrictive CSP. Set it
// here, once, after the handler runs, so every branch below is covered
// without threading it through each individual `c.text(...)` call. The 200
// success path already sets the same value explicitly (it needs to construct
// its own `Response` object to attach the rewritten body) — `next()` runs
// first there too, so this is a harmless no-op overwrite with the same value,
// not a conflict.
tunnelHttpRoutes.use('*', async (c, next) => {
  await next();
  c.res.headers.set('content-security-policy', PROXY_RESPONSE_CSP);
  // The path token is a credential (see authenticateByPathToken) and every
  // proxied URL carries it — never let it ride out in a Referer header.
  c.res.headers.set('referrer-policy', 'no-referrer');
});

// ---------------------------------------------------------------------------
// The proxy route.
// ---------------------------------------------------------------------------

tunnelHttpRoutes.all('/:tunnelId/*', async (c) => {
  const tunnelId = c.req.param('tunnelId');
  // Root, pre-path-token — used to recognize this tunnel's requests before we
  // know which (or whether a) path token is present. The token-bearing
  // `basePath` used for the rest of the request is derived below, once we
  // know which user the cookie (or ticket) resolves to.
  //
  // Derived from the actual request path (via the matched `:tunnelId`
  // segment) rather than hardcoded to the production mount
  // (`/api/v1/tunnel-http/`) — this route is also exercised mounted at a
  // bare `/tunnel-http` prefix (router-auth-gate contract test), and a
  // hardcoded prefix would wrongly 404 every request there before the
  // ticket/cookie check ever runs.
  const tunnelIdSegment = `/${tunnelId}/`;
  const tunnelIdSegmentIndex = c.req.path.indexOf(tunnelIdSegment);
  const tunnelRootPath = tunnelIdSegmentIndex === -1
    // Unreachable in practice — Hono already matched `:tunnelId` as a path
    // segment to get here — but fail toward "no requests match" rather than
    // throw if the assumption ever breaks.
    ? tunnelIdSegment
    : c.req.path.slice(0, tunnelIdSegmentIndex + tunnelIdSegment.length);
  const authCookieName = `bz_tunnel_${tunnelId}`;

  // Refused before touching the ticket/cookie or the device at all: the auth
  // cookie is `sameSite:'None'` (subresources load from the sandbox's opaque
  // origin) so the browser sends it on a cross-site request too — Origin is
  // one of the two signals left standing (the path token, checked below, is
  // the other).
  const crossSiteDenial = tunnelHttpCrossSiteDenialReason(c);
  if (crossSiteDenial) {
    return c.text(crossSiteDenial, 403);
  }

  if (!c.req.path.startsWith(tunnelRootPath)) {
    return c.text('Not found', 404);
  }

  // The first path segment after the tunnel id is the per-(tunnel,user) path
  // token (see the path-token block above the route).
  const afterRoot = c.req.path.slice(tunnelRootPath.length);
  const tokenBoundary = afterRoot.indexOf('/');
  const candidateToken = tokenBoundary === -1 ? afterRoot : afterRoot.slice(0, tokenBoundary);

  // 1. Authn: cookie first; else path token alone (cookie-less opaque-origin
  // subresources); else one-time ticket → set cookie → redirect.
  const ticket = c.req.query('__bzt');
  let userId = await verifyTunnelCookie(getCookie(c, authCookieName), tunnelId);
  let pathTokenOnly = false;
  if (!userId && !ticket) {
    userId = await authenticateByPathToken(candidateToken, tunnelId);
    pathTokenOnly = userId !== null;
  }
  if (!userId) {
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

    const liveAuthority = await authorizeTunnelContinuation(tunnelId, consumed.userId);
    if (!liveAuthority.ok) {
      return c.text('Access denied', liveAuthority.status);
    }

    // Confirm the ticket-bearer actually owns a usable session before minting
    // the cookie (fail-closed — don't hand out a 5-min cookie for a dead/
    // foreign session).
    const ownedAtMint = await loadOwnedTunnelSession(tunnelId, consumed.userId);
    if (!ownedAtMint) {
      return c.text('Not found', 404);
    }

    // `active` means "a client established a session" — set it at successful
    // ticket->cookie exchange. `startedAt` only when still null so a later
    // re-mint (session resuming after idle) doesn't reset session duration.
    const mintUpdates: Record<string, unknown> = { status: 'active' };
    if (!ownedAtMint.startedAt) {
      mintUpdates.startedAt = new Date();
    }
    await withSystemDbAccessContext(async () => {
      await db.update(tunnelSessions).set(mintUpdates).where(eq(tunnelSessions.id, tunnelId));
    });

    // Mint the per-request path token now — it's the first point we have an
    // authenticated userId — and fold it into both the cookie's scoping path
    // and the redirect target the browser follows next. Every subsequent
    // request (cookie-authenticated, below) must present the same token as
    // the first path segment after the tunnel id.
    const pathToken = computeTunnelPathToken(tunnelId, consumed.userId);
    const basePath = `${tunnelRootPath}${pathToken}/`;

    // Subresources originate in the sandbox's opaque origin: Lax is insufficient.
    setCookie(c, authCookieName, await signTunnelCookie(consumed.userId, tunnelId), {
      httpOnly: true,
      secure: true,
      sameSite: 'None',
      path: basePath,
      maxAge: HTTP_TUNNEL_COOKIE_TTL_SECONDS,
    });

    const url = new URL(c.req.url);
    url.searchParams.delete('__bzt');
    const devicePathAndQuery = url.pathname.slice(tunnelRootPath.length) + url.search;
    return c.redirect(basePath + devicePathAndQuery, 302);
  }

  // Cookie-authenticated: the request MUST also carry this (tunnelId, userId)
  // pair's path token as the first segment after the tunnel id, or it is
  // treated as unauthenticated — see the path-token block above the route for
  // why the cookie alone (Origin:null accepted, SameSite:None required) isn't
  // sufficient on its own for a state-changing request.
  if (!tunnelPathTokenMatches(candidateToken, tunnelId, userId)) {
    return c.text('Not found', 404);
  }
  const basePath = `${tunnelRootPath}${candidateToken}/`;

  // 2. Authz: owner + absolute cap + device online + agent connected + policy
  // (fail-closed).
  const liveAuthority = await authorizeTunnelContinuation(tunnelId, userId);
  if (!liveAuthority.ok) {
    return c.text('Access denied', liveAuthority.status);
  }
  const session = await loadOwnedTunnelSession(tunnelId, userId);
  if (!session) {
    return c.text('Not found', 404);
  }

  // Absolute 12h cap, checked before any further processing — including
  // before contacting the agent. The terminal row write (not just the 410)
  // is what makes the cap visible to the polling parent page; a cap that only
  // 410s inside the sandboxed iframe would be a silent reconnect loop.
  if (isPastSessionCap(session.createdAt)) {
    await withSystemDbAccessContext(async () => {
      await db.update(tunnelSessions)
        .set({ status: 'disconnected', errorMessage: 'session_expired', endedAt: new Date() })
        .where(eq(tunnelSessions.id, tunnelId));
    });
    return c.text('Session expired', 410);
  }

  if (session.deviceStatus !== 'online' || !session.agentId || !isAgentConnected(session.agentId)) {
    return c.text('Bridge agent offline', 502);
  }
  const policy = await checkRemoteAccess(session.deviceId, 'proxy');
  if (!policy.allowed) {
    return c.text(policy.reason ?? 'Proxy access disabled by policy', 403);
  }

  // CORS preflight from the sandboxed document: answered here, never sent to
  // the device (it has no idea about our origin). Preflights carry no
  // cookies, so this is reached via path-token auth.
  if (c.req.method === 'OPTIONS' && isSandboxOrigin(c) && c.req.header('access-control-request-method')) {
    return new Response(null, {
      status: 204,
      headers: {
        ...sandboxCorsHeaders(),
        'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE',
        'access-control-allow-headers': c.req.header('access-control-request-headers') ?? '',
        'access-control-max-age': '600',
        vary: 'Origin',
      },
    });
  }

  // All gates passed — ONE code point for the sliding cookie refresh and the
  // throttled lastActivityAt bump. A request rejected by any gate above must
  // NOT reach here: bumping activity (or refreshing the cookie) over a
  // rejected request could paper over a policy-denied/offline stretch with a
  // stale-green session over a dead cookie.
  const activityNow = new Date();
  if (!session.lastActivityAt || activityNow.getTime() - session.lastActivityAt.getTime() > ACTIVITY_BUMP_THROTTLE_MS) {
    await withSystemDbAccessContext(async () => {
      await db.update(tunnelSessions)
        .set({ lastActivityAt: activityNow })
        .where(eq(tunnelSessions.id, tunnelId));
    });
  }
  // Built here (not via setCookie(c, …), which no-ops against the hand-built
  // Response returned below) and appended to respHeaders once it exists.
  const refreshedCookie = pathTokenOnly ? null : generateCookie(authCookieName, await signTunnelCookie(userId, tunnelId), {
    httpOnly: true,
    secure: true,
    sameSite: 'None',
    path: basePath,
    maxAge: HTTP_TUNNEL_COOKIE_TTL_SECONDS,
  });

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
  // This cookie-authenticated route has no request-scoped DB context. The
  // session lookup above established trusted org/device/site values under a
  // bounded system read; use those exact values for the FORCE-RLS allowlist
  // lookup rather than issuing a contextless query that would fail closed for
  // every legitimate proxy request.
  const allowlistRules = await withSystemDbAccessContext(() =>
    getActiveAllowlistPatterns(session.orgId, session.deviceSiteId)
  );

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
        allowlistRules,
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
      lk === 'x-frame-options' ||
      // Origin admission and caching are decided by this route, not the device.
      lk.startsWith('access-control-') ||
      lk === 'cache-control'
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
  respHeaders.set('cache-control', privateCacheControl(upstreamHeaderValue(upstream.headers, 'cache-control')));
  if (isSandboxOrigin(c)) {
    for (const [name, value] of Object.entries(sandboxCorsHeaders())) respHeaders.set(name, value);
  }
  respHeaders.append('vary', 'Origin');

  // Sliding refresh: append (not set) so this doesn't clobber any device
  // Set-Cookie headers already appended above. Never on a path-token-only
  // request — that would convert a URL token into a cookie that outlives the
  // owner's viewer presence.
  if (refreshedCookie) respHeaders.append('set-cookie', refreshedCookie);

  const targetHost = session.targetHost.includes(':') && !session.targetHost.startsWith('[')
    ? `[${session.targetHost}]` : session.targetHost;
  const rewriteOptions = { basePath, targetOrigin: `${scheme}://${targetHost}:${session.targetPort}` };
  const isHtml = contentType.toLowerCase().includes('text/html');
  if (isHtml || contentType.toLowerCase().includes('text/css')) {
    const encodings = (respHeaders.get('content-encoding') ?? 'identity')
      .split(',').map((encoding) => encoding.trim().toLowerCase());
    // Check the entire stack first: an unknown encoding must pass through with
    // its original bytes and headers, even when another layer is supported.
    if (encodings.every((encoding) => ['identity', 'gzip', 'deflate', 'br'].includes(encoding))) {
      try {
        const zlibOptions = { maxOutputLength: TUNNEL_DECOMPRESSED_BODY_MAX_BYTES };
        for (const encoding of encodings.reverse()) {
          if (encoding === 'gzip') body = await gunzipAsync(body, zlibOptions);
          else if (encoding === 'deflate') body = await inflateAsync(body, zlibOptions);
          else if (encoding === 'br') body = await brotliDecompressAsync(body, zlibOptions);
        }
      } catch {
        // Covers both malformed upstream encoding and ERR_BUFFER_TOO_LARGE
        // (decoded size past the cap above) — same safe response either way.
        return c.text('Malformed upstream content encoding', 502);
      }
      body = isHtml
        ? rewriteTunnelHtml(body.toString('utf8'), rewriteOptions)
        : rewriteTunnelCss(body.toString('utf8'), rewriteOptions);
      respHeaders.delete('content-encoding');
      respHeaders.set('content-length', String(Buffer.byteLength(body)));
    }
  }

  // Buffer isn't a DOM `BodyInit`; hand the runtime a Uint8Array for binary
  // responses and the string as-is for rewritten HTML.
  const responseBody: BodyInit = typeof body === 'string' ? body : new Uint8Array(body);
  return new Response(responseBody, { status: upstream.status, headers: respHeaders });
});
