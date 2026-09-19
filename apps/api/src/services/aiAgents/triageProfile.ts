// apps/api/src/services/aiAgents/triageProfile.ts
/**
 * Phase 2 wave P2-4 (#4191, ticket triage) — the `triage` run profile's tool
 * surface and pinned limits. `full` is the existing (default) profile;
 * `verdict` (P2-1) triages one alert/correlation group; `sweep` (P2-2) runs
 * on a schedule against pre-collected evidence for one org; `narrative`
 * (P2-3) turns one org's pre-collected week of activity into a customer
 * report; `triage` turns ONE ticket's system-assembled context into a
 * `TicketTriageProposal` (see `AiAgentRunProfile`,
 * packages/shared/src/types/aiAgents.ts).
 */
import { AI_AGENT_LIMIT_DEFAULTS, type AiAgentLimits, type AiAgentRunProfile } from '@breeze/shared';
import { OUTCOME_TOOL_NAMES, type OutcomeToolName } from './outcomeTools';

/**
 * The triage profile's read-only drill-down floor is EMPTY — same design as
 * `NARRATIVE_TOOL_ALLOWLIST` (`narrativeProfile.ts`), for the same reason: a
 * triage run's entire input is the bounded, system-assembled ticket context
 * (`ticketContext.ts`) collected before the run under a system DB context.
 * There is nothing live for the model to go and re-read, and letting it read
 * one would put unbounded, hostile ticket-adjacent data into a run whose
 * output feeds directly into ticket writes.
 *
 * Kept as an exported (empty) constant rather than inlined, because
 * `verdictProfile.contract.test.ts`'s "triage floor is empty" case asserts on
 * it directly, mirroring the narrative case.
 */
export const TRIAGE_TOOL_ALLOWLIST = [] as const;

/**
 * The triage outcome tool's name, derived by filtering `OUTCOME_TOOL_NAMES`
 * (the single source of truth for outcome-tool names) rather than hard-coded
 * as a literal. `outcomeTools.ts` registers `submit_ticket_proposal` in this
 * SAME task, so — unlike `NARRATIVE_OUTCOME_TOOL_NAME`'s historical literal
 * (see its docstring: that module landed BEFORE its tool was registered,
 * when the filter form would have evaluated to `[]`) — there is no
 * chicken-and-egg ordering problem here, and the filter form is safe from
 * the start. The non-null assertion is backed by `triageProfile.test.ts`'s
 * "agrees with outcomeTools.ts" case, which fails loudly if the name is ever
 * registered under a different spelling.
 */
export const TRIAGE_OUTCOME_TOOL_NAME: OutcomeToolName =
  (OUTCOME_TOOL_NAMES as readonly OutcomeToolName[]).find((name) => name === 'submit_ticket_proposal')!;

export function isTriageProfile(run: { profile: AiAgentRunProfile }): boolean {
  return run.profile === 'triage';
}

/**
 * Effective limits for a triage run: turns pinned to `triageMaxTurns`,
 * budget from `triageBudgetCentsPerRun`, everything else carried through
 * from the snapshot unchanged (concurrency/hour caps are governed by the
 * separate `maxConcurrentTriageRuns`/`maxTriageRunsPerHour` fields at the
 * admission layer — `profileCaps` in `runService.ts` — not here; same split
 * as `verdictLimits`/`sweepLimits`/`narrativeLimits`).
 *
 * `maxActionsPerRun` is a deliberate PASSTHROUGH here — the one field where
 * `triage` diverges from every sibling profile's hard `0` override
 * (`verdictLimits`/`sweepLimits`/`narrativeLimits` all zero it because those
 * run-loop turns never mint anything themselves). A triage run's tool floor
 * is empty (no in-run tool-call budget to protect — same as narrative), but
 * `submit_ticket_proposal`'s output is turned by `finishRun` (task A8) into
 * Tier-2 `manage_tickets` intents AFTER the run completes, capped by this
 * SAME `effective.limits.maxActionsPerRun` as a POST-RUN minting cap on how
 * many intents one ticket-triage run may mint — not an in-run tool-call
 * budget the way it is for `full`. Overriding it to `0` here would make that
 * post-run cap unconditionally zero and silently strand every proposal.
 *
 * `?? AI_AGENT_LIMIT_DEFAULTS...`: a policy snapshot resolved before the v8
 * limits bump has no `triageMaxTurns`/`triageBudgetCentsPerRun` field at
 * all, and an in-flight run on one of those snapshots must still get a real
 * ceiling — the alternative, `maxBudgetCentsPerRun: undefined`, turns the
 * SDK's `maxBudgetUsd` into `NaN`.
 */
export function triageLimits(limits: AiAgentLimits): AiAgentLimits {
  return {
    ...limits,
    maxTurnsPerRun: limits.triageMaxTurns ?? AI_AGENT_LIMIT_DEFAULTS.triageMaxTurns,
    maxBudgetCentsPerRun: limits.triageBudgetCentsPerRun ?? AI_AGENT_LIMIT_DEFAULTS.triageBudgetCentsPerRun,
  };
}

/**
 * The triage-profile tool floor: ALWAYS the (empty) `TRIAGE_TOOL_ALLOWLIST`
 * plus the triage outcome tool, regardless of the agent's own configured
 * allowlist — same "floor, not intersection" design as
 * `narrativeToolAllowlist`/`verdictToolAllowlist`/`sweepToolAllowlist` (see
 * `verdictToolAllowlist`'s docstring for the full rationale).
 *
 * Filtered, not spread, from `OUTCOME_TOOL_NAMES` — same reason as
 * `sweepToolAllowlist`/`verdictToolAllowlist`: spreading the whole catalog
 * would put every OTHER profile's outcome tool into a triage run's exposure
 * too.
 */
export function triageToolAllowlist(_agentAllowlist: string[]): string[] {
  return [
    ...TRIAGE_TOOL_ALLOWLIST,
    ...(OUTCOME_TOOL_NAMES as readonly string[]).filter((name) => name === 'submit_ticket_proposal'),
  ];
}
