import http2 from 'node:http2';
import { importPKCS8, SignJWT } from 'jose';
import { getConfig } from '../config/validate';

/**
 * Native Apple Push Notification service (APNs) sender.
 *
 * Replaces the previous dependence on Expo's push relay: we mint our own
 * provider-authentication JWT (ES256, signed with the .p8 key downloaded from
 * the Apple Developer portal) and speak the HTTP/2 APNs protocol directly to
 * api.push.apple.com. See:
 *   https://developer.apple.com/documentation/usernotifications/setting_up_a_remote_notification_server/establishing_a_token-based_connection_to_apns
 *
 * The module is split so the JWT/request construction is pure and unit-testable
 * without any network: `buildApnsRequest` and `getApnsProviderToken` do no I/O,
 * only `sendApnsNotification` opens an HTTP/2 session.
 */

// APNs requires the provider token be no older than 20 minutes and no more than
// 60 minutes old. We refresh at ~40 minutes: comfortably inside the window while
// avoiding a re-sign on every push. Apple rejects tokens minted more than once
// per ~20 min with TooManyProviderTokenUpdates, so we must reuse, not re-sign.
const TOKEN_REFRESH_MS = 40 * 60 * 1000;

// Default APNs expiration when the caller doesn't specify one: store-and-forward
// for up to an hour. A caller can pass ttl:0 for "deliver now or discard".
const DEFAULT_TTL_SECONDS = 60 * 60;

// APNs reasons (or a 410 status) that mean the token is permanently dead and
// should be purged from our DB rather than retried. Mirrors the DeviceNotRegistered
// handling in expoPush.ts.
const UNREGISTERED_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

const PROD_HOST = 'https://api.push.apple.com';
const SANDBOX_HOST = 'https://api.sandbox.push.apple.com';

/**
 * APNs device tokens are bearer-like addresses. Never log them in full — keep
 * only a short trailing suffix for DB correlation. Duplicated locally (rather
 * than imported from expoPush.ts) to keep this module free of the db-heavy
 * import graph so its unit tests stay network/DB-free. SR-004.
 */
function redactPushToken(token: string | undefined): string {
  if (!token) return '<none>';
  if (token.length <= 4) return '****';
  return `…${token.slice(-4)}`;
}

interface ApnsConfig {
  authKey: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  environment: 'sandbox' | 'production';
}

/** Returns the fully-populated APNs config, or null if any required field is missing. */
function getApnsConfig(): ApnsConfig | null {
  const c = getConfig();
  if (!c.APNS_AUTH_KEY || !c.APNS_KEY_ID || !c.APNS_TEAM_ID || !c.APNS_BUNDLE_ID) {
    return null;
  }
  return {
    authKey: c.APNS_AUTH_KEY,
    keyId: c.APNS_KEY_ID,
    teamId: c.APNS_TEAM_ID,
    bundleId: c.APNS_BUNDLE_ID,
    environment: c.APNS_ENVIRONMENT ?? 'production',
  };
}

/** True iff the four required APNs credentials are present. */
export function isApnsConfigured(): boolean {
  return getApnsConfig() !== null;
}

export interface ApnsPayload {
  title: string;
  body: string;
  /** Extra keys merged into the top level of the payload alongside `aps`. */
  data?: Record<string, unknown>;
  /** Coalesces multiple notifications into one via `apns-collapse-id`. */
  collapseId?: string;
  /** Store-and-forward window in seconds. 0 = deliver immediately or discard. */
  ttl?: number;
}

export interface ApnsRequest {
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface ApnsResult {
  ok: boolean;
  status: number;
  reason?: string;
  unregistered?: boolean;
}

// ---------------------------------------------------------------------------
// Provider-authentication JWT (pure — no network)
// ---------------------------------------------------------------------------

let cachedToken: { jwt: string; issuedAtMs: number } | null = null;

/**
 * .p8 PEM contents in an env var can't carry real newlines, so operators paste
 * them with literal "\n" escapes. importPKCS8 needs real newlines — normalize.
 * Idempotent: a PEM that already has real newlines is unchanged.
 */
function normalizePem(pem: string): string {
  return pem.replace(/\\n/g, '\n');
}

/**
 * Returns a cached APNs provider JWT, refreshing when older than ~40 min.
 * Does no network I/O (only local ES256 signing). Throws if not configured —
 * callers on the delivery path go through isApnsConfigured() first.
 */
export async function getApnsProviderToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now - cachedToken.issuedAtMs < TOKEN_REFRESH_MS) {
    return cachedToken.jwt;
  }
  const cfg = getApnsConfig();
  if (!cfg) throw new Error('APNs is not configured');

  const key = await importPKCS8(normalizePem(cfg.authKey), 'ES256');
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: cfg.keyId })
    .setIssuedAt()
    .setIssuer(cfg.teamId)
    .sign(key);

  cachedToken = { jwt, issuedAtMs: now };
  return jwt;
}

/** Test-only: clears the module-level provider-token cache. */
export function __resetApnsProviderTokenCacheForTests(): void {
  cachedToken = null;
}

/**
 * Builds the HTTP/2 request (pseudo-headers + JSON body) for a single push.
 * PURE: no network, no config beyond the bundle id, deterministic given inputs
 * (except apns-expiration, which is now()+ttl). The signed provider JWT is
 * passed in so this stays unit-testable without minting a key.
 */
export function buildApnsRequest(deviceToken: string, payload: ApnsPayload, jwt: string): ApnsRequest {
  const cfg = getApnsConfig();
  if (!cfg) throw new Error('APNs is not configured');

  const path = `/3/device/${deviceToken}`;
  const ttl = payload.ttl ?? DEFAULT_TTL_SECONDS;
  // apns-expiration is an absolute UNIX time; 0 = discard if not immediately deliverable.
  const expiration = ttl > 0 ? Math.floor(Date.now() / 1000) + ttl : 0;

  const headers: Record<string, string> = {
    ':method': 'POST',
    ':path': path,
    authorization: `bearer ${jwt}`,
    'apns-topic': cfg.bundleId,
    'apns-push-type': 'alert',
    'apns-priority': '10',
    'apns-expiration': String(expiration),
  };
  if (payload.collapseId) {
    headers['apns-collapse-id'] = payload.collapseId;
  }

  const body = JSON.stringify({
    aps: {
      alert: { title: payload.title, body: payload.body },
      sound: 'default',
    },
    ...(payload.data ?? {}),
  });

  return { path, headers, body };
}

// ---------------------------------------------------------------------------
// HTTP/2 delivery (isolated network I/O)
// ---------------------------------------------------------------------------

let session: http2.ClientHttp2Session | null = null;

function apnsHost(): string {
  const cfg = getApnsConfig();
  return cfg?.environment === 'sandbox' ? SANDBOX_HOST : PROD_HOST;
}

/**
 * Returns a live, reusable HTTP/2 session to APNs, (re)connecting lazily. On
 * close / GOAWAY / error we drop the reference so the next call reconnects.
 */
function getSession(): http2.ClientHttp2Session {
  if (session && !session.closed && !session.destroyed) {
    return session;
  }
  const next = http2.connect(apnsHost());
  next.on('close', () => {
    if (session === next) session = null;
  });
  next.on('goaway', () => {
    if (session === next) session = null;
    try {
      next.close();
    } catch {
      /* already closing */
    }
  });
  next.on('error', (err) => {
    console.error('[apns] session error', { host: apnsHost(), error: (err as Error).message });
    if (session === next) session = null;
  });
  session = next;
  return next;
}

function performHttp2Request(req: ApnsRequest): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let stream: http2.ClientHttp2Stream;
    try {
      stream = getSession().request(req.headers);
    } catch (err) {
      reject(err);
      return;
    }
    let status = 0;
    let data = '';
    stream.setEncoding('utf8');
    stream.on('response', (headers) => {
      status = Number(headers[':status']) || 0;
    });
    stream.on('data', (chunk) => {
      data += chunk;
    });
    stream.on('end', () => resolve({ status, body: data }));
    stream.on('error', reject);
    stream.end(req.body);
  });
}

function interpretResponse(res: { status: number; body: string }, deviceToken: string): ApnsResult {
  if (res.status === 200) {
    return { ok: true, status: 200 };
  }

  let reason: string | undefined;
  if (res.body) {
    try {
      reason = (JSON.parse(res.body) as { reason?: string }).reason;
    } catch {
      /* non-JSON error body — leave reason undefined */
    }
  }

  const unregistered = res.status === 410 || (reason != null && UNREGISTERED_REASONS.has(reason));
  if (unregistered) {
    console.warn('[apns] token unregistered', {
      token: redactPushToken(deviceToken),
      status: res.status,
      reason,
    });
    return { ok: false, status: res.status, reason, unregistered: true };
  }

  console.error('[apns] delivery failed', {
    token: redactPushToken(deviceToken),
    status: res.status,
    reason,
  });
  return { ok: false, status: res.status, reason };
}

/**
 * Sends a single notification to APNs. Never throws for a delivery failure —
 * returns a structured result. Returns {ok:false, reason:'not_configured'} when
 * APNs credentials are absent, and {unregistered:true} for dead tokens the
 * caller should purge.
 */
export async function sendApnsNotification(deviceToken: string, payload: ApnsPayload): Promise<ApnsResult> {
  if (!isApnsConfigured()) {
    return { ok: false, status: 0, reason: 'not_configured' };
  }

  let jwt: string;
  try {
    jwt = await getApnsProviderToken();
  } catch (err) {
    console.error('[apns] failed to mint provider token', {
      token: redactPushToken(deviceToken),
      error: (err as Error).message,
    });
    return { ok: false, status: 0, reason: 'provider_token_error' };
  }

  const req = buildApnsRequest(deviceToken, payload, jwt);
  try {
    const res = await performHttp2Request(req);
    return interpretResponse(res, deviceToken);
  } catch (err) {
    console.error('[apns] send failed', {
      token: redactPushToken(deviceToken),
      error: (err as Error).message,
    });
    return { ok: false, status: 0, reason: 'network_error' };
  }
}
