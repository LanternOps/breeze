import { z } from 'zod';

// ============================================
// Page Context Validators
// ============================================

export const aiPageContextSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('device'),
    id: z.string().uuid(),
    hostname: z.string(),
    os: z.string().optional(),
    status: z.string().optional(),
    ip: z.string().optional()
  }),
  z.object({
    type: z.literal('alert'),
    id: z.string().uuid(),
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
    data: z.record(z.unknown())
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
