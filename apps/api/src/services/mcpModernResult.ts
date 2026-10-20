/**
 * B-W03 (#6157): pure result decoration and HTTP status composition for the
 * stateless `2026-07-28` era (D-B16, D-B18), plus the header-mismatch abuse
 * tripwire (D-B19).
 *
 * Breeze keeps no server-side result cache. `cacheScope` is a client hint and
 * every Breeze cacheable result is `private`: lists are permission- and
 * domain-filtered per principal. A future server cache would have to key on
 * scopes, domains, tenant/site access, version and parameters — not principal
 * id alone.
 */
import { API_VERSION } from '../version';
import { envInt } from '../utils/envInt';
import { MCP_SERVER_INSTRUCTIONS } from './mcpGuidance';
import { supportedMcpProtocolVersions } from './mcpProtocol';
import { captureMessage } from './sentry';

export type McpCacheableMethod =
  | 'server/discover'
  | 'tools/list'
  | 'prompts/list'
  | 'resources/list'
  | 'resources/templates/list'
  | 'resources/read';

export const MCP_CACHE_TTL_MS: Readonly<Record<McpCacheableMethod, number>> = Object.freeze({
  'server/discover': 300_000,
  'prompts/list': 300_000,
  // Permission-filtered, and domain grant edits are live.
  'tools/list': 60_000,
  'resources/list': 60_000,
  'resources/templates/list': 60_000,
  'resources/read': 0,
});

const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';

function serverInfo() {
  return { name: 'breeze-rmm', title: 'Breeze RMM', version: API_VERSION };
}

function isCacheableMethod(method: string): method is McpCacheableMethod {
  return Object.prototype.hasOwnProperty.call(MCP_CACHE_TTL_MS, method);
}

export function decorateModernResult(method: string, result: Record<string, unknown>): Record<string, unknown> {
  const existingMeta = typeof result._meta === 'object' && result._meta !== null && !Array.isArray(result._meta)
    ? (result._meta as Record<string, unknown>)
    : {};
  const decorated: Record<string, unknown> = {
    ...result,
    resultType: 'complete',
    _meta: { ...existingMeta, [SERVER_INFO_META_KEY]: serverInfo() },
  };
  if (isCacheableMethod(method)) {
    decorated.ttlMs = MCP_CACHE_TTL_MS[method];
    decorated.cacheScope = 'private';
  }
  return decorated;
}

export function buildDiscoverResult(): Record<string, unknown> {
  return {
    resultType: 'complete',
    supportedVersions: [...supportedMcpProtocolVersions(true)],
    capabilities: { tools: {}, resources: {}, prompts: {} },
    instructions: MCP_SERVER_INSTRUCTIONS,
    _meta: { [SERVER_INFO_META_KEY]: serverInfo() },
    ttlMs: MCP_CACHE_TTL_MS['server/discover'],
    cacheScope: 'private',
  };
}

/**
 * D-B16 precedence (pre-dispatch rejections return their own status before
 * this is reached): a modern `-32601` is 404; otherwise the step-up result
 * (200, or 403 with `MCP_INSUFFICIENT_SCOPE_HTTP_403`) stands. The step-up can
 * therefore never overwrite a modern 404.
 */
export function resolveMcpHttpStatus(
  era: 'legacy' | 'modern',
  response: { error?: { code: number } },
  stepUpStatus: 200 | 403,
): 200 | 403 | 404 {
  if (era === 'modern' && response.error?.code === -32601) return 404;
  return stepUpStatus;
}

// Same shape as recordUnknownMcpSession in routes/mcpServer.ts: count per
// process, raise ONE Sentry event per window when the rate is abnormal. A
// burst of SEP-2243 header mismatches suggests a gateway rewriting bodies or
// request smuggling, not a misbehaving client.
const MCP_HEADER_MISMATCH_WINDOW_MS = 60_000;
const MCP_HEADER_MISMATCH_ALERT_THRESHOLD = envInt('MCP_HEADER_MISMATCH_ALERT_THRESHOLD', 50);

let mismatchWindowStart = 0;
let mismatchWindowCount = 0;
let mismatchWindowAlerted = false;

export function recordMcpHeaderMismatch(): void {
  const now = Date.now();
  if (now - mismatchWindowStart >= MCP_HEADER_MISMATCH_WINDOW_MS) {
    mismatchWindowStart = now;
    mismatchWindowCount = 0;
    mismatchWindowAlerted = false;
  }
  mismatchWindowCount += 1;
  if (mismatchWindowAlerted || mismatchWindowCount < MCP_HEADER_MISMATCH_ALERT_THRESHOLD) return;
  mismatchWindowAlerted = true;
  captureMessage('MCP SEP-2243 header/body mismatch rate is abnormally high', {
    eventCode: 'mcp_header_mismatch_rate_high',
    level: 'warning',
    tags: { window_seconds: '60' },
  });
}

/** Test-only: reset the per-process tripwire window. */
export function __resetMcpHeaderMismatchWindowForTests(): void {
  mismatchWindowStart = 0;
  mismatchWindowCount = 0;
  mismatchWindowAlerted = false;
}
