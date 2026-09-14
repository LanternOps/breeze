import { AI_AGENT_LIMIT_DEFAULTS, type AiAgentLimits, type AiAgentRunProfile } from '@breeze/shared';

/**
 * Fleet Designer (W01). The read-only drill-down floor a design run gets so
 * the model can check a function guess against one device — the evidence
 * bundle cannot carry every device's detail (spec §4.2, D6). Every name is a
 * tier-1 / read-only tier-2 catalog tool (designProfile.test.ts asserts it).
 * Floor, not intersection: the agent's own allowlist is ignored, like
 * narrativeToolAllowlist / sweepToolAllowlist.
 */
export const DESIGN_TOOL_ALLOWLIST = [
  'get_device_details', 'get_device_context', 'search_logs', 'get_script_details',
  'get_configuration_policy', 'get_playbook_history',
] as const;

export const DESIGN_OUTCOME_TOOL_NAME = 'submit_fleet_design';

export function isDesignProfile(run: { profile: AiAgentRunProfile }): boolean {
  return run.profile === 'design';
}

/**
 * Substitutes the design-specific budget/turn caps for the run-loop's
 * generic ones and zeroes `maxActionsPerRun` — a design run is device-less
 * and read-only by construction (Global Constraints), so it never has any
 * actions to spend. Tolerant `?? AI_AGENT_LIMIT_DEFAULTS...` reads for both
 * substituted fields, same posture as narrativeLimits()/sweepLimits(), so a
 * pre-v10 policy snapshot (missing `designBudgetCentsPerRun`/`designMaxTurns`)
 * still resolves to a sane cap rather than `undefined`.
 */
export function designLimits(limits: AiAgentLimits): AiAgentLimits {
  return {
    ...limits,
    maxTurnsPerRun: limits.designMaxTurns ?? AI_AGENT_LIMIT_DEFAULTS.designMaxTurns,
    maxBudgetCentsPerRun: limits.designBudgetCentsPerRun ?? AI_AGENT_LIMIT_DEFAULTS.designBudgetCentsPerRun,
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
