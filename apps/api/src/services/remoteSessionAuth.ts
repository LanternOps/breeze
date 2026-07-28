import { createHash, randomBytes, randomUUID } from 'crypto';
import { getRedis } from './redis';
import { VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS } from './jwt';

export type RemoteWsTicketSessionType = 'terminal' | 'desktop' | 'tunnel' | 'tunnel-http';

export const WS_TICKET_TTL_SECONDS = 60;
export const HTTP_TUNNEL_TICKET_TTL_SECONDS = 300;
const WS_TICKET_TTL_MS = WS_TICKET_TTL_SECONDS * 1000;
export const HTTP_TICKET_TTL_MS = HTTP_TUNNEL_TICKET_TTL_SECONDS * 1000;
const DESKTOP_CONNECT_CODE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const VNC_CONNECT_CODE_TTL_MS = 60 * 1000; // 60 seconds
// Viewer-token advertised expiry derives from the real signed TTL
// (VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS in jwt.ts) so /connect/exchange and the
// VNC exchanges never advertise a window shorter than the token actually lives.
// Security finding #6 — the previous hard-coded 15m understated the 2h TTL 8x.

// Short prefix of sha256(userAgent) stored with the ticket — gives us
// approximate identity binding while tolerating browser-update churn far
// better than exact-UA equality.
const UA_HASH_LEN = 16;

export interface RemoteWsTicketRecordV0 {
  version?: never;
  sessionId: string;
  sessionType: RemoteWsTicketSessionType;
  userId: string;
  expiresAt: number;
  // Caller-binding metadata (Task 16). Stored at issue time so we can reject
  // a 60-second ticket when consumed from a different network position.
  // `ip` is the trusted client IP at issue time; `uaHash` is sha256(UA)[:16].
  // Older records (pre-Task-16) may not have these fields; treated as bound
  // only if present — see consumeWsTicket().
  ip?: string;
  uaHash?: string;
}

export interface RemoteWsTicketRecordV1 {
  version: 1;
  jti: string;
  sessionId: string;
  sessionType: 'desktop' | 'tunnel';
  userId: string;
  expiresAt: number;
  ip?: string;
  uaHash?: string;
}

export interface RemoteWsTicketRecordV2 {
  version: 2;
  jti: string;
  sessionId: string;
  sessionType: RemoteWsTicketSessionType;
  userId: string;
  mfaSatisfied: boolean;
  expiresAt: number;
  ip?: string;
  uaHash?: string;
}

export type RemoteWsTicketRecord =
  | RemoteWsTicketRecordV0
  | RemoteWsTicketRecordV1
  | RemoteWsTicketRecordV2;

interface DesktopConnectCodeRecord {
  sessionId: string;
  userId: string;
  email: string;
  expiresAt: number;
}

interface VncConnectCodeRecord {
  tunnelId: string;
  deviceId: string;
  orgId: string;
  userId: string;
  email: string;
  expiresAt: number;
}

const wsTickets = new Map<string, RemoteWsTicketRecord>();
const desktopConnectCodes = new Map<string, DesktopConnectCodeRecord>();
const vncConnectCodes = new Map<string, VncConnectCodeRecord>();

const REDIS_KEY_PREFIX_WS_TICKET = 'remote:ws_ticket:';
const REDIS_KEY_PREFIX_DESKTOP_CODE = 'remote:desktop_code:';
const REDIS_KEY_PREFIX_VNC_CODE = 'vnc-connect:';

/**
 * Decide whether remote-session tickets must live in Redis (shared across
 * replicas) or can live in process memory.
 *
 * Defaults (fail-closed outside dev/test):
 *   - NODE_ENV=production  → Redis required
 *   - NODE_ENV=staging     → Redis required (multi-replica safe)
 *   - NODE_ENV=development → in-memory (devs without Redis still work)
 *   - NODE_ENV=test        → in-memory (test isolation)
 *
 * Explicit override via `WS_TICKETS_REQUIRE_REDIS`:
 *   - 'true' | '1'  → force Redis (e.g. E2E tests against multi-replica setup)
 *   - 'false' | '0' → force in-memory (emergency escape hatch when Redis is down)
 */
export function shouldUseRedis(): boolean {
  const explicit = process.env.WS_TICKETS_REQUIRE_REDIS;
  if (explicit === 'true' || explicit === '1') return true;
  if (explicit === 'false' || explicit === '0') return false;

  const env = (process.env.NODE_ENV ?? 'development').toLowerCase();
  return env !== 'development' && env !== 'test';
}

// Surface the backend decision once at module load so misconfiguration is
// visible in deploy logs (e.g. staging silently falling back to in-memory).
console.log(
  `[remoteSessionAuth] tickets backend: ${shouldUseRedis() ? 'redis' : 'memory'} ` +
    `(NODE_ENV=${process.env.NODE_ENV ?? 'development'}, ` +
    `override=${process.env.WS_TICKETS_REQUIRE_REDIS ?? 'unset'})`
);

function generateSecret(size: number): string {
  return randomBytes(size).toString('base64url');
}

function hashUa(ua: string): string {
  return createHash('sha256').update(ua).digest('hex').slice(0, UA_HASH_LEN);
}

/**
 * Whether ticket consumption must match the issuer's trusted client IP.
 * Defaults to true. Set WS_TICKET_BIND_IP=false to relax IP-binding only
 * (UA-hash binding stays on regardless).
 *
 * Why an env opt-out: behind a misbehaving corporate NAT the IP could
 * change between the ticket-issue HTTPS request and the ticket-consume
 * WS upgrade within the 60-second window. That's rare but a single
 * customer environment with this problem would otherwise have no escape
 * hatch.
 */
function shouldBindTicketIp(): boolean {
  const explicit = (process.env.WS_TICKET_BIND_IP ?? '').trim().toLowerCase();
  if (explicit === 'false' || explicit === '0' || explicit === 'no' || explicit === 'off') {
    return false;
  }
  return true; // default: bind
}

/**
 * Result of consuming a WS ticket. Distinct rejection reasons let the
 * caller audit-log the cause; the ticket is burned on first mismatch so
 * an adversary cannot probe.
 */
export type ConsumeWsTicketResult =
  | (
      {
        ok: true;
        sessionId: string;
        sessionType: RemoteWsTicketSessionType;
        userId: string;
        expiresAt: number;
      }
      & (
        | { version?: 0; ticketJti?: null }
        | { version: 1; ticketJti: string }
        | { version: 2; ticketJti: string; mfaSatisfied: boolean }
      )
    )
  | { ok: false; reason: 'not_found' | 'expired' | 'ip_mismatch' | 'ua_mismatch' };

function isExpired(expiresAt: number): boolean {
  return Date.now() >= expiresAt;
}

function purgeExpiredRecords<T extends { expiresAt: number }>(store: Map<string, T>): void {
  for (const [key, record] of store) {
    if (isExpired(record.expiresAt)) {
      store.delete(key);
    }
  }
}

function consumeRecord<T>(store: Map<string, T & { expiresAt: number }>, key: string): (T & { expiresAt: number }) | null {
  const record = store.get(key);
  if (!record) return null;

  store.delete(key); // one-time token semantics

  if (isExpired(record.expiresAt)) {
    return null;
  }

  return record;
}

async function redisConsumeJson<T>(key: string): Promise<T | null> {
  const redis = getRedis();
  if (!redis) return null;

  // Atomic GET+DEL for one-time semantics (works across replicas).
  const lua = `
    local v = redis.call('GET', KEYS[1])
    if v then
      redis.call('DEL', KEYS[1])
    end
    return v
  `;

  const raw = await redis.eval(lua, 1, key);
  if (!raw || typeof raw !== 'string') return null;

  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    console.error(
      '[session-auth] Failed to parse remote-session Redis JSON:',
      err instanceof Error ? err.message : 'unknown parse error',
    );
    return null;
  }
}

function hasTicketBaseShape(value: Record<string, unknown>): boolean {
  return (
    typeof value.sessionId === 'string'
    && typeof value.sessionType === 'string'
    && ['terminal', 'desktop', 'tunnel', 'tunnel-http'].includes(value.sessionType)
    && typeof value.userId === 'string'
    && typeof value.expiresAt === 'number'
    && Number.isFinite(value.expiresAt)
    && (value.ip === undefined || typeof value.ip === 'string')
    && (value.uaHash === undefined || typeof value.uaHash === 'string')
  );
}

function parseRemoteWsTicketRecord(value: unknown): RemoteWsTicketRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (!hasTicketBaseShape(candidate)) return null;

  if (candidate.version === undefined) {
    return candidate as unknown as RemoteWsTicketRecordV0;
  }
  if (
    candidate.version === 1
    && typeof candidate.jti === 'string'
    && candidate.jti.length > 0
    && (candidate.sessionType === 'desktop' || candidate.sessionType === 'tunnel')
  ) {
    return candidate as unknown as RemoteWsTicketRecordV1;
  }
  if (
    candidate.version === 2
    && typeof candidate.jti === 'string'
    && candidate.jti.length > 0
    && typeof candidate.mfaSatisfied === 'boolean'
  ) {
    return candidate as unknown as RemoteWsTicketRecordV2;
  }
  return null;
}

async function storeWsTicket(
  ticket: string,
  record: RemoteWsTicketRecord,
  ttlSeconds: number,
): Promise<void> {
  if (shouldUseRedis()) {
    const redis = getRedis();
    if (!redis) {
      throw new Error('Remote session tickets are unavailable (Redis required)');
    }
    await redis.setex(`${REDIS_KEY_PREFIX_WS_TICKET}${ticket}`, ttlSeconds, JSON.stringify(record));
  } else {
    wsTickets.set(ticket, record);
  }
}

export async function createWsTicket(input: {
  sessionId: string;
  sessionType: RemoteWsTicketSessionType;
  userId: string;
  mfaSatisfied: true;
  /** Trusted client IP of the issuer (the user agent that just authenticated). */
  ip?: string;
  /** User-Agent of the issuer; stored as sha256(ua)[:16]. */
  userAgent?: string;
  /** Override TTL in milliseconds. Defaults to WS_TICKET_TTL_MS (60s). Use HTTP_TICKET_TTL_MS for tunnel-http tickets. */
  ttlMs?: number;
}): Promise<{ ticket: string; expiresInSeconds: number }> {
  purgeExpiredRecords(wsTickets);
  const ticket = generateSecret(32);
  const effectiveTtlMs = input.ttlMs
    ?? (input.sessionType === 'tunnel-http' ? HTTP_TICKET_TTL_MS : WS_TICKET_TTL_MS);
  const record: RemoteWsTicketRecordV2 = {
    version: 2,
    jti: randomUUID(),
    sessionId: input.sessionId,
    sessionType: input.sessionType,
    userId: input.userId,
    mfaSatisfied: input.mfaSatisfied,
    expiresAt: Date.now() + effectiveTtlMs,
    // Only persist caller binding when the issuer provided it. Callsites
    // that pre-date Task 16 keep working but lose the IP/UA binding.
    ...(input.ip ? { ip: input.ip } : {}),
    ...(input.userAgent ? { uaHash: hashUa(input.userAgent) } : {}),
  };

  const ttlSeconds = Math.floor(effectiveTtlMs / 1000);
  await storeWsTicket(ticket, record, ttlSeconds);

  return {
    ticket,
    expiresInSeconds: ttlSeconds
  };
}

export async function createLegacyViewerCompatibilityWsTicket(input: {
  mode: 'post_upgrade' | 'pre_upgrade';
  sessionId: string;
  sessionType: 'desktop' | 'tunnel';
  userId: string;
  ip?: string;
  userAgent?: string;
}): Promise<{ ticket: string; expiresInSeconds: number }> {
  if (input.mode !== 'post_upgrade') {
    throw new Error('Legacy viewer compatibility tickets require post_upgrade mode');
  }

  purgeExpiredRecords(wsTickets);
  const ticket = generateSecret(32);
  const record: RemoteWsTicketRecordV1 = {
    version: 1,
    jti: randomUUID(),
    sessionId: input.sessionId,
    sessionType: input.sessionType,
    userId: input.userId,
    expiresAt: Date.now() + WS_TICKET_TTL_MS,
    ...(input.ip ? { ip: input.ip } : {}),
    ...(input.userAgent ? { uaHash: hashUa(input.userAgent) } : {}),
  };
  await storeWsTicket(ticket, record, WS_TICKET_TTL_SECONDS);
  return { ticket, expiresInSeconds: WS_TICKET_TTL_SECONDS };
}

/**
 * One-time consumption of a WS ticket. On any caller-binding mismatch the
 * ticket is deleted (so an attacker cannot probe through different
 * combinations within the 60-second TTL).
 *
 * Callers MUST pass the trusted client IP + UA from the WS upgrade
 * request so binding can be checked. Omitting them is a server-side bug
 * and treated as an immediate `ip_mismatch`/`ua_mismatch` rejection when
 * the stored record has binding metadata.
 */
export async function consumeWsTicket(
  ticket: string,
  caller: { ip: string; userAgent: string }
): Promise<ConsumeWsTicketResult> {
  // Atomic GET+DEL — only one concurrent caller wins the record. The IP+UA
  // checks then run against the (already-claimed) record. A previous
  // version of this function split GET and DEL across an await boundary,
  // which let two concurrent claims both succeed and silently violated the
  // documented one-time semantics — fine for legit racers (e.g. React
  // strict-mode double-fire) but not what the design promises.
  let record: RemoteWsTicketRecord | null = null;

  if (shouldUseRedis()) {
    try {
      const rawRecord = await redisConsumeJson<unknown>(`${REDIS_KEY_PREFIX_WS_TICKET}${ticket}`);
      record = parseRemoteWsTicketRecord(rawRecord);
    } catch (err) {
      console.error('[session-auth] Failed to atomically consume WS ticket from Redis:', err);
      return { ok: false, reason: 'not_found' };
    }
  } else {
    // In-memory equivalent: get + delete synchronously before any await, so
    // a second caller landing on the same tick sees nothing. We do NOT
    // filter by expiry here so the outer code can return 'expired' rather
    // than a less-informative 'not_found'.
    record = wsTickets.get(ticket) ?? null;
    if (record) {
      wsTickets.delete(ticket);
    }
  }

  if (!record) {
    return { ok: false, reason: 'not_found' };
  }

  if (isExpired(record.expiresAt)) {
    return { ok: false, reason: 'expired' };
  }

  // IP binding — only enforced if (a) the env flag is on (default) AND
  // (b) the stored record actually carries an IP. The record is already
  // gone (atomic DEL above), so a probe with corrected IP/UA after a
  // mismatch hits "not_found".
  if (shouldBindTicketIp() && record.ip && record.ip !== caller.ip) {
    return { ok: false, reason: 'ip_mismatch' };
  }

  // UA binding — always enforced when the stored record carries a hash.
  if (record.uaHash && record.uaHash !== hashUa(caller.userAgent)) {
    return { ok: false, reason: 'ua_mismatch' };
  }

  const base = {
    ok: true as const,
    sessionId: record.sessionId,
    sessionType: record.sessionType,
    userId: record.userId,
    expiresAt: record.expiresAt,
  };
  if (record.version === 2) {
    return {
      ...base,
      version: 2,
      ticketJti: record.jti,
      mfaSatisfied: record.mfaSatisfied,
    };
  }
  if (record.version === 1) {
    return { ...base, version: 1, ticketJti: record.jti };
  }
  return { ...base, version: 0, ticketJti: null };
}

export async function createDesktopConnectCode(input: {
  sessionId: string;
  userId: string;
  email: string;
}): Promise<{ code: string; expiresInSeconds: number }> {
  purgeExpiredRecords(desktopConnectCodes);
  const code = generateSecret(24);
  const record: DesktopConnectCodeRecord = {
    ...input,
    expiresAt: Date.now() + DESKTOP_CONNECT_CODE_TTL_MS
  };

  const ttlSeconds = Math.floor(DESKTOP_CONNECT_CODE_TTL_MS / 1000);
  if (shouldUseRedis()) {
    const redis = getRedis();
    if (!redis) {
      throw new Error('Desktop connect codes are unavailable (Redis required)');
    }
    await redis.setex(`${REDIS_KEY_PREFIX_DESKTOP_CODE}${code}`, ttlSeconds, JSON.stringify(record));
  } else {
    desktopConnectCodes.set(code, record);
  }

  return {
    code,
    expiresInSeconds: ttlSeconds
  };
}

export async function consumeDesktopConnectCode(code: string): Promise<DesktopConnectCodeRecord | null> {
  if (shouldUseRedis()) {
    const record = await redisConsumeJson<DesktopConnectCodeRecord>(`${REDIS_KEY_PREFIX_DESKTOP_CODE}${code}`);
    if (!record) return null;
    if (isExpired(record.expiresAt)) return null;
    return record;
  }

  return consumeRecord(desktopConnectCodes, code);
}

export function getViewerAccessTokenExpirySeconds(): number {
  return VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS;
}

export async function createVncConnectCode(input: {
  tunnelId: string;
  deviceId: string;
  orgId: string;
  userId: string;
  email: string;
}): Promise<{ code: string; expiresInSeconds: number }> {
  purgeExpiredRecords(vncConnectCodes);
  const code = generateSecret(32);
  const record: VncConnectCodeRecord = {
    ...input,
    expiresAt: Date.now() + VNC_CONNECT_CODE_TTL_MS,
  };

  const ttlSeconds = Math.floor(VNC_CONNECT_CODE_TTL_MS / 1000);
  if (shouldUseRedis()) {
    const redis = getRedis();
    if (!redis) {
      throw new Error('VNC connect codes are unavailable (Redis required)');
    }
    await redis.setex(`${REDIS_KEY_PREFIX_VNC_CODE}${code}`, ttlSeconds, JSON.stringify(record));
  } else {
    vncConnectCodes.set(code, record);
  }

  return {
    code,
    expiresInSeconds: ttlSeconds,
  };
}

export async function consumeVncConnectCode(code: string): Promise<VncConnectCodeRecord | null> {
  if (shouldUseRedis()) {
    const record = await redisConsumeJson<VncConnectCodeRecord>(`${REDIS_KEY_PREFIX_VNC_CODE}${code}`);
    if (!record) return null;
    if (isExpired(record.expiresAt)) return null;
    return record;
  }

  return consumeRecord(vncConnectCodes, code);
}
