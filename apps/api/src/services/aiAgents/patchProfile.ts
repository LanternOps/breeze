import { AI_AGENT_LIMIT_DEFAULTS, type AiAgentLimits, type AiAgentRunProfile } from '@breeze/shared';

/**
 * AI patch agent (W01). The read-only drill-down floor a `patch`-profile run
 * gets so the model can check a line of its pre-assembled evidence against one
 * device before putting it in the plan. Every entry is a tier-1 / read-only
 * catalog operation wired in the SDK tool set (patchProfile.test.ts asserts
 * both, per `sweepProfile.ts`'s `query_backups` lesson).
 *
 * Deliberately NOT in the floor:
 *  - `get_compliance_status` — has an RBAC entry but no `TOOL_TIERS` entry and
 *    no SDK wiring, so a headless run could never reach it.
 *  - `manage_patches:scan` — an inert stub that dispatches nothing; offering
 *    it would tell the model it can trigger a scan.
 *  - `manage_patches:install|approve|…`, `manage_deployments:start` — the plan
 *    PROPOSES; this profile executes nothing (`patchLimits` pins
 *    `maxActionsPerRun: 0`, W01 mints zero intents).
 *
 * Colon entries are enforced by the guardrail allowlist gate per action
 * (`manage_patches:list` admits only `action: 'list'`), even though the SDK
 * exposes the bare multi-action tool.
 *
 * Floor, not intersection: the agent's own allowlist is ignored, like
 * designToolAllowlist / sweepToolAllowlist.
 */
export const PATCH_TOOL_ALLOWLIST = [
  'get_device_details',
  'get_device_context',
  'get_device_vulnerabilities',
  'manage_patches:list',
  'manage_patches:compliance',
  'manage_maintenance_windows:list',
  'manage_maintenance_windows:active_now',
] as const;

export const PATCH_OUTCOME_TOOL_NAME = 'submit_patch_plan';

export function isPatchProfile(run: { profile: AiAgentRunProfile }): boolean {
  return run.profile === 'patch';
}

/**
 * Substitutes the patch-specific budget/turn caps for the run loop's generic
 * ones and zeroes `maxActionsPerRun` — a patch run is device-less and
 * findings-only by construction. Tolerant `?? AI_AGENT_LIMIT_DEFAULTS…` reads
 * so a pre-v11 policy snapshot (no patch fields) still resolves to a sane cap
 * rather than `undefined` (which turns the SDK's `maxBudgetUsd` into NaN).
 */
export function patchLimits(limits: AiAgentLimits): AiAgentLimits {
  return {
    ...limits,
    maxTurnsPerRun: limits.patchMaxTurns ?? AI_AGENT_LIMIT_DEFAULTS.patchMaxTurns,
    maxBudgetCentsPerRun: limits.patchBudgetCentsPerRun ?? AI_AGENT_LIMIT_DEFAULTS.patchBudgetCentsPerRun,
    maxActionsPerRun: 0,
  };
}

/**
 * A FLOOR, not an intersection with the agent's own `toolAllowlist` — the
 * parameter is intentionally unused. A patch agent's stored allowlist still
 * governs its `full`-profile DEVICE lane (POST /ai/agents/:id/runs); a
 * `patch`-profile run never consults it.
 */
export function patchToolAllowlist(_agentAllowlist: string[]): string[] {
  return [...PATCH_TOOL_ALLOWLIST, PATCH_OUTCOME_TOOL_NAME];
}
