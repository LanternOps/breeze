/**
 * The single parser for MCP_UNATTENDED_TIER3_PRINCIPALS, used both by the
 * runtime approval gate (routes/mcpServer.ts) and by the boot warning
 * (config/validate.ts), so what startup reports is exactly what the gate
 * enforces.
 *
 * Entries (comma-separated):
 *   api_key:<api key id>                     api key ids are UUIDs
 *   oauth_client_user:<client_id>/<user id>  user ids are UUIDs; the client_id
 *                                            is free text and may contain '/',
 *                                            so the user id is the text after
 *                                            the LAST '/'.
 * UUIDs are compared case-insensitively (stored lowercase in Postgres); the
 * client_id is compared exactly. Anything else is malformed and never matches.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface ParsedUnattendedPrincipals {
  /** Canonical principal refs, comparable with mcpPrincipalRefFor(). */
  principals: Set<string>;
  /** Entries as written that can never match a principal. */
  malformed: string[];
}

function canonicalEntry(entry: string): string | null {
  if (entry.startsWith('api_key:')) {
    const id = entry.slice('api_key:'.length);
    return UUID_RE.test(id) ? `api_key:${id.toLowerCase()}` : null;
  }
  if (entry.startsWith('oauth_client_user:')) {
    const rest = entry.slice('oauth_client_user:'.length);
    const slash = rest.lastIndexOf('/');
    if (slash <= 0) return null;
    const clientId = rest.slice(0, slash);
    const userId = rest.slice(slash + 1);
    if (/\s/u.test(clientId) || !UUID_RE.test(userId)) return null;
    return `oauth_client_user:${clientId}/${userId.toLowerCase()}`;
  }
  return null;
}

export function parseUnattendedPrincipals(raw: string | undefined): ParsedUnattendedPrincipals {
  const principals = new Set<string>();
  const malformed: string[] = [];
  for (const entry of (raw ?? '').split(',').map((e) => e.trim()).filter((e) => e.length > 0)) {
    const canonical = canonicalEntry(entry);
    if (canonical) principals.add(canonical);
    else malformed.push(entry);
  }
  return { principals, malformed };
}

/** Canonical ref for a principal id pair, or null when the ids are not UUIDs. */
export function canonicalPrincipalRef(kind: 'api_key', id: string): string | null;
export function canonicalPrincipalRef(kind: 'oauth_client_user', clientId: string, userId: string): string | null;
export function canonicalPrincipalRef(kind: 'api_key' | 'oauth_client_user', a: string, b?: string): string | null {
  return kind === 'api_key' ? canonicalEntry(`api_key:${a}`) : canonicalEntry(`oauth_client_user:${a}/${b ?? ''}`);
}
