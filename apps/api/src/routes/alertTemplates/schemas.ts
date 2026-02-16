import { z } from 'zod';

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type AlertTemplateTarget = {
  scope: 'device' | 'site' | 'organization' | 'tag';
  deviceIds?: string[];
  siteIds?: string[];
  tags?: string[];
  orgId?: string;
};

export type AlertTemplate = {
  id: string;
  name: string;
  description?: string;
  category: string;
  severity: AlertSeverity;
  builtIn: boolean;
  conditions: Record<string, unknown>;
  targets: AlertTemplateTarget;
  defaultCooldownMinutes: number;
  createdAt: Date;
  updatedAt: Date;
};

export type AlertRule = {
  id: string;
  orgId: string | null;
  name: string;
  description?: string;
  templateId: string;
  templateName: string;
  severity: AlertSeverity;
  enabled: boolean;
  targets: AlertTemplateTarget;
  conditions: Record<string, unknown>;
  cooldownMinutes: number;
  createdAt: Date;
  updatedAt: Date;
  lastTriggeredAt: Date | null;
};

export type CorrelationAlert = {
  id: string;
  ruleId: string;
  templateId: string;
  severity: AlertSeverity;
  message: string;
  deviceId: string;
  occurredAt: Date;
};

export type CorrelationLink = {
  id: string;
  alertId: string;
  relatedAlertId: string;
  reason: string;
  confidence: number;
  createdAt: Date;
};

export type CorrelationGroup = {
  id: string;
  title: string;
  summary: string;
  correlationScore: number;
  rootCauseHint: string | null;
  alerts: CorrelationAlert[];
  createdAt: Date;
};

export const severitySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);

export const listTemplatesSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  builtIn: z.enum(['true', 'false']).optional(),
  severity: severitySchema.optional(),
  search: z.string().optional()
});

export const createTemplateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  category: z.string().min(1).max(100).optional(),
  severity: severitySchema,
  conditions: z.record(z.any()).optional().default({}),
  targets: z.record(z.any()).optional(),
  defaultCooldownMinutes: z.number().int().min(0).max(10080).optional()
});

export const updateTemplateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  category: z.string().min(1).max(100).optional(),
  severity: severitySchema.optional(),
  conditions: z.record(z.any()).optional(),
  targets: z.record(z.any()).optional(),
  defaultCooldownMinutes: z.number().int().min(0).max(10080).optional()
});

export const listRulesSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  enabled: z.enum(['true', 'false']).optional(),
  severity: severitySchema.optional(),
  templateId: z.string().uuid().optional(),
  targetType: z.enum(['device', 'site', 'organization', 'tag']).optional(),
  targetValue: z.string().optional(),
  search: z.string().optional()
});

export const createRuleSchema = z.object({
  orgId: z.string().uuid().optional(),
  templateId: z.string().uuid(),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  enabled: z.boolean().optional().default(true),
  severity: severitySchema.optional(),
  targets: z.record(z.any()).optional(),
  conditions: z.record(z.any()).optional(),
  cooldownMinutes: z.number().int().min(0).max(10080).optional()
});

export const updateRuleSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  severity: severitySchema.optional(),
  targets: z.record(z.any()).optional(),
  conditions: z.record(z.any()).optional(),
  cooldownMinutes: z.number().int().min(0).max(10080).optional()
});

export const toggleRuleSchema = z.object({
  enabled: z.boolean()
});

export const listCorrelationsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  alertId: z.string().uuid().optional(),
  minConfidence: z.string().optional()
});

export const analyzeCorrelationsSchema = z.object({
  alertIds: z.array(z.string().uuid()).optional(),
  windowMinutes: z.number().int().min(5).max(1440).optional()
});
