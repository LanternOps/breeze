import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

/**
 * B-W03 (#6157): protocol versions split by era.
 * - Modern (`2026-07-28`) is stateless: no `initialize`, no `Mcp-Session-Id`;
 *   the version rides in every request's `_meta`. Served only when
 *   `MCP_STATELESS_ENABLED`.
 * - Legacy (`2024-11-05`..`2025-11-25`) negotiates via `initialize`.
 */
export const MODERN_MCP_PROTOCOL_VERSIONS = ['2026-07-28'] as const;
export const LEGACY_MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = [...MODERN_MCP_PROTOCOL_VERSIONS, ...LEGACY_MCP_PROTOCOL_VERSIONS] as const;
export type ModernMcpProtocolVersion = (typeof MODERN_MCP_PROTOCOL_VERSIONS)[number];
export type LegacyMcpProtocolVersion = (typeof LEGACY_MCP_PROTOCOL_VERSIONS)[number];
export type McpProtocolVersion = ModernMcpProtocolVersion | LegacyMcpProtocolVersion;
export const LATEST_LEGACY_MCP_PROTOCOL_VERSION: LegacyMcpProtocolVersion = LEGACY_MCP_PROTOCOL_VERSIONS[0];
export const ASSUMED_MCP_PROTOCOL_VERSION: LegacyMcpProtocolVersion = '2025-03-26';

export function isLegacyMcpProtocolVersion(v: unknown): v is LegacyMcpProtocolVersion {
  return LEGACY_MCP_PROTOCOL_VERSIONS.some((version) => version === v);
}

export function isModernMcpProtocolVersion(v: unknown): v is ModernMcpProtocolVersion {
  return MODERN_MCP_PROTOCOL_VERSIONS.some((version) => version === v);
}

/**
 * Legacy-only alias kept for the `initialize` handshake and the legacy header
 * parser — neither may ever accept a modern version (D-B14).
 */
export const isSupportedMcpProtocolVersion = isLegacyMcpProtocolVersion;

/** Versions advertised to clients (e.g. `-32022 data.supported`, `server/discover`). */
export function supportedMcpProtocolVersions(statelessEnabled: boolean): readonly McpProtocolVersion[] {
  return statelessEnabled ? SUPPORTED_MCP_PROTOCOL_VERSIONS : LEGACY_MCP_PROTOCOL_VERSIONS;
}

/**
 * Echo a supported legacy requested version; otherwise answer with the latest
 * legacy version. `initialize` never negotiates a modern version (D-B14).
 */
export function negotiateMcpProtocolVersion(requested: unknown): LegacyMcpProtocolVersion {
  return isLegacyMcpProtocolVersion(requested) ? requested : LATEST_LEGACY_MCP_PROTOCOL_VERSION;
}

/** MCP-Protocol-Version header on non-initialize Streamable HTTP requests. */
export function parseMcpProtocolVersionHeader(value: string | undefined):
  | { ok: true; version: LegacyMcpProtocolVersion; assumed: boolean }
  | { ok: false; value: string } {
  if (value === undefined || value === '') {
    return { ok: true, version: ASSUMED_MCP_PROTOCOL_VERSION, assumed: true };
  }
  return isLegacyMcpProtocolVersion(value)
    ? { ok: true, version: value, assumed: false }
    : { ok: false, value };
}

/**
 * #6407: the catalog `tools/list` enumerates is per-principal (scope/tier
 * filtered) and includes tenant (BYO MCP) tools, whose resolution is allowed
 * to fail and degrade to `[]` mid-enumeration. An offset-only cursor has no
 * way to detect that the list changed between page 1 and page 2 — a client
 * would silently skip or repeat tools. Bind the cursor to a fingerprint of
 * the resolved per-principal catalog (the principal + the sorted tool names)
 * so a cursor issued against one catalog is provably invalid against another.
 * Not a security boundary (the fingerprint is unsigned and travels with the
 * cursor) — purely a staleness/consistency check for a single caller's own
 * paged enumeration.
 */
export function computeToolsListCatalogFingerprint(
  principalRef: string,
  toolNames: readonly string[],
): string {
  const hash = createHash('sha256');
  hash.update(principalRef);
  hash.update('\u0000');
  hash.update(toolNames.join('\u0000'));
  return hash.digest('base64url').slice(0, 22);
}

export function encodeToolsListCursor(offset: number, catalogFingerprint: string): string {
  return Buffer.from(JSON.stringify({ v: 2, offset, f: catalogFingerprint })).toString('base64url');
}

export function decodeToolsListCursor(cursor: unknown): { offset: number; catalogFingerprint: string } | null {
  if (typeof cursor !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') return null;
    const { v, offset, f } = parsed as { v?: unknown; offset?: unknown; f?: unknown };
    if (v !== 2 || typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) return null;
    if (typeof f !== 'string' || f.length === 0) return null;
    return { offset, catalogFingerprint: f };
  } catch {
    return null;
  }
}

/** MCP_TOOLS_LIST_PAGE_SIZE env; 0/unset = single page. */
export function mcpToolsListPageSize(env: NodeJS.ProcessEnv = process.env): number {
  const size = Number(env.MCP_TOOLS_LIST_PAGE_SIZE);
  return Number.isInteger(size) && size > 0 ? size : 0;
}
