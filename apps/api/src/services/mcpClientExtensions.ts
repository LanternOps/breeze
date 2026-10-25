import type { Redis } from 'ioredis';
import { captureMessage } from './sentry';

/**
 * B-W05 (#6159, D-B42): MCP client-extension negotiation.
 *
 * A client declares an extension under `capabilities.extensions[<id>]`. This
 * module turns that untrusted object into a closed, boolean-only shape that the
 * dispatcher threads to the handlers. Every malformed or partial declaration
 * is "not declared": a client that gets it wrong sees today's experience, never
 * an error.
 *
 * Shape note: `McpClientExtensions` is derived from `MCP_CLIENT_EXTENSION_KEYS`
 * (B-W05 `ui`, B-W06 `tasks`). The legacy side key is written and read only
 * for `MCP_LEGACY_SIDE_KEY_EXTENSION_KEYS` (`ui`): Tasks are modern-only.
 */

/** MCP Apps extension id (SEP-1865, `modelcontextprotocol/ext-apps` 2026-01-26). */
export const MCP_UI_EXTENSION_ID = 'io.modelcontextprotocol/ui';
/** The only view mime type the MCP Apps specification defines. */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';
/** Tasks extension id (SEP-2663, `modelcontextprotocol/ext-tasks` 2026-07-28). B-W06 #6160. */
export const MCP_TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks';

/** Every negotiated extension flag. The side key and the sentinel are built from this list. */
export const MCP_CLIENT_EXTENSION_KEYS = ['ui', 'tasks'] as const;
type McpClientExtensionKey = (typeof MCP_CLIENT_EXTENSION_KEYS)[number];

/**
 * B-W06 (#6160, D-B47): the keys a legacy session may carry. Tasks are
 * modern-only (declared per request), so the legacy side key is written and
 * read for `ui` only: a legacy `initialize` declaring tasks stores nothing for
 * it, and a read never yields `tasks: true` whatever the stored value says.
 */
export const MCP_LEGACY_SIDE_KEY_EXTENSION_KEYS = ['ui'] as const satisfies readonly McpClientExtensionKey[];

function isLegacySideKeyExtension(key: McpClientExtensionKey): boolean {
  return (MCP_LEGACY_SIDE_KEY_EXTENSION_KEYS as readonly McpClientExtensionKey[]).includes(key);
}

export type McpClientExtensions = { readonly [K in McpClientExtensionKey]: boolean };

function buildExtensions(isDeclared: (key: McpClientExtensionKey) => boolean): McpClientExtensions {
  return Object.fromEntries(MCP_CLIENT_EXTENSION_KEYS.map((key) => [key, isDeclared(key)])) as McpClientExtensions;
}

function anyDeclared(ext: McpClientExtensions): boolean {
  return MCP_CLIENT_EXTENSION_KEYS.some((key) => ext[key]);
}

export const NO_MCP_CLIENT_EXTENSIONS: McpClientExtensions = Object.freeze(buildExtensions(() => false));

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
 * `tasks` (B-W06 #6160) is true only when
 * `caps.extensions["io.modelcontextprotocol/tasks"]` is a plain object (`{}`
 * included); `true`, an array, `null` or absent is not a declaration.
 */
export function parseMcpClientExtensions(caps: unknown): McpClientExtensions {
  const extensions = ownRecord(caps, 'extensions');
  const ui = ownRecord(extensions, MCP_UI_EXTENSION_ID);
  const mimeTypes = ui && Object.prototype.hasOwnProperty.call(ui, 'mimeTypes') ? ui.mimeTypes : undefined;
  const uiDeclared = Array.isArray(mimeTypes) && mimeTypes.some((mime) => mime === MCP_APP_MIME_TYPE);
  const tasksDeclared = ownRecord(extensions, MCP_TASKS_EXTENSION_ID) !== undefined;
  const declared = buildExtensions((key) => (key === 'ui' ? uiDeclared : tasksDeclared));
  return anyDeclared(declared) ? declared : NO_MCP_CLIENT_EXTENSIONS;
}

/**
 * B-W06 (#6160): the legacy-era view of a declaration — every key outside
 * MCP_LEGACY_SIDE_KEY_EXTENSION_KEYS forced to false (Tasks are modern-only).
 */
export function toLegacyClientExtensions(ext: McpClientExtensions): McpClientExtensions {
  const legacy = buildExtensions((key) => isLegacySideKeyExtension(key) && ext[key]);
  return anyDeclared(legacy) ? legacy : NO_MCP_CLIENT_EXTENSIONS;
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
 * declared. Never throws: a failed write means this session gets the text-only
 * experience for its whole lifetime, so it is reported to Sentry (bounded tag,
 * never the session id) as well as logged.
 */
export async function writeLegacySessionExtensions(
  redis: Redis | null,
  sessionId: string,
  ext: McpClientExtensions,
  ttlSeconds: number,
): Promise<void> {
  const legacy = toLegacyClientExtensions(ext);
  if (!anyDeclared(legacy) || !redis) return;
  try {
    // B-W06: only the legacy keys are serialised, so the W05 payload
    // ('{"ui":true}') is unchanged whatever else was declared.
    const stored = Object.fromEntries(MCP_LEGACY_SIDE_KEY_EXTENSION_KEYS.map((key) => [key, legacy[key]]));
    await redis.setex(`${MCP_SESSION_EXT_REDIS_PREFIX}${sessionId}`, ttlSeconds, JSON.stringify(stored));
  } catch (err) {
    console.warn('[MCP] Failed to persist negotiated client extensions:', err);
    captureMessage('MCP negotiated client extensions could not be persisted for a legacy session', {
      eventCode: 'mcp_session_ext_write_failed',
      level: 'warning',
    });
  }
}

/**
 * Read a legacy session's negotiated extensions. Callers MUST have verified
 * session ownership first. Never throws: a miss, a malformed value or any Redis
 * error is "nothing declared". Each flag is checked strictly (`=== true`); the
 * stored value is never trusted as an object.
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
    // The ownership read on the same connection just succeeded, so a real
    // outage surfaces (fail closed, 503) on that path; this only degrades Apps.
    console.warn('[MCP] Failed to read negotiated client extensions:', err instanceof Error ? err.message : err);
    return NO_MCP_CLIENT_EXTENSIONS;
  }
  if (!raw) return NO_MCP_CLIENT_EXTENSIONS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Only the server writes this key, so unparsable means corruption.
    console.warn('[MCP] Negotiated client extensions side key is not valid JSON; treating as undeclared');
    return NO_MCP_CLIENT_EXTENSIONS;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return NO_MCP_CLIENT_EXTENSIONS;
  const stored = parsed as Record<string, unknown>;
  return toLegacyClientExtensions(buildExtensions((key) => stored[key] === true));
}
