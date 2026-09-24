import { AI_AGENT_LIMIT_DEFAULTS, type AiAgentLimits, type AiAgentRunProfile } from '@breeze/shared';

/**
 * Fleet Designer (W01). The read-only drill-down floor a design run gets so
 * the model can check a function guess against one device — the evidence
 * bundle cannot carry every device's detail (spec §4.2, D6). Every name is a
 * tier-1 / read-only tier-2 catalog tool (designProfile.test.ts asserts it)
 * AND is declared in `createBreezeMcpServer` — the single MCP server a
 * design run attaches (also asserted in designProfile.test.ts). Floor, not
 * intersection: the agent's own allowlist is ignored, like
 * narrativeToolAllowlist / sweepToolAllowlist.
 *
 * `get_script_details` is deliberately absent: it is a `TOOL_TIERS` key and
 * a catalog tool, but it is only declared on the separate `script_builder`
 * MCP server (`scriptBuilderTools.ts`; see `NOT_IN_BREEZE_MCP_SERVER` in
 * `aiAgentSdkTools.mcpCoverage.test.ts`), so `createBreezeMcpServer`'s
 * `onlyTools` rejected it with "referenced unknown tool name(s)" and every
 * design run died at turn 0. No breeze-MCP-declared tool serves the same
 * "read one script's content/metadata" purpose today (`get_script_proposal`
 * reads an authoring proposal, not a library script; `get_script_execution`
 * reads a run's result, not the script) — dropped rather than swapped.
 */
export const DESIGN_TOOL_ALLOWLIST = [
  'get_device_details', 'get_device_hardware_health', 'get_device_context', 'search_logs',
  'get_configuration_policy', 'get_playbook_history',
] as const;

export const DESIGN_OUTCOME_TOOL_NAME = 'submit_fleet_design';

export function isDesignProfile(run: { profile: AiAgentRunProfile }): boolean {
  return run.profile === 'design';
}

/**
 * Substitutes the design-specific budget/turn/wall-clock caps for the
 * run-loop's generic ones and zeroes `maxActionsPerRun` — a design run is
 * device-less and read-only by construction (Global Constraints), so it
 * never has any actions to spend. Tolerant `?? AI_AGENT_LIMIT_DEFAULTS...`
 * reads for every substituted field, same posture as
 * narrativeLimits()/sweepLimits(), so a pre-v10 policy snapshot (missing
 * `designBudgetCentsPerRun`/`designMaxTurns`) — or a pre-#5870 snapshot
 * missing `designWallClockSeconds` — still resolves to a sane cap rather
 * than `undefined`.
 *
 * `wallClockSeconds` (#5870): without this override the run loop
 * (`runLoop.ts`) falls back to the shared 600s default, which cut design
 * runs mid-reasoning well before the raised `maxTurnsPerRun`/
 * `maxBudgetCentsPerRun` ceilings above were ever reached — observed
 * 36/60 turns, 98/300 cents, `wallClockExceeded=true`, yet the run still
 * finalized `completed` because `outcome.fleetDesign` had been submitted.
 * Same pinning shape as `analysisLimits()`'s `analysisWallClockSeconds`.
 */
export function designLimits(limits: AiAgentLimits): AiAgentLimits {
  return {
    ...limits,
    maxTurnsPerRun: limits.designMaxTurns ?? AI_AGENT_LIMIT_DEFAULTS.designMaxTurns,
    maxBudgetCentsPerRun: limits.designBudgetCentsPerRun ?? AI_AGENT_LIMIT_DEFAULTS.designBudgetCentsPerRun,
    wallClockSeconds: limits.designWallClockSeconds ?? AI_AGENT_LIMIT_DEFAULTS.designWallClockSeconds,
    maxActionsPerRun: 0,
  };
}

/**
 * A FLOOR, not an intersection with the agent's own `toolAllowlist` — the
 * parameter is intentionally unused, same posture as narrativeToolAllowlist/
 * sweepToolAllowlist/triageToolAllowlist. A design agent's create/update
 * form still stores a `toolAllowlist` (shared UI component), but a design
 * run never consults it.
 */
export function designToolAllowlist(_agentAllowlist: string[]): string[] {
  return [...DESIGN_TOOL_ALLOWLIST, DESIGN_OUTCOME_TOOL_NAME];
}
