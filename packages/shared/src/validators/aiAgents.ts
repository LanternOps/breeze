import { z } from 'zod';
import { ALERT_SEVERITIES } from '../constants';
import {
  AI_AGENT_KINDS,
  AI_AGENT_LIMIT_DEFAULTS,
  AI_AGENT_MODES,
  AI_ALERT_VERDICT_CLASSIFICATIONS,
  type AlertVerdictOutcome,
} from '../types/aiAgents';

const TOOL_REF = /^[a-z0-9_]+(:[a-z0-9_]+)?$/;

// Every nested policy object is declared ONCE as a defaults-free "fields"
// schema, from which two variants are derived:
//
//   * the create variant  — `.partial().transform(fill defaults)`, so a create
//     body still materializes a complete object;
//   * the patch variant   — `.partial()` and nothing else, so a PATCH carries
//     exactly the keys the caller sent.
//
// Deriving both from one shape is what keeps them from drifting. The split
// exists because Zod applies a field's `.default()` even when the surrounding
// object is optional: with per-field defaults, `PATCH {protectedResources:
// {paths:[...]}}` parsed to a FULL object with `services` and `registryKeys`
// reset to `[]` — silently erasing an act-mode agent's guardrails. Same class
// of bug reset `limits` siblings and dropped `triggers` site/group scoping,
// widening an agent's blast radius.
//
// The patch variants only stop the validator inventing values. The update
// service must still deep-merge them onto the stored jsonb, or writing the
// column replaces it wholesale.

const limitsFields = z.object({
  maxDevicesPerRun: z.number().int().min(1).max(50),
  maxConcurrentRuns: z.number().int().min(1).max(10),
  maxRunsPerHour: z.number().int().min(1).max(500),
  maxTurnsPerRun: z.number().int().min(1).max(100),
  maxBudgetCentsPerRun: z.number().int().min(1).max(5000),
  maxBudgetCentsPerDay: z.number().int().min(1).max(100000),
  wallClockSeconds: z.number().int().min(30).max(1800),
  maxFleetPercentPerDay: z.number().int().min(1).max(100),
  maxActionsPerRun: z.number().int().min(1).max(10),
  maxPolicyDecisionsPerDay: z.number().int().min(1).max(200),
  // Circuit-breaker threshold (wave 6 PR 2, #3828). Bounded 1-10 with NO
  // 0-disables value — see AiAgentLimits.maxConsecutiveFailures's docstring.
  maxConsecutiveFailures: z.number().int().min(1).max(10),
  // Verdict-profile admission caps (phase 2 P2-1) — see
  // AiAgentLimits.maxVerdictRunsPerHour's docstring.
  maxVerdictRunsPerHour: z.number().int().min(1).max(2000),
  maxConcurrentVerdictRuns: z.number().int().min(1).max(20),
  verdictBudgetCentsPerRun: z.number().int().min(1).max(50),
  // Sweep-profile admission caps (phase 2 P2-2) — see
  // AiAgentLimits.maxConcurrentSweepRuns's docstring.
  maxConcurrentSweepRuns: z.number().int().min(1).max(10),
  maxSweepRunsPerHour: z.number().int().min(1).max(200),
  sweepBudgetCentsPerRun: z.number().int().min(5).max(100),
  sweepMaxTurns: z.number().int().min(3).max(20),
  // Narrative-profile admission caps (phase 2 P2-3) — see
  // AiAgentLimits.maxConcurrentNarrativeRuns's docstring. Bounded tighter
  // than the sweep caps on purpose: a narrative run is once-a-week and
  // one-per-org, so anything above a handful an hour is a re-fire, not load.
  maxConcurrentNarrativeRuns: z.number().int().min(1).max(5),
  maxNarrativeRunsPerHour: z.number().int().min(1).max(50),
  narrativeBudgetCentsPerRun: z.number().int().min(5).max(100),
  narrativeMaxTurns: z.number().int().min(2).max(8),
  // Triage-profile admission caps (phase 2 P2-4) — see
  // AiAgentLimits.maxConcurrentTriageRuns's docstring.
  maxConcurrentTriageRuns: z.number().int().min(1).max(10),
  maxTriageRunsPerHour: z.number().int().min(1).max(200),
  triageBudgetCentsPerRun: z.number().int().min(1).max(50),
  triageMaxTurns: z.number().int().min(2).max(12),
  // Promotion threshold (phase 2 P2-5) — see
  // AiAgentLimits.promoteThreshold's docstring.
  promoteThreshold: z.number().int().min(5).max(200),
});
export const aiAgentLimitsPatchSchema = limitsFields.partial();
export const aiAgentLimitsSchema = aiAgentLimitsPatchSchema.transform((v) => ({
  ...AI_AGENT_LIMIT_DEFAULTS,
  ...v,
}));

// `undefined` is the ONLY representation of "unrestricted" for the narrowing
// lists below — hence `.min(1)`. An empty array would read as "matches
// nothing", the exact opposite, and `siteIds ?? []` inverts the field's meaning.
const triggersFields = z.object({
  alertSeverities: z.array(z.enum(ALERT_SEVERITIES)).min(1),
  alertRuleIds: z.array(z.string().guid()).min(1).max(200),
  siteIds: z.array(z.string().guid()).min(1).max(500),
  deviceGroupIds: z.array(z.string().guid()).min(1).max(500),
  deviceTags: z.array(z.string().trim().min(1).max(64)).min(1).max(100),
  respectMaintenanceWindows: z.boolean(),
  // Wave 6 PR 3 (#3828) — ticket-trigger narrowing filters. Same
  // undefined-means-unrestricted / `.min(1)` convention as siteIds/
  // deviceGroupIds above; enforced by runService.ts's
  // evaluateTicketTriggerFilters (see AiAgentTriggers.ticketCategories's
  // docstring for the id-vs-name matching rule).
  ticketCategories: z.array(z.string().trim().min(1).max(100)).min(1).max(100),
  ticketPriorities: z.array(z.enum(['low', 'normal', 'high', 'urgent'])).min(1).max(4),
  // Wave 6 PR 4 (#3828) — anomaly-trigger narrowing filters. Same
  // undefined-means-unrestricted / `.min(1)` convention as ticketCategories/
  // ticketPriorities above; enforced by runService.ts's (Task 3)
  // evaluateAnomalyTriggerFilters. anomalyTypes/metricNames are free text
  // (not a fixed enum — see AiAgentTriggers.anomalyTypes's docstring), capped
  // to the same lengths as the source columns
  // (metric_anomalies.anomaly_type varchar(40), .metric_name varchar(120)).
  anomalyTypes: z.array(z.string().trim().min(1).max(40)).min(1).max(20),
  metricNames: z.array(z.string().trim().min(1).max(120)).min(1).max(50),
  // Unbounded score domain (NOT 0-1) — see AiAgentTriggers.minAnomalyScore's
  // docstring. 1000 is a generous ceiling against garbage input, not a
  // modeled bound: every detector formula in metricAnomalies.ts produces
  // scores well under this today.
  minAnomalyScore: z.number().finite().min(0).max(1000),
  // Wave 6 PR 4 follow-up (#3828) — conservative per-agent opt-in for
  // `triggerKind: 'anomaly'` admission. Unlike every narrowing filter above
  // (undefined = unrestricted), this is a binary safety gate, so its
  // default below is `false` (closed), not omitted. See
  // `AiAgentTriggers.anomalyEnabled`'s docstring (packages/shared/src/types
  // /aiAgents.ts) for the merge semantics — the org's own triggers must set
  // this; a partner-wide baseline can never silently opt an org in.
  anomalyEnabled: z.boolean(),
  // Phase 2 wave P2-4 (#4191) — per-agent opt-in that lifts wave 6.3's
  // forced shadow behavior for ticket-triggered runs. Same binary-safety-gate
  // shape as anomalyEnabled above (default false, org-row-only merge — see
  // AiAgentTriggers.ticketAutonomousWrites's docstring, packages/shared/src
  // /types/aiAgents.ts).
  ticketAutonomousWrites: z.boolean(),
});
export const aiAgentTriggersPatchSchema = triggersFields.partial();
export const aiAgentTriggersSchema = aiAgentTriggersPatchSchema.transform((v) => ({
  alertSeverities: ['critical', 'high'] as Array<(typeof ALERT_SEVERITIES)[number]>,
  respectMaintenanceWindows: true,
  anomalyEnabled: false,
  ticketAutonomousWrites: false,
  ...v,
}));

const recipientsFields = z.object({
  userIds: z.array(z.string().guid()).max(100),
  // Role IDs, not names: roles are tenant-scoped rows with custom names.
  roleIds: z.array(z.string().guid()).max(100),
});
export const aiAgentRecipientsPatchSchema = recipientsFields.partial();
export const aiAgentRecipientsSchema = aiAgentRecipientsPatchSchema.transform((v) => ({
  userIds: [],
  roleIds: [],
  ...v,
}));

const protectedResourcesFields = z.object({
  services: z.array(z.string().trim().min(1).max(128)).max(200),
  paths: z.array(z.string().trim().min(1).max(512)).max(200),
  registryKeys: z.array(z.string().trim().min(1).max(512)).max(200),
  deviceTags: z.array(z.string().trim().min(1).max(64)).max(100),
});
export const aiAgentProtectedResourcesPatchSchema = protectedResourcesFields.partial();
export const aiAgentProtectedResourcesSchema = aiAgentProtectedResourcesPatchSchema.transform((v) => ({
  services: [],
  paths: [],
  registryKeys: [],
  deviceTags: [],
  ...v,
}));

// Wave 4 Part B (Task 6, #3826): the closed set of saved scripts an operator
// has explicitly opted into unattended act-mode execution. `toolAllowlist`
// admitting `run_script` is shape-only ("this agent may call run_script at
// all") — this is the separate, per-script authorization the manifest's
// run_script op requires before executing ANY particular script unattended
// (actRevalidation.ts). Max 50 mirrors nothing structural; it is a sane
// upper bound on a hand-curated allowlist an operator actually reviews.
// Wave 5 Part B (#3827): the closed set of POLICY_DECIDABLE_TIER3 keys an
// operator has explicitly opted into unattended policy-decided authorization
// for this agent. Shape-only here (format + max 50, mirroring toolAllowlist's
// TOOL_REF pattern since a key is exactly a `tool` or `tool:action` string) —
// the semantic check (registry membership, not four_eyes/T4/secret-bearing)
// requires POLICY_DECIDABLE_TIER3 and aiGuardrails.ts, which are API-only
// modules this package cannot import. That check lives in agentService.ts
// (validateAuthorizationKeys, apps/api/src/services/actionIntents/
// policyDecidable.ts) and runs at write time, rejecting with a structured 422.
const actAssetsFields = z.object({
  scriptIds: z.array(z.string().guid()).max(50),
  supervisedActionKeys: z.array(z.string().regex(TOOL_REF)).max(50),
});
export const aiAgentActAssetsPatchSchema = actAssetsFields.partial();
export const aiAgentActAssetsSchema = aiAgentActAssetsPatchSchema.transform((v) => ({
  scriptIds: [],
  supervisedActionKeys: [],
  ...v,
}));

export const aiAgentPolicyFieldsSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(AI_AGENT_MODES).default('off'),
  model: z.string().trim().min(1).max(100).nullable().default(null),
  toolAllowlist: z.array(z.string().regex(TOOL_REF)).max(300).default([]),
  protectedResources: aiAgentProtectedResourcesSchema.prefault({}),
  limits: aiAgentLimitsSchema.prefault({}),
  triggers: aiAgentTriggersSchema.prefault({}),
  recipients: aiAgentRecipientsSchema.prefault({}),
  actAssets: aiAgentActAssetsSchema.prefault({}),
  instructions: z.string().max(2000).nullable().default(null),
  cooldownSeconds: z.number().int().min(0).max(86400).default(900),
});

export const createAiAgentSchema = aiAgentPolicyFieldsSchema.extend({
  ownerScope: z.enum(['organization', 'partner']).optional(),
  orgId: z.string().guid().optional(),
  kind: z.enum(AI_AGENT_KINDS),
  name: z.string().trim().min(1).max(120),
});

// Every field optional with NO default at any depth: an absent key means "leave
// the stored value alone", and must never round-trip as a shipped default.
export const updateAiAgentSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  mode: z.enum(AI_AGENT_MODES).optional(),
  model: z.string().trim().min(1).max(100).nullable().optional(),
  toolAllowlist: z.array(z.string().regex(TOOL_REF)).max(300).optional(),
  protectedResources: aiAgentProtectedResourcesPatchSchema.optional(),
  limits: aiAgentLimitsPatchSchema.optional(),
  triggers: aiAgentTriggersPatchSchema.optional(),
  recipients: aiAgentRecipientsPatchSchema.optional(),
  actAssets: aiAgentActAssetsPatchSchema.optional(),
  instructions: z.string().max(2000).nullable().optional(),
  cooldownSeconds: z.number().int().min(0).max(86400).optional(),
});

/**
 * Manual "run now" trigger body. `.strict()` so a caller cannot smuggle an
 * `orgId`/`kind`/`dedupeKey` past the route into `createAndEnqueueAgentRun` —
 * the org comes from the device row and the kind from the agent row.
 */
export const triggerAgentRunSchema = z.object({
  deviceId: z.string().guid(),
}).strict();

export type CreateAiAgentInput = z.infer<typeof createAiAgentSchema>;
export type UpdateAiAgentInput = z.infer<typeof updateAiAgentSchema>;
export type TriggerAgentRunInput = z.infer<typeof triggerAgentRunSchema>;

/**
 * Phase 2 wave P2-1 (alert verdicts) — validates the `submit_alert_verdict`
 * outcome tool's payload before it is persisted to `ai_alert_verdicts`.
 * `alertVerdictOutcomeSchema` below is `.strict()` so a model-produced
 * payload cannot smuggle an extra top-level key past validation into
 * storage; the discriminant (`action`) already pins each suggestedAction
 * variant to exactly its own field set.
 */
const alertVerdictSuggestedActionSchema = z.discriminatedUnion('action', [
  z.object({
    tool: z.literal('manage_alerts'),
    action: z.literal('suppress'),
    alertId: z.string().uuid(),
    // Review round 2 (IMPORTANT 2): a MODEL-suggested suppression may never
    // be indefinite (`0` = forever on the real `manage_alerts` tool schema,
    // aiToolSchemas.ts — that one stays `min(0)` deliberately, since a human
    // approver can choose "forever"). Keep this bound in sync with
    // `outcomeTools.ts`'s `SUBMIT_ALERT_VERDICT_SHAPE` — the two schemas
    // validate the same field at two different points in the same pipeline.
    suppressDuration: z.number().int().min(1).max(720),
  }),
  z.object({
    tool: z.literal('manage_alerts'),
    action: z.literal('resolve'),
    alertId: z.string().uuid(),
  }),
]);

export const alertVerdictOutcomeSchema: z.ZodType<AlertVerdictOutcome> = z.object({
  classification: z.enum(AI_ALERT_VERDICT_CLASSIFICATIONS),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(400),
  pattern: z.object({
    kind: z.enum(['daily', 'weekly', 'after_event']),
    evidenceAlertIds: z.array(z.string().uuid()).max(50),
  }).optional(),
  suggestedAction: alertVerdictSuggestedActionSchema.optional(),
}).strict();
