// apps/api/src/services/aiAgents/verdictProfile.ts
/**
 * Phase 2 wave P2-1 (alert verdicts) — the `verdict` run profile's read-only
 * tool surface and pinned limits. `full` is the existing (default) profile;
 * `verdict` is a lighter-weight run scoped to producing an `AiAlertVerdict`
 * for one alert or correlation group (see `AiAgentRunProfile`,
 * packages/shared/src/types/aiAgents.ts).
 */
import type { AiAgentLimits, AiAgentRunProfile } from '@breeze/shared';
import { OUTCOME_TOOL_NAMES } from './outcomeTools';

/**
 * Read-only surface of a verdict run. A `tool:action` entry pins one of a
 * multiplexed tool's read actions (e.g. `manage_alerts` also carries
 * mutating actions — `acknowledge`/`resolve`/`suppress` — that must never be
 * reachable from a verdict-profile run); a bare tool name is single-purpose
 * and read-only in its entirety. `verdictProfile.test.ts`'s "every
 * allowlisted tool/action is read-only" case asserts this against
 * `TIER2_ACTIONS`/`TOOL_TIERS`/`TIER2_READONLY_TOOLS` directly, so this list
 * can never silently drift onto a mutating action or a Tier-3 tool.
 */
export const VERDICT_TOOL_ALLOWLIST = [
  'manage_alerts:list', 'manage_alerts:get', 'get_device_details', 'analyze_metrics', 'query_monitors',
] as const;
export const VERDICT_MAX_TURNS = 3;

export function isVerdictProfile(run: { profile: AiAgentRunProfile }): boolean {
  return run.profile === 'verdict';
}

/**
 * Effective limits for a verdict run: turns pinned to `VERDICT_MAX_TURNS`,
 * budget from `verdictBudgetCentsPerRun`, everything else carried through
 * from the snapshot unchanged (device/concurrency/hour caps are governed by
 * the separate `maxVerdictRunsPerHour`/`maxConcurrentVerdictRuns` fields at
 * the admission layer, not here).
 *
 * `maxActionsPerRun: 0` is a deliberate hard override, not a passthrough — a
 * verdict run only ever classifies (optionally proposing one mutation via the
 * `submit_alert_verdict` outcome tool, never executing one). The shared
 * `aiAgentLimitsSchema` validator bounds `maxActionsPerRun` to `[1, 10]`
 * (packages/shared/src/validators/aiAgents.ts), so `0` would fail a re-parse
 * — but this object is a runtime-derived value handed straight to the run
 * loop, never re-validated through that schema, so the out-of-schema `0` is
 * safe here.
 */
export function verdictLimits(limits: AiAgentLimits): AiAgentLimits {
  return {
    ...limits,
    maxTurnsPerRun: VERDICT_MAX_TURNS,
    maxBudgetCentsPerRun: limits.verdictBudgetCentsPerRun,
    maxActionsPerRun: 0,
  };
}

/**
 * allowlist ∩ VERDICT_TOOL_ALLOWLIST, plus the outcome tool. Never widens —
 * an agent whose configured allowlist omits one of `VERDICT_TOOL_ALLOWLIST`'s
 * entries stays without it on a verdict run too. `checkAgentGuardrails`
 * (`aiGuardrails.ts`) already treats `tool:action` entries as allowlist
 * matches and lets read-only tools bypass the allowlist check entirely, so
 * this intersection governs *exposure* — which tools the SDK is even given —
 * not a second guardrail; it is not itself a security boundary. Wiring this
 * into the SDK tool-exposure path is Task A7.
 */
export function verdictToolAllowlist(agentAllowlist: string[]): string[] {
  const allowed = new Set<string>(agentAllowlist);
  const pinned = VERDICT_TOOL_ALLOWLIST.filter((entry) => allowed.has(entry) || allowed.has(entry.split(':')[0]!));
  return [...pinned, ...OUTCOME_TOOL_NAMES];
}
