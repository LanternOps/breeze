import { z } from 'zod';

// ============================================
// Filter Operator Schemas
// ============================================

export const filterOperatorSchema = z.enum([
  // Comparison operators
  'equals',
  'notEquals',
  'greaterThan',
  'greaterThanOrEquals',
  'lessThan',
  'lessThanOrEquals',
  // String operators
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'matches',
  // Collection operators
  'in',
  'notIn',
  'hasAny',
  'hasAll',
  'isEmpty',
  'isNotEmpty',
  // Null operators
  'isNull',
  'isNotNull',
  // Date operators
  'before',
  'after',
  'between',
  'withinLast',
  'notWithinLast'
]);

// ============================================
// Filter Value Schemas
// ============================================

const dateRangeValueSchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date()
});

const relativeTimeValueSchema = z.object({
  amount: z.number().positive(),
  unit: z.enum(['minutes', 'hours', 'days', 'weeks', 'months'])
});

export const filterValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.coerce.date(),
  z.array(z.string()),
  z.array(z.number()),
  dateRangeValueSchema,
  relativeTimeValueSchema
]);

// ============================================
// Filter Condition Schemas
// ============================================

export const filterConditionSchema = z.object({
  field: z.string().min(1),
  operator: filterOperatorSchema,
  value: filterValueSchema.optional()
});

// Recursive schema for nested groups
export const filterConditionGroupSchema: z.ZodType<{
  operator: 'AND' | 'OR';
  conditions: Array<
    | { field: string; operator: string; value?: unknown }
    | { operator: 'AND' | 'OR'; conditions: unknown[] }
  >;
}> = z.lazy(() =>
  z.object({
    operator: z.enum(['AND', 'OR']),
    conditions: z
      .array(z.union([filterConditionSchema, filterConditionGroupSchema]))
      .min(1)
  })
);

export const filterRootSchema = z.union([
  filterConditionSchema,
  filterConditionGroupSchema
]);

// ============================================
// Saved Filter Schemas
// ============================================

export const createSavedFilterSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  conditions: filterConditionGroupSchema
});

export const updateSavedFilterSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  conditions: filterConditionGroupSchema.optional()
});

export const savedFilterQuerySchema = z.object({
  search: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(50)
});

// ============================================
// Custom Field Schemas
// ============================================

export const customFieldTypeSchema = z.enum([
  'text',
  'number',
  'boolean',
  'dropdown',
  'date'
]);

export const customFieldOptionsSchema = z.object({
  choices: z
    .array(
      z.object({
        label: z.string().min(1),
        value: z.string().min(1)
      })
    )
    .optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  minLength: z.number().min(0).optional(),
  maxLength: z.number().min(1).optional(),
  pattern: z.string().optional()
});

export const createCustomFieldSchema = z.object({
  name: z.string().min(1).max(100),
  fieldKey: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z][a-z0-9_]*$/, 'Field key must be lowercase alphanumeric with underscores'),
  type: customFieldTypeSchema,
  options: customFieldOptionsSchema.optional(),
  required: z.boolean().default(false),
  defaultValue: z.unknown().optional(),
  deviceTypes: z.array(z.enum(['windows', 'macos', 'linux'])).optional()
});

export const updateCustomFieldSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  options: customFieldOptionsSchema.optional(),
  required: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
  deviceTypes: z.array(z.enum(['windows', 'macos', 'linux'])).nullable().optional()
});

export const customFieldQuerySchema = z.object({
  type: customFieldTypeSchema.optional(),
  search: z.string().optional()
});

// ============================================
// Device Group Filter Schemas
// ============================================

export const createDynamicGroupSchema = z.object({
  name: z.string().min(1).max(255),
  siteId: z.string().uuid().optional(),
  filterConditions: filterConditionGroupSchema,
  parentId: z.string().uuid().optional()
});

export const updateDynamicGroupSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  siteId: z.string().uuid().nullable().optional(),
  filterConditions: filterConditionGroupSchema.optional(),
  parentId: z.string().uuid().nullable().optional()
});

export const pinDeviceToGroupSchema = z.object({
  deviceId: z.string().uuid(),
  pin: z.boolean()
});

// ============================================
// Deployment Schemas
// ============================================

export const rolloutConfigSchema = z.object({
  type: z.enum(['immediate', 'staggered']),
  staggered: z
    .object({
      batchSize: z.union([z.number().positive(), z.string().regex(/^\d+%$/)]),
      batchDelayMinutes: z.number().min(0),
      pauseOnFailureCount: z.number().min(1).optional(),
      pauseOnFailurePercent: z.number().min(1).max(100).optional()
    })
    .optional(),
  respectMaintenanceWindows: z.boolean().default(false),
  retryConfig: z.object({
    maxRetries: z.number().min(0).max(10).default(3),
    backoffMinutes: z.array(z.number().min(1)).default([5, 15, 60])
  })
});

export const deploymentTargetConfigSchema = z.object({
  type: z.enum(['devices', 'groups', 'filter', 'all']),
  deviceIds: z.array(z.string().uuid()).optional(),
  groupIds: z.array(z.string().uuid()).optional(),
  filter: filterConditionGroupSchema.optional()
});

export const deploymentScheduleSchema = z.object({
  type: z.enum(['immediate', 'scheduled', 'maintenance_window']),
  scheduledAt: z.coerce.date().optional(),
  maintenanceWindowId: z.string().uuid().optional()
});

export const scriptPayloadSchema = z.object({
  type: z.literal('script'),
  scriptId: z.string().uuid(),
  parameters: z.record(z.unknown()).optional()
});

export const patchPayloadSchema = z.object({
  type: z.literal('patch'),
  patchIds: z.array(z.string().uuid()).min(1)
});

export const softwarePayloadSchema = z.object({
  type: z.literal('software'),
  packageId: z.string().uuid(),
  action: z.enum(['install', 'uninstall', 'update'])
});

export const policyPayloadSchema = z.object({
  type: z.literal('policy'),
  policyId: z.string().uuid()
});

export const deploymentPayloadSchema = z.discriminatedUnion('type', [
  scriptPayloadSchema,
  patchPayloadSchema,
  softwarePayloadSchema,
  policyPayloadSchema
]);

export const createDeploymentSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(['script', 'patch', 'software', 'policy']),
  payload: deploymentPayloadSchema,
  targetConfig: deploymentTargetConfigSchema,
  schedule: deploymentScheduleSchema.optional(),
  rolloutConfig: rolloutConfigSchema
});

export const updateDeploymentSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  schedule: deploymentScheduleSchema.optional(),
  rolloutConfig: rolloutConfigSchema.optional()
});

export const deploymentQuerySchema = z.object({
  status: z
    .enum(['draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled', 'failed'])
    .optional(),
  type: z.enum(['script', 'patch', 'software', 'policy']).optional(),
  search: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(50)
});

// ============================================
// Filter Preview Schemas
// ============================================

export const filterPreviewSchema = z.object({
  conditions: filterConditionGroupSchema,
  limit: z.number().min(1).max(100).default(10)
});
