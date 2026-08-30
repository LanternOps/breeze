// apps/api/src/services/aiAgents/narrativeProfile.ts
/**
 * Phase 2 wave P2-3 (weekly org narrative) — the `narrative` run profile's
 * tool surface and pinned limits. `full` is the existing (default) profile;
 * `verdict` (P2-1) triages one alert/correlation group; `sweep` (P2-2) runs
 * on a schedule against pre-collected evidence for one org; `narrative`
 * turns one org's pre-collected WEEK of activity into an
 * `NarrativeOutcome` for a customer-facing report (see
 * `AiAgentRunProfile`, packages/shared/src/types/aiAgents.ts).
 */
import { AI_AGENT_LIMIT_DEFAULTS, type AiAgentLimits, type AiAgentRunProfile } from '@breeze/shared';

/**
 * The narrative profile's read-only drill-down floor is EMPTY — deliberately,
 * and this is the design difference from `verdict`/`sweep` rather than an
 * oversight or a placeholder for a later task.
 *
 * `verdict` and `sweep` both allow a handful of single-purpose read-only
 * tools so the model can confirm ONE row of the evidence it was handed before
 * reporting on it. A narrative run has nothing to confirm: its entire input is
 * the bounded, system-assembled weekly context (`narrativeContext.ts`, task
 * 5), collected before the run under a system DB context and already
 * summarised to counts and top-N lists. There is no per-device fact for it to
 * go and re-read, and letting it read one would (a) put live, unbounded
 * fleet data into a run whose output is a customer-facing document, and (b)
 * make the run's cost unbounded in a way `narrativeMaxTurns` (3) could not
 * hold.
 *
 * So the whole floor a narrative run ever sees is the outcome tool below.
 * Kept as an exported (empty) constant rather than inlined, because
 * `verdictProfile.contract.test.ts`'s "narrative floor is empty" case asserts
 * on it directly: if anyone ever adds a tool here, that contract fails and
 * forces the read-only tier check to be satisfied first.
 */
export const NARRATIVE_TOOL_ALLOWLIST = [] as const;

/**
 * The narrative outcome tool's name.
 *
 * `outcomeTools.ts` is the single source of truth for outcome-tool names, and
 * `verdictToolAllowlist`/`sweepToolAllowlist` both derive their outcome entry
 * by filtering `OUTCOME_TOOL_NAMES`. This constant is a literal instead for a
 * historical reason: within wave P2-3 this module landed before the tool was
 * registered, when the filter form would have evaluated to `[]` and shipped a
 * profile with no way to produce its outcome. The registration has since
 * landed (`outcomeTools.ts` carries `submit_narrative`, its schema, MCP-name
 * mapping and `outcomeToolsForProfile` arm), and the drift risk is pinned from
 * both sides: `narrativeProfile.test.ts` compares this literal against every
 * narrative entry of `OUTCOME_TOOL_NAMES`, and `outcomeTools.test.ts`'s
 * per-profile floor-agreement case pins the two representations to each other.
 * Switching to the filter form for parity with the sibling profiles is safe
 * whenever someone next touches this file.
 */
export const NARRATIVE_OUTCOME_TOOL_NAME = 'submit_narrative';

export function isNarrativeProfile(run: { profile: AiAgentRunProfile }): boolean {
  return run.profile === 'narrative';
}

/**
 * Effective limits for a narrative run: turns pinned to `narrativeMaxTurns`,
 * budget from `narrativeBudgetCentsPerRun`, everything else carried through
 * from the snapshot unchanged (concurrency/hour caps are governed by the
 * separate `maxConcurrentNarrativeRuns`/`maxNarrativeRunsPerHour` fields at
 * the admission layer — `profileCaps` in `runService.ts` — not here; same
 * split as `verdictLimits`/`sweepLimits`).
 *
 * `maxActionsPerRun: 0` is a deliberate hard override, not a passthrough, and
 * is stricter here than for either sibling profile: a narrative run does not
 * even PROPOSE a mutation (`sweep`'s `proposedAction` / `verdict`'s proposed
 * remediation have no analogue in `NarrativeOutcome`). It writes prose
 * about a week that already happened. Same out-of-schema-safe `0` as
 * `verdictLimits`/`sweepLimits` — this object is a runtime-derived value
 * handed straight to the run loop, never re-validated through
 * `aiAgentLimitsSchema` (whose `maxActionsPerRun` bound is `[1, 10]`).
 *
 * `?? AI_AGENT_LIMIT_DEFAULTS...`: a policy snapshot resolved before the v7
 * limits bump has no `narrativeMaxTurns`/`narrativeBudgetCentsPerRun` field at
 * all, and an in-flight run on one of those snapshots must still get a real
 * ceiling — the alternative, `maxBudgetCentsPerRun: undefined`, turns the
 * SDK's `maxBudgetUsd` into `NaN`.
 */
export function narrativeLimits(limits: AiAgentLimits): AiAgentLimits {
  return {
    ...limits,
    maxTurnsPerRun: limits.narrativeMaxTurns ?? AI_AGENT_LIMIT_DEFAULTS.narrativeMaxTurns,
    maxBudgetCentsPerRun:
      limits.narrativeBudgetCentsPerRun ?? AI_AGENT_LIMIT_DEFAULTS.narrativeBudgetCentsPerRun,
    maxActionsPerRun: 0,
  };
}

/**
 * The narrative-profile tool floor: ALWAYS the (empty) `NARRATIVE_TOOL_ALLOWLIST`
 * plus the narrative outcome tool, regardless of the agent's own configured
 * allowlist — same "floor, not intersection" design as
 * `verdictToolAllowlist`/`sweepToolAllowlist` (see `verdictToolAllowlist`'s
 * docstring for the full rationale: intersecting against a `full`-profile
 * allowlist can leak a bare multi-action tool's mutating actions in by
 * accident of naming).
 *
 * Here that design is at its simplest and strongest: the result does not vary
 * with the agent's allowlist at ALL, and contains exactly one entry — the
 * submission channel. A narrative run can therefore never execute anything,
 * by construction rather than by guardrail.
 */
export function narrativeToolAllowlist(_agentAllowlist: string[]): string[] {
  return [...NARRATIVE_TOOL_ALLOWLIST, NARRATIVE_OUTCOME_TOOL_NAME];
}
