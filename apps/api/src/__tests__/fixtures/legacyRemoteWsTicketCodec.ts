/**
 * Frozen pre-Wave-4 ticket codec from reviewed base
 * 96371e53f360cae91c6af21e4e2917c76c1bebe5.
 *
 * Keep this deliberately ignorant of additive version/JTI/MFA fields: it is
 * compatibility evidence for the historical reader, not a second production
 * implementation.
 */
export interface LegacyRemoteWsTicketRecord {
  sessionId: string;
  sessionType: 'terminal' | 'desktop' | 'tunnel' | 'tunnel-http';
  userId: string;
  expiresAt: number;
  ip?: string;
  uaHash?: string;
}

export function encodeLegacyRemoteWsTicket(record: LegacyRemoteWsTicketRecord): string {
  return JSON.stringify(record);
}

export function readWithFrozenLegacyRemoteWsTicketCodec(raw: string): LegacyRemoteWsTicketRecord {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return {
    sessionId: parsed.sessionId as string,
    sessionType: parsed.sessionType as LegacyRemoteWsTicketRecord['sessionType'],
    userId: parsed.userId as string,
    expiresAt: parsed.expiresAt as number,
    ...(typeof parsed.ip === 'string' ? { ip: parsed.ip } : {}),
    ...(typeof parsed.uaHash === 'string' ? { uaHash: parsed.uaHash } : {}),
  };
}
