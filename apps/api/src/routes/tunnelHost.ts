/**
 * Network Proxy host mode (spec 2026-10-06 §3–§6). Reached only through
 * tunnelHostDispatch for an asserted tunnel Host, so no app route, auth
 * middleware, CORS or app security header ever runs here. Every path-mode
 * gate runs via tunnelHttpCore; only authentication, admission, rewriting and
 * response headers differ.
 *
 * Request order: host-mode off / unknown host → 404; §4a admission (service
 * worker → 404, cross-site → 403); `/__bz/enter` (ticket → cookie); cookie
 * auth; `/__bz/ping`; reserved `/__bz/*` → 404; gates; budgets; dispatch.
 */
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { getCookie, generateCookie } from 'hono/cookie';
import { randomBytes } from 'node:crypto';
import { consumeWsTicket } from '../services/remoteSessionAuth';
import { getTrustedClientIp } from '../services/clientIp';
import { isTunnelOriginEnabledForOrg } from '../services/tunnelOriginOptIn';
import { acquireTunnelHttpSlot, checkTunnelHttpRate } from '../services/tunnelHttpBudget';
import { recordTunnelHttpOutcome } from '../services/tunnelHttpMetrics';
import { withHostModeBaseHeaders } from '../services/tunnelHostBaseHeaders';
import { captureException } from '../services/sentry';
import {
  buildTunnelOrigin, getTunnelOriginConfig, matchTunnelHost, type TunnelCookieContext,
} from '../config/tunnelOrigin';
import {
  HOST_COOKIE_AUDIENCE, HTTP_TUNNEL_COOKIE_TTL_SECONDS, activateTunnelSessionOnExchange,
  authorizeTunnelContinuation, bumpTunnelActivity, decodeUpstreamBody, deviceTargetOrigin,
  dispatchTunnelHttpRequest, loadOwnedTunnelSession, runTunnelRequestGates, signTunnelCookie, verifyTunnelCookie,
  type TunnelDispatchOutcome,
} from './tunnelHttpCore';
import { TUNNEL_ENTER_PATH, admitTunnelHostRequest } from './tunnelHostAdmission';
import {
  TUNNEL_FRAME_COOKIE, TUNNEL_TAB_COOKIE, buildHostModeResponseHeaders, buildHostModeUpstreamHeaders, hostModeCsp,
} from './tunnelHostHeaders';
import { rewriteTunnelCss, rewriteTunnelHtml } from './tunnelHttpRewrite';

/** postMessage type the bootstrap page sends the app when the iframe cannot work (W03 consumes it). */
export const TUNNEL_COOKIE_BLOCKED_MESSAGE_TYPE = 'breeze-tunnel-cookie-blocked';
const PING_PATH = '/__bz/ping';

export const tunnelHostRoutes = new Hono();

// Every response — including 401/403/404/429/5xx and onError — gets the
// host-mode security headers. A handler-set CSP (the enter page's nonce CSP,
// which carries its own frame-ancestors) wins.
// (The tunnel-host classifier applies the same headers again to whatever
// leaves the tunnel surface, including responses from outer gates.)
tunnelHostRoutes.use('*', async (c, next) => {
  await next();
  const res = withHostModeBaseHeaders(c.res, getTunnelOriginConfig()?.frameAncestor ?? null);
  if (res !== c.res) c.res = res;
});

// Never echo an internal error to the device page; count it and report it
// (the sub-app's Response is returned as-is, so the app-level onError and its
// Sentry capture never see these). The error name only in the console: a
// message can carry a device path.
tunnelHostRoutes.onError((err, c) => {
  console.error(`[tunnel-host] unhandled ${err instanceof Error ? err.name : typeof err}`);
  captureException(err, c);
  recordTunnelHttpOutcome('host', 'internal_error');
  return c.text('Internal error', 500);
});

function cookieName(context: TunnelCookieContext): string {
  return context === 'tab' ? TUNNEL_TAB_COOKIE : TUNNEL_FRAME_COOKIE;
}

/** `__Host-`: no Domain, `Path=/`, `Secure` — a sibling tunnel host can neither set nor overwrite it. */
async function proxyAuthCookie(userId: string, tunnelId: string, context: TunnelCookieContext): Promise<string> {
  const value = await signTunnelCookie(userId, tunnelId, { audience: HOST_COOKIE_AUDIENCE, context });
  return context === 'tab'
    ? generateCookie(TUNNEL_TAB_COOKIE, value, {
      path: '/', secure: true, httpOnly: true, sameSite: 'Lax', maxAge: HTTP_TUNNEL_COOKIE_TTL_SECONDS,
    })
    : generateCookie(TUNNEL_FRAME_COOKIE, value, {
      path: '/', secure: true, httpOnly: true, sameSite: 'None', partitioned: true, maxAge: HTTP_TUNNEL_COOKIE_TTL_SECONDS,
    });
}

/** The cookie's JWT binds tunnel id, audience AND context, so a frame token under the tab name fails. */
async function authenticate(c: Context, tunnelId: string): Promise<{ userId: string; context: TunnelCookieContext } | null> {
  for (const context of ['frame', 'tab'] as const) {
    const userId = await verifyTunnelCookie(getCookie(c, cookieName(context)), tunnelId, { audience: HOST_COOKIE_AUDIENCE, context });
    if (userId) return { userId, context };
  }
  return null;
}

/**
 * `/__bz` and everything under it, however it is spelled: case, ASCII
 * percent-escapes (decoded repeatedly — `_`, `b`, `z` and `/` are all ASCII),
 * backslashes, repeated slashes and dot segments. Non-ASCII or stray `%`
 * sequences are left alone so a device path like `/100%` still works. A path
 * that keeps changing after a few rounds is treated as reserved.
 */
const ASCII_ESCAPE = /%([0-7][0-9a-f])/gi;
function isReservedPath(rawPathname: string): boolean {
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

/**
 * 200 bootstrap, NOT a 302 (plan G1, confirmed by W00 in every engine): a
 * redirect inherits the cross-site taint of the app's iframe navigation, so
 * §4a would refuse the device's `/`. The page confirms the cookie stuck
 * (CHIPS / third-party cookies) via a same-origin ping and, in the iframe,
 * that web storage works (amended 2026-10-12b item 1: Chrome with 3PC blocked
 * keeps the Partitioned cookie but throws on localStorage in the iframe), then
 * navigates same-origin. Otherwise it tells the app (and only the app — the
 * postMessage target is the configured frame ancestor) to offer a new tab.
 * In a tab, a storage failure has no better fallback, so it proceeds.
 */
function enterPage(nonce: string, tunnelId: string, frameAncestor: string, context: TunnelCookieContext): string {
  const cfg = JSON.stringify({ tunnelId, ancestor: frameAncestor, framed: context === 'frame', type: TUNNEL_COOKIE_BLOCKED_MESSAGE_TYPE })
    .replace(/</g, '\\u003c');
  return '<!doctype html><html><head><meta charset="utf-8"><title>Connecting…</title></head>'
    + `<body><p id="m">Connecting…</p><script nonce="${nonce}">(function(){var c=${cfg};`
    + "function blocked(reason){document.getElementById('m').textContent='This browser blocked the proxy session. Open the device in a new tab from Breeze.';"
    + 'if(c.framed&&window.parent!==window){try{window.parent.postMessage({type:c.type,tunnelId:c.tunnelId,reason:reason},c.ancestor);}catch(e){}}}'
    + "function storageOk(){try{localStorage.setItem('__bz_probe','1');localStorage.removeItem('__bz_probe');return true;}catch(e){return false;}}"
    + "fetch('/__bz/ping',{credentials:'same-origin',cache:'no-store'}).then(function(r){"
    + "if(r.status!==204){blocked('cookie');}else if(c.framed&&!storageOk()){blocked('storage');}else{location.replace('/');}"
    + "},function(){blocked('cookie');});"
    + '})();</script></body></html>';
}

function authFailed(c: Context): Response {
  recordTunnelHttpOutcome('host', 'auth_failed');
  return c.text('Unauthorized', 401);
}

function gateDenied(c: Context, message: string, status: ContentfulStatusCode): Response {
  recordTunnelHttpOutcome('host', 'gate_denied');
  return c.text(message, status);
}

async function handleEnter(c: Context, tunnelId: string, frameAncestor: string): Promise<Response> {
  const ticket = c.req.query('t');
  const mode = c.req.query('mode');
  // Validated before the one-time ticket is spent.
  if (!ticket || (mode !== undefined && mode !== 'tab')) return authFailed(c);
  const context: TunnelCookieContext = mode === 'tab' ? 'tab' : 'frame';
  // The cookie context must match the navigation: the partitioned frame cookie
  // only for an iframe, the unpartitioned Lax tab cookie only top-level.
  // (Absent Sec-Fetch-Dest — older browsers — falls back to the ticket alone.)
  const dest = c.req.header('sec-fetch-dest')?.trim().toLowerCase();
  if (dest !== undefined && dest !== (context === 'tab' ? 'document' : 'iframe')) {
    recordTunnelHttpOutcome('host', 'admission_refused');
    return c.text('Cross-site request blocked', 403);
  }

  const consumed = await consumeWsTicket(ticket, { ip: getTrustedClientIp(c), userAgent: c.req.header('user-agent') ?? '' });
  if (!consumed.ok || consumed.sessionId !== tunnelId || consumed.sessionType !== 'tunnel-http') return authFailed(c);

  const liveAuthority = await authorizeTunnelContinuation(tunnelId, consumed.userId);
  if (!liveAuthority.ok) return gateDenied(c, 'Access denied', liveAuthority.status as ContentfulStatusCode);
  const owned = await loadOwnedTunnelSession(tunnelId, consumed.userId);
  if (!owned) return gateDenied(c, 'Not found', 404);
  // Amendment 3 (defense in depth): the partner can switch host mode off
  // between ticket mint and exchange, and this host has no app auth context.
  // Keyed by the verified session row's org. Checked before activation so a
  // refused exchange leaves the row untouched.
  if (!(await isTunnelOriginEnabledForOrg(owned.orgId))) return gateDenied(c, 'Not found', 404);
  // Conditional on the row still being connectable: never reopens a closed session.
  if (!(await activateTunnelSessionOnExchange(tunnelId, !owned.startedAt))) return gateDenied(c, 'Not found', 404);

  const nonce = randomBytes(16).toString('base64');
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy':
      `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; ${hostModeCsp(frameAncestor)}`,
  });
  headers.append('set-cookie', await proxyAuthCookie(consumed.userId, tunnelId, context));
  return new Response(enterPage(nonce, tunnelId, frameAncestor, context), { status: 200, headers });
}

// Statuses a fetch Response can carry; 1xx (incl. 101 upgrades) is not proxied.
function isServableStatus(status: unknown): status is number {
  return typeof status === 'number' && Number.isInteger(status) && status >= 200 && status <= 599;
}
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

tunnelHostRoutes.all('*', async (c) => {
  const config = getTunnelOriginConfig();
  if (!config) return c.text('Not found', 404);
  const tunnelId = matchTunnelHost(c.req.header('host'), config);
  if (!tunnelId) return c.text('Not found', 404);
  const tunnelOrigin = buildTunnelOrigin(config, tunnelId);
  const url = new URL(c.req.url);

  const admission = admitTunnelHostRequest({
    method: c.req.method,
    path: url.pathname,
    tunnelOrigin,
    secFetchSite: c.req.header('sec-fetch-site'),
    secFetchDest: c.req.header('sec-fetch-dest'),
    origin: c.req.header('origin'),
    serviceWorker: c.req.header('service-worker'),
  });
  if (!admission.ok) {
    recordTunnelHttpOutcome('host', 'admission_refused');
    return c.text(admission.status === 404 ? 'Not found' : 'Cross-site request blocked', admission.status);
  }

  if (url.pathname === TUNNEL_ENTER_PATH) return handleEnter(c, tunnelId, config.frameAncestor);
  const auth = await authenticate(c, tunnelId);
  if (url.pathname === PING_PATH) return auth ? c.body(null, 204) : authFailed(c);
  if (isReservedPath(url.pathname)) return c.text('Not found', 404);
  if (!auth) return authFailed(c);

  const gate = await runTunnelRequestGates(tunnelId, auth.userId);
  if (!gate.ok) return gateDenied(c, gate.message, gate.status);
  const { session } = gate;
  const targetOrigin = deviceTargetOrigin(session);

  const budgetKeys = { userId: auth.userId, tunnelId, agentId: session.agentId };
  const rate = await checkTunnelHttpRate(budgetKeys);
  if (!rate.ok && rate.scope === 'unavailable') {
    // The budget store (Redis) is down: fail closed, but say what it is.
    recordTunnelHttpOutcome('host', 'budget_unavailable');
    c.header('retry-after', String(rate.retryAfterSeconds));
    return c.text('Service unavailable', 503);
  }
  if (!rate.ok) {
    recordTunnelHttpOutcome('host', 'rate_limited');
    c.header('retry-after', String(rate.retryAfterSeconds));
    return c.text('Too many requests', 429);
  }
  const slot = acquireTunnelHttpSlot(budgetKeys);
  if (!slot.ok) {
    recordTunnelHttpOutcome('host', 'rate_limited');
    c.header('retry-after', '1');
    return c.text('Too many concurrent requests', 429);
  }
  let outcome: TunnelDispatchOutcome;
  try {
    // All gates and budgets passed: the one point for the activity bump.
    await bumpTunnelActivity(tunnelId, session.lastActivityAt);
    const method = c.req.method.toUpperCase();
    const bodyB64 = method === 'GET' || method === 'HEAD' ? '' : Buffer.from(await c.req.arrayBuffer()).toString('base64');
    outcome = await dispatchTunnelHttpRequest(tunnelId, session, {
      method,
      path: url.pathname + url.search,
      headers: buildHostModeUpstreamHeaders(c.req.header(), { tunnelOrigin, targetOrigin }),
      bodyB64,
    });
  } finally {
    slot.release();
  }
  if (!outcome.ok) {
    recordTunnelHttpOutcome('host', 'dispatch_failed');
    console.warn(`[tunnel-host] dispatch failed tunnel=${tunnelId} reason=${outcome.reason}`);
    return c.text(outcome.message, outcome.status);
  }

  const { upstream } = outcome;
  if (!isServableStatus(upstream.status)) {
    recordTunnelHttpOutcome('host', 'dispatch_failed');
    console.warn(`[tunnel-host] dispatch failed tunnel=${tunnelId} reason=unservable_status status=${String(upstream.status).slice(0, 16)}`);
    return c.text('Malformed upstream response', 502);
  }
  const { headers, contentType } = buildHostModeResponseHeaders(upstream.headers ?? {}, {
    context: auth.context, targetOrigin, frameAncestor: config.frameAncestor,
  });
  // Sliding refresh: appended after the device's own (already filtered) cookies.
  headers.append('set-cookie', await proxyAuthCookie(auth.userId, tunnelId, auth.context));

  if (NULL_BODY_STATUSES.has(upstream.status)) {
    headers.delete('content-encoding');
    recordTunnelHttpOutcome('host', 'proxied');
    return new Response(null, { status: upstream.status, headers });
  }

  let body: Buffer | string = Buffer.from(upstream.bodyB64 ?? '', 'base64');
  const lowered = contentType.toLowerCase();
  const isHtml = lowered.includes('text/html');
  if (isHtml || lowered.includes('text/css')) {
    const decoded = await decodeUpstreamBody(body, headers.get('content-encoding'));
    if (!decoded.ok) {
      recordTunnelHttpOutcome('host', 'dispatch_failed');
      console.warn(`[tunnel-host] dispatch failed tunnel=${tunnelId} reason=content_encoding`);
      return c.text('Malformed upstream content encoding', 502);
    }
    if (decoded.decoded) {
      // Host mode: the device owns the origin; only absolute device-origin URLs are mapped.
      const options = { basePath: '/', targetOrigin };
      body = isHtml
        ? rewriteTunnelHtml(decoded.body.toString('utf8'), options, { injectBase: false })
        : rewriteTunnelCss(decoded.body.toString('utf8'), options);
      headers.delete('content-encoding');
      headers.set('content-length', String(Buffer.byteLength(body)));
    }
  }
  recordTunnelHttpOutcome('host', 'proxied');
  return new Response(typeof body === 'string' ? body : new Uint8Array(body), { status: upstream.status, headers });
});
