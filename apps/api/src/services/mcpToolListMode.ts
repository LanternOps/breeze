/**
 * Which tools an external MCP client is shown by `tools/list` (#12427).
 *
 * `full` lists every tool this caller may call. `progressive` is a small core plus
 * search_tools / get_tool_details / call_tool. The mode governs listing and
 * server instructions only: it never changes what a call may do.
 *
 * Resolved once per request, from the request that carries the override. Never
 * stored on a session. Pure, apart from mcpToolListDefault's env read and its
 * once-per-process report of an invalid value.
 */

export type McpToolListMode = 'full' | 'progressive';
export type McpToolListModeSource = 'request' | 'credential' | 'deployment_default';
export type ResolvedMcpToolListMode = { mode: McpToolListMode; source: McpToolListModeSource };

export const MCP_TOOL_LIST_HEADER = 'Mcp-Tool-List';
export const MCP_TOOL_LIST_META_KEY = 'app.breeze/toolList';

export type RequestedToolListMode =
  | { ok: true; mode: McpToolListMode | null }
  | { ok: false; reason: 'tool_list_mode_conflict' | 'tool_list_mode_invalid' };

function isMode(value: unknown): value is McpToolListMode {
  return value === 'full' || value === 'progressive';
}

/**
 * The request's own override. `header` is the raw `Mcp-Tool-List` value;
 * `meta` is `params._meta['app.breeze/toolList']` (the caller passes it in the
 * stateless era only). Exact values only: a misspelt or contradictory request
 * is refused, never silently resolved.
 */
export function readRequestedToolListMode(input: { header: string | undefined; meta: unknown }): RequestedToolListMode {
  const { header, meta } = input;
  if (header !== undefined && !isMode(header)) return { ok: false, reason: 'tool_list_mode_invalid' };
  if (meta !== undefined && !isMode(meta)) return { ok: false, reason: 'tool_list_mode_invalid' };
  if (header !== undefined && meta !== undefined && header !== meta) return { ok: false, reason: 'tool_list_mode_conflict' };
  return { ok: true, mode: header ?? meta ?? null };
}

let invalidDefaultReported = false;

/** `MCP_TOOL_LIST_DEFAULT`; an unrecognised value is `full` (today's behaviour), reported once. */
export function mcpToolListDefault(env: NodeJS.ProcessEnv = process.env): McpToolListMode {
  // Compose maps an unset variable to the empty string.
  const raw = env.MCP_TOOL_LIST_DEFAULT;
  if (raw === undefined || raw === '') return 'full';
  if (isMode(raw)) return raw;
  if (!invalidDefaultReported) {
    invalidDefaultReported = true;
    console.error(`[MCP] MCP_TOOL_LIST_DEFAULT=${JSON.stringify(raw)} is not "full" or "progressive"; using "full"`);
  }
  return 'full';
}

/** Test-only: re-arm the once-per-process invalid-default report. */
export function __resetMcpToolListDefaultWarningForTests(): void {
  invalidDefaultReported = false;
}

export function resolveMcpToolListMode(input: {
  requestOverride: McpToolListMode | null;
  /** Null when the principal has no stored-mode slot. */
  credential: { mcpToolListMode: McpToolListMode | null; partnerServicePrincipal: boolean } | null;
  deploymentDefault: McpToolListMode;
}): ResolvedMcpToolListMode {
  if (input.requestOverride) return { mode: input.requestOverride, source: 'request' };
  if (input.credential?.mcpToolListMode) return { mode: input.credential.mcpToolListMode, source: 'credential' };
  // Partner service principal keys are scripted integrations: `full` unless
  // the request itself opts in, whatever the deployment default becomes.
  if (input.credential?.partnerServicePrincipal) return { mode: 'full', source: 'credential' };
  return { mode: input.deploymentDefault, source: 'deployment_default' };
}
