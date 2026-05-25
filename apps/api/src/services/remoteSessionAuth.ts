import { createHash, randomBytes } from 'crypto';
import { getRedis } from './redis';

type SessionType = 'terminal' | 'desktop' | 'tunnel';

const WS_TICKET_TTL_MS = 60 * 1000; // 60 seconds
const DESKTOP_CONNECT_CODE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const VNC_CONNECT_CODE_TTL_MS = 60 * 1000; // 60 seconds
const ACCESS_TOKEN_EXPIRY_SECONDS = 15 * 60; // Must match createAccessToken expiry

// Short prefix of sha256(userAgent) stored with the ticket — gives us
// approximate identity binding while tolerating browser-update churn far
// better than exact-UA equality.
const UA_HASH_LEN = 16;

interface WsTicketRecord {
  sessionId: string;
  sessionType: SessionType;
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

const wsTickets = new Map<string, WsTicketRecord>();
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
  | { ok: true; sessionId: string; sessionType: SessionType; userId: string; expiresAt: number }
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
    console.error('[session-auth] Failed to parse Redis JSON for key:', key, err);
    return null;
  }
}

export async function createWsTicket(input: {
  sessionId: string;
  sessionType: SessionType;
  userId: string;
  /** Trusted client IP of the issuer (the user agent that just authenticated). */
  ip?: string;
  /** User-Agent of the issuer; stored as sha256(ua)[:16]. */
  userAgent?: string;
}): Promise<{ ticket: string; expiresInSeconds: number }> {
  purgeExpiredRecords(wsTickets);
  const ticket = generateSecret(32);
  const record: WsTicketRecord = {
    sessionId: input.sessionId,
    sessionType: input.sessionType,
    userId: input.userId,
    expiresAt: Date.now() + WS_TICKET_TTL_MS,
    // Only persist caller binding when the issuer provided it. Callsites
    // that pre-date Task 16 keep working but lose the IP/UA binding.
    ...(input.ip ? { ip: input.ip } : {}),
    ...(input.userAgent ? { uaHash: hashUa(input.userAgent) } : {}),
  };

  const ttlSeconds = Math.floor(WS_TICKET_TTL_MS / 1000);
  if (shouldUseRedis()) {
    const redis = getRedis();
    if (!redis) {
      // Production hardening: if Redis is unavailable, don't fall back to in-memory tickets.
      // This avoids cross-replica inconsistencies that can break security assumptions.
      throw new Error('Remote session tickets are unavailable (Redis required)');
    }
    await redis.setex(`${REDIS_KEY_PREFIX_WS_TICKET}${ticket}`, ttlSeconds, JSON.stringify(record));
  } else {
    wsTickets.set(ticket, record);
  }

  return {
    ticket,
    expiresInSeconds: ttlSeconds
  };
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
  // We need read-then-(maybe-)delete semantics so we can return the
  // correct rejection reason. The legacy GET+DEL Lua / `consumeRecord`
  // helper deletes unconditionally; here we read first, decide, and
  // delete in both the success and mismatch paths so a stolen ticket
  // cannot be probed again with corrected values.
  let record: WsTicketRecord | null = null;

  if (shouldUseRedis()) {
    const redis = getRedis();
    if (!redis) {
      return { ok: false, reason: 'not_found' };
    }
    const raw = await redis.get(`${REDIS_KEY_PREFIX_WS_TICKET}${ticket}`);
    if (raw && typeof raw === 'string') {
      try {
        record = JSON.parse(raw) as WsTicketRecord;
      } catch (err) {
        console.error('[session-auth] Failed to parse Redis WS ticket JSON:', err);
        // Burn the unparseable key so it can't be hammered.
        await redis.del(`${REDIS_KEY_PREFIX_WS_TICKET}${ticket}`);
        return { ok: false, reason: 'not_found' };
      }
    }
  } else {
    record = wsTickets.get(ticket) ?? null;
  }

  if (!record) {
    return { ok: false, reason: 'not_found' };
  }

  const burn = async () => {
    if (shouldUseRedis()) {
      const redis = getRedis();
      if (redis) {
        await redis.del(`${REDIS_KEY_PREFIX_WS_TICKET}${ticket}`);
      }
    } else {
      wsTickets.delete(ticket);
    }
  };

  if (isExpired(record.expiresAt)) {
    await burn();
    return { ok: false, reason: 'expired' };
  }

  // IP binding — only enforced if (a) the env flag is on (default) AND
  // (b) the stored record actually carries an IP. Records minted before
  // Task 16 (or by paths that don't have request context) skip this.
  if (shouldBindTicketIp() && record.ip && record.ip !== caller.ip) {
    await burn();
    return { ok: false, reason: 'ip_mismatch' };
  }

  // UA binding — always enforced when the stored record carries a hash.
  if (record.uaHash && record.uaHash !== hashUa(caller.userAgent)) {
    await burn();
    return { ok: false, reason: 'ua_mismatch' };
  }

  // All checks pass — consume the ticket (one-time semantics).
  await burn();

  return {
    ok: true,
    sessionId: record.sessionId,
    sessionType: record.sessionType,
    userId: record.userId,
    expiresAt: record.expiresAt,
  };
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
  return ACCESS_TOKEN_EXPIRY_SECONDS;
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
