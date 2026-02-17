import { z } from 'zod';

export const createConfigPolicySchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  status: z.enum(['active', 'inactive', 'archived']).optional(),
  orgId: z.string().uuid().optional(),
});

export const updateConfigPolicySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  status: z.enum(['active', 'inactive', 'archived']).optional(),
});

export const addFeatureLinkSchema = z.object({
  featureType: z.enum(['patch', 'alert_rule', 'backup', 'security', 'monitoring', 'maintenance', 'compliance', 'automation']),
  featurePolicyId: z.string().uuid().optional(),
  inlineSettings: z.record(z.unknown()).optional(),
}).refine(
  (data) => data.featurePolicyId || data.inlineSettings,
  { message: 'At least one of featurePolicyId or inlineSettings is required' }
);

export const updateFeatureLinkSchema = z.object({
  featurePolicyId: z.string().uuid().nullable().optional(),
  inlineSettings: z.record(z.unknown()).nullable().optional(),
});

export const assignPolicySchema = z.object({
  level: z.enum(['partner', 'organization', 'site', 'device_group', 'device']),
  targetId: z.string().uuid(),
  priority: z.number().int().min(0).max(1000).optional(),
});

export const diffSchema = z.object({
  add: z.array(z.object({
    configPolicyId: z.string().uuid(),
    level: z.enum(['partner', 'organization', 'site', 'device_group', 'device']),
    targetId: z.string().uuid(),
    priority: z.number().int().min(0).optional(),
  })).optional(),
  remove: z.array(z.string().uuid()).optional(),
});

export const listConfigPoliciesSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  status: z.enum(['active', 'inactive', 'archived']).optional(),
  search: z.string().optional(),
  orgId: z.string().uuid().optional(),
});

export const targetQuerySchema = z.object({
  level: z.enum(['partner', 'organization', 'site', 'device_group', 'device']),
  targetId: z.string().uuid(),
});

export const idParamSchema = z.object({ id: z.string().uuid() });
export const linkIdParamSchema = z.object({ id: z.string().uuid(), linkId: z.string().uuid() });
export const assignmentIdParamSchema = z.object({ id: z.string().uuid(), aid: z.string().uuid() });
export const deviceIdParamSchema = z.object({ deviceId: z.string().uuid() });
