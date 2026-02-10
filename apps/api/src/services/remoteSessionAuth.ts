import { randomBytes } from 'crypto';
import type { TokenPayload } from './jwt';

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

export function createWsTicket(input: {
  sessionId: string;
  sessionType: SessionType;
  userId: string;
}): { ticket: string; expiresInSeconds: number } {
  purgeExpiredRecords(wsTickets);
  const ticket = generateSecret(32);
  wsTickets.set(ticket, {
    ...input,
    expiresAt: Date.now() + WS_TICKET_TTL_MS
  });

  return {
    ticket,
    expiresInSeconds: Math.floor(WS_TICKET_TTL_MS / 1000)
  };
}

export function consumeWsTicket(ticket: string): WsTicketRecord | null {
  return consumeRecord(wsTickets, ticket);
}

export function createDesktopConnectCode(input: {
  sessionId: string;
  userId: string;
  tokenPayload: Omit<TokenPayload, 'type'>;
}): { code: string; expiresInSeconds: number } {
  purgeExpiredRecords(desktopConnectCodes);
  const code = generateSecret(24);
  desktopConnectCodes.set(code, {
    ...input,
    expiresAt: Date.now() + DESKTOP_CONNECT_CODE_TTL_MS
  });

  return {
    code,
    expiresInSeconds: Math.floor(DESKTOP_CONNECT_CODE_TTL_MS / 1000)
  };
}

export function consumeDesktopConnectCode(code: string): DesktopConnectCodeRecord | null {
  return consumeRecord(desktopConnectCodes, code);
}

export function getViewerAccessTokenExpirySeconds(): number {
  return ACCESS_TOKEN_EXPIRY_SECONDS;
}
