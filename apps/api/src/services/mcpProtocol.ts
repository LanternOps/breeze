import { Buffer } from 'node:buffer';

export const SUPPORTED_MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export type McpProtocolVersion = (typeof SUPPORTED_MCP_PROTOCOL_VERSIONS)[number];
export const LATEST_MCP_PROTOCOL_VERSION: McpProtocolVersion = SUPPORTED_MCP_PROTOCOL_VERSIONS[0];
export const ASSUMED_MCP_PROTOCOL_VERSION: McpProtocolVersion = '2025-03-26';

export function isSupportedMcpProtocolVersion(v: unknown): v is McpProtocolVersion {
  return SUPPORTED_MCP_PROTOCOL_VERSIONS.some((version) => version === v);
}

/** Echo a supported requested version; otherwise answer with the latest we support. */
export function negotiateMcpProtocolVersion(requested: unknown): McpProtocolVersion {
  return isSupportedMcpProtocolVersion(requested) ? requested : LATEST_MCP_PROTOCOL_VERSION;
}

/** MCP-Protocol-Version header on non-initialize Streamable HTTP requests. */
export function parseMcpProtocolVersionHeader(value: string | undefined):
  | { ok: true; version: McpProtocolVersion; assumed: boolean }
  | { ok: false; value: string } {
  if (value === undefined || value === '') {
    return { ok: true, version: ASSUMED_MCP_PROTOCOL_VERSION, assumed: true };
  }
  return isSupportedMcpProtocolVersion(value)
    ? { ok: true, version: value, assumed: false }
    : { ok: false, value };
}

export function encodeToolsListCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, offset })).toString('base64url');
}

export function decodeToolsListCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') return null;
    const { v, offset } = parsed as { v?: unknown; offset?: unknown };
    return v === 1 && typeof offset === 'number' && Number.isInteger(offset) && offset >= 0
      ? offset
      : null;
  } catch {
    return null;
  }
}

/** MCP_TOOLS_LIST_PAGE_SIZE env; 0/unset = single page. */
export function mcpToolsListPageSize(env: NodeJS.ProcessEnv = process.env): number {
  const size = Number(env.MCP_TOOLS_LIST_PAGE_SIZE);
  return Number.isInteger(size) && size > 0 ? size : 0;
}
