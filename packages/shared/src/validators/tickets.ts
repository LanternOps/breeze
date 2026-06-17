import { z } from 'zod';

export const ticketStatusSchema = z.enum(['new', 'open', 'pending', 'on_hold', 'resolved', 'closed']);
export const ticketPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
export const ticketSourceSchema = z.enum(['portal', 'email', 'alert', 'manual', 'api', 'ai']);
export type TicketStatus = z.infer<typeof ticketStatusSchema>;
export type TicketPriority = z.infer<typeof ticketPrioritySchema>;

export const createTicketSchema = z.object({
  orgId: z.string().guid(),
  subject: z.string().min(1).max(255),
  description: z.string().max(50_000).optional(),
  deviceId: z.string().guid().optional(),
  categoryId: z.string().guid().optional(),
  priority: ticketPrioritySchema.default('normal'),
  dueDate: z.coerce.date().optional(),
  assigneeId: z.string().guid().optional()
});

export const updateTicketSchema = z.object({
  subject: z.string().min(1).max(255).optional(),
  description: z.string().max(50_000).optional(),
  categoryId: z.string().guid().nullable().optional(),
  priority: ticketPrioritySchema.optional(),
  dueDate: z.coerce.date().nullable().optional(),
  responseSlaMinutes: z.number().int().positive().nullable().optional(),
  resolutionSlaMinutes: z.number().int().positive().nullable().optional(),
  deviceId: z.string().guid().nullable().optional(),
  tags: z.array(z.string().max(50)).max(20).optional()
});

export const changeTicketStatusSchema = z.object({
  status: ticketStatusSchema.optional(),
  statusId: z.string().guid().optional(),
  resolutionNote: z.string().min(1).max(10_000).optional(),
  pendingReason: z.string().max(500).optional()
}).superRefine((v, ctx) => {
  const hasStatus = v.status !== undefined;
  const hasStatusId = v.statusId !== undefined;
  if (hasStatus && hasStatusId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide either status or statusId, not both', path: ['status'] });
  }
  if (!hasStatus && !hasStatusId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Either status or statusId is required', path: [] });
  }
  if (hasStatus && v.status === 'resolved' && (!v.resolutionNote || v.resolutionNote.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'resolutionNote is required when resolving', path: ['resolutionNote'] });
  }
});

export const assignTicketSchema = z.object({
  assigneeId: z.string().guid().nullable()
});

// Bulk queue actions (assign / status). Resolving is intentionally excluded:
// it requires a per-ticket resolution note, so it stays a per-ticket action.
export const bulkTicketActionSchema = z.object({
  ticketIds: z.array(z.string().guid()).min(1).max(100),
  action: z.enum(['assign', 'status']),
  assigneeId: z.string().guid().nullable().optional(),
  status: ticketStatusSchema.optional()
}).refine(
  (v) => v.action !== 'assign' || v.assigneeId !== undefined,
  { message: 'assigneeId is required when action is assign (null to unassign)', path: ['assigneeId'] }
).refine(
  (v) => v.action !== 'status' || v.status !== undefined,
  { message: 'status is required when action is status', path: ['status'] }
).refine(
  (v) => v.action !== 'status' || v.status !== 'resolved',
  { message: 'Resolving requires a per-ticket resolution note; resolve tickets individually', path: ['status'] }
);

export const addTicketCommentSchema = z.object({
  content: z.string().min(1).max(50_000),
  isPublic: z.boolean().default(true)
});

export const listTicketsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: ticketStatusSchema.optional(),
  statusGroup: z.enum(['open', 'closed']).optional(),
  orgId: z.string().guid().optional(),
  deviceId: z.string().guid().optional(),
  assignee: z.union([z.literal('me'), z.literal('unassigned'), z.string().guid()]).optional(),
  categoryId: z.string().guid().optional(),
  priority: ticketPrioritySchema.optional(),
  slaState: z.enum(['ok', 'at_risk', 'breached', 'breaching']).optional(),
  search: z.string().max(200).optional(),
  sort: z.enum(['triage', 'newest', 'oldest', 'due']).default('triage')
});

export const ticketCategoryInputSchema = z.object({
  name: z.string().min(1).max(100),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  parentId: z.string().guid().nullable().optional(),
  defaultPriority: ticketPrioritySchema.nullable().optional(),
  responseSlaMinutes: z.number().int().positive().nullable().optional(),
  resolutionSlaMinutes: z.number().int().positive().nullable().optional(),
  defaultBillable: z.boolean().optional(),
  defaultHourlyRate: z.number().nonnegative().nullable().optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional()
});
