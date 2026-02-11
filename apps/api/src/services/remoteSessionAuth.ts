import { randomBytes } from 'crypto';
import type { TokenPayload } from './jwt';
import { getRedis } from './redis';

type SessionType = 'terminal' | 'desktop';

const WS_TICKET_TTL_MS = 60 * 1000; // 60 seconds
const DESKTOP_CONNECT_CODE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const ACCESS_TOKEN_EXPIRY_SECONDS = 15 * 60; // Must match createAccessToken expiry

interface WsTicketRecord {
  sessionId: string;
  sessionType: SessionType;
  userId: string;
  expiresAt: number;
}

interface DesktopConnectCodeRecord {
  sessionId: string;
  userId: string;
  tokenPayload: Omit<TokenPayload, 'type'>;
  expiresAt: number;
}

const wsTickets = new Map<string, WsTicketRecord>();
const desktopConnectCodes = new Map<string, DesktopConnectCodeRecord>();

const REDIS_KEY_PREFIX_WS_TICKET = 'remote:ws_ticket:';
const REDIS_KEY_PREFIX_DESKTOP_CODE = 'remote:desktop_code:';

function shouldUseRedis(): boolean {
  // In production SaaS, tickets must be shared across replicas.
  return (process.env.NODE_ENV ?? 'development') === 'production';
}

function generateSecret(size: number): string {
  return randomBytes(size).toString('base64url');
}

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
}): Promise<{ ticket: string; expiresInSeconds: number }> {
  purgeExpiredRecords(wsTickets);
  const ticket = generateSecret(32);
  const record: WsTicketRecord = {
    ...input,
    expiresAt: Date.now() + WS_TICKET_TTL_MS
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

export async function consumeWsTicket(ticket: string): Promise<WsTicketRecord | null> {
  if (shouldUseRedis()) {
    const record = await redisConsumeJson<WsTicketRecord>(`${REDIS_KEY_PREFIX_WS_TICKET}${ticket}`);
    if (!record) return null;
    if (isExpired(record.expiresAt)) return null;
    return record;
  }

  return consumeRecord(wsTickets, ticket);
}

export async function createDesktopConnectCode(input: {
  sessionId: string;
  userId: string;
  tokenPayload: Omit<TokenPayload, 'type'>;
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
