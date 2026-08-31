// apps/api/src/services/aiAgents/verdictProfile.ts
/**
 * Phase 2 wave P2-1 (alert verdicts) — the `verdict` run profile's read-only
 * tool surface and pinned limits. `full` is the existing (default) profile;
 * `verdict` is a lighter-weight run scoped to producing an `AiAlertVerdict`
 * for one alert or correlation group (see `AiAgentRunProfile`,
 * packages/shared/src/types/aiAgents.ts).
 */
import { AI_AGENT_LIMIT_DEFAULTS, type AiAgentLimits, type AiAgentRunProfile } from '@breeze/shared';
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
// Tuned from 3 to 4 (with a matching 2¢ -> 5¢ verdictBudgetCentsPerRun default
// bump in packages/shared/src/types/aiAgents.ts) after the P2-1 live check
// (task 16): 3 of 4 real claude-sonnet-4-6 verdict runs hit the 3-turn cap
// (2 read-only tool calls, then no turn left to call submit_alert_verdict)
// before ever reaching a classification.
export const VERDICT_MAX_TURNS = 4;

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
 *
 * `verdictBudgetCentsPerRun` falls back to `AI_AGENT_LIMIT_DEFAULTS` (review
 * fix, wave P2-1 fix round 1): a policy snapshot resolved before the wave-6
 * bump (`schemaVersion` 1-4, see `AiAgentPolicySnapshot`'s header in
 * packages/shared) has no `verdictBudgetCentsPerRun` field at all, and an
 * in-flight run on one of those snapshots MUST still be able to run a
 * verdict profile — the alternative is `maxBudgetCentsPerRun: undefined`,
 * which turns the SDK's `maxBudgetUsd` into `NaN` (division by 100 of
 * `undefined`) and the run never gets a real budget ceiling at all.
 */
export function verdictLimits(limits: AiAgentLimits): AiAgentLimits {
  return {
    ...limits,
    maxTurnsPerRun: VERDICT_MAX_TURNS,
    maxBudgetCentsPerRun: limits.verdictBudgetCentsPerRun ?? AI_AGENT_LIMIT_DEFAULTS.verdictBudgetCentsPerRun,
    maxActionsPerRun: 0,
  };
}

/**
 * The verdict-profile tool floor: ALWAYS `VERDICT_TOOL_ALLOWLIST` + the
 * outcome tool, regardless of the agent's own configured allowlist.
 *
 * Review fix (wave P2-1 fix round 1) — this is a PLAN CHANGE that supersedes
 * the original "intersects, never widens" design: intersecting against the
 * agent's `full`-profile allowlist let a bare `manage_alerts` entry (which
 * exists to permit `acknowledge`/`resolve`/`suppress` on FULL runs) leak
 * into a verdict run's exposure too, since the intersection matched on the
 * bare tool name without knowing which actions the agent actually intended
 * to grant. `VERDICT_TOOL_ALLOWLIST` is entirely read-only tools/actions by
 * construction (`verdictProfile.test.ts`'s "every allowlisted tool/action is
 * read-only" case pins this against `TOOL_TIERS`/`TIER2_ACTIONS`/
 * `TIER2_READONLY_TOOLS` directly), so serving the full floor regardless of
 * the agent's allowlist widens nothing a `full`-profile run couldn't already
 * do read-only — it just stops a verdict run's exposure from being narrower
 * (and, worse, differently-shaped) than intended by accident of which tools
 * an operator happened to allowlist for unrelated act-mode purposes.
 *
 * `checkAgentGuardrails` (`aiGuardrails.ts`) already treats `tool:action`
 * entries as allowlist matches and lets read-only tools bypass the allowlist
 * check entirely, so this list governs *exposure* — which tools the SDK is
 * even given — not a second guardrail on its own; `runLoop.ts`'s pre-hook
 * additionally builds a verdict run's `guardrailPolicy.toolAllowlist` from
 * this SAME list (never the agent's raw `full`-profile allowlist) and denies
 * any disposition other than `allow` outright, so a bare `manage_alerts`
 * elsewhere in the agent's configuration can never reach `propose`/`act` on
 * a verdict run either.
 */
export function verdictToolAllowlist(_agentAllowlist: string[]): string[] {
  // Filtered, NOT spread: `OUTCOME_TOOL_NAMES` is the catalog of EVERY
  // profile's outcome tool, and since wave P2-2 it also carries
  // `submit_sweep_findings` — spreading it here would put a sweep run's
  // outcome tool into a verdict run's exposure AND its
  // `guardrailPolicy.toolAllowlist` (`runLoop.ts` builds both from this one
  // list). Mirrors `sweepToolAllowlist`'s own filter, for the same reason.
  return [
    ...VERDICT_TOOL_ALLOWLIST,
    ...OUTCOME_TOOL_NAMES.filter((name) => name === 'submit_alert_verdict'),
  ];
}
