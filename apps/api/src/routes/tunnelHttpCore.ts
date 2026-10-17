/**
 * Shared core for both Network Proxy modes (spec 2026-10-06 §3): path mode
 * (routes/tunnelHttp.ts) and host mode (routes/tunnelHost.ts). Every gate here
 * runs identically in both — only authentication, rewriting and response
 * headers differ by mode.
 */
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'crypto';
import { brotliDecompress, gunzip, inflate } from 'node:zlib';
import { promisify } from 'node:util';
import { and, eq, inArray } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { tunnelSessions, devices } from '../db/schema';
import { sendCommandToAgentAwaitResult } from '../services/agentCommandAwait';
import { getActiveAllowlistPatterns } from '../services/tunnelAllowlist';
import { isAgentConnected } from './agentWs';
import { checkRemoteAccess } from '../services/remoteAccessPolicy';
import { getSignKey, getVerifyKey, buildHeader } from '../services/jwt';
import { authorizeRemoteSessionContinuation } from '../services/remoteWsAuthorization';
import { PERMISSIONS } from '../services/permissions';
import type { TunnelCookieContext } from '../config/tunnelOrigin';

export const HTTP_REQUEST_TIMEOUT_MS = 25_000;
export const HTTP_TUNNEL_COOKIE_TTL_SECONDS = 300;
export const HTTP_TUNNEL_COOKIE_CLOCK_TOLERANCE_SECONDS = 0;
// Absolute session cap, independent of the sliding cookie refresh. Enforced
// here (before forwarding to the agent) AND in POST /tunnels/:id/http-ticket
// (tunnels.ts) so an already-capped session can't even mint a fresh ticket.
export const HTTP_TUNNEL_MAX_SESSION_HOURS = 12;
const HTTP_TUNNEL_MAX_SESSION_MS = HTTP_TUNNEL_MAX_SESSION_HOURS * 60 * 60 * 1000;
// Throttle for the lastActivityAt bump — avoid a write on every single
// sub-resource request while a page is actively loading.
const ACTIVITY_BUMP_THROTTLE_MS = 30_000;
export const PATH_COOKIE_AUDIENCE = 'breeze-tunnel-http';
export const HOST_COOKIE_AUDIENCE = 'breeze-tunnel-host';
export const CONNECTABLE_TUNNEL_STATUSES = ['pending', 'connecting', 'active'] as const;
export const TUNNEL_CLOSED_ERROR = 'tunnel_closed';

export function tunnelHttpCommandPrefix(tunnelId: string): string {
  return `http-req-${tunnelId}-`;
}

const TUNNEL_CONTINUATION_PERMISSIONS = [PERMISSIONS.REMOTE_ACCESS, PERMISSIONS.DEVICES_EXECUTE];

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

export function authorizeTunnelContinuation(tunnelId: string, userId: string) {
  return authorizeRemoteSessionContinuation(
    { sessionId: tunnelId, sessionType: 'tunnel', userId },
    TUNNEL_CONTINUATION_PERMISSIONS,
  );
}

/** Absolute 12h cap off the tunnel row's createdAt, independent of activity. */
export function isPastSessionCap(createdAt: Date): boolean {
  return Date.now() - createdAt.getTime() > HTTP_TUNNEL_MAX_SESSION_MS;
}

// Hop-by-hop headers (RFC 7230 §6.1) plus `host` — never forwarded in either
// direction. Lowercased for case-insensitive matching.
export const HOP_BY_HOP = new Set([
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
// the prefixed jar so they round-trip without leaking app cookies.
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

export function collectForwardableHeaders(reqHeaders: Record<string, string>): Record<string, string[]> {
  const headers: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(reqHeaders)) {
    if (FORWARDABLE_REQUEST_HEADERS.has(k.toLowerCase())) headers[k] = [v];
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Cookie signing (reuses the JWT keyring from services/jwt.ts — no bespoke
// crypto). Distinct audience so a tunnel cookie can never be replayed as an API
// access/viewer token, and vice-versa. Path and host mode use different
// audiences; host mode additionally binds a frame/tab context claim.
// ---------------------------------------------------------------------------

export async function signTunnelCookie(
  userId: string,
  tunnelId: string,
  opts: { audience?: string; context?: TunnelCookieContext } = {},
): Promise<string> {
  const { key, kid } = getSignKey();
  const claims: Record<string, string> = { tunnelId };
  if (opts.context) claims.ctx = opts.context;
  return new SignJWT(claims)
    .setProtectedHeader(buildHeader(kid))
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${HTTP_TUNNEL_COOKIE_TTL_SECONDS}s`)
    .setIssuer('breeze')
    .setAudience(opts.audience ?? PATH_COOKIE_AUDIENCE)
    .sign(key);
}

export async function verifyTunnelCookie(
  token: string | undefined,
  tunnelId: string,
  opts: { audience?: string; context?: TunnelCookieContext } = {},
): Promise<string | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getVerifyKey, {
      issuer: 'breeze',
      audience: opts.audience ?? PATH_COOKIE_AUDIENCE,
      algorithms: ['HS256'],
      clockTolerance: HTTP_TUNNEL_COOKIE_CLOCK_TOLERANCE_SECONDS,
    });
    if (payload.tunnelId !== tunnelId) return null;
    if ((payload.ctx ?? undefined) !== opts.context) return null;
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session ownership + reachability lookup (fail-closed).
// ---------------------------------------------------------------------------

export interface UsableTunnel {
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
export type ReachableTunnel = UsableTunnel & { agentId: string };

// System DB context: these routes mount before auth middleware (no
// request-scoped RLS context); every caller enforces ownership in app code.
export async function loadTunnelRow(tunnelId: string) {
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
 * Load a tunnel session and confirm the cookie/ticket user owns it and it's in
 * a connectable state (`session.userId === userId`). Returns null (→ 404)
 * when the session is missing, owned by someone else, or in a terminal state.
 */
export async function loadOwnedTunnelSession(tunnelId: string, userId: string): Promise<UsableTunnel | null> {
  const row = await loadTunnelRow(tunnelId);
  if (!row) return null;
  const { session, device } = row;
  if (session.userId !== userId) return null;
  if (!(CONNECTABLE_TUNNEL_STATUSES as readonly string[]).includes(session.status)) return null;

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

export type TunnelGateResult =
  | { ok: true; session: ReachableTunnel }
  | { ok: false; status: ContentfulStatusCode; message: string;
      reason: 'live_authority' | 'not_found' | 'session_expired' | 'agent_offline' | 'policy' };

/**
 * Authz: live authority + owner + absolute cap + device online + agent
 * connected + policy (fail-closed). Same gates, same order, same responses as
 * path mode had before the extraction.
 */
export async function runTunnelRequestGates(tunnelId: string, userId: string): Promise<TunnelGateResult> {
  const liveAuthority = await authorizeTunnelContinuation(tunnelId, userId);
  if (!liveAuthority.ok) {
    return { ok: false, status: liveAuthority.status as ContentfulStatusCode, message: 'Access denied', reason: 'live_authority' };
  }
  const session = await loadOwnedTunnelSession(tunnelId, userId);
  if (!session) return { ok: false, status: 404, message: 'Not found', reason: 'not_found' };

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
    return { ok: false, status: 410, message: 'Session expired', reason: 'session_expired' };
  }
  if (session.deviceStatus !== 'online' || !session.agentId || !isAgentConnected(session.agentId)) {
    return { ok: false, status: 502, message: 'Bridge agent offline', reason: 'agent_offline' };
  }
  const policy = await checkRemoteAccess(session.deviceId, 'proxy');
  if (!policy.allowed) {
    return { ok: false, status: 403, message: policy.reason ?? 'Proxy access disabled by policy', reason: 'policy' };
  }
  return { ok: true, session: session as ReachableTunnel };
}

/**
 * Throttled lastActivityAt bump — call only after every gate passed. A request
 * rejected by any gate must NOT reach here: bumping activity over a
 * rejected request could paper over a policy-denied/offline stretch with a
 * stale-green session.
 */
export async function bumpTunnelActivity(tunnelId: string, lastActivityAt: Date | null): Promise<void> {
  const now = new Date();
  if (lastActivityAt && now.getTime() - lastActivityAt.getTime() <= ACTIVITY_BUMP_THROTTLE_MS) return;
  await withSystemDbAccessContext(async () => {
    await db.update(tunnelSessions).set({ lastActivityAt: now }).where(eq(tunnelSessions.id, tunnelId));
  });
}

export function tunnelScheme(session: Pick<UsableTunnel, 'scheme' | 'targetPort'>): 'http' | 'https' {
  return (session.scheme as 'http' | 'https' | null) ?? (session.targetPort === 443 ? 'https' : 'http');
}

export function deviceTargetOrigin(session: Pick<UsableTunnel, 'scheme' | 'targetPort' | 'targetHost'>): string {
  const host = session.targetHost.includes(':') && !session.targetHost.startsWith('[')
    ? `[${session.targetHost}]` : session.targetHost;
  return `${tunnelScheme(session)}://${host}:${session.targetPort}`;
}

export interface UpstreamHttpResponse {
  status: number;
  headers: Record<string, string[]>;
  bodyB64: string;
  truncated?: boolean;
}

export type TunnelDispatchOutcome =
  | { ok: true; upstream: UpstreamHttpResponse }
  | { ok: false; status: 502 | 504; message: string;
      reason: 'timeout' | 'tls_cert_untrusted' | 'agent_error' | 'malformed_response' | 'tunnel_closed' };

/**
 * Allowlist lookup + http_request dispatch + error mapping. Callers MUST obtain
 * `session` from `runTunnelRequestGates` (which enforces ownership, status and
 * policy) and must never cast an arbitrary row into `ReachableTunnel`.
 */
export async function dispatchTunnelHttpRequest(
  tunnelId: string,
  session: ReachableTunnel,
  request: { method: string; path: string; headers: Record<string, string[]>; bodyB64: string },
): Promise<TunnelDispatchOutcome> {
  // These routes have no request-scoped DB context. The session lookup
  // established trusted org/device/site values under a bounded system read;
  // use those exact values for the FORCE-RLS allowlist lookup rather than
  // issuing a contextless query that would fail closed for every legitimate
  // proxy request.
  const allowlistRules = await withSystemDbAccessContext(() =>
    getActiveAllowlistPatterns(session.orgId, session.deviceSiteId)
  );

  const awaitResult = await sendCommandToAgentAwaitResult(
    session.agentId,
    {
      id: `${tunnelHttpCommandPrefix(tunnelId)}${randomUUID()}`,
      type: 'http_request',
      payload: {
        tunnelId,
        targetHost: session.targetHost,
        targetPort: session.targetPort,
        scheme: tunnelScheme(session),
        method: request.method,
        path: request.path,
        headers: request.headers,
        bodyB64: request.bodyB64,
        skipTlsVerify: session.skipTlsVerify,
        allowlistRules,
      },
    },
    HTTP_REQUEST_TIMEOUT_MS,
  );

  if (awaitResult.status !== 'completed') {
    const err = awaitResult.error ?? '';
    if (err === TUNNEL_CLOSED_ERROR) return { ok: false, status: 502, message: 'Tunnel closed', reason: 'tunnel_closed' };
    if (/timeout/i.test(err)) {
      return { ok: false, status: 504, message: 'Upstream timeout', reason: 'timeout' };
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
      return { ok: false, status: 502, message: 'Untrusted upstream certificate', reason: 'tls_cert_untrusted' };
    }
    return { ok: false, status: 502, message: 'Bridge agent error', reason: 'agent_error' };
  }

  // Parse the agent's structured HTTP response (carried in stdout).
  try {
    return { ok: true, upstream: JSON.parse(awaitResult.stdout ?? '') as UpstreamHttpResponse };
  } catch {
    return { ok: false, status: 502, message: 'Malformed upstream response', reason: 'malformed_response' };
  }
}

/**
 * Decode a full gzip/deflate/br/identity stack. Check the entire stack first:
 * an unknown encoding must pass through with its original bytes and headers,
 * even when another layer is supported.
 */
export async function decodeUpstreamBody(
  body: Buffer,
  contentEncoding: string | null,
): Promise<{ ok: true; body: Buffer; decoded: boolean } | { ok: false }> {
  const encodings = (contentEncoding ?? 'identity').split(',').map((e) => e.trim().toLowerCase());
  if (!encodings.every((e) => ['identity', 'gzip', 'deflate', 'br'].includes(e))) {
    return { ok: true, body, decoded: false };
  }
  try {
    const zlibOptions = { maxOutputLength: TUNNEL_DECOMPRESSED_BODY_MAX_BYTES };
    let out = body;
    for (const encoding of [...encodings].reverse()) {
      if (encoding === 'gzip') out = await gunzipAsync(out, zlibOptions);
      else if (encoding === 'deflate') out = await inflateAsync(out, zlibOptions);
      else if (encoding === 'br') out = await brotliDecompressAsync(out, zlibOptions);
    }
    return { ok: true, body: out, decoded: true };
  } catch {
    // Covers both malformed upstream encoding and ERR_BUFFER_TOO_LARGE
    // (decoded size past the cap above) — same safe response either way.
    return { ok: false };
  }
}

export function upstreamHeaderValue(headers: Record<string, string[]> | undefined, name: string): string | null {
  for (const [k, values] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === name) return values.join(', ');
  }
  return null;
}

/**
 * Ticket-exchange activation, CONDITIONAL on the row still being connectable
 * (spec §4): an exchange racing Close can never flip a closed row back to
 * active. Returns false when nothing matched (caller answers 404, no cookie).
 */
export async function activateTunnelSessionOnExchange(tunnelId: string, setStartedAt: boolean): Promise<boolean> {
  const updates: Record<string, unknown> = { status: 'active' };
  if (setStartedAt) updates.startedAt = new Date();
  const rows = await withSystemDbAccessContext(async () =>
    db.update(tunnelSessions)
      .set(updates)
      .where(and(eq(tunnelSessions.id, tunnelId), inArray(tunnelSessions.status, [...CONNECTABLE_TUNNEL_STATUSES])))
      .returning({ id: tunnelSessions.id }));
  return rows.length > 0;
}
