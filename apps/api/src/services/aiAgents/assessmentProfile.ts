// apps/api/src/services/aiAgents/assessmentProfile.ts
/**
 * Wisp W05 — the `assessment` run profile's tool surface, pinned limits and
 * admission caps. An assessment is a grant-bearing, device-less run of the
 * org's `triage`-kind agent (`createAndEnqueueAgentRun({ kind: 'triage',
 * profile: 'assessment', grant })`, admission rule 2a) that looks at what
 * changed for ONE org under a Wisp grant and reports only through outcome
 * tools (`outcomeToolsForProfile('assessment')`): concerns, nudges and
 * proposals. It executes nothing itself (see `AiAgentRunProfile`,
 * packages/shared/src/types/aiAgents.ts).
 *
 * The caps below are module constants, not `AiAgentLimits` fields (W05 plan,
 * planner call 4): no policy page configures this profile, and a new limits
 * field would force a policy-snapshot version bump for nothing. `profileCaps`
 * in `runService.ts` reads them directly.
 */
import type { AiAgentLimits, AiAgentRunProfile } from '@breeze/shared';
import { outcomeToolsForProfile } from './outcomeTools';

/** Turns per assessment run (w00 "Assessment limits"). */
export const ASSESSMENT_MAX_TURNS = 15;
/** Model spend per assessment run, in cents (w00). */
export const ASSESSMENT_BUDGET_CENTS_PER_RUN = 25;
/** Wall clock per assessment run, in seconds (w00). */
export const ASSESSMENT_WALL_CLOCK_SECONDS = 300;
/** Queued + running assessment runs per (agent, org) — admission rule 6b. */
export const ASSESSMENT_MAX_CONCURRENT_RUNS = 1;
/** Assessment runs queued per (agent, org) in a rolling hour — admission rule 6b. */
export const ASSESSMENT_MAX_RUNS_PER_HOUR = 6;

/**
 * The assessment profile's read-only drill-down floor: the Tier-1 reads an
 * assessment needs to look at what changed for one org. Non-empty, like
 * `DESIGN_TOOL_ALLOWLIST` (`designProfile.ts`) and unlike triage/narrative,
 * because an assessment's input is a short context block (what changed since
 * the last assessment), not a complete evidence bundle — the model drills
 * into live data to decide whether something is a concern.
 *
 * Every entry is base tier 1 in `TOOL_TIERS`, registered in `aiTools`,
 * agent-reachable and declared on the breeze MCP server
 * (assessmentProfile.test.ts asserts all four). `manage_alerts` is a
 * multiplexed tool whose mutating actions escalate in `aiGuardrails.ts`, so
 * it is listed ONLY action-scoped to its two reads — the same entries
 * `VERDICT_TOOL_ALLOWLIST` uses. There is no agent-reachable ticket read
 * tool today (`manage_tickets` is not in `TOOL_TIERS`); ticket facts reach
 * the run through the context block instead.
 *
 * `recall` (Wisp W03) reads the grantor's memory through the grant-aware
 * broker; it works only because the run's agent auth carries `wispGrant`
 * (W05b Task 6). Its write sibling `remember` is Tier 2 and deliberately
 * absent: an assessment records what it learned through outcome tools.
 *
 * Read-only by construction on top of the list itself: `assessmentLimits`
 * zeroes `maxActionsPerRun`, and the run loop's per-call grant-ceiling check
 * still applies to every call (`createAgentRunPreToolUse`).
 */
export const ASSESSMENT_TOOL_ALLOWLIST: readonly string[] = [
  // Devices and change history.
  'query_devices', 'get_device_details', 'query_audit_log',
  // Alerts (read actions only).
  'manage_alerts:list', 'manage_alerts:get',
  // Backup health.
  'get_backup_status', 'query_backup_sla',
  // Incidents.
  'list_incidents', 'get_incident_timeline',
  // Security posture, EDR and vulnerabilities.
  'get_security_posture', 'list_edr_detections', 'get_vulnerability_report', 'get_device_vulnerabilities',
  // Wisp memory (W03), grant-scoped.
  'recall',
];

export function isAssessmentProfile(run: { profile: AiAgentRunProfile }): boolean {
  return run.profile === 'assessment';
}

/**
 * Effective limits for an assessment run: turns, budget and wall clock pinned
 * to the constants above, and `maxActionsPerRun` zeroed — an assessment never
 * executes anything itself; every write it wants goes through an outcome tool
 * and becomes an intent after the run. Everything else is carried through
 * from the snapshot unchanged. Concurrency and hourly caps are NOT here: they
 * are admission-layer (`profileCaps` in `runService.ts`), same split as
 * `triageLimits`/`designLimits`.
 *
 * No `?? AI_AGENT_LIMIT_DEFAULTS…` fallbacks are needed (unlike the siblings):
 * nothing is read off the snapshot for the pinned fields, so an older policy
 * snapshot cannot produce an `undefined` (→ `NaN` `maxBudgetUsd`) cap here.
 */
export function assessmentLimits(limits: AiAgentLimits): AiAgentLimits {
  return {
    ...limits,
    maxTurnsPerRun: ASSESSMENT_MAX_TURNS,
    maxBudgetCentsPerRun: ASSESSMENT_BUDGET_CENTS_PER_RUN,
    wallClockSeconds: ASSESSMENT_WALL_CLOCK_SECONDS,
    maxActionsPerRun: 0,
  };
}

/**
 * The assessment tool floor: ALWAYS `ASSESSMENT_TOOL_ALLOWLIST`, regardless of
 * the agent's own configured allowlist — same "floor, not intersection"
 * design as `designToolAllowlist`/`triageToolAllowlist`. The parameter is
 * intentionally unused.
 *
 * Why not an intersection: an agent's `toolAllowlist` is a MUTATION
 * allowlist — `checkAgentGuardrails` lets a read-only call through without
 * consulting it — and the `triage` kind preset (`AGENT_KIND_PRESETS.triage`)
 * holds only mutating entries, so an intersection would leave a default
 * triage agent's assessment with no reads at all. Narrowing happens where it
 * belongs: the grant ceiling intersects the stored allowlist at admission
 * (`intersectAllowlistWithCeiling`) and is re-checked on every tool call.
 *
 * Ends with the profile's outcome tools, read from
 * `outcomeToolsForProfile('assessment')` (the single source of truth the run
 * loop also uses for capture and `extraTools`) rather than re-listed here —
 * the same reason the siblings filter `OUTCOME_TOOL_NAMES` instead of
 * hard-coding a literal. `resolveRunToolExposure` maps an outcome name to its
 * MCP name and keeps it out of `onlyTools`.
 */
export function assessmentToolAllowlist(_agentAllowlist: string[]): string[] {
  return [...ASSESSMENT_TOOL_ALLOWLIST, ...outcomeToolsForProfile('assessment')];
}
