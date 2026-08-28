import { z } from 'zod';
import { ALERT_SEVERITIES } from '../constants';
import {
  AI_AGENT_KINDS,
  AI_AGENT_LIMIT_DEFAULTS,
  AI_AGENT_MODES,
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
});
export const aiAgentTriggersPatchSchema = triggersFields.partial();
export const aiAgentTriggersSchema = aiAgentTriggersPatchSchema.transform((v) => ({
  alertSeverities: ['critical', 'high'] as Array<(typeof ALERT_SEVERITIES)[number]>,
  respectMaintenanceWindows: true,
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
const actAssetsFields = z.object({
  scriptIds: z.array(z.string().guid()).max(50),
});
export const aiAgentActAssetsPatchSchema = actAssetsFields.partial();
export const aiAgentActAssetsSchema = aiAgentActAssetsPatchSchema.transform((v) => ({
  scriptIds: [],
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
