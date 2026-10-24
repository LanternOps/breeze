import type { Redis } from 'ioredis';

/**
 * B-W05 (#6159, D-B42): MCP client-extension negotiation.
 *
 * A client declares an extension under `capabilities.extensions[<id>]`. This
 * module turns that untrusted object into a closed, boolean-only shape that the
 * dispatcher threads to the handlers. Every malformed or partial declaration
 * is "not declared": a client that gets it wrong sees today's experience, never
 * an error.
 *
 * Shape note for B-W06 (#6160): `McpClientExtensions` is a flat record of
 * readonly booleans. Tasks adds `tasks` as one more key; nothing else here
 * should need to change.
 */

/** MCP Apps extension id (SEP-1865, `modelcontextprotocol/ext-apps` 2026-01-26). */
export const MCP_UI_EXTENSION_ID = 'io.modelcontextprotocol/ui';
/** The only view mime type the MCP Apps specification defines. */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

export type McpClientExtensions = { readonly ui: boolean };

export const NO_MCP_CLIENT_EXTENSIONS: McpClientExtensions = Object.freeze({ ui: false });

function ownRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
  const child = (value as Record<string, unknown>)[key];
  if (child === null || typeof child !== 'object' || Array.isArray(child)) return undefined;
  return child as Record<string, unknown>;
}

/**
 * `ui` is true only when `caps.extensions["io.modelcontextprotocol/ui"].mimeTypes`
 * is an array containing the exact string `text/html;profile=mcp-app`.
 */
export function parseMcpClientExtensions(caps: unknown): McpClientExtensions {
  const extensions = ownRecord(caps, 'extensions');
  const ui = ownRecord(extensions, MCP_UI_EXTENSION_ID);
  const mimeTypes = ui && Object.prototype.hasOwnProperty.call(ui, 'mimeTypes') ? ui.mimeTypes : undefined;
  const declared = Array.isArray(mimeTypes) && mimeTypes.some((mime) => mime === MCP_APP_MIME_TYPE);
  return declared ? { ui: true } : NO_MCP_CLIENT_EXTENSIONS;
}

/**
 * Legacy streamable era: the declaration arrives once, on `initialize`, and is
 * kept beside the session's ownership key (`mcp-session:<sid>`) under its own
 * key. A side key rather than a richer ownership value so the security-critical
 * ownership format never changes.
 */
export const MCP_SESSION_EXT_REDIS_PREFIX = 'mcp:session-ext:';

/**
 * Persist a declared extension set for a freshly minted legacy session, with
 * the session's own absolute, never-refreshed TTL. A no-op when nothing was
 * declared. Never throws: a failed write only means the client gets the
 * text-only experience.
 */
export async function writeLegacySessionExtensions(
  redis: Redis | null,
  sessionId: string,
  ext: McpClientExtensions,
  ttlSeconds: number,
): Promise<void> {
  if (!ext.ui || !redis) return;
  try {
    await redis.setex(`${MCP_SESSION_EXT_REDIS_PREFIX}${sessionId}`, ttlSeconds, JSON.stringify({ ui: true }));
  } catch (err) {
    console.warn('[MCP] Failed to persist negotiated client extensions:', err instanceof Error ? err.message : err);
  }
}

/**
 * Read a legacy session's negotiated extensions. Callers MUST have verified
 * session ownership first. Never throws: a miss, a malformed value or any Redis
 * error is `{ ui: false }`.
 */
export async function readLegacySessionExtensions(
  redis: Redis | null,
  sessionId: string | undefined,
): Promise<McpClientExtensions> {
  if (!redis || !sessionId) return NO_MCP_CLIENT_EXTENSIONS;
  let raw: string | null;
  try {
    raw = await redis.get(`${MCP_SESSION_EXT_REDIS_PREFIX}${sessionId}`);
  } catch (err) {
    console.warn('[MCP] Failed to read negotiated client extensions:', err instanceof Error ? err.message : err);
    return NO_MCP_CLIENT_EXTENSIONS;
  }
  if (!raw) return NO_MCP_CLIENT_EXTENSIONS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return NO_MCP_CLIENT_EXTENSIONS;
    return (parsed as Record<string, unknown>).ui === true ? { ui: true } : NO_MCP_CLIENT_EXTENSIONS;
  } catch {
    return NO_MCP_CLIENT_EXTENSIONS;
  }
}
