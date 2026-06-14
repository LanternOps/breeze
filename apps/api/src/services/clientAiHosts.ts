/**
 * AI for Office — the host vocabulary. The client surface runs inside one of
 * four Office hosts; a session's host is encoded in ai_sessions.type as
 * `${host}_client` (no separate column). Keep this list and the DB principal
 * CHECK constraint (migration 2026-06-13-d-ai-for-office-host-keying.sql) in sync.
 */
export const CLIENT_HOSTS = ['excel', 'word', 'powerpoint', 'outlook'] as const;
export type ClientHost = (typeof CLIENT_HOSTS)[number];

export function isClientHost(value: unknown): value is ClientHost {
  return typeof value === 'string' && (CLIENT_HOSTS as readonly string[]).includes(value);
}

/** host -> ai_sessions.type value, e.g. 'excel' -> 'excel_client'. */
export function clientSessionType(host: ClientHost): string {
  return `${host}_client`;
}

/** Every client session type, for "any client session" WHERE filters. */
export const CLIENT_SESSION_TYPES: string[] = CLIENT_HOSTS.map(clientSessionType);

/** ai_sessions.type -> host, or null when the row is not a client session. */
export function clientHostFromType(type: string): ClientHost | null {
  if (!type.endsWith('_client')) return null;
  const host = type.slice(0, -'_client'.length);
  return isClientHost(host) ? host : null;
}
