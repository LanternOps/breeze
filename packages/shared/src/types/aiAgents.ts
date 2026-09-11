export const AI_AGENT_KINDS = ['triage', 'patch', 'helpdesk'] as const;
export type AiAgentKind = (typeof AI_AGENT_KINDS)[number];

export const AI_AGENT_MODES = ['off', 'shadow', 'act'] as const;
export type AiAgentMode = (typeof AI_AGENT_MODES)[number];

/** Ladder used by the tighten-only merge: lower rank = stricter. */
export const AI_AGENT_MODE_RANK: Readonly<Record<AiAgentMode, number>> = Object.freeze({ off: 0, shadow: 1, act: 2 });

export function minAgentMode(a: AiAgentMode, b: AiAgentMode): AiAgentMode {
  return AI_AGENT_MODE_RANK[a] <= AI_AGENT_MODE_RANK[b] ? a : b;
}

export const AI_AGENT_RUN_STATUSES = [
  'queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'expired', 'skipped',
] as const;
export type AiAgentRunStatus = (typeof AI_AGENT_RUN_STATUSES)[number];

export const AI_AGENT_TRIGGER_KINDS = ['alert', 'manual', 'schedule', 'ticket', 'anomaly'] as const;
export type AiAgentTriggerKind = (typeof AI_AGENT_TRIGGER_KINDS)[number];

export interface AiAgentLimits {
  maxDevicesPerRun: number;
  maxConcurrentRuns: number;
  maxRunsPerHour: number;
  maxTurnsPerRun: number;
  maxBudgetCentsPerRun: number;
  maxBudgetCentsPerDay: number;
  wallClockSeconds: number;
  maxFleetPercentPerDay: number;
  /**
   * Cap on the number of act-mode tool executions a single run may perform.
   * Unenforced in this PR (Part B's run loop enforces it) — the field exists
   * now so partners/orgs can pre-configure it and every policy snapshot from
   * this point on carries it.
   */
  maxActionsPerRun: number;
  /**
   * Wave 5 Part A (#3827) — cap on the number of Tier-3 mutations resolved
   * unattended via `POLICY_DECIDABLE_TIER3` (no human approval) per agent per
   * org per day. Unenforced in this PR — `resolvePolicyDecisionState` is a
   * stub that always returns `human_required`, so nothing consumes this field
   * yet; it ships now so partners/orgs can pre-configure it and every policy
   * snapshot from this point on carries it. Part B's `attemptPolicyDecision`
   * is the enforcer (see runService.ts's limits-coverage inventory).
   */
  maxPolicyDecisionsPerDay: number;
  /**
   * Wave 6 PR 2 (#3828) — the per-org circuit breaker's threshold: how many
   * consecutive terminal-failure runs an agent may accumulate in one org
   * before `recordRunTerminal` (agentCircuit.ts) auto-opens the circuit and
   * admission starts refusing new runs with `skip('circuit_open')`. Bounded
   * 1-10 deliberately with NO 0-disables value — a circuit breaker that can
   * be configured off is not a safety control (wave-6 quorum, 2026-08-28).
   * Enforced in `transitionRunStatus` via `agentCircuit.ts` — see
   * runService.ts's limits-coverage inventory.
   */
  maxConsecutiveFailures: number;
  /**
   * Phase 2 wave P2-1 (alert verdicts) — the verdict-profile admission caps,
   * kept separate from the `full`-profile `maxRunsPerHour`/`maxConcurrentRuns`
   * so a burst of cheap `verdict`-profile runs (per-alert classification)
   * never starves the full triage/patch/helpdesk run budget, and vice versa.
   * `maxRunsPerHour`/`maxConcurrentRuns` above apply ONLY to the `full`
   * profile; admission for `verdict`-profile runs is counted against these
   * three fields instead (see runService step 6b).
   */
  maxVerdictRunsPerHour: number;
  maxConcurrentVerdictRuns: number;
  verdictBudgetCentsPerRun: number;
  /**
   * Phase 2 wave P2-2 (scheduled sweeps) — the `sweep`-profile admission
   * caps, kept separate from `full`'s `maxConcurrentRuns`/`maxRunsPerHour`
   * and `verdict`'s `maxConcurrentVerdictRuns`/`maxVerdictRunsPerHour` for
   * the same reason those two are split from each other: a burst of
   * scheduled sweep runs (one per org per cron occurrence) must never starve
   * either of the other two profiles' admission budget, and vice versa.
   */
  maxConcurrentSweepRuns: number;
  maxSweepRunsPerHour: number;
  sweepBudgetCentsPerRun: number;
  sweepMaxTurns: number;
  /**
   * Phase 2 wave P2-3 (weekly org narrative) — the `narrative`-profile
   * admission caps, split from `full`/`verdict`/`sweep` for the same reason
   * those three are split from each other. Deliberately the TIGHTEST of the
   * four: a narrative run is a once-a-week, one-per-org report generator, so
   * a burst of them is always a bug (a re-fired schedule occurrence, a
   * retry storm) rather than legitimate load. `narrativeMaxTurns` is 3
   * because the profile's whole job is one bounded context read followed by
   * one `submit_narrative` call — a run needing more turns than that is
   * not converging and should end.
   */
  maxConcurrentNarrativeRuns: number;
  maxNarrativeRunsPerHour: number;
  narrativeBudgetCentsPerRun: number;
  narrativeMaxTurns: number;
  /**
   * v8 (P2-4) — the `triage`-profile admission caps, split from
   * `full`/`verdict`/`sweep`/`narrative` for the same reason those four are
   * split from each other: a burst of ticket-triggered triage runs (one per
   * ticket create / first human comment / `status_changed → resolved`) must
   * never starve any other profile's admission budget, and vice versa.
   * `triageMaxTurns` is deliberately tight (6): the profile's whole job is
   * one bounded context read (linked device's last 24h alerts/verdicts, open
   * sweep findings, last 3 resolved same-category tickets) followed by one
   * `submit_ticket_proposal` call — a run needing many more turns than that
   * is not converging and should end.
   */
  maxConcurrentTriageRuns: number;
  maxTriageRunsPerHour: number;
  triageBudgetCentsPerRun: number;
  triageMaxTurns: number;
  /**
   * v9 (P2-5) — verified-evidence count a colon key must reach before it
   * becomes promote-eligible. Merged with `max`, not `min`: a partner
   * raising the bar must not be undercut by an org lowering it.
   */
  promoteThreshold: number;
}

export const AI_AGENT_LIMIT_DEFAULTS: Readonly<AiAgentLimits> = Object.freeze({
  maxDevicesPerRun: 1,
  maxConcurrentRuns: 1,
  maxRunsPerHour: 20,
  maxTurnsPerRun: 25,
  maxBudgetCentsPerRun: 50,
  maxBudgetCentsPerDay: 1000,
  wallClockSeconds: 600,
  maxFleetPercentPerDay: 5,
  maxActionsPerRun: 3,
  maxPolicyDecisionsPerDay: 10,
  maxConsecutiveFailures: 3,
  maxVerdictRunsPerHour: 200,
  maxConcurrentVerdictRuns: 4,
  // Tuned from 3/2¢ to 4/5¢ after the P2-1 live check (task 16): 3 of 4
  // Sonnet verdict runs hit the 3-turn cap without ever calling
  // submit_alert_verdict, spending 9-10 cost-cents against the 2-cent budget
  // before reaching a submittable turn. See maxTurnsPerRun's sibling bump in
  // apps/api/src/services/aiAgents/verdictProfile.ts (VERDICT_MAX_TURNS).
  verdictBudgetCentsPerRun: 5,
  // Sweep-profile admission caps (phase 2 P2-2) — see
  // AiAgentLimits.maxConcurrentSweepRuns's docstring.
  maxConcurrentSweepRuns: 2,
  maxSweepRunsPerHour: 20,
  sweepBudgetCentsPerRun: 30,
  sweepMaxTurns: 8,
  // Narrative-profile admission caps (phase 2 P2-3) — see
  // AiAgentLimits.maxConcurrentNarrativeRuns's docstring.
  maxConcurrentNarrativeRuns: 1,
  maxNarrativeRunsPerHour: 5,
  narrativeBudgetCentsPerRun: 20,
  narrativeMaxTurns: 3,
  // Triage-profile admission caps (phase 2 P2-4) — see
  // AiAgentLimits.maxConcurrentTriageRuns's docstring.
  maxConcurrentTriageRuns: 2,
  maxTriageRunsPerHour: 30,
  triageBudgetCentsPerRun: 10,
  triageMaxTurns: 6,
  // Promotion threshold (phase 2 P2-5) — see AiAgentLimits.promoteThreshold's
  // docstring. Merged with max, not min (effectivePolicy.ts).
  promoteThreshold: 20,
});

export interface AiAgentTriggers {
  alertSeverities: Array<'critical' | 'high' | 'medium' | 'low' | 'info'>;
  alertRuleIds?: string[];
  siteIds?: string[];
  deviceGroupIds?: string[];
  deviceTags?: string[];
  respectMaintenanceWindows: boolean;
  /**
   * Wave 6 PR 3 (#3828) — narrowing filters for `triggerKind: 'ticket'`
   * admission. Same `undefined`-means-unrestricted convention as
   * `siteIds`/`deviceGroupIds` above (never `[]` — see the validator).
   * Enforced by `runService.ts`'s `evaluateTicketTriggerFilters`, fed by
   * `ticketHelpdeskSubscriber.ts`'s `ticketContext` (wave 6 PR 3 review
   * follow-up, #3828). Entries may be either the ticket's free-text
   * `category` name or its `categoryId` (matched per-value — see
   * `evaluateTicketTriggerFilters`'s docstring for the id-vs-name rule).
   */
  ticketCategories?: string[];
  /** `ticket_priority` enum values (`db/schema/portal.ts`). Enforced by
   *  `runService.ts`'s `evaluateTicketTriggerFilters`. */
  ticketPriorities?: Array<'low' | 'normal' | 'high' | 'urgent'>;
  /**
   * Wave 6 PR 4 (#3828) — narrowing filters for `triggerKind: 'anomaly'`
   * admission (`evaluateAnomalyTriggerFilters`, Task 3). Same
   * undefined-means-unrestricted / `.min(1)` convention as `ticketCategories`
   * above, NOT `alertSeverities`' opt-in-list asymmetry.
   *
   * `anomalyTypes` matches `metric_anomaly_incidents.anomaly_type` /
   * `metric_anomalies.anomaly_type` — free text (`'spike'`/`'drop'`/`'trend'`
   * today, `apps/api/src/services/metricAnomalies.ts`), NOT a fixed pg enum,
   * so this is `string[]`, not a literal union — the detector can grow new
   * anomaly types without a shared-package release.
   */
  anomalyTypes?: string[];
  /** Matches `metric_anomalies.metric_name` (free text, e.g. `cpu_percent`). */
  metricNames?: string[];
  /**
   * Minimum `metric_anomaly_incidents.peak_score` (the detector's raw,
   * UNBOUNDED `score` magnitude — see `metric_anomalies.score`, a
   * `doublePrecision`) an incident's peak must reach to admit a run.
   * Deliberately NOT constrained to 0-1: unlike `confidence` (a derived,
   * bounded 0.5-0.99 value the detector computes FROM score), `score` itself
   * has no fixed ceiling across the spike/drop/trend detectors — see the
   * `peakScore` column comment on `metricAnomalyIncidents.ts`. `undefined`
   * means unrestricted (no floor), same convention as every other
   * trigger-filter field on this interface.
   */
  minAnomalyScore?: number;
  /**
   * Wave 6 PR 4 follow-up (#3828) — conservative per-agent opt-in for
   * `triggerKind: 'anomaly'` admission. Default `false` (see the validator's
   * `aiAgentTriggersSchema` transform): without this, any org with
   * `ml.anomalies.enabled` AND an enabled `triage` agent started receiving
   * anomaly-triggered shadow runs with zero configuration and no per-agent
   * opt-out — the `anomalyTypes`/`metricNames`/`minAnomalyScore` filters
   * above follow the repo's absent-means-unrestricted convention, so none of
   * them could act as an opt-in gate.
   *
   * Deliberately NOT this interface's usual "undefined means unrestricted"
   * convention: this is a binary safety gate for an unproven pilot
   * detector, not a narrowing filter, so its default must be the closed
   * (off) state.
   *
   * **Merge semantics (deliberately NOT the tighten-only intersection every
   * other trigger field above uses):** `evaluateAgentTriggerFilters`-style
   * tighten-only merges compute `partner ∩ org`, but for a boolean opt-in
   * gate that shape is unsafe in the common "org has no override row"
   * case — `mergeAgentPolicies` falls back to the partner baseline
   * VERBATIM when there is no org override, which would let a partner-wide
   * baseline row silently opt every org under it into an unproven pilot
   * with zero org-level action. So this field reads ONLY the org's own
   * trigger override: `effective.triggers.anomalyEnabled` is `true` iff the
   * ORG-level `ai_agents` row for this agent has `triggers.anomalyEnabled:
   * true` set explicitly. The partner baseline's own value for this field
   * is never consulted, in either direction: an org with no override row at
   * all always resolves to unset (falsy) here, and an org that HAS
   * explicitly opted in stays opted in regardless of what the partner
   * baseline separately holds. See `mergeAgentPolicies` (effectivePolicy.ts)
   * for the implementation and `evaluateAnomalyTriggerFilters`'s admission
   * gate in runService.ts for the enforcement point (checked unconditionally
   * for `triggerKind: 'anomaly'`, not only when an `anomalyContext` happens
   * to be supplied).
   *
   * Not part of a versioned snapshot-shape bump: like `anomalyTypes`/
   * `metricNames`/`minAnomalyScore` above (added the same wave, also
   * without a bump), this is a new OPTIONAL field on `triggers`, not on
   * `limits` — every `AI_AGENT_POLICY_SNAPSHOT_VERSION` bump to date (v2-v5)
   * was for a `limits` field specifically, because runtime code branches on
   * `schemaVersion` to decide whether a STORED run snapshot's `limits`
   * object can be trusted to carry that key. Nothing branches on
   * `schemaVersion` for `triggers` fields; every read site already treats a
   * missing trigger-filter key as its default (unrestricted, or here, off).
   */
  anomalyEnabled?: boolean;
  /**
   * Phase 2 wave P2-4 (#4191) — per-agent opt-in that lifts wave 6.3's forced
   * shadow behavior for `triggerKind: 'ticket'` runs. Default `false` (see
   * the validator's `aiAgentTriggersSchema` transform): without this, an
   * agent in `mode: 'act'` would start writing ticket fields, linking
   * devices, and creating drafts unattended the moment `act` was flipped on
   * — a second, independent gate is required (spec §4.4: "lifts the shadow
   * force ONLY when both gates are open: agent `mode = 'act'` AND
   * `triggers.ticketAutonomousWrites`").
   *
   * Deliberately NOT this interface's usual "undefined means unrestricted"
   * convention: like `anomalyEnabled`, this is a binary safety gate for
   * unattended writes, not a narrowing filter, so its default must be the
   * closed (off) state.
   *
   * **Merge semantics (deliberately NOT the tighten-only intersection every
   * narrowing trigger field uses):** same shape as `anomalyEnabled` — a
   * partner-wide baseline row can never blanket-enable autonomous ticket
   * writes for every org under it. This field reads ONLY the org's own
   * trigger override: `effective.triggers.ticketAutonomousWrites` is `true`
   * iff the ORG-level `ai_agents` row for this agent has
   * `triggers.ticketAutonomousWrites: true` set explicitly. The partner
   * baseline's own value is never consulted, in either direction. See
   * `mergeAgentPolicies` (effectivePolicy.ts) for the implementation, and
   * consult this flag in BOTH the live effective policy (at intent-creation
   * time — decided inside the same transaction that creates the Tier-2
   * intent, spec §4.4 amendment) and the run's start-of-run policy snapshot.
   *
   * Not part of a versioned snapshot-shape bump: like `anomalyEnabled`
   * before it, this is a new OPTIONAL field on `triggers`, not on `limits`
   * — every `AI_AGENT_POLICY_SNAPSHOT_VERSION` bump to date was for a
   * `limits` field specifically (see the version history below). Nothing
   * branches on `schemaVersion` for `triggers` fields; every read site
   * already treats a missing trigger-filter key as its default (here, off).
   */
  ticketAutonomousWrites?: boolean;
}

export interface AiAgentRecipients {
  userIds: string[];
  /**
   * Role IDs, not role names. `roles` is a tenant-scoped table with custom
   * names and an `isSystem` flag (apps/api/src/db/schema/users.ts) — there is
   * no fixed owner/admin/technician union in this product, so matching by name
   * would silently miss renamed or partner-defined roles.
   */
  roleIds: string[];
}

export interface AiAgentProtectedResources {
  services: string[];
  paths: string[];
  registryKeys: string[];
  deviceTags: string[];
}

/**
 * Wave 4 Part B (Task 6, #3826) — per-script act-mode authorization.
 *
 * `toolAllowlist` admitting `run_script` is necessary but never sufficient for
 * unattended execution: a saved script can read secrets, rewrite config, or do
 * anything else its author wrote, so allowlisting the TOOL must not silently
 * authorize every script an org happens to have. `scriptIds` is the closed set
 * an operator has explicitly opted into for act mode; empty/absent means
 * run_script is never act-eligible for this agent — the model may still call
 * it, and it still records as a proposal exactly like any other unmatched
 * Tier-3 mutation (Global Constraints, plan header).
 */
export interface AiAgentActAssets {
  scriptIds: string[];
  /**
   * Wave 5 Part B (#3827) — the closed set of `POLICY_DECIDABLE_TIER3`
   * (apps/api/src/services/actionIntents/policyDecidable.ts) keys an operator
   * has explicitly authorized for THIS agent to have policy-decided (no human
   * fanout) when `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED` is on. Same
   * tighten-only shape as `scriptIds`: membership here is necessary but never
   * sufficient — `attemptPolicyDecision` still gates on live guardrails, kill
   * state, and the exposure caps.
   *
   * Optional, unlike `scriptIds`: this field did not exist before this wave,
   * and `AI_AGENT_POLICY_SNAPSHOT_VERSION` was NOT bumped for it (v3 is
   * already tolerant of a new key inside `actAssets` — see the version
   * history below). A run enqueued before this deploy, and a partner/org row
   * written before this deploy, both carry an `actAssets` object with no
   * `supervisedActionKeys` key at all — every read site must treat that as
   * "authorizes nothing" (`?? []`), never throw on its absence.
   */
  supervisedActionKeys?: string[];
}

/** The policy fields that the resolver merges (everything on ai_agents that governs a run). */
export interface AiAgentPolicy {
  enabled: boolean;
  mode: AiAgentMode;
  model: string | null;
  toolAllowlist: string[];
  protectedResources: AiAgentProtectedResources;
  limits: AiAgentLimits;
  triggers: AiAgentTriggers;
  recipients: AiAgentRecipients;
  actAssets: AiAgentActAssets;
  instructions: string | null;
  cooldownSeconds: number;
}

export type AiAgentPolicyProvenance = Record<keyof AiAgentPolicy, 'partner' | 'org' | 'merged'>;

/**
 * Bumped whenever the shape of `effective` changes. ai_agent_runs.policy_snapshot
 * is append-only ledger data that outlives this type, so a v1 row must stay
 * distinguishable from a v2 row — there is no backfill for a run that already
 * happened.
 *
 * v2: `effective.limits` gained `maxActionsPerRun`. An in-flight run enqueued
 * before that deploy still carries a v1 snapshot (no `maxActionsPerRun` in
 * `effective.limits`) and MUST still execute — every read site that touches
 * `schemaVersion` or `effective.limits` has to tolerate a v1 row, never
 * reject it.
 *
 * v3 (wave 5 Part A #3827): `effective.limits` gained
 * `maxPolicyDecisionsPerDay`. Same rule: an in-flight run's v1 or v2 snapshot
 * lacks the field and MUST still execute — nothing reads it yet (unenforced
 * this PR), but every site that switches on `schemaVersion` must tolerate
 * 1, 2, AND 3.
 *
 * v4 (wave 6 PR 2 #3828): `effective.limits` gained
 * `maxConsecutiveFailures` (the circuit breaker's threshold). Same rule
 * again: a v1/v2/v3 in-flight run's snapshot lacks the field and MUST still
 * execute — `recordRunTerminal` (agentCircuit.ts) resolves the effective
 * threshold at transition time via `resolveEffectiveAgentSystem`, never off
 * the stored run snapshot, so a pre-v4 run's missing field never blocks
 * circuit accounting. Every site that switches on `schemaVersion` must
 * tolerate 1, 2, 3, AND 4. Write side always stamps the current version.
 *
 * v5 (phase 2 P2-1): `effective.limits` gained
 * `maxVerdictRunsPerHour`, `maxConcurrentVerdictRuns`,
 * `verdictBudgetCentsPerRun`; read sites fall back to
 * `AI_AGENT_LIMIT_DEFAULTS` for a v1–v4 snapshot. `verdictBudgetCentsPerRun`'s
 * default (and `VERDICT_MAX_TURNS` in verdictProfile.ts) were tuned from
 * 2¢/3 turns to 5¢/4 turns shortly after this bump, after the P2-1 live
 * check (task 16) found 3 of 4 Sonnet verdict runs ran out before submitting
 * — the schema shape didn't change again, so this is still a v5 snapshot.
 *
 * v6 (this bump, P2-2): sweep-profile counters/budget/turns —
 * `effective.limits` gained `maxConcurrentSweepRuns`, `maxSweepRunsPerHour`,
 * `sweepBudgetCentsPerRun`, `sweepMaxTurns`. Same rule as every prior bump:
 * a v1–v5 in-flight run's snapshot lacks these fields and MUST still
 * execute; read sites fall back to `AI_AGENT_LIMIT_DEFAULTS` for a pre-v6
 * snapshot. Every site that switches on `schemaVersion` must tolerate 1
 * through 6.
 *
 * v7 (P2-3): narrative-profile counters/budget/turns —
 * `effective.limits` gained `maxConcurrentNarrativeRuns`,
 * `maxNarrativeRunsPerHour`, `narrativeBudgetCentsPerRun`,
 * `narrativeMaxTurns`. Same rule as every prior bump: a v1-v6 in-flight
 * run's snapshot lacks these fields and MUST still execute; read sites fall
 * back to `AI_AGENT_LIMIT_DEFAULTS` for a pre-v7 snapshot. Every site that
 * switches on `schemaVersion` must tolerate 1 through 7.
 *
 * v8 (P2-4): triage-profile counters/budget/turns —
 * `effective.limits` gained `maxConcurrentTriageRuns`, `maxTriageRunsPerHour`,
 * `triageBudgetCentsPerRun`, `triageMaxTurns`. Same rule as every prior bump:
 * a v1-v7 in-flight run's snapshot lacks these fields and MUST still
 * execute; read sites fall back to `AI_AGENT_LIMIT_DEFAULTS` for a pre-v8
 * snapshot. Every site that switches on `schemaVersion` must tolerate 1
 * through 8. (`triggers.ticketAutonomousWrites`, added the same wave, does
 * NOT bump this version — see that field's own docstring.)
 *
 * v9 (this bump, P2-5): `promoteThreshold` — see `AiAgentLimits.promoteThreshold`'s
 * docstring. Same rule as every prior bump: a v1-v8 in-flight run's snapshot
 * lacks this field and MUST still execute; read sites fall back to
 * `AI_AGENT_LIMIT_DEFAULTS.promoteThreshold` for a pre-v9 snapshot. Every
 * site that switches on `schemaVersion` must tolerate 1 through 9.
 */
export const AI_AGENT_POLICY_SNAPSHOT_VERSION = 9 as const;

export interface AiAgentPolicySnapshot {
  /** 1 (pre-maxActionsPerRun), 2 (pre-maxPolicyDecisionsPerDay), 3 (pre-maxConsecutiveFailures), 4 (pre-verdict-limits), 5 (pre-sweep-limits), 6 (pre-narrative-limits), 7 (pre-triage-limits), 8 (pre-promoteThreshold), or 9 (current). Read sites must tolerate all nine. */
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  agentId: string;
  kind: AiAgentKind;
  effective: AiAgentPolicy;
  provenance: AiAgentPolicyProvenance;
  resolvedAt: string;
}

/**
 * Modes the API accepts on WRITE today — all three. `mode_not_supported` is
 * now reached only by a mode that is not a member of this list at all; it is
 * no longer the answer for `act`, which wave 4 Part B admitted (see below).
 *
 * This lives in shared rather than in the API because it is a wire contract:
 * the settings form has to know which modes a create will be allowed to pick,
 * and there is no row to read `supportedModes` off before the agent exists.
 * Two copies of this list means the create form silently keeps refusing `act`
 * on the day the API starts accepting it.
 *
 * Wave 4 Part B (Task 6, #3826): `act` ships bounded, verified, revalidated
 * unattended execution against a closed manifest — see actManifest.ts and the
 * plan header's Design authority. A write is still refused with 422
 * `act_prerequisites_not_met` unless the agent has a resolvable recipient and
 * at least one act-eligible allowlisted surface (agentService.ts).
 */
export const SUPPORTED_AGENT_MODES: readonly AiAgentMode[] = ['off', 'shadow', 'act'] as const;

export type AiAgentOwnerScope = 'organization' | 'partner';

/**
 * The wire shape of one agent as returned by /api/v1/ai/agents.
 *
 * Declared here, and named as the API handler's return type, so the endpoint
 * cannot drift from the client that consumes it. It is deliberately NOT "every
 * column of ai_agents": spreading the row would publish `createdBy`,
 * `lastUpdatedBy` and `disabledBy`, and would silently make every column added
 * in a later wave part of the public API of a table whose entire purpose is
 * agent authority.
 *
 * The nested policy objects are `Partial` because that is what the columns
 * actually store — jsonb defaulting to `{}`, with defaults applied at read time
 * by normalizeAgentPolicy. The top-level fields are NOT optional: those columns
 * are NOT NULL, so a client writing `toolAllowlist ?? []` would be papering over
 * a contract change rather than handling a real absence.
 */
export interface AiAgentDto {
  id: string;
  kind: AiAgentKind;
  name: string;
  enabled: boolean;
  mode: AiAgentMode;
  model: string | null;
  orgId: string | null;
  partnerId: string | null;
  /** Derived from the owner columns; always consistent with them. */
  ownerScope: AiAgentOwnerScope;
  /** True for a partner-wide baseline row (`partner_id` set, `org_id` null). */
  allOrgs: boolean;
  /** What this API build will accept for `mode` on a write. */
  supportedModes: readonly AiAgentMode[];
  toolAllowlist: string[];
  protectedResources: Partial<AiAgentProtectedResources>;
  limits: Partial<AiAgentLimits>;
  triggers: Partial<AiAgentTriggers>;
  recipients: Partial<AiAgentRecipients>;
  actAssets: Partial<AiAgentActAssets>;
  instructions: string | null;
  cooldownSeconds: number;
  /** ISO-8601. Non-null means the agent is soft-deleted. */
  disabledAt: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * The agent's most recent run, as the LIST route projects it (`loadLastRuns`
   * in apps/api/src/routes/aiAgents.ts batches one query for the whole page).
   *
   * Optional because only the list route computes them; `null` — which that
   * route always sends, computed or not — means "this agent has never run in
   * an org this caller can see". The settings page used to declare its own
   * `AgentListItem = AiAgentDto & {...}` for exactly these two fields, which
   * made the DTO a description of the wire shape that the wire did not match.
   */
  lastRunAt?: string | null;
  lastRunStatus?: string | null;
  /**
   * How many things that most recent run left for a human to look at — the
   * same number `AiAgentRunListItemDto.findingsToReview` carries, from the
   * same helper (`countFindingsToReview` / `findingsToReviewSql`,
   * apps/api/src/services/aiAgents/runFindings.ts), computed over the SAME
   * `DISTINCT ON` row `lastRunStatus` above comes from.
   *
   * `lastRunStatus` alone understates the agent: a sweep that found six
   * problems and was allowed to execute none of them reports `completed`, so
   * the settings list showed a healthy-looking agent sitting on unread
   * findings. `null` — never 0 — when there is no visible last run at all,
   * matching its two siblings; 0 means "there IS a last run and it left
   * nothing to review".
   *
   * Optional for the same reason as its siblings: only the list route
   * computes it, and every other route that returns an `AiAgentDto` answers
   * `null` rather than omitting the key.
   */
  lastRunFindingsToReview?: number | null;
  /**
   * Whether `resolveEffectiveAgentInner` would treat this row as effective
   * (#4170) — always `true` for a partner-wide row (`allOrgs`), since it IS
   * the baseline; for an org row, `true` only when an active partner-wide
   * baseline of the same `kind` exists for this org's partner. An org row
   * with `false` here shows `enabled`/`mode` from its own columns but the
   * resolver returns `null` for it: it overrides nothing and has no effect.
   *
   * Optional for the same reason as the `lastRun*` fields above: only the
   * LIST route computes it (one query for the whole page, not per row) —
   * every other route that returns an `AiAgentDto` omits the key rather than
   * guessing at it.
   */
  hasPartnerBaseline?: boolean;
}

/**
 * Agent tool catalog (spec `2026-09-06-ai-agent-builder-design.md` §4.1). One
 * operation within a reachable tool's catalog entry: a bare tool (no
 * discriminator) has exactly one operation with `action: null` whose `key`
 * equals the tool name; a multi-operation tool has one entry per
 * discriminator value with `key: '<tool>:<action>'`. `tier`/`readOnly` are
 * resolved through `checkGuardrails`, never hand-declared — see
 * `apps/api/src/services/aiAgents/agentToolCatalog.ts`.
 */
export interface AgentToolOperationDto {
  key: string;
  action: string | null;
  tier: 1 | 2 | 3;
  readOnly: boolean;
  /** `key` is a member of `POLICY_DECIDABLE_TIER3`. */
  policyDecidable: boolean;
  /** `key`'s tool (at this action) is one `ACT_MANIFEST` can dispatch unattended. */
  actEligible: boolean;
  /**
   * `actEligible` holds only while the agent's `actAssets.scriptIds` is
   * non-empty (`run_script` — the run loop refuses an unauthorized script and
   * proposes instead). The outcome rule (`outcomeFor`, packages/shared) turns
   * this into an approval request until a script is authorized.
   */
  actRequiresAuthorizedScripts: boolean;
}

/** One agent-reachable tool's catalog entry — `capability` is an `AgentCapabilityId`. */
export interface AgentToolCatalogToolDto {
  name: string;
  capability: string;
  tier: 1 | 2 | 3;
  /** True only when every operation on this tool is read-only. */
  readOnly: boolean;
  operations: AgentToolOperationDto[];
}

/** `GET /ai/agents/tool-catalog` response body's `data`. */
export interface AgentToolCatalogDto {
  capabilities: { id: string; tone: 'standard' | 'high' }[];
  tools: AgentToolCatalogToolDto[];
  presets: Record<AiAgentKind, string[]>;
  /**
   * Every registered tool NOT in `tools` — not in `TOOL_TIERS`,
   * `AGENT_HUMAN_ONLY_TOOLS`, `BLOCKED_TOOLS`, or secret-bearing. Lets the
   * picker tell a stale allowlist entry that names a real-but-unreachable
   * tool (`unreachable_tool`) apart from one that never existed
   * (`unknown_tool`) — see `apps/api/src/services/aiAgents/agentToolCatalog.ts`'s
   * `listUnreachableRegisteredTools`.
   */
  unreachableTools: string[];
}

/**
 * `GET /ai/agents/ceiling?kind=` response body's `data` — the partner-wide
 * baseline's tool ceiling for one `kind`, projected for an org- or
 * partner-scoped caller. `null` for a system-scope session, a caller with no
 * `partnerId` at all, or when no live baseline exists for that kind.
 */
export interface AgentCeilingDto {
  toolAllowlist: string[];
  supervisedActionKeys: string[];
  /**
   * The baseline's `actAssets.scriptIds`. The effective policy an org agent
   * runs under is `intersect(partner.scriptIds, org.scriptIds)`
   * (`effectivePolicy.ts`), so a script the org row lists but the baseline
   * does not is never dispatched unattended — the preview and the edit
   * drawer intersect against this before counting authorized scripts.
   */
  scriptIds: string[];
}

/**
 * `POST /ai/agents/preview` response body's `data` (Task 11, #5051; spec
 * §4.6 step 4). Evaluates a DRAFT agent policy through the SAME
 * `AgentToolCatalogDto` and `AgentCeilingDto` the picker and run loop use, so
 * the guided create flow's review card can never drift from what
 * create/update would actually enforce. Built by
 * `apps/api/src/services/aiAgents/agentPreview.ts`'s `buildAgentPreview` —
 * pure, no DB read beyond the ceiling the route already resolved.
 */
export interface AgentPreviewDto {
  mode: AiAgentMode;
  kind: AiAgentKind;
  /** `catalog.tools.filter(t => t.readOnly).length` — the "always on" reads, independent of `operations` below. */
  readOnlyToolCount: number;
  /**
   * Scripts the draft is effectively authorized to run unattended:
   * `actAssets.scriptIds` (deduped), intersected with the partner ceiling's
   * list when there is a ceiling (#5065). Always `0` when the draft's own
   * allowlist, or the ceiling's, does not admit `run_script` — the
   * allowlists intersect first, so nothing could run whatever the lists
   * share (#5089 review). Drives the `run_script` outcome and the review
   * card's "N scripts authorized" note.
   */
  authorizedScriptCount: number;
  /**
   * One entry per resolved MUTATING operation the draft's `toolAllowlist`
   * admits, deduplicated by `key`. A bare entry on a multi-operation tool
   * expands to every one of that tool's non-read-only operations (its
   * always-on reads are already counted in `readOnlyToolCount`, not listed
   * here); an entry the catalog cannot resolve — unknown tool, unreachable
   * tool, or an action the tool does not have — contributes to
   * `unrecognised` instead of an operation here.
   */
  operations: Array<{
    key: string;
    capability: string;
    /**
     * `mode === 'act' && op.actEligible` -> `'unattended'`; else tier 3 ->
     * `'approval_request'`; else (tier 1/2, never selected alone but
     * reachable via a bare multi-op expansion) -> `'logged_proposal'`.
     */
    outcome: 'approval_request' | 'logged_proposal' | 'unattended';
    /**
     * Non-null when act mode WOULD dispatch this operation unattended but a
     * prerequisite is still missing — today only `'authorized_scripts'`
     * (`run_script` with an empty `actAssets.scriptIds`), in which case
     * `outcome` is the truthful `'approval_request'`. Lets the review card say
     * why rather than silently downgrade.
     */
    unattendedBlockedBy: 'authorized_scripts' | null;
    /** `key` is inside the intersection of the ceiling's and the draft's own `supervisedActionKeys` (or just the draft's own, on a partner draft with no ceiling). */
    preauthorized: boolean;
    /** `true` unconditionally when there is no ceiling (a partner draft, or an org draft with no live partner baseline yet). */
    withinCeiling: boolean;
  }>;
  /** Raw `toolAllowlist` entries the catalog could not resolve, verbatim (never rewritten). */
  unrecognised: string[];
  triggers: {
    alertSeverities: AiAgentTriggers['alertSeverities'];
    respectMaintenanceWindows: boolean;
    ticketAutonomousWrites: boolean;
  };
  protectedResources: AiAgentProtectedResources;
  limits: AiAgentLimits;
  /** `AiAgentPolicy.cooldownSeconds` is a sibling of `limits`, not one of its
   *  fields — carried through separately so the review card's "six exposed
   *  limits" (spec §4.6 step 4) can render it alongside the five in `limits`
   *  without reaching into a differently-shaped policy row. */
  cooldownSeconds: number;
  recipients: AiAgentRecipients;
}

/**
 * Wave 4 Part B — act mode verdicts.
 *
 * `execution` reports the tool dispatch outcome for a manifest-matched call
 * that act mode actually ran (through the normal tool path): `failed` for a
 * tool-reported error, `timeout` for a command that never resolved inside its
 * bound, `unknown` when the dispatch outcome could not be classified either
 * way (never conflate this with `failed` — an `unknown` execution still runs
 * verification, since the underlying action may well have succeeded).
 */
export type ActExecutionVerdict = 'succeeded' | 'failed' | 'timeout' | 'unknown';

/**
 * `verification` reports the op's OWN read-back against `execution`, not a
 * restatement of it: `skipped` is for an op with no declared postcondition
 * (a bare script run today — see actVerify.ts), `inconclusive` is a read-back
 * that itself failed/timed out (the action's real effect is unknown, not
 * negative) — only `failed` triggers the rule-less attention alert.
 */
export type ActVerificationVerdict = 'passed' | 'failed' | 'inconclusive' | 'skipped';

/**
 * Run-level rollup computed once at finish from every acted-on op's
 * (execution, verification) pair plus whatever else the run proposed:
 * `remediated` — every act execution verified `passed`; `needs_attention` —
 * at least one act execution verified `failed` or `inconclusive`;
 * `partial` — a mix of successful act executions and unmatched-mutation
 * proposals in the same run; `no_action` — the run performed no act
 * executions at all (shadow/propose-only turns, or a read-only run).
 */
export type AgentRunVerdict = 'remediated' | 'needs_attention' | 'partial' | 'no_action';

/**
 * Phase 2 wave P2-1 (alert verdicts). `full` is the existing (default) agent
 * run shape; `verdict` is a lighter-weight run profile scoped to producing
 * an `AiAlertVerdict` for one alert or correlation group instead of a full
 * triage/patch/helpdesk turn. See runService step 6b for how admission is
 * counted per-profile.
 *
 * Phase 2 wave P2-2 (scheduled sweeps) added `sweep`: a `schedule`-triggered
 * run profile that evaluates a fixed set of `AiSweepKind`s against one org's
 * fleet and produces a `SweepFindingsOutcome` instead of a full triage turn.
 * Admission for `sweep`-profile runs is counted against
 * `AiAgentLimits.maxConcurrentSweepRuns`/`maxSweepRunsPerHour`, not the
 * `full`/`verdict` counters above — see that field's docstring.
 *
 * Phase 2 wave P2-3 (weekly org narrative) added `narrative`: a
 * `schedule`-triggered run profile that reads one org's bounded weekly
 * context and produces a `NarrativeOutcome` (see `orgNarrativeReport.ts`)
 * instead of findings or a verdict. Admission is counted against
 * `AiAgentLimits.maxConcurrentNarrativeRuns`/`maxNarrativeRunsPerHour`.
 *
 * Phase 2 wave P2-4 (ticket triage, act) added `triage`: a
 * `ticket`-triggered run profile (create / first human comment /
 * `status_changed → resolved`) with an empty tool floor plus
 * `submit_ticket_proposal` as its only outcome tool — a `full`-profile run
 * cannot reach an outcome tool. Produces a `TicketTriageProposal`
 * (`types/ticketTriage.ts`) instead of findings, a verdict, or a narrative.
 * Admission is counted against
 * `AiAgentLimits.maxConcurrentTriageRuns`/`maxTriageRunsPerHour`.
 */
export const AI_AGENT_RUN_PROFILES = ['full', 'verdict', 'sweep', 'narrative', 'triage'] as const;
export type AiAgentRunProfile = (typeof AI_AGENT_RUN_PROFILES)[number];

/**
 * Phase 2 wave P2-1 (alert verdicts). Classification an `ai_alert_verdicts`
 * row assigns to the alert (or correlation group) it evaluated.
 */
export const AI_ALERT_VERDICT_CLASSIFICATIONS = [
  'actionable', 'transient_self_healed', 'recurring_pattern', 'duplicate_of_group', 'needs_human',
] as const;
export type AiAlertVerdictClassification = (typeof AI_ALERT_VERDICT_CLASSIFICATIONS)[number];

/** Phase 2 wave P2-1 (alert verdicts). Stored in `ai_alert_verdicts.pattern`. */
export interface AiAlertVerdictPattern {
  kind: 'daily' | 'weekly' | 'after_event';
  evidenceAlertIds: string[];
}

/**
 * Phase 2 wave P2-1 (alert verdicts). The one mutation an `AlertVerdictOutcome`
 * may propose — always `manage_alerts`, since a verdict-profile run only ever
 * classifies and optionally acts on the alert(s) it evaluated, never any
 * other tool. `suppress` carries how long (hours); `resolve` does not.
 */
export type AlertVerdictSuggestedAction =
  | { tool: 'manage_alerts'; action: 'suppress'; alertId: string; suppressDuration: number }
  | { tool: 'manage_alerts'; action: 'resolve'; alertId: string };

/**
 * Phase 2 wave P2-1 (alert verdicts). Produced by the `submit_alert_verdict`
 * outcome tool (spec §4.1) and stored on `ai_alert_verdicts`. `pattern` is
 * present only for `recurring_pattern`/`duplicate_of_group` classifications
 * that found supporting evidence; `suggestedAction` is present only when the
 * model chose to propose a `manage_alerts` mutation alongside the verdict.
 */
export interface AlertVerdictOutcome {
  classification: AiAlertVerdictClassification;
  confidence: number;
  rationale: string;
  pattern?: AiAlertVerdictPattern;
  suggestedAction?: AlertVerdictSuggestedAction;
}
