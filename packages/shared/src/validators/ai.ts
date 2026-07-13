import { z } from 'zod';

// ============================================
// Page Context Validators
// ============================================

export const aiPageContextSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('device'),
    id: z.string().guid(),
    hostname: z.string(),
    os: z.string().optional(),
    status: z.string().optional(),
    ip: z.string().optional()
  }),
  z.object({
    type: z.literal('alert'),
    id: z.string().guid(),
    title: z.string(),
    severity: z.string().optional(),
    deviceHostname: z.string().optional()
  }),
  z.object({
    type: z.literal('dashboard'),
    orgName: z.string().optional(),
    deviceCount: z.number().optional(),
    alertCount: z.number().optional()
  }),
  z.object({
    type: z.literal('custom'),
    label: z.string(),
    data: z.record(z.string(), z.unknown())
  })
]);

// ============================================
// Session Validators
// ============================================

export const createAiSessionSchema = z.object({
  pageContext: aiPageContextSchema.optional(),
  model: z.string().max(100).optional(),
  title: z.string().max(255).optional()
});

export const sendAiMessageSchema = z.object({
  content: z.string().min(1).max(10000),
  pageContext: aiPageContextSchema.optional()
});

export const approveToolSchema = z.object({
  approved: z.boolean()
});

export const approvePlanSchema = z.object({
  approved: z.boolean()
});

export const aiApprovalModeSchema = z.enum(['per_step', 'action_plan', 'auto_approve', 'hybrid_plan']);

export const pauseAiSchema = z.object({
  paused: z.boolean()
});

// ============================================
// Query Validators
// ============================================

export const aiSessionQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  status: z.enum(['active', 'closed', 'expired']).optional()
});

// ============================================
// Script Builder Validators
// ============================================

export const scriptBuilderContextSchema = z.object({
  scriptId: z.string().guid().optional(),
  editorSnapshot: z.object({
    name: z.string().max(255).optional(),
    content: z.string().max(500_000).optional(),
    description: z.string().max(2000).optional(),
    language: z.enum(['powershell', 'bash', 'python', 'cmd']).optional(),
    osTypes: z.array(z.enum(['windows', 'macos', 'linux'])).optional(),
    category: z.string().max(100).optional(),
    parameters: z.array(z.object({
      name: z.string(),
      type: z.enum(['string', 'number', 'boolean', 'select']),
      defaultValue: z.string().optional(),
      required: z.boolean().optional(),
      options: z.string().max(1000).optional(),
    })).max(50).optional(),
    runAs: z.enum(['system', 'user', 'elevated']).optional(),
    // The editor snapshot echoes the current form values, which for legacy
    // scripts may hold timeouts saved under the old 86400 intake cap. Tolerate
    // those (don't fail session creation on an unrelated field) but clamp to
    // 3600 — the agent executor's hard MaxTimeout (#2398).
    timeoutSeconds: z.number().min(1).max(86400).transform((v) => Math.min(v, 3600)).optional(),
  }).optional(),
});

export const createScriptBuilderSessionSchema = z.object({
  context: scriptBuilderContextSchema.optional(),
  title: z.string().max(255).optional(),
});
