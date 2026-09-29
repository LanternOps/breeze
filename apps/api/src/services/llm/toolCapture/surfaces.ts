import { BREEZE_MCP_TOOL_NAMES, listChatSurfaceToolNames } from '../../aiAgentSdkTools';
import { getHelperAllowedMcpToolNames, getHelperAllowedTools, type HelperPermissionLevel } from '../../helperToolFilter';
import { fullRunToolExposure } from '../../aiAgents/runLoop';
import { SCRIPT_BUILDER_MCP_TOOL_NAMES } from '../../scriptBuilderTools';

export type CaptureSurfaceId = 'chat' | 'helper-basic' | 'helper-standard' | 'helper-extended' | 'agent-full' | 'script-builder';

export interface CaptureSurface {
  id: CaptureSurfaceId;
  /** Exactly what the surface passes as query() allowedTools. */
  allowedTools: readonly string[];
  helperPermissionLevel?: HelperPermissionLevel;
  /** Exactly what the surface passes as createBreezeMcpServer options.onlyTools; undefined = whole registry. */
  onlyTools?: ReadonlySet<string>;
  /** The surface's `getOrCreate` `toolSearch` opt-in; the policy still decides per host (aiToolSearchPolicy.ts). */
  toolSearch: boolean;
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
    onlyTools: new Set(getHelperAllowedTools(level)),
    toolSearch: false,
    server: 'breeze',
    mcpServerName: 'breeze',
    includePartialMessages: true,
    source: 'routes/helper/index.ts:100-121 (helperMcpServerFactory); services/helperToolFilter.ts:22-80',
  };
}

/**
 * `full` profile exposure for a read-only agent (empty allowlist), as
 * runLoop.driveSdkLoop passes it. The exposure also names registry tools the
 * SDK server never declares; production registers only the declared ones
 * (createBreezeMcpServer skips unknown onlyTools names outside tests), so the
 * harness registers exposure ∩ declared and allows the full exposure.
 */
const AGENT_FULL_EXPOSURE = fullRunToolExposure([]);
const DECLARED = new Set(listChatSurfaceToolNames());

/**
 * One row per in-product surface the spec names. Values are taken from the
 * SAME exports the surfaces pass to query()/createBreezeMcpServer — never
 * re-typed here — so a surface change moves the harness with it
 * (surfaces.test.ts asserts equality).
 *
 * Since A-W04 only web chat registers the whole server; it defers all but the
 * alwaysLoad set behind tool search when the host allows it. Helper and agent
 * runs register a real `onlyTools` subset.
 */
export const CAPTURE_SURFACES: Readonly<Record<CaptureSurfaceId, CaptureSurface>> = {
  chat: {
    id: 'chat', allowedTools: BREEZE_MCP_TOOL_NAMES, toolSearch: true, server: 'breeze', mcpServerName: 'breeze',
    includePartialMessages: true, source: 'services/streamingSessionManager.ts:1289-1310 (routes/ai.ts:1024 toolSearch: true)',
  },
  'helper-basic': helperSurface('basic'),
  'helper-standard': helperSurface('standard'),
  'helper-extended': helperSurface('extended'),
  'agent-full': {
    id: 'agent-full',
    allowedTools: AGENT_FULL_EXPOSURE.map((name) => `mcp__breeze__${name}`),
    onlyTools: new Set(AGENT_FULL_EXPOSURE.filter((name) => DECLARED.has(name))),
    toolSearch: false,
    server: 'breeze', mcpServerName: 'breeze',
    includePartialMessages: false, source: 'services/aiAgents/runLoop.ts:1979-2001 (fullRunToolExposure → exposureList/onlyTools)',
  },
  'script-builder': {
    id: 'script-builder', allowedTools: SCRIPT_BUILDER_MCP_TOOL_NAMES, toolSearch: false, server: 'script_builder', mcpServerName: 'script_builder',
    includePartialMessages: true, source: 'routes/scriptAi.ts:268-287; services/scriptBuilderTools.ts:63,396',
  },
};
