import { BREEZE_MCP_TOOL_NAMES } from '../../aiAgentSdkTools';
import { getHelperAllowedMcpToolNames, type HelperPermissionLevel } from '../../helperToolFilter';
import { SCRIPT_BUILDER_MCP_TOOL_NAMES } from '../../scriptBuilderTools';

export type CaptureSurfaceId = 'chat' | 'helper-basic' | 'helper-standard' | 'helper-extended' | 'agent-full' | 'script-builder';

export interface CaptureSurface {
  id: CaptureSurfaceId;
  /** Exactly what the surface passes as query() allowedTools. */
  allowedTools: readonly string[];
  helperPermissionLevel?: HelperPermissionLevel;
  /** Exactly what the surface passes as createBreezeMcpServer options.onlyTools; undefined = whole registry. */
  onlyTools?: ReadonlySet<string>;
  server: 'breeze' | 'script_builder';
  mcpServerName: string;               // key used in query() mcpServers
  includePartialMessages: boolean;     // true for the streamingSessionManager surfaces, false for agent runs
  source: string;                      // file:line the values were taken from — printed in the report
}

/** Keep the prompt permission and SDK allowlist on the same level. */
function helperSurface(level: HelperPermissionLevel): CaptureSurface {
  return {
    id: `helper-${level}`,
    helperPermissionLevel: level,
    allowedTools: getHelperAllowedMcpToolNames(level),
    server: 'breeze',
    mcpServerName: 'breeze',
    includePartialMessages: true,
    source: 'routes/helper/index.ts:164-166,349; services/helperToolFilter.ts:22-70',
  };
}

/**
 * One row per in-product surface the spec names. Values are taken from the
 * SAME exports the surfaces pass to query()/createBreezeMcpServer — never
 * re-typed here — so a surface change moves the harness with it
 * (surfaces.test.ts asserts equality).
 *
 * `onlyTools` is undefined on every row on purpose: today only the headless
 * agent profiles (verdict/sweep/…) pass a registration subset
 * (aiAgents/runLoop.ts:1877-1892); chat, Helper and the `full` profile
 * register the whole server and gate by allowedTools only. Measuring that
 * gap is the point of this wave.
 */
export const CAPTURE_SURFACES: Readonly<Record<CaptureSurfaceId, CaptureSurface>> = {
  chat: {
    id: 'chat', allowedTools: BREEZE_MCP_TOOL_NAMES, server: 'breeze', mcpServerName: 'breeze',
    includePartialMessages: true, source: 'services/streamingSessionManager.ts:1128-1155 (routes/ai.ts:833)',
  },
  'helper-basic': helperSurface('basic'),
  'helper-standard': helperSurface('standard'),
  'helper-extended': helperSurface('extended'),
  'agent-full': {
    id: 'agent-full', allowedTools: BREEZE_MCP_TOOL_NAMES, server: 'breeze', mcpServerName: 'breeze',
    includePartialMessages: false, source: 'services/aiAgents/runLoop.ts:1866-1968 (profileAllowlist null on full)',
  },
  'script-builder': {
    id: 'script-builder', allowedTools: SCRIPT_BUILDER_MCP_TOOL_NAMES, server: 'script_builder', mcpServerName: 'script_builder',
    includePartialMessages: true, source: 'routes/scriptAi.ts:268-287; services/scriptBuilderTools.ts:63,396',
  },
};
