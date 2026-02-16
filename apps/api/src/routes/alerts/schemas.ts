import { z } from 'zod';

// Alert Rules schemas
export const listAlertRulesSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  isActive: z.enum(['true', 'false']).optional(),
  enabled: z.enum(['true', 'false']).optional()
});

export const createAlertRuleSchema = z.object({
  orgId: z.string().uuid().optional(),
  templateId: z.string().uuid().optional(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
  targetType: z.string().min(1).max(50).optional(),
  targetId: z.string().uuid().optional(),
  targets: z.object({
    type: z.enum(['all', 'org', 'site', 'group', 'device']),
    ids: z.array(z.string().uuid()).optional()
  }).optional(),
  conditions: z.any().optional(),
  notificationChannelIds: z.array(z.string().uuid()).optional(),
  notificationChannels: z.array(z.string().uuid()).optional(),
  cooldownMinutes: z.coerce.number().int().min(1).max(1440).optional(),
  autoResolve: z.boolean().optional(),
  enabled: z.boolean().optional(),
  active: z.boolean().optional(),
  isActive: z.boolean().optional(),
  overrideSettings: z.any().optional(),
  overrides: z.any().optional(),
  escalationPolicyId: z.string().uuid().optional()
}).superRefine((data, ctx) => {
  if (!data.templateId) {
    if (!data.name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['name'],
        message: 'Rule name is required'
      });
    }
    if (!data.severity) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['severity'],
        message: 'Severity is required'
      });
    }
    if (data.conditions === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['conditions'],
        message: 'Conditions are required'
      });
    }
  }
});

export const updateAlertRuleSchema = z.object({
  templateId: z.string().uuid().optional(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
  targetType: z.string().min(1).max(50).optional(),
  targetId: z.string().uuid().optional(),
  targets: z.object({
    type: z.enum(['all', 'org', 'site', 'group', 'device']),
    ids: z.array(z.string().uuid()).optional()
  }).optional(),
  conditions: z.any().optional(),
  notificationChannelIds: z.array(z.string().uuid()).optional(),
  notificationChannels: z.array(z.string().uuid()).optional(),
  cooldownMinutes: z.coerce.number().int().min(1).max(1440).optional(),
  autoResolve: z.boolean().optional(),
  enabled: z.boolean().optional(),
  active: z.boolean().optional(),
  overrideSettings: z.any().optional(),
  overrides: z.any().optional(),
  escalationPolicyId: z.string().uuid().optional(),
  isActive: z.boolean().optional()
});

export const testAlertRuleSchema = z.object({
  deviceId: z.string().uuid()
});

// Alerts schemas
export const listAlertsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  status: z.enum(['active', 'acknowledged', 'resolved', 'suppressed']).optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
  deviceId: z.string().uuid().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional()
});

export const resolveAlertSchema = z.object({
  note: z.string().optional()
});

export const suppressAlertSchema = z.object({
  until: z.string() // ISO date string
});

// Notification Channels schemas
export const listChannelsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  type: z.enum(['email', 'slack', 'teams', 'webhook', 'pagerduty', 'sms']).optional(),
  enabled: z.enum(['true', 'false']).optional()
});

export const createChannelSchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  type: z.enum(['email', 'slack', 'teams', 'webhook', 'pagerduty', 'sms']),
  config: z.record(z.unknown()), // JSONB for type-specific config
  enabled: z.boolean().default(true)
});

export const updateChannelSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  config: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional()
});

// Escalation Policies schemas
export const listPoliciesSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional()
});

export const createPolicySchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  steps: z.any() // JSONB for escalation steps
});

export const updatePolicySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  steps: z.any().optional()
});
