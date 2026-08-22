import { z } from 'zod';
import {
  AI_AGENT_KINDS,
  AI_AGENT_LIMIT_DEFAULTS,
  AI_AGENT_MODES,
} from '../types/aiAgents';

const TOOL_REF = /^[a-z0-9_]+(:[a-z0-9_]+)?$/;

export const aiAgentLimitsSchema = z.object({
  maxDevicesPerRun: z.number().int().min(1).max(50).default(AI_AGENT_LIMIT_DEFAULTS.maxDevicesPerRun),
  maxConcurrentRuns: z.number().int().min(1).max(10).default(AI_AGENT_LIMIT_DEFAULTS.maxConcurrentRuns),
  maxRunsPerHour: z.number().int().min(1).max(500).default(AI_AGENT_LIMIT_DEFAULTS.maxRunsPerHour),
  maxTurnsPerRun: z.number().int().min(1).max(100).default(AI_AGENT_LIMIT_DEFAULTS.maxTurnsPerRun),
  maxBudgetCentsPerRun: z.number().int().min(1).max(5000).default(AI_AGENT_LIMIT_DEFAULTS.maxBudgetCentsPerRun),
  maxBudgetCentsPerDay: z.number().int().min(1).max(100000).default(AI_AGENT_LIMIT_DEFAULTS.maxBudgetCentsPerDay),
  wallClockSeconds: z.number().int().min(30).max(1800).default(AI_AGENT_LIMIT_DEFAULTS.wallClockSeconds),
  maxFleetPercentPerDay: z.number().int().min(1).max(100).default(AI_AGENT_LIMIT_DEFAULTS.maxFleetPercentPerDay),
});

export const aiAgentTriggersSchema = z.object({
  alertSeverities: z.array(z.enum(['critical', 'high', 'medium', 'low', 'info'])).default(['critical', 'high']),
  alertRuleIds: z.array(z.string().guid()).max(200).optional(),
  siteIds: z.array(z.string().guid()).max(500).optional(),
  deviceGroupIds: z.array(z.string().guid()).max(500).optional(),
  deviceTags: z.array(z.string().trim().min(1).max(64)).max(100).optional(),
  respectMaintenanceWindows: z.boolean().default(true),
});

export const aiAgentRecipientsSchema = z.object({
  userIds: z.array(z.string().guid()).max(100).default([]),
  roles: z.array(z.enum(['owner', 'admin', 'technician'])).default([]),
});

export const aiAgentProtectedResourcesSchema = z.object({
  services: z.array(z.string().trim().min(1).max(128)).max(200).default([]),
  paths: z.array(z.string().trim().min(1).max(512)).max(200).default([]),
  registryKeys: z.array(z.string().trim().min(1).max(512)).max(200).default([]),
  deviceTags: z.array(z.string().trim().min(1).max(64)).max(100).default([]),
});

export const aiAgentPolicyFieldsSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(AI_AGENT_MODES).default('off'),
  model: z.string().trim().min(1).max(100).nullable().default(null),
  toolAllowlist: z.array(z.string().regex(TOOL_REF)).max(300).default([]),
  protectedResources: aiAgentProtectedResourcesSchema.prefault({}),
  limits: aiAgentLimitsSchema.prefault({}),
  triggers: aiAgentTriggersSchema.prefault({}),
  recipients: aiAgentRecipientsSchema.prefault({}),
  instructions: z.string().max(2000).nullable().default(null),
  cooldownSeconds: z.number().int().min(0).max(86400).default(900),
});

export const createAiAgentSchema = aiAgentPolicyFieldsSchema.extend({
  ownerScope: z.enum(['organization', 'partner']).optional(),
  orgId: z.string().guid().optional(),
  kind: z.enum(AI_AGENT_KINDS),
  name: z.string().trim().min(1).max(120),
});

export const updateAiAgentSchema = createAiAgentSchema
  .partial()
  .omit({ ownerScope: true, kind: true, orgId: true })
  // Zod 4 materializes child defaults through .partial(); strip every
  // create-time default so an omitted PATCH field cannot reset stored policy.
  .extend({
    enabled: createAiAgentSchema.shape.enabled.removeDefault().optional(),
    mode: createAiAgentSchema.shape.mode.removeDefault().optional(),
    model: createAiAgentSchema.shape.model.removeDefault().optional(),
    toolAllowlist: createAiAgentSchema.shape.toolAllowlist.removeDefault().optional(),
    protectedResources: createAiAgentSchema.shape.protectedResources.unwrap().optional(),
    limits: createAiAgentSchema.shape.limits.unwrap().optional(),
    triggers: createAiAgentSchema.shape.triggers.unwrap().optional(),
    recipients: createAiAgentSchema.shape.recipients.unwrap().optional(),
    instructions: createAiAgentSchema.shape.instructions.removeDefault().optional(),
    cooldownSeconds: createAiAgentSchema.shape.cooldownSeconds.removeDefault().optional(),
  });

export type CreateAiAgentInput = z.infer<typeof createAiAgentSchema>;
export type UpdateAiAgentInput = z.infer<typeof updateAiAgentSchema>;
