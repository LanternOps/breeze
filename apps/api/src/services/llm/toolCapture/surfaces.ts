import { BREEZE_MCP_TOOL_NAMES, listChatSurfaceToolNames } from '../../aiAgentSdkTools';
import { getHelperAllowedMcpToolNames, getHelperAllowedTools, type HelperPermissionLevel } from '../../helperToolFilter';
import { resolveRunProfileLimits, resolveRunToolExposure } from '../../aiAgents/runLoop';
import { outcomeToolsForRun, type OutcomeToolName } from '../../aiAgents/outcomeTools';
import { SCRIPT_BUILDER_MCP_TOOL_NAMES } from '../../scriptBuilderTools';
import { AI_AGENT_LIMIT_DEFAULTS, type AiAgentRunProfile } from '@breeze/shared';

export type CaptureSurfaceId =
  | 'chat' | 'helper-basic' | 'helper-standard' | 'helper-extended' | 'agent-full' | 'script-builder'
  | 'agent-full-remediation' | 'agent-analysis';

/** The agent-profile surfaces the agent golden set (#7428) runs on. */
export type AgentCaptureSurfaceId = 'agent-full-remediation' | 'agent-analysis';

export interface CaptureSurface {
  id: CaptureSurfaceId;
  /** Exactly what the surface passes as query() allowedTools. */
  allowedTools: readonly string[];
  helperPermissionLevel?: HelperPermissionLevel;
  /** Exactly what the surface passes as createBreezeMcpServer options.onlyTools; undefined = whole registry. */
  onlyTools?: ReadonlySet<string>;
  /** The surface's `getOrCreate` `toolSearch` opt-in; the policy still decides per host (aiToolSearchPolicy.ts). */
  toolSearch: boolean;
  /**
   * The production turn cap the policy's low-turn-budget rule is judged
   * against (never the harness's own artificially low `maxTurns`). Omitted =
   * a fresh chat session's budget (runSurface.ts).
   */
  turnBudget?: number;
  /** Agent-profile surfaces: the run profile whose prompt builders and exposure this mirrors. */
  agentProfile?: AiAgentRunProfile;
  /** Agent-profile surfaces: the profile's outcome tools, registered as `extraTools` exactly as runLoop does. */
  outcomeTools?: readonly OutcomeToolName[];
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
 * `full` profile exposure for a read-only agent (empty allowlist), exactly as
 * runLoop.driveSdkLoop passes it: since #7427 both `allowedTools` and
 * `onlyTools` are the declared floor (`declaredFullRunToolExposure`).
 */
const AGENT_FULL_EXPOSURE = resolveRunToolExposure({ profile: 'full' }, []);
const DECLARED = new Set(listChatSurfaceToolNames());

/**
 * A representative remediation agent's own allowlist (#7428): the handful of
 * mutating operations a triage/remediation agent is typically granted. The
 * `full` exposure is dominated by its read-only floor, so this adds only the
 * mutating-only tools to the registered set; it exists so the measured
 * surface is an agent that can act, not only a read-only one.
 */
export const REPRESENTATIVE_REMEDIATION_ALLOWLIST: readonly string[] = [
  'manage_alerts:acknowledge', 'manage_alerts:resolve', 'manage_services:restart',
  'disk_cleanup', 'execute_command', 'run_script', 'manage_patches:install',
];

/**
 * An agent-profile surface derived from runLoop's own exports: the exposure
 * (`resolveRunToolExposure`), the turn cap (`resolveRunProfileLimits` on the
 * default limits) and the outcome tools (`outcomeToolsForRun`). The `full`
 * floor is already declared-only (#7427); registration is still filtered to
 * declared names so an env-gated profile tool cannot throw in the harness. `toolSearch`
 * mirrors runLoop's opt-in; the eval's `--surface-search on` arm measures a
 * hypothetical opt-in without changing it.
 */
function agentSurface(
  id: AgentCaptureSurfaceId,
  profile: AiAgentRunProfile,
  agentAllowlist: readonly string[],
  source: string,
): CaptureSurface {
  const run = { profile };
  const { exposedNames, onlyTools } = resolveRunToolExposure(run, [...agentAllowlist]);
  return {
    id,
    agentProfile: profile,
    allowedTools: [...new Set(exposedNames)],
    onlyTools: new Set([...(onlyTools ?? [])].filter((name) => DECLARED.has(name))),
    outcomeTools: outcomeToolsForRun(run),
    toolSearch: false,
    turnBudget: resolveRunProfileLimits(run, AI_AGENT_LIMIT_DEFAULTS).maxTurnsPerRun,
    server: 'breeze', mcpServerName: 'breeze',
    includePartialMessages: false,
    source,
  };
}

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
    allowedTools: [...new Set(AGENT_FULL_EXPOSURE.exposedNames)],
    onlyTools: AGENT_FULL_EXPOSURE.onlyTools,
    toolSearch: false,
    server: 'breeze', mcpServerName: 'breeze',
    includePartialMessages: false, source: 'services/aiAgents/runLoop.ts:1667,1714 (declaredFullRunToolExposure via resolveRunToolExposure → exposedNames/onlyTools)',
  },
  'agent-full-remediation': agentSurface('agent-full-remediation', 'full', REPRESENTATIVE_REMEDIATION_ALLOWLIST,
    'services/aiAgents/runLoop.ts:1680,1714 (resolveRunProfileLimits/resolveRunToolExposure, full + REPRESENTATIVE_REMEDIATION_ALLOWLIST)'),
  'agent-analysis': agentSurface('agent-analysis', 'analysis', [],
    'services/aiAgents/runLoop.ts:1680,1714 (resolveRunProfileLimits/resolveRunToolExposure); aiAgents/analysisProfile.ts:26'),
  'script-builder': {
    id: 'script-builder', allowedTools: SCRIPT_BUILDER_MCP_TOOL_NAMES, toolSearch: false, server: 'script_builder', mcpServerName: 'script_builder',
    includePartialMessages: true, source: 'routes/scriptAi.ts:268-287; services/scriptBuilderTools.ts:63,396',
  },
};
