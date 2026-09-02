// apps/api/src/services/aiAgents/sweepProfile.ts
/**
 * Phase 2 wave P2-2 (scheduled sweeps) — the `sweep` run profile's read-only
 * tool surface and pinned limits. `full` is the existing (default) profile;
 * `verdict` (wave P2-1) triages one alert/correlation group; `sweep` runs on
 * a fixed schedule against pre-collected, system-executed evidence for one
 * org and produces a `SweepFindingsOutcome` instead of a full triage turn
 * (see `AiAgentRunProfile`, packages/shared/src/types/aiAgents.ts).
 */
import { AI_AGENT_LIMIT_DEFAULTS, type AiAgentLimits, type AiAgentRunProfile } from '@breeze/shared';
import { OUTCOME_TOOL_NAMES } from './outcomeTools';

/**
 * Read-only drill-down floor for a sweep run: small, single-purpose tools a
 * model may call to confirm one row of the system-collected evidence before
 * reporting it via `submit_sweep_findings` — same "floor, not intersection"
 * design as `VERDICT_TOOL_ALLOWLIST` (`verdictProfile.ts`; see its docstring
 * for the full rationale). `sweepProfile.test.ts`'s "every floor tool is
 * read-only" case (duplicated as a contract in
 * `verdictProfile.contract.test.ts`) pins this against
 * `TOOL_TIERS`/`TIER2_READONLY_TOOLS` directly, so this list can never
 * silently drift onto a mutating or Tier-3 tool.
 *
 * `query_backups` was DROPPED from the task brief's original 5-tool proposal
 * during implementation (self-review, controller ruling): it is registered
 * in the `aiTools` execution registry (`aiToolsBackup.ts`) but has no entry
 * in `TOOL_TIERS` and no SDK tool wiring in `aiAgentSdkTools.ts` at all, so
 * it is not reachable from ANY headless SDK run today — including it here
 * would either silently expose nothing (the SDK never offers a tool with no
 * `makeHandler` registration) or force the read-only contract test to
 * tolerate an unregistered/untiered name. Flagged in the task report as a
 * pre-existing gap rather than adding tier/wiring for it out of this task's
 * scope.
 */
export const SWEEP_TOOL_ALLOWLIST = [
  'get_device_details', 'get_service_monitoring_status', 'get_device_vulnerabilities', 'analyze_metrics',
] as const;

export function isSweepProfile(run: { profile: AiAgentRunProfile }): boolean {
  return run.profile === 'sweep';
}

/**
 * Effective limits for a sweep run: turns pinned to `sweepMaxTurns`, budget
 * from `sweepBudgetCentsPerRun`, everything else carried through from the
 * snapshot unchanged (device/concurrency/hour caps are governed by the
 * separate `maxConcurrentSweepRuns`/`maxSweepRunsPerHour` fields at the
 * admission layer, not here — same split as `verdictLimits`).
 *
 * `maxActionsPerRun: 0` is a deliberate hard override, not a passthrough — a
 * sweep run only ever reports findings (optionally proposing one mutation
 * via `submit_sweep_findings`'s `proposedAction` field, which becomes a
 * supervised device-bound intent, never a run-loop execution). Same
 * out-of-schema-safe `0` as `verdictLimits` — see its docstring for why this
 * bypasses `aiAgentLimitsSchema`'s `[1, 10]` bound safely (this object is a
 * runtime-derived value handed straight to the run loop, never re-validated
 * through that schema).
 *
 * `?? AI_AGENT_LIMIT_DEFAULTS...` fallback: a policy snapshot resolved
 * before the v6 limits bump has no `sweepMaxTurns`/`sweepBudgetCentsPerRun`
 * field at all — same tolerant-read pattern `verdictLimits` uses for
 * `verdictBudgetCentsPerRun` (the alternative, `maxBudgetCentsPerRun:
 * undefined`, turns the SDK's `maxBudgetUsd` into `NaN`).
 */
export function sweepLimits(limits: AiAgentLimits): AiAgentLimits {
  return {
    ...limits,
    maxTurnsPerRun: limits.sweepMaxTurns ?? AI_AGENT_LIMIT_DEFAULTS.sweepMaxTurns,
    maxBudgetCentsPerRun: limits.sweepBudgetCentsPerRun ?? AI_AGENT_LIMIT_DEFAULTS.sweepBudgetCentsPerRun,
    maxActionsPerRun: 0,
  };
}

/**
 * The sweep-profile tool floor: ALWAYS `SWEEP_TOOL_ALLOWLIST` + the sweep
 * outcome tool, regardless of the agent's own configured allowlist — same
 * "floor, not intersection" design as `verdictToolAllowlist` (see its
 * docstring for the full rationale: intersecting against a `full`-profile
 * allowlist can leak a bare multi-action tool's mutating actions in by
 * accident of naming, where this list is entirely read-only by
 * construction).
 *
 * Filters `OUTCOME_TOOL_NAMES` down to `submit_sweep_findings` rather than
 * hard-coding the literal, so a rename in `outcomeTools.ts` (the single
 * source of truth for outcome-tool names) can never leave this floor
 * silently exposing a stale name. Cast to `readonly string[]` before
 * filtering so this compiles regardless of whether `outcomeTools.ts` has
 * shipped `submit_sweep_findings` yet — `OUTCOME_TOOL_NAMES`'s literal union
 * type would otherwise make the `===` comparison a type error until it has
 * (task 6, this same wave; see the task-4 report for the resulting
 * cross-task dependency on this repo's parallel-task cherry-pick model).
 */
export function sweepToolAllowlist(_agentAllowlist: string[]): string[] {
  return [
    ...SWEEP_TOOL_ALLOWLIST,
    ...(OUTCOME_TOOL_NAMES as readonly string[]).filter((name) => name === 'submit_sweep_findings'),
  ];
}
